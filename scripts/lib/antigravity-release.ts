/**
 * Shared helpers for downloading and running official Antigravity CLI release
 * binaries in an isolated sandbox for prompt/tool contract extraction.
 *
 * Upstream: https://github.com/google-antigravity/antigravity-cli
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const REPO_OWNER = "google-antigravity";
export const REPO_NAME = "antigravity-cli";

/** Release tags are bare semver (`1.5.9`), unlike OpenCode's `vX.Y.Z`. */
export function parseSemver(tag: string): [number, number, number] {
  const match = tag.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

export function semverCompare(a: string, b: string): number {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  if (a1 !== b1) return b1 - a1;
  if (a2 !== b2) return b2 - a2;
  return b3 - a3;
}

export interface ReleaseAsset {
  name: string;
  archive: "tar.gz" | "zip";
}

export function assetForPlatform(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  options: { musl?: boolean } = {},
): ReleaseAsset {
  if (platform === "linux") {
    if (arch === "arm64") {
      return {
        name: options.musl ? "agy_cli_linux_arm64_musl.tar.gz" : "agy_cli_linux_arm64.tar.gz",
        archive: "tar.gz",
      };
    }
    if (arch === "x64") {
      return {
        name: options.musl ? "agy_cli_linux_x64_musl.tar.gz" : "agy_cli_linux_x64.tar.gz",
        archive: "tar.gz",
      };
    }
  } else if (platform === "darwin") {
    if (arch === "arm64") return { name: "agy_cli_mac_arm64.tar.gz", archive: "tar.gz" };
    if (arch === "x64") return { name: "agy_cli_mac_x64.tar.gz", archive: "tar.gz" };
  } else if (platform === "win32") {
    if (arch === "arm64") return { name: "agy_cli_windows_arm64.zip", archive: "zip" };
    if (arch === "x64") return { name: "agy_cli_windows_x64.zip", archive: "zip" };
  }
  // Default to the glibc linux-x64 asset used by CI (ubuntu-latest).
  return { name: "agy_cli_linux_x64.tar.gz", archive: "tar.gz" };
}

export async function resolveLatestReleaseTag(token?: string): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": "pi-oauth-antigravity-extractor",
    Accept: "application/vnd.github.v3+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=100`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to list releases from GitHub API: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const releases = (await response.json()) as Array<{
    tag_name: string;
    prerelease?: boolean;
    draft?: boolean;
  }>;

  const stable = releases
    .filter(
      (release) =>
        /^\d+\.\d+\.\d+$/.test(release.tag_name) && !release.prerelease && !release.draft,
    )
    .map((release) => release.tag_name)
    .sort(semverCompare);

  if (stable.length === 0) {
    throw new Error("No stable semver releases found in google-antigravity/antigravity-cli");
  }
  return stable[0];
}

function runArchiveTool(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

function findBinary(dir: string): string {
  const candidates: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > 2) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
      } else if (
        entry.isFile() &&
        (entry.name === "antigravity" || entry.name === "antigravity.exe")
      ) {
        candidates.push(path);
      }
    }
  };
  walk(dir, 0);
  if (candidates.length === 0) {
    throw new Error(`Antigravity CLI binary not found under ${dir}`);
  }
  return candidates[0];
}

export interface DownloadOptions {
  /** GitHub token for release metadata (asset downloads are anonymous). */
  token?: string;
  /** Use the musl build on linux (glibc is the default). */
  musl?: boolean;
}

export async function downloadReleaseBinary(
  tag: string,
  destDir: string,
  options: DownloadOptions = {},
): Promise<string> {
  mkdirSync(destDir, { recursive: true });
  const asset = assetForPlatform(process.platform, process.arch, options);
  const binName = process.platform === "win32" ? "antigravity.exe" : "antigravity";
  const extractedBin = join(destDir, binName);
  if (existsSync(extractedBin)) return extractedBin;

  const downloadUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${tag}/${asset.name}`;
  const archivePath = join(destDir, asset.name);

  console.log(`Downloading ${downloadUrl}...`);
  const headers: Record<string, string> = { "User-Agent": "pi-oauth-antigravity-extractor" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(downloadUrl, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download ${downloadUrl}: HTTP ${response.status}`);
  }
  writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));

  console.log(`Extracting ${asset.name}...`);
  if (asset.archive === "tar.gz") {
    runArchiveTool("tar", ["xzf", archivePath, "-C", destDir]);
  } else {
    runArchiveTool("unzip", ["-q", archivePath, "-d", destDir]);
  }

  const binary = findBinary(destDir);
  if (binary !== extractedBin) {
    // Flatten to the stable path so repeat runs reuse the cached binary.
    copyFileSync(binary, extractedBin);
  }
  if (process.platform !== "win32") chmodSync(extractedBin, 0o755);
  return extractedBin;
}

