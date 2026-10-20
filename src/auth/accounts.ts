import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultProjectId } from "../client/client.js";
import { antigravityEnv } from "../utils/util.js";
import type {
  AntigravityAccount,
  AntigravityAccountsState,
  AntigravityOAuthCredentials,
} from "../types/types.js";

export const ACCOUNTS_FILE_NAME = "antigravity-accounts.json";

/** Access tokens are refreshed this long before their `expires` timestamp. */
export const TOKEN_REFRESH_SLACK_MS = 5 * 60 * 1000;

export type AntigravityAccountInput = {
  email: string;
  refresh: string;
  access: string;
  expires: number;
  projectId: string;
};

export function getAgentDirSafe(): string {
  try {
    return getAgentDir();
  } catch {
    return join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
  }
}

export function getAuthFilePath(): string {
  return join(getAgentDirSafe(), "auth.json");
}

export function getAccountsFilePath(): string {
  const envPath = antigravityEnv("ACCOUNTS_FILE");
  if (envPath) return envPath;
  return join(getAgentDirSafe(), ACCOUNTS_FILE_NAME);
}

function isAccount(value: unknown): value is AntigravityAccount {
  if (typeof value !== "object" || value === null) return false;
  const account = value as Partial<AntigravityAccount>;
  return (
    typeof account.email === "string" &&
    account.email.length > 0 &&
    typeof account.refresh === "string" &&
    typeof account.access === "string" &&
    typeof account.projectId === "string" &&
    account.projectId.length > 0 &&
    typeof account.expires === "number" &&
    Number.isFinite(account.expires)
  );
}

function normalizeState(state: AntigravityAccountsState): AntigravityAccountsState {
  const now = Date.now();
  // Deduplicate by email, keeping the newest entry last.
  const byEmail = new Map<string, AntigravityAccount>();
  for (const account of state.accounts) {
    // Hand-edited or older account files may omit timestamps; both the LRU
    // failover order and /antigravity.accounts rendering need finite numbers.
    if (!Number.isFinite(account.addedAt)) account.addedAt = now;
    if (!Number.isFinite(account.lastUsedAt)) account.lastUsedAt = account.addedAt;
    byEmail.set(account.email, account);
  }
  state.accounts = [...byEmail.values()];
  if (!state.activeEmail || !state.accounts.some((a) => a.email === state.activeEmail)) {
    state.activeEmail = state.accounts[0]?.email;
  }
  return state;
}

function readStateFile(file: string): AntigravityAccountsState {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<AntigravityAccountsState> | null;
    if (!parsed || typeof parsed !== "object") return { accounts: [] };
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts.filter(isAccount) : [];
    const activeEmail = typeof parsed.activeEmail === "string" ? parsed.activeEmail : undefined;
    return normalizeState({ accounts, activeEmail });
  } catch {
    // Corrupt file: treat as empty rather than blocking every command.
    return { accounts: [] };
  }
}

function readFileRecord(file: string): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Distinguish "no auth.json yet" from "auth.json exists but cannot be read".
 * The difference matters: writing an empty record over an unreadable file would
 * destroy the credentials of every other provider stored in it.
 */
type AuthStorageFile = { state: "missing" | "ok" | "unreadable"; data: Record<string, unknown> };

function readAuthStorageFile(file: string): AuthStorageFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { state: code === "ENOENT" ? "missing" : "unreadable", data: {} };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "unreadable", data: {} };
    }
    return { state: "ok", data: parsed as Record<string, unknown> };
  } catch {
    return { state: "unreadable", data: {} };
  }
}

function writeFileAtomic(file: string, data: string, fallbackMode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true });
  let mode = fallbackMode;
  try {
    if (existsSync(file)) mode = statSync(file).mode & 0o777;
  } catch {
    // keep fallback mode
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode });
    renameSync(tmp, file);
  } catch (err) {
    try {
      // Fall back to a direct write in edge cases, such as a cross-filesystem rename.
      writeFileSync(file, data, { encoding: "utf8", mode });
    } catch (fallbackErr) {
      throw fallbackErr instanceof Error ? fallbackErr : (err as Error);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // tmp cleanup: best effort
      }
    }
  }
}

/**
 * Save the account state atomically with 0600-style permissions (tokens at rest).
 */
