import test from "node:test";
import assert from "node:assert/strict";
import {
  ANTIGRAVITY_UPSTREAM_HUB_CL,
  ANTIGRAVITY_UPSTREAM_HUB_VERSION,
  ANTIGRAVITY_UPSTREAM_MODEL,
  ANTIGRAVITY_UPSTREAM_RELEASE,
  ANTIGRAVITY_UPSTREAM_SYSTEM_PROMPT,
  ANTIGRAVITY_UPSTREAM_TOOLS,
} from "../src/antigravity-upstream.js";
import { parseHubManifest } from "../scripts/lib/antigravity-release.js";

const REQUIRED_TOOLS = [
  "ask_question",
  "edit_file",
  "invoke_subagent",
  "read_file",
  "run_command",
  "search_web",
  "write_file",
] as const;

test("upstream contract is pinned to an official Antigravity CLI release", () => {
  assert.match(ANTIGRAVITY_UPSTREAM_RELEASE, /^\d+\.\d+\.\d+$/);
  assert.match(ANTIGRAVITY_UPSTREAM_MODEL, /^[a-z0-9][a-z0-9.-]+$/);
  assert.match(ANTIGRAVITY_UPSTREAM_HUB_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(ANTIGRAVITY_UPSTREAM_HUB_CL, /^\d+$/);
  assert.ok(Object.keys(ANTIGRAVITY_UPSTREAM_TOOLS).length >= 10);
});

test("Hub updater manifest supplies the User-Agent version and changelist", () => {
  const manifest = [
    "version: 2.32.1",
    "files:",
    "  - url: https://storage.googleapis.com/antigravity-public/antigravity-hub/2.32.1-6001966350991360/linux-x64/Antigravity.AppImage",
    "path: Antigravity.AppImage",
    "",
  ].join("\n");
  assert.deepEqual(parseHubManifest(manifest), {
    version: "2.32.1",
    cl: "6001966350991360",
  });
  assert.throws(() => parseHubManifest("version: 2.32.1\nfiles: []\n"));
});

test("dumped system prompt is complete and normalized", () => {
  const prompt = ANTIGRAVITY_UPSTREAM_SYSTEM_PROMPT;
  assert.ok(prompt.length > 5_000);
  assert.match(prompt, /^<identity>\nYou are Antigravity,/);
  for (const section of [
    "<artifacts>",
    "<guidelines>",
    "<skills>",
    "<user_information>",
  ]) {
    assert.ok(prompt.includes(section), `missing section ${section}`);
  }
  assert.match(prompt, /Command Working Directory: <workspace>/);
  assert.match(prompt, /App Data Directory: <appDataDir>/);
  assert.match(prompt, /Artifact Directory Path: <appDataDir>\/brain\/<conversation-id>/);
  assert.match(prompt, /The USER's OS version is <os>\./);

  // Volatile capture-time values must never leak into the committed contract.
  assert.doesNotMatch(
    prompt,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  );
  assert.doesNotMatch(prompt, /\/tmp\/pi\//);
});

test("dumped tool catalog carries genuine declarations", () => {
  for (const name of REQUIRED_TOOLS) {
    const tool = ANTIGRAVITY_UPSTREAM_TOOLS[name];
    assert.ok(tool, `missing tool ${name}`);
    assert.ok(tool.description.length > 20, `tool ${name} has a short description`);
    assert.equal(tool.parameters.type, "object", `tool ${name} is not an object schema`);
    assert.equal(typeof tool.parameters.properties, "object");
  }

  for (const [name, tool] of Object.entries(ANTIGRAVITY_UPSTREAM_TOOLS)) {
    assert.equal(typeof tool.description, "string", `tool ${name} description`);
    assert.ok(tool.description.trim().length > 0, `tool ${name} empty description`);
    assert.equal(tool.parameters.type, "object", `tool ${name} parameters.type`);
  }
});
