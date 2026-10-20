/**
 * Vendored from Rahularya01/pi-antigravity@0.6.0 (main 855c5fce, MIT).
 * Local patches on top of upstream:
 * - refreshAntigravityToken accepts and forwards the AbortSignal from Pi's
 *   refreshToken(credentials, signal) contract (pi 0.84+).
 * - redactSecrets also matches Google refresh tokens in the "1//04…"
 *   double-slash spelling (upstream regex only matched "1/04…").
 * Upgrade: diff upstream src/ against this directory and re-apply local patches,
 * then run `npx tsc -p .pi/extensions/tsconfig.json --noEmit && npm run test:extensions`.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import {
  accountTokenExpired,
  getActiveAccount,
  getApiKey,
  loadAccountsState,
  loginAntigravity,
  refreshAntigravityToken,
  removeAccount,
  switchActiveAccount,
} from "./auth/index.js";
import { DEFAULT_ENDPOINT, endpointCandidates } from "./client/index.js";
import {
  getLastAccountFailover,
  getLastDiagnostics,
  runWithDiagnostics,
} from "./diagnostics/index.js";
import {
  DEFAULT_IMAGE_MODEL,
  generateAntigravityImage,
  IMAGE_ASPECT_RATIOS,
  parseImageCommandArgs,
} from "./image/index.js";
import { ANTIGRAVITY_MODELS, PROVIDER_ID, PROVIDER_NAME } from "./models/index.js";
import { ANTIGRAVITY_API, streamAntigravity } from "./stream/index.js";
import {
  fetchAccountUsage,
  formatModelsList,
  registerAntigravityUsageAdapter,
  resolveApiKeyFromContext,
} from "./usage/index.js";
import { maskEmail, prewarmConnection, redactSecrets } from "./utils/index.js";

function formatTimeDistance(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp)) return "unknown";
  const minutes = Math.max(0, Math.round((now - timestamp) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Pi's interactive `notify` writes into the chat transcript. `console.log` in that
 * mode prints to the raw terminal and paints over the TUI. Use one channel only.
 */
function emitCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") console.error(text);
  else console.log(text);
}

async function withUsage(
  ctx: ExtensionCommandContext,
  fn: (usage: Awaited<ReturnType<typeof fetchAccountUsage>>) => string,
): Promise<void> {
  try {
    const apiKey = await resolveApiKeyFromContext(ctx);
    if (!apiKey) {
      emitCommandOutput(
        ctx,
        "No Antigravity credentials. Run /login antigravity first.",
        "warning",
      );
      return;
    }
    if (ctx.hasUI) ctx.ui.notify("Fetching Antigravity usage…", "info");
    const usage = await runWithDiagnostics(() => fetchAccountUsage(apiKey));
    emitCommandOutput(ctx, fn(usage));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emitCommandOutput(ctx, `Antigravity usage failed: ${msg}`, "warning");
  }
}