export function saveAccountsState(state: AntigravityAccountsState): void {
  normalizeState(state);
  try {
    writeFileAtomic(getAccountsFilePath(), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Storage failures must not break auth flows; state stays in-memory for this call.
  }
}

/**
 * Read the stored account database. On first run it imports the account that
 * legacy versions kept only in auth.json, so existing users never re-login.
 */
export function loadAccountsState(): AntigravityAccountsState {
  const file = getAccountsFilePath();
  if (!existsSync(file)) {
    const migrated = migrateLegacyAuthStorage();
    if (migrated) {
      // Keep auth.json in sync so token refresh paths in Pi keep working.
      syncActiveToAuthStorage(migrated.accounts.find((a) => a.email === migrated.activeEmail));
      return migrated;
    }
    return { accounts: [] };
  }
  return readStateFile(file);
}

/** One-time import of the credential that older versions stored in auth.json. */
export function migrateLegacyAuthStorage(): AntigravityAccountsState | undefined {
  const data = readFileRecord(getAuthFilePath());
  const credential = data?.antigravity as
    | { refresh?: unknown; access?: unknown; expires?: unknown; projectId?: unknown; email?: unknown }
    | undefined;
  if (!credential) return undefined;
  const refresh = typeof credential.refresh === "string" ? credential.refresh : "";
  const access = typeof credential.access === "string" ? credential.access : "";
  const email = typeof credential.email === "string" ? credential.email : "";
  if (!refresh || !access || !email) return undefined;
  const projectId =
    typeof credential.projectId === "string" && credential.projectId
      ? credential.projectId
      : defaultProjectId(email);
  const now = Date.now();
  const state: AntigravityAccountsState = {
    activeEmail: email,
    accounts: [
      {
        email,
        refresh,
        access,
        expires: typeof credential.expires === "number" ? credential.expires : 0,
        projectId,
        addedAt: now,
        lastUsedAt: now,
      },
    ],
  };
  saveAccountsState(state);
  return state;
}

export function getActiveAccount(): AntigravityAccount | undefined {
  const state = loadAccountsState();
  return state.accounts.find((a) => a.email === state.activeEmail) ?? state.accounts[0];
}

export function getAccountByEmail(email: string): AntigravityAccount | undefined {
  return loadAccountsState().accounts.find((a) => a.email === email);
}

/**
 * Mirror the active account into Pi's standard auth.json so the rest of Pi
 * (model registry, credential store, fallback reads) keeps using its normal path.
 */
export function syncActiveToAuthStorage(account?: AntigravityAccount): void {
  const authPath = getAuthFilePath();
  const existing = readAuthStorageFile(authPath);
  // Leave a corrupt or unreadable auth.json untouched. Rewriting it from an
  // empty record would silently delete every other provider's credentials; the
  // accounts file remains the source of truth in that case.
  if (existing.state === "unreadable") return;
  const data = existing.data;
  if (account) {
    data.antigravity = {
      type: "oauth",
      refresh: account.refresh,
      access: account.access,
      expires: account.expires,
      projectId: account.projectId,
      email: account.email,
    };
  } else {
    delete data.antigravity;
  }
  if (existing.state === "missing" && !account) return; // don't create a stray auth.json
  try {
    writeFileAtomic(authPath, `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    // Best-effort sync; the accounts file remains the source of truth.
  }
}

/** Mark an existing account as active and mirror it into auth.json. */
export async function switchActiveAccount(email: string): Promise<AntigravityAccount> {
  const state = loadAccountsState();
  const account = state.accounts.find((a) => a.email === email);
  if (!account) {
    throw new Error(`Antigravity account not found: ${email}`);
  }
  if (state.activeEmail !== email) {
    state.activeEmail = email;
    account.lastUsedAt = Date.now();
    saveAccountsState(state);
    syncActiveToAuthStorage(account);
  } else {
    account.lastUsedAt = Date.now();
    saveAccountsState(state);
  }
  return account;
}

/**
 * Insert or replace an account by email. By default it also becomes the
 * active account and is synced into auth.json; pass setActive:false for
 * background refreshes of secondary accounts.
 */
export async function upsertAccount(
  input: AntigravityAccountInput,
  options: { setActive?: boolean } = {},
): Promise<AntigravityAccount> {
  const setActive = options.setActive !== false;
  const state = loadAccountsState();
  const now = Date.now();
  const existingIndex = state.accounts.findIndex((a) => a.email === input.email);
  const account: AntigravityAccount = {
    ...input,
    addedAt: existingIndex >= 0 ? (state.accounts[existingIndex] as AntigravityAccount).addedAt : now,
    lastUsedAt: now,
  };
  if (existingIndex >= 0) state.accounts[existingIndex] = account;
  else state.accounts.push(account);

  if (setActive || !state.activeEmail) state.activeEmail = account.email;
  saveAccountsState(state);
  // auth.json only mirrors the active credential. Syncing on background
  // refreshes of secondary accounts would rewrite Pi's own auth.json and race
  // with Pi's writes to the same file.
  const active = state.accounts.find((a) => a.email === state.activeEmail);
  if (active && active.email === account.email) syncActiveToAuthStorage(active);
  return account;
}

/**
 * Remove an account. If it was active, the next remaining account becomes
 * active (synced to auth.json); when the last account is removed the
 * antigravity entry is cleared from auth.json. Returns true if removed.
 */
export async function removeAccount(email: string): Promise<boolean> {
  const state = loadAccountsState();
  const index = state.accounts.findIndex((a) => a.email === email);
  if (index === -1) return false;
  state.accounts.splice(index, 1);
  if (state.activeEmail === email) state.activeEmail = state.accounts[0]?.email;
  saveAccountsState(state);
  syncActiveToAuthStorage(state.accounts.find((a) => a.email === state.activeEmail));
  return true;
}

/**
 * Locate the saved account that corresponds to a credential: match by email
 * first, then by refresh token, then by access token (tokens rotate, emails don't).
 */
export function findAccountForCredentials(credentials: {
  email?: unknown;
  refresh?: unknown;
  access?: unknown;
}): AntigravityAccount | undefined {
  const state = loadAccountsState();
  if (typeof credentials.email === "string" && credentials.email) {
    const byEmail = state.accounts.find((a) => a.email === credentials.email);
    if (byEmail) return byEmail;
  }
  if (typeof credentials.refresh === "string" && credentials.refresh) {
    const byRefresh = state.accounts.find((a) => a.refresh === credentials.refresh);
    if (byRefresh) return byRefresh;
  }
  if (typeof credentials.access === "string" && credentials.access) {
    const byAccess = state.accounts.find((a) => a.access === credentials.access);
    if (byAccess) return byAccess;
  }
  return undefined;
}

export function accountTokenExpired(account: AntigravityAccount): boolean {
  return account.expires <= Date.now() + TOKEN_REFRESH_SLACK_MS;
}

/**
 * Resolve the email identifying an account from credentials, matching by email,
 * then access token, then unique projectId (if only one account has it), then activeEmail.
 */
export function resolveAccountEmail(
  creds: {
    email?: string;
    token?: string;
    projectId?: string;
  },
  state = loadAccountsState(),
): string | undefined {
  if (creds.email) return creds.email;
  if (creds.token) {
    const byAccess = state.accounts.find((a) => a.access === creds.token);
    if (byAccess?.email) return byAccess.email;
  }
  if (creds.projectId) {
    const matching = state.accounts.filter((a) => a.projectId === creds.projectId);
    if (matching.length === 1 && matching[0]?.email) return matching[0].email;
  }
  return state.activeEmail && state.accounts.some((a) => a.email === state.activeEmail)
    ? state.activeEmail
    : undefined;
}

/** Serialize an account into the Antigravity API-key envelope used everywhere else. */
export function accountToApiKey(account: AntigravityAccount): string {
  const envelope = {
    token: account.access,
    projectId: account.projectId,
    email: account.email || undefined,
  };
  if (envelope.email === undefined) delete envelope.email;
  return JSON.stringify(envelope);
}

/** Convert a stored account into the OAuth credential shape Pi expects. */
export function credentialsFromAccount(account: AntigravityAccount): AntigravityOAuthCredentials {
  return {
    type: "oauth",
    refresh: account.refresh,
    access: account.access,
    expires: account.expires,
    projectId: account.projectId,
    email: account.email,
  };
}
