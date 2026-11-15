/**
 * Dumps the genuine Antigravity CLI system prompt and tool catalog from
 * official releases of https://github.com/google-antigravity/antigravity-cli.
 *
 * How it works:
 * 1. Resolves the target release tag (latest stable X.Y.Z or --tag).
 * 2. Downloads and unpacks the official Antigravity CLI binary for the current
 *    platform (or uses --bin).
 * 3. Starts an ephemeral mock Gemini API server on 127.0.0.1:0.
 * 4. Runs `antigravity --settings '{"modelProvider":"gemini"}' -p ...` in a
 *    clean sandbox with GEMINI_API_KEY and GOOGLE_GEMINI_BASE_URL pointing at
 *    the mock server. The CLI renders its real system instruction and tool
 *    declarations before the first `streamGenerateContent` call; the mock
 *    captures that request body.
 * 5. Normalizes volatile values (workspace/app-data paths, conversation UUID,
 *    host OS) to placeholders and writes `src/antigravity-upstream.ts`
 *    (or checks for drift under --check).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import {
  downloadReleaseBinary,
  resolveLatestHubIdentity,
  resolveLatestReleaseTag,
  setupSandbox,
  type SandboxEnvironment,
} from "./lib/antigravity-release.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const TARGET_FILE = join(REPO_ROOT, "src", "antigravity-upstream.ts");

/**
 * Core tools every Antigravity release we support must declare. New tools are
 * picked up automatically; losing one of these means the extraction broke or
 * upstream changed its contract and the generated file needs a manual review.
 */
export const REQUIRED_UPSTREAM_TOOLS = [
  "ask_question",
  "edit_file",
  "invoke_subagent",
  "read_file",
  "run_command",
  "search_web",
  "write_file",
] as const;

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

interface GeminiFunctionDeclaration {
  name?: unknown;
  description?: unknown;
  parametersJsonSchema?: unknown;
  parameters?: unknown;
}