export default function (pi: ExtensionAPI): void {
  // Open the TLS connection up front so the first message of a session does not pay
  // the handshake. Opt out with ANTIGRAVITY_NO_PREWARM=1.
  const primaryEndpoint = endpointCandidates()[0];
  if (primaryEndpoint) prewarmConnection(primaryEndpoint);

  registerApiProvider({
    api: ANTIGRAVITY_API,
    stream: streamAntigravity,
    streamSimple: streamAntigravity,
  });

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: ANTIGRAVITY_API,
    models: ANTIGRAVITY_MODELS,
    oauth: {
      name: PROVIDER_NAME,
      login: loginAntigravity,
      refreshToken: refreshAntigravityToken,
      getApiKey,
    },
    streamSimple: streamAntigravity,
  });

  registerAntigravityUsageAdapter(pi);

  pi.registerCommand("antigravity.models", {
    description: "List Antigravity runtime models + remaining pool fraction",
    handler: async (args, ctx) => {
      const all = /\ball\b/i.test(args || "");
      await withUsage(ctx, (usage) => formatModelsList(usage, { all }));
    },
  });

  pi.registerCommand("antigravity.doctor", {
    description: "Show sanitized Antigravity provider diagnostics",
    handler: async (_args, ctx) => {
      const d = getLastDiagnostics();
      const failover = getLastAccountFailover();
      const lines = [
        `provider=${PROVIDER_ID}`,
        `lastResolvedRuntimeModel=${d.resolvedRuntimeModel || "none"}`,
        `availableModels=${d.availableModels || "none"}`,
        `matchedModel=${d.matchedModelDebug || "none"}`,
        `lastEndpoint=${d.endpoint || "none"}`,
        `lastStatus=${d.status ?? "none"}`,
        `lastProjectId=${d.projectId || "none"}`,
        ...(failover
          ? [
              `accountFailover=${maskEmail(failover.from) ?? "unknown"} -> ${
                maskEmail(failover.to) ?? "unknown"
              }`,
            ]
          : []),
        ...(d.latencyMs !== undefined ? [`lastLatencyMs=${d.latencyMs}`] : []),
        `lastError=${d.error ? redactSecrets(d.error) : "none"}`,
        "transport=native-streamSimple",
        "runtimeCli=not-used",
        "commands=/antigravity.models /antigravity.doctor /antigravity.accounts /antigravity.image",
      ];
      emitCommandOutput(ctx, `Antigravity doctor\n${lines.join("\n")}`);
    },
  });

  pi.registerCommand("antigravity.accounts", {
    description: "List saved Antigravity accounts; switch active / remove (interactive)",
    handler: async (_args, ctx) => {
      const state = loadAccountsState();
      if (!state.accounts.length) {
        emitCommandOutput(
          ctx,
          "No saved Antigravity accounts. Run /login antigravity to add one.",
          "warning",
        );
        return;
      }
      const active = getActiveAccount();
      const activeEmail = active?.email;
      const now = Date.now();
      const lines = state.accounts.map((account) => {
        const marker = account.email === activeEmail ? "✓" : " ";
        const tokenState = accountTokenExpired(account) ? "expired" : "ready";
        return `${marker} ${account.email}  ·  ${tokenState} token · project ${account.projectId} · added ${formatTimeDistance(account.addedAt, now)} ago · last used ${formatTimeDistance(account.lastUsedAt, now)} ago`;
      });
      emitCommandOutput(ctx, `Antigravity accounts\n${lines.join("\n")}`);
      if (!ctx.hasUI) return;

      // Interactive maintenance menu (labels map back to actions by index).
      const switchCandidates = state.accounts
        .filter((account) => account.email !== activeEmail)
        .map((account) => ({ label: `Switch to ${account.email}`, email: account.email }));
      const options: string[] = [
        "Add another Google account (via /login)",
        ...switchCandidates.map((entry) => entry.label),
      ];
      if (state.accounts.length > 1) {
        options.push("Remove an account…");
      }
      const choice = await ctx.ui.select("Antigravity accounts", options);
      if (!choice) return;
      if (choice.startsWith("Add another Google account")) {
        emitCommandOutput(
          ctx,
          "Run /login antigravity and pick \"Add another Google account\" in the login menu.",
        );
        return;
      }
      const switchTarget = switchCandidates.find((entry) => entry.label === choice);
      if (switchTarget) {
        try {
          await switchActiveAccount(switchTarget.email);
          emitCommandOutput(ctx, `Active Antigravity account: ${switchTarget.email}`);
        } catch (error) {
          emitCommandOutput(
            ctx,
            `Failed to switch account: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }
      if (choice.startsWith("Remove an account")) {
        const removable = state.accounts.map((account) => account.email);
        const target = await ctx.ui.select("Remove which account?", removable);
        if (!target) return;
        if (target === activeEmail) {
          const confirmed = await ctx.ui.confirm(
            "Remove the active account?",
            "Pi will switch to the next saved Antigravity account.",
          );
          if (!confirmed) return;
        }
        const removed = await removeAccount(target);
        if (removed) {
          // Re-read: the pre-removal snapshot no longer describes the next active account.
          const nextActive = loadAccountsState().activeEmail;
          emitCommandOutput(
            ctx,
            `Removed ${target}.${nextActive ? ` Active account: ${nextActive}` : " No accounts left. Run /login antigravity."}`,
          );
        } else {
          emitCommandOutput(ctx, `Account ${target} not found.`, "warning");
        }
      }
    },
  });

  pi.registerCommand("antigravity.image", {
    description:
      "Generate an image via Antigravity (usage: /antigravity.image [--ratio 16:9] <prompt>)",
    handler: async (args, ctx) => {
      const parsed = parseImageCommandArgs(args || "");
      if (!parsed.prompt) {
        emitCommandOutput(
          ctx,
          "Usage: /antigravity.image [--ratio 16:9] [--model gemini-3.1-flash-image] [--path file.png] <prompt>",
          "warning",
        );
        return;
      }
      try {
        const apiKey = await resolveApiKeyFromContext(ctx);
        if (!apiKey) {
          emitCommandOutput(
            ctx,
            "No Antigravity credentials. Run /login antigravity first.",
            "warning",
          );
          return;
        }
        if (ctx.hasUI) ctx.ui.notify("Generating Antigravity image…", "info");
        const result = await generateAntigravityImage({
          apiKey,
          cwd: ctx.cwd,
          prompt: parsed.prompt,
          aspectRatio: parsed.aspectRatio,
          model: parsed.model,
          path: parsed.path,
        });
        emitCommandOutput(ctx, `Saved image to ${result.savedPaths.join(", ")}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Antigravity image failed: ${redactSecrets(msg)}`, "warning");
      }
    },
  });

  pi.registerTool({
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate an image via Antigravity using the signed-in Google account. Saves under .pi/generated-images/ unless path is set.",
    promptSnippet: "Generate images via Antigravity OAuth (Gemini image models)",
    promptGuidelines: [
      "Use generate_image when the user asks to create, draw, or generate an image.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Image description." }),
      aspectRatio: Type.Optional(StringEnum(IMAGE_ASPECT_RATIOS)),
      model: Type.Optional(
        Type.String({
          description: `Image model id. Default: ${DEFAULT_IMAGE_MODEL}.`,
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "Project-relative file or directory to save the image.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) {
        throw new Error("No Antigravity credentials. Run /login antigravity first.");
      }
      onUpdate?.({ content: [{ type: "text", text: "Generating image…" }], details: {} });
      const result = await generateAntigravityImage({
        apiKey,
        cwd: ctx.cwd,
        prompt: params.prompt,
        aspectRatio: params.aspectRatio,
        model: params.model,
        path: params.path,
        signal,
      });
      const notes = result.text.join(" ").trim();
      return {
        content: [
          {
            type: "text" as const,
            text: `Saved image to ${result.savedPaths.join(", ")}${notes ? `. ${notes}` : ""}`,
          },
          ...result.images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
        details: { model: result.model, savedPaths: result.savedPaths },
      };
    },
  });
}
