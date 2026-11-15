# @heyhuynhgiabuu/pi-oauth-antigravity

Google Antigravity OAuth provider extension for [Pi](https://pi.dev). Connects Pi directly to Google Cloud Code Assist / Antigravity with zero-friction OAuth login, day-one support for **Gemini 3.8 Flash**, prompt-cache session affinity, and image generation.

## Features

- **Google OAuth Login**: Browser-based PKCE flow with local loopback callback (`localhost:51121`) and headless paste-URL fallback. Automatically handles token refresh with `AbortSignal` forwarding.
- **Day-One Gemini 3.8 Flash**: First-class support for `gemini-3.8-flash` with dynamic effort-tier routing (`-low`, `-medium`, `-high`), 65,536 max output token clamping, and fallback resilience.
- **Prompt Cache Affinity & Trajectory Chaining**:
  - Deterministic 63-bit session IDs derived from initial turn content.
  - Monotonic trajectory tracking (`agentId`, `trajectoryId`, `stepIndex`).
  - Response ID chaining via `labels.last_execution_id`.
  - Endpoint stickiness to prevent cluster hopping across Google's daily and fallback endpoints.
  - Cross-restart session state persistence (`.pi/agent/cache/antigravity-sessions.json`) to maintain cluster affinity across quick Pi restarts.
- **Image Generation**: Built-in `generate_image` tool and `/antigravity.image` command powered by Google's image models with aspect-ratio selection and safe directory containment.
- **Multiple accounts**: Sign in to several Google accounts, switch the active one from `/login antigravity` or `/antigravity.accounts`, see each account's quota in `/usage`, and fail over to another account when the active one runs out of plan quota.
- **Diagnostic & Usage Tools**:
  - `/antigravity.usage` — shared quota pools (Gemini 5h/weekly, Claude+GPT 5h) with plan tier and reset countdowns.
  - Optional unified dashboard: install [`pi-usage-core`](https://github.com/ReStranger/pi-usage-core) and the same pools also appear in the shared `/usage` dashboard and footer status line.
  - `/antigravity.models` — backend discovery of available Cloud Code Assist models and remaining pool fractions.
  - `/antigravity.doctor` — connection check, token expiry inspection, account failover, and diagnostic dump.

## Supported Models

| Public Model ID | Backend Wire ID | Max Output | Context Window |
| :--- | :--- | :--- | :--- |
| `antigravity/gemini-4-hydrogen` | `gemini-4-hydrogen-{low,medium,high,xhigh}`† | 65,536† | 1,048,576† |
| `antigravity/gemini-4-carbon` | `gemini-4-carbon-{low,medium,high}`† | 65,536† | 1,048,576† |
| `antigravity/gemini-4-argon` | `gemini-4-argon-{low,medium,high}` | 65,536† | 1,048,576† |
| `antigravity/gemini-3.8-flash` | `gemini-3.8-flash-{low,medium,high}` | 65,536 | 1,048,576 |
| `antigravity/gemini-3.7-flash` | `gemini-3.7-flash-{low,medium,high}` | 65,536 | 1,048,576 |
| `antigravity/gemini-3.7-flash-thinking` | `gemini-3.7-flash-thinking` | 65,536 | 1,048,576 |
| `antigravity/gemini-3.6-flash` | `gemini-3.6-flash-{low,medium,high}` | 65,536 | 1,048,576 |
| `antigravity/gemini-3.1-pro` | `gemini-3.1-pro` | 65,536 | 1,048,576 |
| `antigravity/claude-opus-5-5-low` | `claude-opus-5-5-low` | 64,000* | 250,000* |
| `antigravity/claude-opus-5-5-medium` | `claude-opus-5-5-medium` | 64,000* | 250,000* |
| `antigravity/claude-opus-5-5-high` | `claude-opus-5-5-high` | 64,000* | 250,000* |
| `antigravity/claude-sonnet-5-5-low` | `claude-sonnet-5-5-low` | 64,000* | 200,000* |
| `antigravity/claude-sonnet-5-5-medium` | `claude-sonnet-5-5-medium` | 64,000* | 200,000* |
| `antigravity/claude-sonnet-5-5-high` | `claude-sonnet-5-5-high` | 64,000* | 200,000* |

Hydrogen (2026-11-12) is the first model with an `-xhigh` effort tier; Carbon (2026-11-10)
and Argon (2026-10-13) top out at High. Argon/Carbon/Hydrogen are entitlement-gated
(Ultra / Enterprise / paid Pro); a rejected request falls back through the Gemini 4
family to Gemini 3.8 Flash.

`claude-opus-4-6-thinking`, `claude-sonnet-4-6` and `gpt-oss-120b-medium` were removed by
Google on **2026-11-18** and are no longer selectable; pinned overrides to their wire ids
still resolve until the backend drops them, and their retirement notices are detected and
surfaced as errors instead of assistant text.

### Third-party OAuth is a ToS risk

Google's enforcement against third-party Antigravity OAuth clients is active: appeal forms
name "using third party software to access Antigravity", and 403 `PERMISSION_DENIED /
TOS_VIOLATION` reports against third-party clients exist (oh-my-pi paused its provider on
2026-11-14 for this reason). Using this extension may put your Google account at risk —
prefer the official Antigravity IDE/CLI when possible, and don't say you weren't warned.

† Gemini 4 family: Argon wire ids verified against live discovery (2026-10-14); Carbon/Hydrogen wire ids follow the family pattern but are UNVERIFIED against a live listing. Limits and pricing are same-family estimates; a rejected request falls back to the previous Gemini 4 model, then Gemini 3.8 Flash.

\* Claude Opus 5.5 / Sonnet 5.5 are officially served (2026-11 models doc, live discovery
since 2026-10-03); the listed output/context figures stay same-family estimates until
Google publishes 5.5-specific numbers.

The request identity tracks the shipping Hub client
(`antigravity/hub/<version> (aidev_client; os_type=…; arch=…; cl=<changelist>)`). The Hub
version and Piper changelist are generated from the official Hub updater manifest, and
every call sends fresh `x-cloudaicompanion-trace-id` / `X-Aicode-Request-Id` headers — a
stale client identity silently receives a REDUCED model catalog from discovery, without an
error.

## Installation

Install directly into Pi via npm:

```bash
pi install npm:@heyhuynhgiabuu/pi-oauth-antigravity
```

Or run directly from source:

```bash
pi -e /path/to/pi-oauth-antigravity/dist/index.js
```

## Setup & Login

1. Run Pi and start the OAuth login:
   ```bash
   pi auth login --provider antigravity
   ```
2. Your browser will open the Google Sign-In page. Sign in with your Google account.
3. Once authenticated, the extension saves credentials and discovers your available Cloud Code Assist project.
4. Select or switch to any Antigravity model:
   ```bash
   pi --model antigravity/gemini-3.8-flash
   ```

### Multiple accounts

Running `/login antigravity` again opens an account menu instead of the Google sign-in page:

- **Add another Google account** opens the browser flow and saves the account.
- Selecting a saved account makes it active without opening the browser. The extension refreshes a stale access token first.
- **Remove an account…** deletes it from the saved accounts.

Saved accounts live in `antigravity-accounts.json` in Pi's agent directory (`~/.pi/agent/`); set `ANTIGRAVITY_ACCOUNTS_FILE` to use another path. The extension writes this file atomically with `0600` permissions because it holds refresh tokens. It also mirrors the active credential into Pi's `auth.json`, so the rest of Pi keeps reading credentials the way it already does.

When the active account returns a plan-quota 429 (`Individual quota reached`), the extension switches to the next saved account for that request and leaves it active for later ones. `/antigravity.doctor` reports the last switch as `accountFailover=`.

## Slash Commands

- `/antigravity.usage` — view shared quota pools (Gemini 5h/weekly, Claude+GPT 5h), plan tier, and reset countdowns.
- `/antigravity.models` — list dynamically fetched and statically registered models + remaining pool fraction.
- `/antigravity.accounts` — list saved accounts with token state, then switch or remove one (interactive).
- `/antigravity.doctor` — diagnose OAuth state, refresh token health, endpoint connectivity, and the last account failover.
- `/antigravity.image <prompt> [--aspect 1:1|16:9|...]` — generate images directly to your project.

> **Optional: unified `/usage` dashboard.** This extension always works standalone. If you also install [`pi-usage-core`](https://github.com/ReStranger/pi-usage-core) (`pi install npm:pi-usage-core`), the Antigravity pools are additionally registered into its interactive `/usage` dashboard and persistent footer status line. `/antigravity.doctor` reports which mode is active on the `usageCore=` line.

## Upstream Prompt & Tool Sync

`src/antigravity-upstream.ts` is generated from official
[`google-antigravity/antigravity-cli`](https://github.com/google-antigravity/antigravity-cli)
releases and pins the genuine CLI system instruction plus its function
declarations. The extractor downloads the release binary, runs it headless in an
isolated sandbox (`modelProvider: "gemini"`, throwaway `GEMINI_API_KEY`,
`GOOGLE_GEMINI_BASE_URL` pointed at a local mock), and records the first
`streamGenerateContent` request before normalization:

| Placeholder | Captured value |
| :--- | :--- |
| `<workspace>` | CLI working directory / active workspace |
| `<appDataDir>` | `$HOME/.gemini/antigravity-cli` |
| `<home>` / `<sandbox>` | Capture sandbox paths |
| `<conversation-id>` | Per-conversation UUID |
| `<os>` | Host OS reported to the model |

The same extraction pins the Hub `User-Agent` identity from the official
Antigravity Hub updater manifest (`latest-x64-linux.yml`): the Hub version and
Piper changelist are refreshed together with the prompt/tools, while
`os_type`/`arch` are filled from the host at runtime. Override with
`ANTIGRAVITY_HUB_VERSION`, `ANTIGRAVITY_HUB_CL`, `ANTIGRAVITY_HUB_OS`,
`ANTIGRAVITY_HUB_ARCH`, or replace the whole header with
`ANTIGRAVITY_USER_AGENT`.

By default the extension passes this contract through on the wire: the genuine
system prompt is rendered with the real workspace, app-data directory, session
id, and OS, and sent as `systemInstruction`; the genuine Antigravity declarations
are appended after Pi's tools. Pi's own prompt is carried as a leading user turn
instead of `systemInstruction` because Antigravity answers `429
RESOURCE_EXHAUSTED` when that slot fingerprints a third-party coding agent — the
same text in a user turn is accepted. Calls to `read_file`, `write_file`,
`edit_file`, and `run_command` are bridged to Pi's `read`, `write`, `edit`, and
`bash` (with argument translation). The remaining upstream tools (subagents,
swarm, schedule, tasks, web search, questions) have no Pi built-in equivalent and
stay declared as-is; if the model calls one, Pi reports an unknown-tool error and
the model can retry with a Pi tool. The pass-through adds roughly 4k prompt
tokens per request. The genuine prompt also references Antigravity's own built-in
skills under the app-data directory; those skill files are not installed by this
extension, so reads of them will fail. Disable the whole pass-through with
`ANTIGRAVITY_UPSTREAM_CONTRACT=off`.

`/antigravity.doctor` reports the pinned release, Hub client identity (version +
changelist), model, tool count, and whether the pass-through is on.

```bash
# Refresh from the latest release
npm run extract-antigravity

# Pin a specific release / model
npm run extract-antigravity -- --tag 1.5.9 --model gemini-3.8-flash-high

# Override the Hub manifest (for a mirror or a fixed version)
npm run extract-antigravity -- --hub-manifest https://example.com/latest-x64-linux.yml

# Fail on drift (CI)
npm run extract-antigravity:check
```

The `Sync Antigravity Upstream Contract` GitHub Actions workflow runs daily,
commits prompt/tool/identity changes, and re-runs typecheck and the test suite.



> **Optional: unified `/usage` dashboard.** This extension always works standalone. If you also install [`pi-usage-core`](https://github.com/ReStranger/pi-usage-core) (`pi install npm:pi-usage-core`), the Antigravity pools are additionally registered into its interactive `/usage` dashboard and persistent footer status line. `/antigravity.doctor` reports which mode is active on the `usageCore=` line.

## Development

```bash
# Install dependencies
npm install

# Run unit tests
npm test

# Typecheck
npm run typecheck

# Build TypeScript to dist/
npm run build
```

## Credits & Upstream

Vendored and adapted from [Rahularya01/pi-antigravity](https://github.com/Rahularya01/pi-antigravity) (MIT License) with prompt-cache session affinity, day-one Gemini 3.8 Flash catalog, response chaining, and cross-process persistence.

## License

[MIT](LICENSE) © 2026 huynhgiabuu
