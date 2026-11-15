import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ANTIGRAVITY_UPSTREAM_PROMPT_MARKER,
	antigravityUpstreamContractEnabled,
	antigravityUpstreamPromptValues,
	mapAntigravityUpstreamToolCall,
	renderAntigravityUpstreamSystemPrompt,
} from "../src/antigravity-contract.js";

function withContractEnv<T>(value: string | undefined, fn: () => T): T {
	const previous = process.env.ANTIGRAVITY_UPSTREAM_CONTRACT;
	if (value === undefined) delete process.env.ANTIGRAVITY_UPSTREAM_CONTRACT;
	else process.env.ANTIGRAVITY_UPSTREAM_CONTRACT = value;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env.ANTIGRAVITY_UPSTREAM_CONTRACT;
		else process.env.ANTIGRAVITY_UPSTREAM_CONTRACT = previous;
	}
}

test("upstream contract is enabled by default and can be turned off", () => {
	assert.equal(withContractEnv(undefined, antigravityUpstreamContractEnabled), true);
	assert.equal(withContractEnv("1", antigravityUpstreamContractEnabled), true);
	for (const value of ["0", "off", "false", "no", " OFF "]) {
		assert.equal(
			withContractEnv(value, antigravityUpstreamContractEnabled),
			false,
			`expected ${value} to disable the contract`,
		);
	}
});

test("rendered upstream prompt carries real values instead of placeholders", () => {
	const prompt = renderAntigravityUpstreamSystemPrompt({
		workspace: "/work/project",
		appDataDir: "/home/dev/.gemini/antigravity-cli",
		conversationId: "conversation-123",
		os: "linux",
	});
	assert.ok(prompt.startsWith(ANTIGRAVITY_UPSTREAM_PROMPT_MARKER));
	assert.match(prompt, /Command Working Directory: \/work\/project/);
	assert.match(prompt, /App Data Directory: \/home\/dev\/\.gemini\/antigravity-cli/);
	assert.match(prompt, /Conversation ID: conversation-123/);
	assert.match(prompt, /Artifact Directory Path: \/home\/dev\/\.gemini\/antigravity-cli\/brain\/conversation-123/);
	assert.match(prompt, /The USER's OS version is linux\./);
	assert.doesNotMatch(prompt, /<workspace>|<appDataDir>|<conversation-id>|<os>/);
});

test("prompt values use the process workspace and host OS", () => {
	const values = antigravityUpstreamPromptValues("sess-1");
	assert.equal(values.workspace, process.cwd());
	assert.equal(values.conversationId, "sess-1");
	assert.ok(["linux", "macos", "windows"].includes(values.os));
	assert.ok(values.appDataDir.includes(".gemini/antigravity-cli"));
});

test("upstream tool calls bridge to Pi built-ins", () => {
	const dir = mkdtempSync(join(tmpdir(), "antigravity-contract-"));
	const existing = join(dir, "existing.ts");
	const fresh = join(dir, "fresh.ts");
	writeFileSync(existing, "old content");
	try {
		withContractEnv(undefined, () => {
			assert.deepEqual(mapAntigravityUpstreamToolCall("read_file", {
				Path: "/tmp/a.ts",
				StartLine: 10,
				EndLine: 20,
			}), {
				name: "read",
				arguments: { path: "/tmp/a.ts", offset: 10, limit: 11 },
			});

			// Create-only upstream writes bridge for new files, but not over
			// existing ones unless `Overwrite: true` was explicit.
			assert.deepEqual(mapAntigravityUpstreamToolCall("write_file", {
				Path: fresh,
				Content: "hello",
			}), {
				name: "write",
				arguments: { path: fresh, content: "hello" },
			});
			assert.equal(
				mapAntigravityUpstreamToolCall("write_file", { Path: existing, Content: "clobber" }),
				undefined,
			);
			assert.deepEqual(mapAntigravityUpstreamToolCall("write_file", {
				Path: existing,
				Content: "clobber",
				Overwrite: true,
			}), {
				name: "write",
				arguments: { path: existing, content: "clobber" },
			});

			assert.deepEqual(mapAntigravityUpstreamToolCall("edit_file", {
				Path: "/tmp/a.ts",
				Target: "old",
				Replacement: "new",
			}), {
				name: "edit",
				arguments: {
					path: "/tmp/a.ts",
					edits: [{ oldText: "old", newText: "new" }],
				},
			});

			assert.deepEqual(mapAntigravityUpstreamToolCall("run_command", {
				CommandLine: "npm test",
				WaitMsBeforeAsync: 5000,
			}), {
				name: "bash",
				arguments: { command: "npm test", timeout: 5 },
			});
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	assert.equal(existsSync(dir), false);
});

test("unbridgeable upstream calls are left untouched", () => {
	withContractEnv(undefined, () => {
		// `write` must not turn an append into a full overwrite.
		assert.equal(
			mapAntigravityUpstreamToolCall("write_file", {
				Path: "/tmp/a.ts",
				Content: "tail",
				Append: true,
			}),
			undefined,
		);
		assert.equal(mapAntigravityUpstreamToolCall("invoke_subagent", { Prompt: "x" }), undefined);
		assert.equal(
			mapAntigravityUpstreamToolCall("run_command", {
				CommandLine: "npm run dev",
				IsDaemon: true,
				WaitMsBeforeAsync: 5000,
			}),
			undefined,
		);
		for (const wait of [500, 1000]) {
			assert.equal(
				mapAntigravityUpstreamToolCall("run_command", {
					CommandLine: "npm test",
					WaitMsBeforeAsync: wait,
				}),
				undefined,
				`wait ${wait}ms means backgrounding upstream`,
			);
		}
		assert.equal(mapAntigravityUpstreamToolCall("unknown_tool", {}), undefined);
		assert.equal(mapAntigravityUpstreamToolCall("read_file", {}), undefined);
		assert.equal(
			mapAntigravityUpstreamToolCall("read_file", {
				Path: "/tmp/a.ts",
				ByteOffset: 46080,
			}),
			undefined,
			"byte offsets cannot be expressed as line offsets",
		);
	});
});

test("bridging is disabled together with the contract", () => {
	withContractEnv("off", () => {
		assert.equal(
			mapAntigravityUpstreamToolCall("read_file", { Path: "/tmp/a.ts" }),
			undefined,
		);
	});
});