export interface SandboxEnvironment {
  sandboxDir: string;
  homeDir: string;
  appDataDir: string;
  workspaceDir: string;
  runEnv: Record<string, string>;
}

/**
 * Antigravity Hub auto-updater. The Hub is versioned independently from the
 * `antigravity-cli` release tag, and its manifest is the same source the
 * shipping client uses. The manifest also carries the Piper changelist in the
 * artifact path, e.g. `antigravity-hub/2.32.1-6001966350991360/...`, which is
 * the `cl` value in the Hub `User-Agent`.
 */
export const HUB_UPDATER_BASE =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app";

/** CI uses the linux-x64 manifest; the version/CL are platform-independent. */
export const DEFAULT_HUB_MANIFEST = `${HUB_UPDATER_BASE}/manifest/latest-x64-linux.yml`;

export interface HubIdentity {
  version: string;
  cl: string;
  manifestUrl: string;
}

/** Parse `version: X.Y.Z` plus the `antigravity-hub/X.Y.Z-<cl>/` artifact path. */
export function parseHubManifest(text: string): { version: string; cl: string } {
  const versionMatch = text.match(/^version:\s*(\d+\.\d+\.\d+)\s*$/m);
  if (!versionMatch) {
    throw new Error("Antigravity Hub manifest has no semver version");
  }
  const version = versionMatch[1];
  const escaped = version.replace(/\./g, "\\.");
  const clMatch = text.match(new RegExp(`antigravity-hub/${escaped}-(\\d+)/`));
  if (!clMatch) {
    throw new Error(`Antigravity Hub manifest has no changelist for version ${version}`);
  }
  return { version, cl: clMatch[1] };
}

/** Resolve the current Hub version and Piper changelist used in the User-Agent. */
export async function resolveLatestHubIdentity(
  options: { manifestUrl?: string } = {},
): Promise<HubIdentity> {
  const manifestUrl = options.manifestUrl ?? DEFAULT_HUB_MANIFEST;
  const response = await fetch(manifestUrl, {
    headers: { "User-Agent": "electron-builder", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Antigravity Hub manifest ${manifestUrl}: HTTP ${response.status}`);
  }
  const { version, cl } = parseHubManifest(await response.text());
  return { version, cl, manifestUrl };
}

/**
 * Creates a fresh, deterministic sandbox for one extraction run:
 *
 * - the CLI's home is isolated from the developer's real `~/.gemini`;
 * - the workspace is an empty directory so no `AGENTS.md`/rules leak in;
 * - ambient Google/Antigravity credentials and proxy settings are stripped,
 *   and the Gemini backend is pointed at the local mock server.
 */
export function setupSandbox(baseDir: string, mockPort: number): SandboxEnvironment {
  const sandboxDir = join(baseDir, "sandbox");
  rmSync(sandboxDir, { recursive: true, force: true });

  const homeDir = join(sandboxDir, "home");
  const workspaceDir = join(sandboxDir, "workspace");
  const appDataDir = join(homeDir, ".gemini", "antigravity-cli");
  const tmpDir = join(sandboxDir, "tmp");
  for (const dir of [homeDir, workspaceDir, appDataDir, tmpDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const runEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(AGY_|ANTIGRAVITY_|GEMINI_|GOOGLE_)/.test(key)) continue;
    if (/^(https?|all|no)_proxy$/i.test(key)) continue;
    runEnv[key] = value;
  }

  Object.assign(runEnv, {
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_STATE_HOME: join(homeDir, ".local", "state"),
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    SHELL: process.platform === "win32" ? "" : "/bin/bash",
    TERM: "dumb",
    NO_COLOR: "1",
    GEMINI_API_KEY: "antigravity-extract-key",
    GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${mockPort}`,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  });

  return { sandboxDir, homeDir, appDataDir, workspaceDir, runEnv };
}
