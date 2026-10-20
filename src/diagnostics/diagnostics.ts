import { AsyncLocalStorage } from "node:async_hooks";
import { redactSecrets } from "../utils/security.js";

export type DiagnosticsSnapshot = {
  status?: number;
  endpoint?: string;
  error?: string;
  projectId?: string;
  resolvedRuntimeModel?: string;
  availableModels?: string;
  matchedModelDebug?: string;
  latencyMs?: number;
  maskedEmail?: string;
  tokenExpiry?: string;
  /** Set when a 429 plan-quota triggered an automatic account switch mid-request. */
  accountFailover?: { from?: string; to: string };
};

const storage = new AsyncLocalStorage<DiagnosticsSnapshot>();

/** Last completed request snapshot for `/antigravity.doctor`. */
let lastSnapshot: DiagnosticsSnapshot = {};

/**
 * Last account switch, kept outside the snapshot. Unrelated work that runs later
 * (for example a pi-usage-core quota poll) commits its own empty bag and would
 * otherwise erase the failover before the user runs `/antigravity.doctor`.
 */
let lastAccountFailover: DiagnosticsSnapshot["accountFailover"];

function currentBag(): DiagnosticsSnapshot {
  return storage.getStore() ?? lastSnapshot;
}

/** Run work with an isolated diagnostics bag; commits it to `lastSnapshot` when done. */
export async function runWithDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
  const bag: DiagnosticsSnapshot = {};
  return storage.run(bag, async () => {
    try {
      return await fn();
    } finally {
      lastSnapshot = { ...bag };
    }
  });
}

export function getLastDiagnostics(): Readonly<DiagnosticsSnapshot> {
  return lastSnapshot;
}

/** Read endpoint from the active request bag (or last snapshot outside a request). */
export function getCurrentEndpoint(): string | undefined {
  return currentBag().endpoint;
}

export function getCurrentMatchedModelDebug(): string | undefined {
  return currentBag().matchedModelDebug;
}

export function getCurrentAvailableModels(): string | undefined {
  return currentBag().availableModels;
}

export function setLastStatus(status: number | undefined): void {
  currentBag().status = status;
}
export function setLastEndpoint(endpoint: string | undefined): void {
  currentBag().endpoint = endpoint;
}
export function setLastError(error: string | undefined): void {
  currentBag().error = error === undefined ? undefined : redactSecrets(error).slice(0, 800);
}
export function setLastProjectId(projectId: string | undefined): void {
  currentBag().projectId = projectId;
}
export function setLastResolvedRuntimeModel(model: string | undefined): void {
  currentBag().resolvedRuntimeModel = model;
}
export function setLastAvailableModels(models: string | undefined): void {
  currentBag().availableModels = models;
}
export function setLastMatchedModelDebug(debug: string | undefined): void {
  currentBag().matchedModelDebug =
    debug === undefined ? undefined : redactSecrets(debug).slice(0, 1200);
}
export function setLastLatencyMs(ms: number | undefined): void {
  currentBag().latencyMs = ms;
}
export function setLastMaskedEmail(email: string | undefined): void {
  currentBag().maskedEmail = email;
}
export function setLastAccountFailover(from: string | undefined, to: string): void {
  const failover = { from, to };
  lastAccountFailover = failover;
  currentBag().accountFailover = failover;
}
export function getLastAccountFailover(): DiagnosticsSnapshot["accountFailover"] {
  return lastAccountFailover;
}
export function setLastTokenExpiry(expiry: string | undefined): void {
  currentBag().tokenExpiry = expiry;
}

/** Test helper: reset last snapshot between cases. */
export function resetDiagnosticsForTests(): void {
  lastSnapshot = {};
  lastAccountFailover = undefined;
}
