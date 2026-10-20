import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AccountStatus,
  UsageAccount,
  UsageMetric,
  UsageModelPool,
  UsageProviderAdapter,
  UsageQuotaBucket,
} from "pi-usage-core";
import { PROVIDER_ID } from "../models/models.js";
import { runWithDiagnostics } from "../diagnostics/diagnostics.js";
import { fetchAccountUsage, resolveApiKeyFromContext } from "./usage.js";
import type { AccountUsage } from "../types/types.js";

declare global {
  var __PI_USAGE__:
    | {
        register(adapter: UsageProviderAdapter): void;
        getAdapters(): UsageProviderAdapter[];
      }
    | undefined;
}

export function convertUsageToAccount(usage: AccountUsage): UsageAccount {
  const pools: UsageModelPool[] = [];

  for (const group of usage.groups) {
    const isGemini = /gemini/i.test(group.displayName);
    const isClaude = /claude|gpt/i.test(group.displayName);

    let poolId = group.displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    let modelKeys = [group.displayName.toLowerCase()];

    if (isGemini) {
      poolId = "gemini";
      modelKeys = ["gemini"];
    } else if (isClaude) {
      poolId = "claude-gpt";
      modelKeys = ["claude", "gpt"];
    }

    const buckets: UsageQuotaBucket[] = group.buckets.map((b) => {
      const remFraction = typeof b.remainingFraction === "number" ? b.remainingFraction : 1.0;
      const remaining = Math.round(remFraction * 100);
      const used = Math.max(0, 100 - remaining);
      const is5h = /five hour|5h/i.test(b.displayName) || /5h|five_hour/i.test(b.window || "");

      let resetsAt: number | undefined;
      if (b.resetTime) {
        const ts = Date.parse(b.resetTime);
        if (Number.isFinite(ts)) resetsAt = ts;
      }

      return {
        id: b.bucketId || b.displayName,
        label: b.displayName,
        period: is5h ? "5h" : "weekly",
        used,
        remaining,
        unit: "percent",
        resetsAt,
        isPrimary: is5h,
      };
    });

    const firstBucket = buckets[0];
    if (firstBucket && !buckets.some((b) => b.isPrimary)) {
      firstBucket.isPrimary = true;
    }

    pools.push({
      id: poolId,
      name: group.displayName,
      description: group.description,
      modelKeys,
      buckets,
    });
  }

  // Fallback: if groups is empty (e.g. free tier accounts without retrieveUserQuotaSummary access),
  // extract quota buckets from models catalog
  if (pools.length === 0 && usage.models.length > 0) {
    const geminiModels = usage.models.filter(
      (m) => m.modelId.startsWith("gemini") && m.remainingFraction !== undefined,
    );
    const claudeGptModels = usage.models.filter(
      (m) =>
        (m.modelId.startsWith("claude") || m.modelId.startsWith("gpt")) &&
        m.remainingFraction !== undefined,
    );

    const refGemini = geminiModels[0];
    if (refGemini) {
      const remFraction = refGemini.remainingFraction ?? 1.0;
      const remaining = Math.round(remFraction * 100);
      const used = Math.max(0, 100 - remaining);
      let resetsAt: number | undefined;
      if (refGemini.resetTime) {
        const ts = Date.parse(refGemini.resetTime);
        if (Number.isFinite(ts)) resetsAt = ts;
      }
      pools.push({
        id: "gemini",
        name: "Gemini Models",
        modelKeys: ["gemini"],
        buckets: [
          {
            id: "gemini-shared",
            label: "Gemini Pool",
            period: "5h",
            used,
            remaining,
            unit: "percent",
            resetsAt,
            isPrimary: true,
          },
        ],
      });
    }

    const refClaudeGpt = claudeGptModels[0];
    if (refClaudeGpt) {
      const remFraction = refClaudeGpt.remainingFraction ?? 1.0;
      const remaining = Math.round(remFraction * 100);
      const used = Math.max(0, 100 - remaining);
      let resetsAt: number | undefined;
      if (refClaudeGpt.resetTime) {
        const ts = Date.parse(refClaudeGpt.resetTime);
        if (Number.isFinite(ts)) resetsAt = ts;
      }
      pools.push({
        id: "claude-gpt",
        name: "Claude & GPT Models",
        modelKeys: ["claude", "gpt"],
        buckets: [
          {
            id: "claude-gpt-shared",
            label: "Claude & GPT Pool",
            period: "5h",
            used,
            remaining,
            unit: "percent",
            resetsAt,
            isPrimary: true,
          },
        ],
      });
    }
  }

  const metrics: UsageMetric[] = [];
  const planLabel = usage.planLabel || usage.paidTier?.name || usage.productTier?.name;
  if (planLabel) {
    metrics.push({
      id: "plan-tier",
      label: "Plan",
      value: planLabel,
    });
  }
  if (usage.defaultAgentModelId) {
    metrics.push({
      id: "default-model",
      label: "Default Model",
      value: usage.defaultAgentModelId,
    });
  }

  const hasPools = pools.length > 0;
  const isError = !hasPools && Boolean(usage.quotaSummaryError);
  const status: AccountStatus = isError ? "error" : "ready";
  const errorMessage = isError ? usage.quotaSummaryError : undefined;

  return {
    id: usage.projectId || "antigravity-active",
    name: "Account",
    email: usage.email,
    status,
    errorMessage,
    isActive: true,
    lastUpdated: usage.fetchedAt || Date.now(),
    pools,
    metrics,
  };
}

export function createAntigravityUsageAdapter(): UsageProviderAdapter {
  return {
    id: PROVIDER_ID,
    displayName: "Google Antigravity",

    async getAccounts(ctx: ExtensionContext): Promise<UsageAccount[]> {
      const apiKey = await resolveApiKeyFromContext(ctx);
      if (!apiKey) {
        return [
          {
            id: "antigravity-default",
            name: "Google Antigravity",
            status: "auth-required",
            errorMessage: "No Antigravity credentials found. Run /login antigravity first.",
            pools: [],
            lastUpdated: Date.now(),
          },
        ];
      }

      try {
        const usage = await runWithDiagnostics(() => fetchAccountUsage(apiKey));
        return [convertUsageToAccount(usage)];
      } catch (err) {
        return [
          {
            id: "antigravity-error",
            name: "Google Antigravity",
            status: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
            pools: [],
            lastUpdated: Date.now(),
          },
        ];
      }
    },

    async refresh(ctx: ExtensionContext): Promise<UsageAccount[]> {
      return this.getAccounts(ctx);
    },
  };
}

export function registerAntigravityUsageAdapter(pi: ExtensionAPI): UsageProviderAdapter {
  const adapter = createAntigravityUsageAdapter();

  pi.events.emit("pi-usage:register", adapter);

  pi.events.on("pi-usage:discover", () => {
    pi.events.emit("pi-usage:register", adapter);
  });

  if (globalThis.__PI_USAGE__?.register) {
    globalThis.__PI_USAGE__.register(adapter);
  }

  pi.on("session_start", () => {
    pi.events.emit("pi-usage:register", adapter);
  });

  return adapter;
}
