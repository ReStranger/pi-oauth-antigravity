import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertUsageToAccount,
  createAntigravityUsageAdapter,
  registerAntigravityUsageAdapter,
} from "../src/usage/adapter.js";
import type { AccountUsage } from "../src/types/types.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

test("convertUsageToAccount maps quota groups into UsageModelPools and primary buckets", () => {
  const usage: AccountUsage = {
    projectId: "proj-123",
    endpoint: "https://cloudcode-pa.googleapis.com",
    email: "dev@example.com",
    productTier: { name: "Standard" },
    paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
    planLabel: "Google AI Pro (g1-pro-tier)",
    groups: [
      {
        displayName: "Gemini Models",
        description: "Shared pool for Gemini models",
        buckets: [
          {
            bucketId: "gemini-5h",
            displayName: "Session (5h)",
            remainingFraction: 0.75,
            resetTime: "2026-03-30T16:00:00Z",
            window: "FIVE_HOURS",
          },
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Quota",
            remainingFraction: 0.9,
            resetTime: "2026-04-05T00:00:00Z",
            window: "WEEKLY",
          },
        ],
      },
      {
        displayName: "Claude & GPT Models",
        description: "Shared pool for Claude & GPT",
        buckets: [
          {
            bucketId: "claude-5h",
            displayName: "Session (5h)",
            remainingFraction: 0.4,
            resetTime: "2026-03-30T17:30:00Z",
          },
        ],
      },
    ],
    models: [],
    defaultAgentModelId: "gemini-3.8-flash",
    fetchedAt: 1700000000000,
  };

  const account = convertUsageToAccount(usage);

  assert.equal(account.id, "proj-123");
  assert.equal(account.name, "Account");
  assert.equal(account.email, "dev@example.com");
  assert.equal(account.status, "ready");
  assert.equal(account.isActive, true);
  assert.equal(account.pools.length, 2);

  // Gemini Pool
  const geminiPool = account.pools.find((p) => p.id === "gemini");
  assert.ok(geminiPool);
  assert.deepEqual(geminiPool.modelKeys, ["gemini"]);
  assert.equal(geminiPool.buckets.length, 2);

  const gemini5h = geminiPool.buckets.find((b) => b.id === "gemini-5h");
  assert.ok(gemini5h);
  assert.equal(gemini5h.remaining, 75);
  assert.equal(gemini5h.used, 25);
  assert.equal(gemini5h.period, "5h");
  assert.equal(gemini5h.isPrimary, true);
  assert.equal(gemini5h.resetsAt, Date.parse("2026-03-30T16:00:00Z"));

  const geminiWeekly = geminiPool.buckets.find((b) => b.id === "gemini-weekly");
  assert.ok(geminiWeekly);
  assert.equal(geminiWeekly.remaining, 90);
  assert.equal(geminiWeekly.used, 10);
  assert.equal(geminiWeekly.period, "weekly");
  assert.equal(geminiWeekly.isPrimary, false);

  // Claude & GPT Pool
  const claudePool = account.pools.find((p) => p.id === "claude-gpt");
  assert.ok(claudePool);
  assert.deepEqual(claudePool.modelKeys, ["claude", "gpt"]);
  const claude5h = claudePool.buckets[0];
  assert.ok(claude5h);
  assert.equal(claude5h.remaining, 40);
  assert.equal(claude5h.used, 60);
  assert.equal(claude5h.isPrimary, true);

  // Metrics
  assert.ok(account.metrics?.some((m) => m.id === "plan-tier" && m.value === "Google AI Pro (g1-pro-tier)"));
  assert.ok(account.metrics?.some((m) => m.id === "default-model" && m.value === "gemini-3.8-flash"));
});

