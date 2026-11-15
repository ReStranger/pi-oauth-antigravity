/**
 * Request shaping for the dumped Antigravity CLI contract.
 *
 * Mirrors the `pi-opencode-free` pattern: the genuine upstream system prompt
 * and tool declarations are carried on the wire alongside Pi's own prompt and
 * tools. The prompt is rendered from the normalized dump with the real
 * workspace/app-data/conversation values before it is appended.
 *
 * Antigravity's tool names (`read_file`, `run_command`, …) do not match Pi's
 * built-ins, so the executable subset is bridged back to Pi names in the
 * stream parser (`read`, `write`, `edit`, `bash`). Tools with no Pi equivalent
 * stay as declared; disable the whole contract with
 * `ANTIGRAVITY_UPSTREAM_CONTRACT=off` if that is not wanted.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
  ANTIGRAVITY_UPSTREAM_SYSTEM_PROMPT,
  ANTIGRAVITY_UPSTREAM_TOOLS,
} from "./antigravity-upstream.js";

/** The line every genuine Antigravity system prompt starts with. */
export const ANTIGRAVITY_UPSTREAM_PROMPT_MARKER =
  "<identity>\nYou are Antigravity, a powerful agentic AI assistant";

export function antigravityUpstreamContractEnabled(): boolean {
  const raw = process.env.ANTIGRAVITY_UPSTREAM_CONTRACT?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export interface AntigravityUpstreamPromptValues {
  workspace: string;
  appDataDir: string;
  conversationId: string;
  os: string;
}

export function antigravityUpstreamOs(): string {
  return process.platform === "darwin"
    ? "macos"
    : process.platform === "win32"
      ? "windows"
      : "linux";
}

export function antigravityUpstreamPromptValues(
  conversationId: string,
): AntigravityUpstreamPromptValues {
  return {
    workspace: process.cwd(),
    appDataDir: join(homedir(), ".gemini", "antigravity-cli"),
    conversationId,
    os: antigravityUpstreamOs(),
  };
}

/** Renders the committed template with real per-session values. */
export function renderAntigravityUpstreamSystemPrompt(
  values: AntigravityUpstreamPromptValues,
): string {
  return ANTIGRAVITY_UPSTREAM_SYSTEM_PROMPT.split("<workspace>")
    .join(values.workspace)
    .split("<appDataDir>")
    .join(values.appDataDir)
    .split("<conversation-id>")
    .join(values.conversationId)
    .split("<os>")
    .join(values.os);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Bridges the upstream tool calls that have an exact-enough Pi built-in:
 *
 * | Upstream       | Pi      | Argument translation                         |
 * | :------------- | :------ | :------------------------------------------- |
 * | `read_file`    | `read`  | `Path` → `path`, `StartLine` → `offset`      |
 * | `write_file`   | `write` | `Path` → `path`, `Content` → `content`       |
 * | `edit_file`    | `edit`  | `Path`/`Target`/`Replacement` → one edit     |
 * | `run_command`  | `bash`  | `CommandLine` → `command`                    |
 *
 * Returns `undefined` when no safe rewrite exists (unknown name, a write with
 * `Append: true`, or one that would overwrite an existing file without an
 * explicit `Overwrite: true`). Other upstream tools (subagents, swarm,
 * schedule, …) are left untouched and will fail Pi's tool lookup if the model
 * calls them.
 */
export function mapAntigravityUpstreamToolCall(
  name: string,
  args: unknown,
): { name: string; arguments: JsonObject } | undefined {
  if (!antigravityUpstreamContractEnabled()) return undefined;
  if (!Object.prototype.hasOwnProperty.call(ANTIGRAVITY_UPSTREAM_TOOLS, name)) return undefined;

  const input = asRecord(args);
  switch (name) {
    case "read_file": {
      const path = asString(input.Path);
      if (path === undefined) return undefined;
      // Pi reads by line, not byte; continuing a byte-truncated read from line
      // one would loop, so leave those calls to fail explicitly upstream-side.
      const byteOffset = asNumber(input.ByteOffset);
      if (byteOffset !== undefined && byteOffset > 0) return undefined;
      const rawOffset = asNumber(input.StartLine);
      const offset = rawOffset !== undefined && rawOffset > 0 ? rawOffset : undefined;
      const endLine = asNumber(input.EndLine);
      const mapped: JsonObject = { path };
      if (offset !== undefined) mapped.offset = offset;
      if (endLine !== undefined) {
        const start = offset ?? 1;
        if (endLine >= start) mapped.limit = endLine - start + 1;
      }
      return { name: "read", arguments: mapped };
    }
    case "write_file": {
      // `write` always overwrites. Keep the upstream create-only semantics:
      // never bridge appends, and only overwrite when explicitly allowed or
      // when the file does not exist yet.
      if (input.Append === true) return undefined;
      const path = asString(input.Path);
      if (path === undefined) return undefined;
      if (input.Overwrite !== true && existsSync(path)) return undefined;
      return {
        name: "write",
        arguments: { path, content: asString(input.Content) ?? "" },
      };
    }
    case "edit_file": {
      const path = asString(input.Path);
      const target = asString(input.Target);
      if (path === undefined || target === undefined) return undefined;
      return {
        name: "edit",
        arguments: {
          path,
          edits: [{ oldText: target, newText: asString(input.Replacement) ?? "" }],
        },
      };
    }
    case "run_command": {
      // Pi has no task/background channel: a daemon or a short-wait command
      // would either hang or be killed at the timeout. Leave those untouched.
      if (input.IsDaemon === true) return undefined;
      const command = asString(input.CommandLine);
      if (command === undefined) return undefined;
      const waitMs = asNumber(input.WaitMsBeforeAsync);
      if (waitMs !== undefined && waitMs <= 1000) return undefined;
      const mapped: JsonObject = { command };
      if (waitMs !== undefined) mapped.timeout = Math.ceil(waitMs / 1000);
      return { name: "bash", arguments: mapped };
    }
    default:
      return undefined;
  }
}
