import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountTokenExpired,
  credentialsFromAccount,
  getAccountByEmail,
  getActiveAccount,
  loadAccountsState,
  removeAccount,
  resolveAccountEmail,
  saveAccountsState,
  switchActiveAccount,
  upsertAccount,
} from "../src/auth/accounts.js";
import { activateAccountForMenu, refreshAccount } from "../src/auth/oauth.js";
import { createAntigravityUsageAdapter } from "../src/usage/adapter.js";
import { ANTIGRAVITY_API, isPlanQuotaError, streamAntigravity } from "../src/stream/stream.js";
import { DEFAULT_ENDPOINT } from "../src/client/client.js";
import { PROVIDER_ID } from "../src/models/models.js";
import type { AntigravityAccount, AntigravityAccountsState } from "../src/types/types.js";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";

/** Point accounts/auth.json paths at a throwaway agent dir for one test. */
function useTestAgentDir(): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-accounts-test-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  // A developer's ANTIGRAVITY_ACCOUNTS_FILE would otherwise redirect these tests
  // at a real account store.
  const prevAccountsFile = process.env.ANTIGRAVITY_ACCOUNTS_FILE;
  const prevNoagyAccountsFile = process.env.NOAGY_ACCOUNTS_FILE;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.ANTIGRAVITY_ACCOUNTS_FILE;
  delete process.env.NOAGY_ACCOUNTS_FILE;
  return {
    dir,
    restore: () => {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      if (prevAccountsFile === undefined) delete process.env.ANTIGRAVITY_ACCOUNTS_FILE;
      else process.env.ANTIGRAVITY_ACCOUNTS_FILE = prevAccountsFile;
      if (prevNoagyAccountsFile === undefined) delete process.env.NOAGY_ACCOUNTS_FILE;
      else process.env.NOAGY_ACCOUNTS_FILE = prevNoagyAccountsFile;
    },
  };
}

function makeAccount(email: string, overrides: Partial<AntigravityAccount> = {}): AntigravityAccount {
  const now = Date.now();
  return {
    email,
    refresh: `refresh-${email}`,
    access: `access-${email}`,
    expires: now + 60 * 60 * 1000,
    projectId: `project-${email.split("@")[0]}`,
    addedAt: now,
    lastUsedAt: now,
    ...overrides,
  };
}

function readAgentJson(dir: string, file: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(join(dir, file), "utf-8")) as unknown;
  return (parsed ?? {}) as Record<string, unknown>;
}