test("convertUsageToAccount synthesizes pools from models when quota groups are empty (e.g. Free Tier)", () => {
  const usage: AccountUsage = {
    projectId: "free-proj",
    endpoint: "https://cloudcode-pa.googleapis.com",
    groups: [],
    quotaSummaryError: "403 SUBSCRIPTION_REQUIRED",
    models: [
      {
        modelId: "gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        remainingFraction: 0.8,
        resetTime: "2026-03-30T18:00:00Z",
      },
      {
        modelId: "claude-sonnet-4-6",
        displayName: "Claude Sonnet",
        remainingFraction: 0.5,
        resetTime: "2026-03-30T19:00:00Z",
      },
    ],
    fetchedAt: 1700000000000,
  };

  const account = convertUsageToAccount(usage);
  assert.equal(account.id, "free-proj");
  assert.equal(account.pools.length, 2);

  const gemini = account.pools.find((p) => p.id === "gemini");
  assert.ok(gemini);
  assert.equal(gemini.buckets[0]?.remaining, 80);
  assert.equal(gemini.buckets[0]?.used, 20);
  assert.equal(gemini.buckets[0]?.isPrimary, true);

  const claude = account.pools.find((p) => p.id === "claude-gpt");
  assert.ok(claude);
  assert.equal(claude.buckets[0]?.remaining, 50);
  assert.equal(claude.buckets[0]?.used, 50);
  assert.equal(claude.buckets[0]?.isPrimary, true);
});

test("createAntigravityUsageAdapter returns auth-required when no credentials exist", async () => {
  const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-usage-test-"));
  const prevEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
  try {
    const adapter = createAntigravityUsageAdapter();
    assert.equal(adapter.id, "antigravity");
    assert.equal(adapter.displayName, "Google Antigravity");

    const mockCtx = {
      modelRegistry: {
        getApiKeyForProvider: async () => undefined,
      },
    } as unknown as ExtensionContext;

    const accounts = await adapter.getAccounts(mockCtx);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.status, "auth-required");
    assert.match(accounts[0]?.errorMessage ?? "", /Run \/login antigravity/);
  } finally {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevEnv;
    rmSync(tmpAgentDir, { recursive: true, force: true });
  }
});

test("registerAntigravityUsageAdapter registers on event bus, discover, and global bridge", () => {
  const emittedEvents: Array<{ name: string; data: unknown }> = [];
  const eventListeners = new Map<string, Array<(data: unknown) => void>>();
  const lifecycleListeners = new Map<string, Array<() => void>>();

  const mockPi = {
    events: {
      emit: (name: string, data: unknown) => {
        emittedEvents.push({ name, data });
      },
      on: (name: string, cb: (data: unknown) => void) => {
        const list = eventListeners.get(name) || [];
        list.push(cb);
        eventListeners.set(name, list);
        return () => {};
      },
    },
    on: (event: string, cb: () => void) => {
      const list = lifecycleListeners.get(event) || [];
      list.push(cb);
      lifecycleListeners.set(event, list);
    },
  } as unknown as ExtensionAPI;

  let globalRegistered = false;
  globalThis.__PI_USAGE__ = {
    register: () => {
      globalRegistered = true;
    },
    getAdapters: () => [],
  };

  const adapter = registerAntigravityUsageAdapter(mockPi);
  assert.equal(adapter.id, "antigravity");

  // Initial emit on bus
  assert.equal(emittedEvents.some((e) => e.name === "pi-usage:register" && e.data === adapter), true);

  // Global bridge registered
  assert.equal(globalRegistered, true);

  // Discovery callback emits register again
  const discoverHandlers = eventListeners.get("pi-usage:discover") || [];
  assert.equal(discoverHandlers.length, 1);
  const beforeCount = emittedEvents.length;
  discoverHandlers[0]?.(undefined);
  assert.equal(emittedEvents.length, beforeCount + 1);

  // session_start callback emits register again
  const sessionStartHandlers = lifecycleListeners.get("session_start") || [];
  assert.equal(sessionStartHandlers.length, 1);
  sessionStartHandlers[0]?.();
  assert.equal(emittedEvents.length, beforeCount + 2);

  // Cleanup
  delete (globalThis as Record<string, unknown>).__PI_USAGE__;
});
