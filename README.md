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
  - Integrates with [`pi-usage-core`](https://github.com/ReStranger/pi-usage-core), which registers Antigravity quota pools (Gemini 5h/weekly, Claude+GPT 5h) in the unified `/usage` dashboard and footer status line.
  - `/antigravity.models` lists the Cloud Code Assist models the backend offers and the remaining pool fractions.
  - `/antigravity.doctor` checks the connection, inspects token expiry, and dumps diagnostics.

## Supported Models

| Public Model ID | Backend Wire ID | Max Output | Context Window |
| :--- | :--- | :--- | :--- |
| `antigravity/gemini-4-argon` | `gemini-4-argon-{low,medium,high}`† | 65,536† | 1,048,576† |
| `antigravity/gemini-3.8-flash` | `gemini-3.8-flash-{low,medium,high}` | 65,536 | 1,048,576 |
| `antigravity/gemini-3.7-flash` | `gemini-3.7-flash-{low,medium,high}` | 65,536 | 1,048,576 |
| `antigravity/gemini-3.7-flash-thinking` | `gemini-3.7-flash-thinking` | 65,536 | 1,048,576 |
| `antigravity/gemini-3.6-flash` | `gemini-3.6-flash-{low,medium,high}` | 65,536 | 1,048,576 |
| `antigravity/gemini-3.1-pro` | `gemini-3.1-pro` | 65,536 | 1,048,576 |
| `antigravity/claude-opus-4-6` | `claude-opus-4-6` | 64,000 | 200,000 |
| `antigravity/claude-opus-5-5-low` | `claude-opus-5-5-low` | 64,000* | 250,000* |
| `antigravity/claude-opus-5-5-medium` | `claude-opus-5-5-medium` | 64,000* | 250,000* |
| `antigravity/claude-opus-5-5-high` | `claude-opus-5-5-high` | 64,000* | 250,000* |
| `antigravity/claude-sonnet-4-6` | `claude-sonnet-4-6` | 64,000 | 200,000 |
| `antigravity/claude-sonnet-5-5-low` | `claude-sonnet-5-5-low` | 64,000* | 200,000* |
| `antigravity/claude-sonnet-5-5-medium` | `claude-sonnet-5-5-medium` | 64,000* | 200,000* |
| `antigravity/claude-sonnet-5-5-high` | `claude-sonnet-5-5-high` | 64,000* | 200,000* |
| `antigravity/gpt-oss-120b` | `gpt-oss-120b` | 8,192 | 131,072 |

† Inferred from runtime ids referenced by Antigravity IDE 2.23.0, not yet confirmed against a live model listing; limits and pricing are provisional, and requests fall back to Gemini 3.8 Flash if the backend rejects the model.

\* Provisional same-family estimates only; Claude 5.5 backend output/context limits have not been verified.

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

- `/antigravity.models` lists dynamically fetched and statically registered models with the remaining pool fraction.
- `/antigravity.accounts` lists saved accounts with token state, then switches or removes one (interactive).
- `/antigravity.doctor` diagnoses OAuth state, refresh token health, endpoint connectivity, and the last account failover.
- `/antigravity.image <prompt> [--aspect 1:1|16:9|...]` generates images directly to your project.

> **Quota & Usage Tracking**: Quota tracking is now powered by [`pi-usage-core`](https://github.com/ReStranger/pi-usage-core). Install `pi-usage-core` to view Antigravity pools in the interactive `/usage` dashboard and persistent footer status line.

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