interface GeminiToolGroup {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

interface CapturedGeminiRequest {
  systemInstruction?: { parts?: Array<{ text?: string }> };
  tools?: GeminiToolGroup[];
}

export interface UpstreamTool {
  description: string;
  parameters: Record<string, unknown>;
}

export interface UpstreamCapture {
  release: string;
  model: string;
  hubVersion: string;
  hubCl: string;
  hubManifestUrl: string;
  systemPrompt: string;
  tools: Record<string, UpstreamTool>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mock Gemini endpoint: captures the first request that carries prompt + tools. */
function startMockGeminiServer(): Promise<{
  port: number;
  close: () => Promise<void>;
  captured: () => CapturedGeminiRequest | undefined;
  capturedModel: () => string | undefined;
}> {
  let captured: CapturedGeminiRequest | undefined;
  let capturedRuntimeModel: string | undefined;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "";
      const modelMatch = url.match(/\/models\/([^:?]+):/);
      if (modelMatch && !capturedRuntimeModel) {
        capturedRuntimeModel = decodeURIComponent(modelMatch[1]);
      }
      if (req.method === "POST" && body) {
        try {
          const parsed = JSON.parse(body) as CapturedGeminiRequest;
          if (
            !captured &&
            parsed.systemInstruction &&
            Array.isArray(parsed.tools) &&
            parsed.tools.length > 0
          ) {
            captured = parsed;
          }
        } catch {
          // Non-JSON bodies are irrelevant for the capture.
        }
      }

      if (url.includes("streamGenerateContent")) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.write(
          `data: ${JSON.stringify({
            candidates: [
              { content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" },
            ],
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 1,
              totalTokenCount: 2,
            },
          })}\n\n`,
        );
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [
            { content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
        }),
      );
    });
  };

  return new Promise((resolveServer, rejectServer) => {
    const server = createServer(handler);
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolveServer({
        port,
        captured: () => captured,
        capturedModel: () => capturedRuntimeModel,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
      });
    });
  });
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCli(
  binary: string,
  args: string[],
  sandbox: SandboxEnvironment,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(binary, args, {
      cwd: sandbox.workspaceDir,
      env: sandbox.runEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const captureChunk = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (target === "stdout") stdout = (stdout + chunk.toString("utf8")).slice(-64_000);
      else stderr = (stderr + chunk.toString("utf8")).slice(-64_000);
    };
    child.stdout?.on("data", (chunk: Buffer) => captureChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => captureChunk("stderr", chunk));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolveRun({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function normalizePrompt(prompt: string, sandbox: SandboxEnvironment): string {
  let normalized = prompt;
  normalized = normalized.split(sandbox.appDataDir).join("<appDataDir>");
  normalized = normalized.split(sandbox.workspaceDir).join("<workspace>");
  normalized = normalized.split(sandbox.homeDir).join("<home>");
  normalized = normalized.split(sandbox.sandboxDir).join("<sandbox>");
  normalized = normalized.replace(
    /The USER's OS version is [^.\n]+\./g,
    "The USER's OS version is <os>.",
  );
  normalized = normalized.replace(UUID_PATTERN, "<conversation-id>");
  return normalized;
}

function assertNormalized(prompt: string, sandbox: SandboxEnvironment): void {
  for (const leak of [sandbox.appDataDir, sandbox.workspaceDir, sandbox.homeDir, sandbox.sandboxDir]) {
    if (prompt.includes(leak)) {
      throw new Error(`System prompt still contains a sandbox path after normalization: ${leak}`);
    }
  }
  if (UUID_PATTERN.test(prompt)) {
    UUID_PATTERN.lastIndex = 0;
    throw new Error("System prompt still contains a UUID after normalization");
  }
  UUID_PATTERN.lastIndex = 0;
}

function extractTools(capture: CapturedGeminiRequest): Record<string, UpstreamTool> {
  const groups = Array.isArray(capture.tools) ? capture.tools : [];
  const catalog: Record<string, UpstreamTool> = {};

  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.functionDeclarations)) continue;
    for (const declaration of group.functionDeclarations) {
      if (!isRecord(declaration)) continue;
      const name = declaration.name;
      const description = declaration.description;
      const parameters = declaration.parametersJsonSchema ?? declaration.parameters;
      if (typeof name !== "string" || !name) continue;
      if (name in catalog) continue;
      if (typeof description !== "string" || !description.trim()) {
        throw new Error(`Tool "${name}" has an empty description`);
      }
      if (!isRecord(parameters)) {
        throw new Error(`Tool "${name}" has no JSON-schema parameters`);
      }
      catalog[name] = { description, parameters };
    }
  }

  const sorted: Record<string, UpstreamTool> = {};
  for (const name of Object.keys(catalog).sort()) sorted[name] = catalog[name];

  const missing = REQUIRED_UPSTREAM_TOOLS.filter((name) => !sorted[name]);
  if (missing.length > 0) {
    throw new Error(
      `Antigravity CLI did not declare the expected tools: ${missing.join(", ")}. ` +
        `Captured: ${Object.keys(sorted).join(", ") || "none"}`,
    );
  }
  return sorted;
}

function toTemplateLiteral(text: string): string {
  return (
    "`" +
    text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") +
    "`"
  );
}

function renderGeneratedFile(capture: UpstreamCapture): string {
  const toolNames = Object.keys(capture.tools);
  return `/**
 * AUTO-GENERATED by \`scripts/extract-antigravity.ts\` — do not edit by hand.
 *
 * Source: https://github.com/google-antigravity/antigravity-cli release ${capture.release}
 * Capture: the CLI's first Gemini \`streamGenerateContent\` request with
 * \`modelProvider: "gemini"\` (genuine system instruction + function declarations).
 * Client identity: the Antigravity Hub updater manifest supplies the Hub
 * version and Piper changelist used in the \`User-Agent\`:
 * ${capture.hubManifestUrl}
 *
 * Volatile values are normalized to placeholders:
 *   <workspace>        command working directory / active workspace
 *   <appDataDir>       CLI app data directory ($HOME/.gemini/antigravity-cli)
 *   <home>             sandbox home directory
 *   <sandbox>          sandbox root (fallback for other sandbox paths)
 *   <conversation-id>  per-conversation UUID
 *   <os>               host OS reported to the model
 *
 * Refresh with \`npm run extract-antigravity\`; verify with
 * \`npm run extract-antigravity:check\`.
 */
export const ANTIGRAVITY_UPSTREAM_RELEASE: string = ${JSON.stringify(capture.release)};
export const ANTIGRAVITY_UPSTREAM_MODEL: string = ${JSON.stringify(capture.model)};
export const ANTIGRAVITY_UPSTREAM_HUB_VERSION: string = ${JSON.stringify(capture.hubVersion)};
export const ANTIGRAVITY_UPSTREAM_HUB_CL: string = ${JSON.stringify(capture.hubCl)};

export interface AntigravityUpstreamTool {
  description: string;
  parameters: Record<string, unknown>;
}

/** Genuine system instruction, with volatile values normalized to placeholders. */
export const ANTIGRAVITY_UPSTREAM_SYSTEM_PROMPT: string = ${toTemplateLiteral(capture.systemPrompt)};

/** Genuine Antigravity tool declarations (${toolNames.length} tools, schema as sent on the wire). */
export const ANTIGRAVITY_UPSTREAM_TOOLS: Record<string, AntigravityUpstreamTool> = ${JSON.stringify(
    capture.tools,
    null,
    2,
  )};
`;
}

function firstDifference(current: string, expected: string): string {
  const currentLines = current.split("\n");
  const expectedLines = expected.split("\n");
  const total = Math.max(currentLines.length, expectedLines.length);
  for (let index = 0; index < total; index += 1) {
    if (currentLines[index] === expectedLines[index]) continue;
    const line = index + 1;
    const format = (value: string | undefined): string =>
      value === undefined ? "<missing line>" : value.length > 240 ? `${value.slice(0, 240)}…` : value;
    return [
      `first difference at line ${line}:`,
      `  current:  ${format(currentLines[index])}`,
      `  captured: ${format(expectedLines[index])}`,
    ].join("\n");
  }
  return "files differ only in their trailing content";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const isWrite = args.includes("--write") || !isCheck;
  const musl = args.includes("--musl");

  let customTag: string | undefined;
  const tagIndex = args.indexOf("--tag");
  if (tagIndex !== -1 && args[tagIndex + 1]) customTag = args[tagIndex + 1];

  let customBin: string | undefined;
  const binIndex = args.indexOf("--bin");
  if (binIndex !== -1 && args[binIndex + 1]) customBin = args[binIndex + 1];

  let targetFile = TARGET_FILE;
  const outIndex = args.indexOf("--out");
  if (outIndex !== -1 && args[outIndex + 1]) targetFile = resolve(args[outIndex + 1]);
  const displayTarget = relative(REPO_ROOT, targetFile) || targetFile;

  let model: string | undefined;
  const modelIndex = args.indexOf("--model");
  if (modelIndex !== -1 && args[modelIndex + 1]) model = args[modelIndex + 1];

  let timeoutMs = 180_000;
  const timeoutIndex = args.indexOf("--timeout");
  if (timeoutIndex !== -1 && args[timeoutIndex + 1]) {
    const parsed = Number(args[timeoutIndex + 1]);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid --timeout value: ${args[timeoutIndex + 1]}`);
    }
    timeoutMs = parsed * 1000;
  }

  let hubManifestUrl: string | undefined;
  const hubIndex = args.indexOf("--hub-manifest");
  if (hubIndex !== -1 && args[hubIndex + 1]) hubManifestUrl = args[hubIndex + 1];

  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  console.log("Resolving Antigravity Hub client identity...");
  const hub = await resolveLatestHubIdentity({ manifestUrl: hubManifestUrl });
  console.log(`Hub client: ${hub.version} (cl=${hub.cl})`);

  console.log("Resolving Antigravity CLI release...");
  const release = customTag ?? (await resolveLatestReleaseTag(githubToken));
  console.log(`Using release tag: ${release}`);

  const workDir = join("/tmp", "pi", "extract-antigravity", release);
  mkdirSync(workDir, { recursive: true });
  const binary =
    customBin ?? (await downloadReleaseBinary(release, join(workDir, "bin"), { musl, token: githubToken }));
  console.log(`Antigravity CLI binary: ${binary}`);

  const server = await startMockGeminiServer();
  const sandbox = setupSandbox(workDir, server.port);
  console.log(`Mock Gemini endpoint: http://127.0.0.1:${server.port}`);
  console.log("Running the CLI in an isolated sandbox...");

  const cliArgs = [
    "--settings",
    JSON.stringify({ modelProvider: "gemini" }),
    "--dangerously-skip-permissions",
    "--output-format",
    "json",
  ];
  if (model) cliArgs.push("--model", model);
  cliArgs.push("-p", "extract");

  let run: RunResult;
  try {
    run = await runCli(binary, cliArgs, sandbox, timeoutMs);
  } finally {
    await server.close();
  }

  const captured = server.captured();
  if (!captured) {
    const details = [
      run.timedOut ? `CLI timed out after ${timeoutMs / 1000}s` : "",
      `exit code: ${run.exitCode}`,
      run.stdout ? `stdout:\n${run.stdout}` : "",
      run.stderr ? `stderr:\n${run.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(`The CLI did not send a Gemini request with prompt + tools.\n${details}`);
  }

  if (run.exitCode !== 0) {
    console.warn(
      `Warning: the CLI exited with code ${run.exitCode}; the captured request was still complete.\n` +
        `${(run.stderr || run.stdout).slice(-2_000)}`,
    );
  }

  const promptParts = Array.isArray(captured.systemInstruction?.parts)
    ? captured.systemInstruction.parts
    : [];
  const rawPrompt = promptParts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n");
  if (rawPrompt.length < 1_000) {
    throw new Error(`Captured system prompt is suspiciously short (${rawPrompt.length} chars)`);
  }
  if (!rawPrompt.includes("<identity>") || !rawPrompt.includes("<user_information>")) {
    throw new Error("Captured system prompt is missing expected Antigravity sections");
  }

  const systemPrompt = normalizePrompt(rawPrompt, sandbox);
  assertNormalized(systemPrompt, sandbox);

  const tools = extractTools(captured);
  const toolNames = Object.keys(tools);

  console.log(
    `Captured system prompt (${systemPrompt.length} chars) and ${toolNames.length} tools: ${toolNames.join(", ")}`,
  );

  const capturedModel = server.capturedModel() ?? model ?? "unknown";

  const expected = renderGeneratedFile({
    release,
    model: capturedModel,
    hubVersion: hub.version,
    hubCl: hub.cl,
    hubManifestUrl: hub.manifestUrl,
    systemPrompt,
    tools,
  });

  const current = existsSync(targetFile) ? readFileSync(targetFile, "utf8") : "";
  const hasDiff = current !== expected;

  if (isCheck) {
    if (hasDiff) {
      console.error(`\n[DRIFT DETECTED] ${displayTarget} differs from release ${release}`);
      console.error(firstDifference(current, expected));
      console.error("Run `npm run extract-antigravity` to update.");
      process.exit(1);
    }
    console.log(`\n[OK] ${displayTarget} is up-to-date with release ${release}`);
    process.exit(0);
  }

  if (isWrite) {
    if (!hasDiff) {
      console.log(`\n${displayTarget} is already identical to release ${release}.`);
    } else {
      writeFileSync(targetFile, expected, "utf8");
      console.log(`\nUpdated ${displayTarget} from release ${release}.`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Extraction error:", error);
    process.exit(1);
  });
}