async function withFetchStub(
  respond: (url: string, call: number) => Response,
  fn: (calls: string[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    calls.push(url);
    return respond(url, calls.length);
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function okEndpoint(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("loadAccountsState migrates the legacy auth.json credential once", () => {
  const env = useTestAgentDir();
  try {
    writeFileSync(
      join(env.dir, "auth.json"),
      JSON.stringify({
        antigravity: {
          access: "legacy-access",
          refresh: "legacy-refresh",
          expires: Date.now() + 120000,
          projectId: "legacy-proj",
          email: "legacy@example.com",
        },
      }),
      "utf-8",
    );

    const state = loadAccountsState();
    assert.equal(state.accounts.length, 1);
    assert.equal(state.activeEmail, "legacy@example.com");
    const account = state.accounts[0] as AntigravityAccount;
    assert.equal(account.access, "legacy-access");
    assert.equal(account.refresh, "legacy-refresh");
    assert.equal(account.projectId, "legacy-proj");
    assert.ok(account.addedAt > 0);

    // Sync back keeps Pi's credential store usable right after migration.
    const mirrored = readAgentJson(env.dir, "auth.json") as Record<string, Record<string, unknown>>;
    assert.equal(mirrored.antigravity?.email, "legacy@example.com");
    assert.equal(mirrored.antigravity?.type, "oauth");

    assert.ok(existsSync(join(env.dir, "antigravity-accounts.json")));
  } finally {
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("upsertAccount adds, replaces, and keeps addedAt for known emails", async () => {
  const env = useTestAgentDir();
  try {
    await upsertAccount(makeAccount("one@example.com"), { setActive: true });
    assert.equal(getActiveAccount()?.email, "one@example.com");

    await upsertAccount(makeAccount("two@example.com"), { setActive: false });
    let state = loadAccountsState();
    assert.equal(state.accounts.length, 2);
    assert.equal(state.activeEmail, "one@example.com");

    const addedAtBefore = (
      loadAccountsState().accounts.find((a) => a.email === "two@example.com") as AntigravityAccount
    ).addedAt;
    await upsertAccount(makeAccount("two@example.com", { access: "rotated-access" }), {
      setActive: true,
    });
    state = loadAccountsState();
    const replaced = state.accounts.find((a) => a.email === "two@example.com") as AntigravityAccount;
    assert.equal(replaced.access, "rotated-access");
    assert.equal(replaced.addedAt, addedAtBefore);
    assert.equal(state.activeEmail, "two@example.com");
  } finally {
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("switchActiveAccount updates state and mirrors into auth.json", async () => {
  const env = useTestAgentDir();
  try {
    await upsertAccount(makeAccount("a@example.com"), { setActive: true });
    await upsertAccount(makeAccount("b@example.com"), { setActive: false });

    const switched = await switchActiveAccount("b@example.com");
    assert.equal(switched.email, "b@example.com");
    assert.equal(loadAccountsState().activeEmail, "b@example.com");

    const mirrored = readAgentJson(env.dir, "auth.json") as Record<string, Record<string, unknown>>;
    assert.equal(mirrored.antigravity?.email, "b@example.com");
    assert.equal(mirrored.antigravity?.access, "access-b@example.com");
    assert.equal(mirrored.antigravity?.type, "oauth");

    await assert.rejects(() => switchActiveAccount("missing@example.com"), /not found/);
  } finally {
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("a corrupt auth.json is never overwritten", async () => {
  const env = useTestAgentDir();
  try {
    const corrupt = '{"openai":{"type":"oauth","access":"keep-me"';
    writeFileSync(join(env.dir, "auth.json"), corrupt, "utf-8");

    await upsertAccount(makeAccount("a@example.com"), { setActive: true });

    // Renaming this file would delete every other provider's credentials, so it
    // must stay untouched even though the account was saved elsewhere.
    assert.equal(readFileSync(join(env.dir, "auth.json"), "utf-8"), corrupt);
    assert.equal(loadAccountsState().activeEmail, "a@example.com");
  } finally {
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("refreshing a secondary account leaves auth.json untouched", async () => {
  const env = useTestAgentDir();
  try {
    await upsertAccount(makeAccount("a@example.com"), { setActive: true });
    await upsertAccount(makeAccount("b@example.com", { expires: Date.now() - 60_000 }), {
      setActive: false,
    });
    // Pi owns auth.json for the active account; give it a token the store does not
    // have so any rewrite by the secondary refresh is observable.
    writeFileSync(
      join(env.dir, "auth.json"),
      JSON.stringify({
        antigravity: {
          type: "oauth",
          email: "a@example.com",
          access: "pi-owned-access",
          refresh: "pi-owned-refresh",
          expires: Date.now() + 3600_000,
          projectId: "project-a",
        },
      }),
      "utf-8",
    );

    await withFetchStub(
      () => okEndpoint({ access_token: "rotated-b", expires_in: 3600 }),
      async () => {
        const beta = loadAccountsState().accounts.find(
          (account) => account.email === "b@example.com",
        ) as AntigravityAccount;
        const refreshed = await refreshAccount(beta);
        assert.equal(refreshed.access, "rotated-b");
      },
    );

    // Only the active credential is mirrored into Pi's auth.json.
    const mirrored = readAgentJson(env.dir, "auth.json") as Record<string, Record<string, unknown>>;
    assert.equal(mirrored.antigravity?.access, "pi-owned-access");
    assert.equal(loadAccountsState().activeEmail, "a@example.com");
  } finally {
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("accounts without timestamps are normalized on load", () => {
  const env = useTestAgentDir();
  try {
    writeFileSync(
      join(env.dir, "antigravity-accounts.json"),
      JSON.stringify({
        activeEmail: "a@example.com",
        accounts: [
          {
            email: "a@example.com",
            refresh: "r",
            access: "a",
            expires: Date.now() + 3600_000,
            projectId: "p",
          },
        ],
      }),
      "utf-8",
    );

    const account = loadAccountsState().accounts[0] as AntigravityAccount;
    assert.ok(Number.isFinite(account.addedAt));
    assert.equal(account.lastUsedAt, account.addedAt);
  } finally {
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("menu activation refreshes an expired saved account", async () => {
  const env = useTestAgentDir();
  try {
    await upsertAccount(makeAccount("a@example.com"), { setActive: true });
    await upsertAccount(makeAccount("b@example.com", { expires: Date.now() - 60_000 }), {
      setActive: false,
    });

    await withFetchStub(
      () => okEndpoint({ access_token: "rotated-b", expires_in: 3600 }),
      async () => {
        const account = await activateAccountForMenu("b@example.com");
        assert.ok(account);
        assert.equal(account.access, "rotated-b");
        assert.equal(loadAccountsState().activeEmail, "b@example.com");
        assert.equal(getAccountByEmail("b@example.com")?.access, "rotated-b");
      },
    );
  } finally {
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("menu activation reports a dead refresh token instead of returning stale credentials", async () => {
  const env = useTestAgentDir();
  try {
    await upsertAccount(makeAccount("a@example.com"), { setActive: true });
    await upsertAccount(makeAccount("dead@example.com", { expires: Date.now() - 60_000 }), {
      setActive: false,
    });

    await withFetchStub(
      () => new Response("invalid_grant", { status: 400 }),
      async () => {
        assert.equal(await activateAccountForMenu("dead@example.com"), undefined);
        // A failed refresh must not move Pi onto the unusable account.
        assert.equal(loadAccountsState().activeEmail, "a@example.com");
      },
    );

    await assert.rejects(() => activateAccountForMenu("missing@example.com"), /not found/);
  } finally {
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("removeAccount promotes the next account and clears auth.json when empty", async () => {
  const env = useTestAgentDir();
  try {
    await upsertAccount(makeAccount("a@example.com"), { setActive: true });
    await upsertAccount(makeAccount("b@example.com"), { setActive: false });

    assert.equal(await removeAccount("unknown@example.com"), false);

    // Removing the active account promotes the next remaining one.
    assert.equal(await removeAccount("a@example.com"), true);
    const state = loadAccountsState();
    assert.equal(state.accounts.length, 1);
    assert.equal(state.activeEmail, "b@example.com");
    const mirrored = readAgentJson(env.dir, "auth.json") as Record<string, Record<string, unknown>>;
    assert.equal(mirrored.antigravity?.email, "b@example.com");

    // Last removal leaves no antigravity credential in auth.json.
    assert.equal(await removeAccount("b@example.com"), true);
    assert.equal(loadAccountsState().accounts.length, 0);
    const cleared = readAgentJson(env.dir, "auth.json");
    assert.equal(cleared.antigravity, undefined);
  } finally {
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

const USAGE_RESPONSE = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-5h",
          displayName: "Session (5h)",
          remainingFraction: 0.5,
          window: "FIVE_HOURS",
        },
      ],
    },
  ],
  models: { "gemini-3.5-flash": { quotaInfo: { remainingFraction: 0.9 } } },
  paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
};

test("adapter getAccounts returns every account with the active flag", async () => {
  const env = useTestAgentDir();
  try {
    const alpha = makeAccount("a@example.com", { projectId: "proj-a" });
    const beta = makeAccount("b@example.com", { projectId: "proj-b" });
    saveAccountsState({ activeEmail: "b@example.com", accounts: [alpha, beta] });

    await withFetchStub(() => okEndpoint(USAGE_RESPONSE), async () => {
      const adapter = createAntigravityUsageAdapter();
      const accounts = await adapter.getAccounts({} as unknown as ExtensionContext);

      assert.equal(accounts.length, 2);
      const alphaEntry = accounts.find((a) => a.email === "a@example.com");
      const betaEntry = accounts.find((a) => a.email === "b@example.com");
      assert.ok(alphaEntry);
      assert.ok(betaEntry);
      assert.equal(alphaEntry.id, "a@example.com");
      assert.equal(betaEntry.id, "b@example.com");
      assert.equal(alphaEntry.name, "a@example.com");
      assert.equal(betaEntry.isActive, true);
      assert.equal(alphaEntry.isActive, false);
      assert.equal(betaEntry.status, "ready");
      assert.ok((betaEntry.pools.length ?? 0) >= 1);
    });
  } finally {
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("adapter getAccounts flags auth-required when a refresh token is revoked", async () => {
  const env = useTestAgentDir();
  try {
    const dead = makeAccount("dead@example.com", { expires: Date.now() - 60000 });
    saveAccountsState({ activeEmail: "dead@example.com", accounts: [dead] });

    await withFetchStub((url, call) => {
      // Token refresh endpoint rejects: revoked refresh token.
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response("invalid_grant", { status: 400 });
      }
      void call;
      return okEndpoint(USAGE_RESPONSE);
    }, async () => {
      const adapter = createAntigravityUsageAdapter();
      const accounts = await adapter.getAccounts({} as unknown as ExtensionContext);
      assert.equal(accounts.length, 1);
      const entry = accounts[0];
      assert.ok(entry);
      assert.equal(entry.email, "dead@example.com");
      assert.equal(entry.status, "auth-required");
      assert.match(entry.errorMessage ?? "", /Token refresh failed/);
    });
  } finally {
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("refreshAccount rotates tokens without changing the active account", async () => {
  const env = useTestAgentDir();
  try {
    const alpha = makeAccount("a@example.com", { expires: Date.now() - 60 * 1000 });
    const beta = makeAccount("b@example.com", { expires: Date.now() + 60 * 60 * 1000 });
    saveAccountsState({ activeEmail: "b@example.com", accounts: [alpha, beta] });

    await withFetchStub(
      () =>
        new Response(JSON.stringify({ access_token: "rotated-access", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      async () => {
        const refreshed = await refreshAccount(alpha);
        assert.equal(refreshed.access, "rotated-access");
        assert.equal(accountTokenExpired(refreshed), false);

        const state = loadAccountsState();
        assert.equal(state.activeEmail, "b@example.com");
        const updated = state.accounts.find((a) => a.email === "a@example.com") as AntigravityAccount;
        assert.equal(updated.access, "rotated-access");

        const credential = credentialsFromAccount(updated);
        assert.equal(credential.type, "oauth");
        assert.equal(credential.refresh, "refresh-a@example.com");
      },
    );
  } finally {
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

const STREAM_OK_SSE =
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n';

function fakeModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: ANTIGRAVITY_API,
    provider: PROVIDER_ID,
    baseUrl: DEFAULT_ENDPOINT,
    contextWindow: 1_048_576,
    maxTokens: 65536,
  } as unknown as Model<Api>;
}

async function streamOnce(apiKey: string, sessionId: string): Promise<{
  stopReason: string;
  errorMessage?: string;
}> {
  const stream = streamAntigravity(
    fakeModel("gemini-3.8-flash"),
    normalizeContext({
      systemPrompt: "You are pi.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    } as never),
    {
      apiKey,
      sessionId,
      reasoning: "high",
    } as never,
  );
  return (await stream.result()) as { stopReason: string; errorMessage?: string };
}

function planQuotaResponse(): Response {
  return new Response(
    "Individual quota reached. Please upgrade your subscription. Resets in 3h0m0s.",
    { status: 429, headers: { "content-type": "text/plain" } },
  );
}

test("resolveAccountEmail resolves by email, token, unique projectId, or activeEmail", () => {
  const alpha = makeAccount("a@example.com", { projectId: "aicode-consumers" });
  const beta = makeAccount("b@example.com", { projectId: "aicode-consumers" });
  const state: AntigravityAccountsState = {
    activeEmail: "a@example.com",
    accounts: [alpha, beta],
  };

  // Direct email match
  assert.equal(
    resolveAccountEmail({ email: "b@example.com", projectId: "aicode-consumers" }, state),
    "b@example.com",
  );

  // Match by access token
  assert.equal(
    resolveAccountEmail({ token: alpha.access, projectId: "aicode-consumers" }, state),
    "a@example.com",
  );

  // Fallback to activeEmail when multiple accounts share the same projectId
  assert.equal(
    resolveAccountEmail({ projectId: "aicode-consumers" }, state),
    "a@example.com",
  );

  // Unique projectId match when only one account has it
  const uniqueState: AntigravityAccountsState = {
    activeEmail: "other@example.com",
    accounts: [
      makeAccount("solo@example.com", { projectId: "unique-project" }),
      makeAccount("other@example.com", { projectId: "aicode-consumers" }),
    ],
  };
  assert.equal(
    resolveAccountEmail({ projectId: "unique-project" }, uniqueState),
    "solo@example.com",
  );
});

test("plan-quota 429 transparently fails over to the next saved account when accounts share projectId", async () => {
  const env = useTestAgentDir();
  const prevSessions = process.env.ANTIGRAVITY_SESSIONS_FILE;
  process.env.ANTIGRAVITY_SESSIONS_FILE = join(env.dir, "sessions.json");
  try {
    // Both accounts share the standard consumer project id "aicode-consumers"
    const alpha = makeAccount("a@example.com", { projectId: "aicode-consumers" });
    const beta = makeAccount("b@example.com", { projectId: "aicode-consumers" });
    saveAccountsState({ activeEmail: "a@example.com", accounts: [alpha, beta] });

    await withFetchStub(
      (_url, call) =>
        call === 1
          ? planQuotaResponse()
          : new Response(STREAM_OK_SSE, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
      async (calls) => {
        const message = await streamOnce(
          JSON.stringify({
            token: "access-a@example.com",
            projectId: "aicode-consumers",
            email: "a@example.com",
          }),
          "-8282828282",
        );
        assert.equal(calls.length, 2);
        assert.equal(message.stopReason, "stop");

        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        const state = loadAccountsState();
        assert.equal(state.activeEmail, "b@example.com"); // switched to beta despite sharing projectId
      },
    );
  } finally {
    if (prevSessions === undefined) delete process.env.ANTIGRAVITY_SESSIONS_FILE;
    else process.env.ANTIGRAVITY_SESSIONS_FILE = prevSessions;
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("plan-quota 429 transparently fails over to the next saved account", async () => {
  const env = useTestAgentDir();
  const prevSessions = process.env.ANTIGRAVITY_SESSIONS_FILE;
  process.env.ANTIGRAVITY_SESSIONS_FILE = join(env.dir, "sessions.json");
  try {
    const alpha = makeAccount("a@example.com", { projectId: "proj-a" });
    const beta = makeAccount("b@example.com", { projectId: "proj-b" });
    saveAccountsState({ activeEmail: "a@example.com", accounts: [alpha, beta] });
    assert.ok(isPlanQuotaError(429, "Individual quota reached. Resets in 3h0m0s."));

    await withFetchStub(
      (_url, call) =>
        call === 1
          ? planQuotaResponse()
          : new Response(STREAM_OK_SSE, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
      async (calls) => {
        const message = await streamOnce(
          JSON.stringify({ token: "access-a@example.com", projectId: "proj-a", email: "a@example.com" }),
          "-5252525252",
        );
        assert.equal(calls.length, 2);
        assert.equal(message.stopReason, "stop");

        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        const state = loadAccountsState();
        assert.equal(state.activeEmail, "b@example.com"); // failover switched accounts
        const mirrored = readAgentJson(env.dir, "auth.json") as Record<
          string,
          Record<string, unknown>
        >;
        assert.equal(mirrored.antigravity?.email, "b@example.com");
      },
    );
  } finally {
    if (prevSessions === undefined) delete process.env.ANTIGRAVITY_SESSIONS_FILE;
    else process.env.ANTIGRAVITY_SESSIONS_FILE = prevSessions;
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("failover skips the current account by project id when the credential has no email", async () => {
  const env = useTestAgentDir();
  const prevSessions = process.env.ANTIGRAVITY_SESSIONS_FILE;
  process.env.ANTIGRAVITY_SESSIONS_FILE = join(env.dir, "sessions.json");
  try {
    const now = Date.now();
    const alpha = makeAccount("a@example.com", { projectId: "proj-a", lastUsedAt: now - 2000 });
    const beta = makeAccount("b@example.com", { projectId: "proj-b", lastUsedAt: now - 1000 });
    saveAccountsState({ activeEmail: "a@example.com", accounts: [alpha, beta] });

    await withFetchStub(
      (_url, call) =>
        call === 1
          ? planQuotaResponse()
          : new Response(STREAM_OK_SSE, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
      async (calls) => {
        // Legacy credential shape: token + projectId, no email. Without project-id
        // tracking the LRU sort would pick the exhausted account again.
        const message = await streamOnce(
          JSON.stringify({ token: "access-a@example.com", projectId: "proj-a" }),
          "-7373737373",
        );
        assert.equal(calls.length, 2);
        assert.equal(message.stopReason, "stop");
        assert.equal(loadAccountsState().activeEmail, "b@example.com");
      },
    );
  } finally {
    if (prevSessions === undefined) delete process.env.ANTIGRAVITY_SESSIONS_FILE;
    else process.env.ANTIGRAVITY_SESSIONS_FILE = prevSessions;
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("consecutive plan-quota failures walk through every saved account", async () => {
  const env = useTestAgentDir();
  const prevSessions = process.env.ANTIGRAVITY_SESSIONS_FILE;
  process.env.ANTIGRAVITY_SESSIONS_FILE = join(env.dir, "sessions.json");
  try {
    saveAccountsState({
      activeEmail: "a@example.com",
      accounts: [
        makeAccount("a@example.com", { projectId: "proj-a" }),
        makeAccount("b@example.com", { projectId: "proj-b" }),
        makeAccount("c@example.com", { projectId: "proj-c" }),
      ],
    });

    await withFetchStub(
      (_url, call) =>
        call <= 2
          ? planQuotaResponse()
          : new Response(STREAM_OK_SSE, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
      async (calls) => {
        const message = await streamOnce(
          JSON.stringify({ token: "access-a@example.com", projectId: "proj-a", email: "a@example.com" }),
          "-7474747474",
        );
        assert.equal(calls.length, 3);
        assert.equal(message.stopReason, "stop");
        assert.equal(loadAccountsState().activeEmail, "c@example.com");
      },
    );
  } finally {
    if (prevSessions === undefined) delete process.env.ANTIGRAVITY_SESSIONS_FILE;
    else process.env.ANTIGRAVITY_SESSIONS_FILE = prevSessions;
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("single saved account fails fast without failover", async () => {
  const env = useTestAgentDir();
  const prevSessions = process.env.ANTIGRAVITY_SESSIONS_FILE;
  process.env.ANTIGRAVITY_SESSIONS_FILE = join(env.dir, "sessions.json");
  try {
    const only = makeAccount("solo@example.com", { projectId: "proj-solo" });
    saveAccountsState({ activeEmail: "solo@example.com", accounts: [only] } as AntigravityAccountsState);

    await withFetchStub(
      () => planQuotaResponse(),
      async (calls) => {
        const message = await streamOnce(
          JSON.stringify({
            token: "access-solo@example.com",
            projectId: "proj-solo",
            email: "solo@example.com",
          }),
          "-6262626262",
        );
        assert.equal(calls.length, 1); // no switch possible → fail fast
        assert.equal(message.stopReason, "error");
        assert.match(message.errorMessage ?? "", /^Quota reached\. Please wait 3h/);
      },
    );
  } finally {
    if (prevSessions === undefined) delete process.env.ANTIGRAVITY_SESSIONS_FILE;
    else process.env.ANTIGRAVITY_SESSIONS_FILE = prevSessions;
    env.restore();
    rmSync(env.dir, { recursive: true, force: true });
  }
});
