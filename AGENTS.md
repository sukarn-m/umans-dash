# UMANS-Proxy — Developer Guide

## Project Structure

```
UMANS-PROXY/
├── proxy.js              # Main proxy implementation + request router (~3390 lines)
├── dashboard.html        # Dashboard with usage cards, model list, key management, Sleev toggle
├── .config/
│   └── config.json       # Runtime configuration (API key, KEYS array, enabled models, etc.)
├── .cache/               # Cached assets (auto-created)
│   ├── wallpaper.jpg           # Cached Bing wallpaper
│   ├── wallpaper-haven.jpg      # Cached Wallhaven wallpaper
│   └── wallpaper-freegen.jpg   # Current FreeGen AI wallpaper (pending swap file: wallpaper-freegen.pending.jpg)
├── .logs/                # HTTP error logs (auto-created, per-session rotating files)
├── package.json          # Project metadata (MIT, no deps)
├── LICENSE               # MIT license
├── README.md             # User documentation
└── AGENTS.md             # This file
```

## Key Components

### 1. Constants & Config (proxy.js:1-86, 452-581)

- `UMANS_API_BASE` — `https://api.code.umans.ai/v1`
- `API_KEY_ENV_VAR` — `UMANS_API_KEY`
- `MODELS_DEV_CATALOG_URL` — `https://models.dev/api.json` (external reasoning metadata)
- `SLEEV_GATEWAY_HOST` / `SLEEV_GATEWAY_PORT` / `SLEEV_GATEWAY_BASE` — Sleev gateway connection (`127.0.0.1:17321`)
- `IS_BUN` — Detected at runtime (`typeof Bun !== 'undefined'`)
- `RUNTIME_VERSION` — Bun or Node version string
- Error logging system (`initErrorLogger`, `redactHeaders`, `redactBodyJson`, `logHttpError`) — writes rotating error logs to `.logs/errors-*.log` with header/body redaction
- `loadConfig()` (line 452) — Loads `.config/config.json` with env var overrides (`LISTEN_ADDR`, `UPSTREAM_BASE_URL`, `REQUEST_TIMEOUT`, `UMANS_API_KEY`, `API_KEYS`, `CACHE_TTL`, `CACHE_MAX_SIZE`, `CACHE_ENABLED`, `OVERRIDE_CONCURRENCY`, `MAX_IMAGES`, `SLEEV_ENABLED`, `VISION_HANDOFF_ENABLED`, `VISION_HANDOFF_MODEL`, `VISION_HANDOFF_PROMPT`). Loads the `KEYS` array from config for key pool persistence.
- `saveConfig()` (line 545) / `debouncedSaveConfig()` (line 575) — Writes config (debounced 500ms), including `KEYS` array persistence
- `parseDuration()` (line 523) — Parses strings like `15m`, `6h`, `30s` to ms
- `maskToken(key)` (line 537) — Masks an API key for display as `prefix...suffix`
- `parseListenPort(addr)` (line 541) — Parses `LISTEN_ADDR` into a port number

### 2. Global State (proxy.js:88-375)

| Variable | Type | Purpose |
|---|---|---|
| `config` | Object | Runtime config object |
| `userInfoCache` | Object | `{ data, time, ttl: 60000 }` |
| `startTime` | Date | Server start timestamp |
| `keyPool` | KeyPool/null | Multi-key pool instance |
| `globalSessionCounter` | Number | Incrementing session counter for logging |
| `conversationMap` | Map | Bounded (10k) session → key affinity store |
| `activeRequests` | Number | In-flight upstream requests |
| `requestQueue` | Array | FIFO array of pending requests when at concurrency limit |
| `MAX_QUEUE_SIZE` | 256 | Hard cap on queue depth; rejects with 503 when full |
| `modelCatalogCache` / `modelCatalogCacheTime` | Object/Number | Cached model catalog data + fetch timestamp |
| `modelCatalogFetchPromise` | Promise/null | Dedup promise for concurrent catalog fetches (race condition fix) |
| `modelDisplayNameMap` | Object | Maps model IDs → display names (populated from `/v1/models/info`) |
| `modelInfoMap` | Object | Maps model IDs → full capability metadata |
| `modelsDevCache` / `modelsDevCacheTime` | Object/Number | Cached models.dev catalog for reasoning metadata |
| `RATE_LIMIT_MAP` | Object | Per-model rate limit delays |
| `MAX_BODY_SIZE` | Number | Hard request body cap (5 MB) |
| `MAX_RETRIES` | Number | Upstream chat-completion retries (10) |
| `RETRY_DELAY_MS` | Number | Base retry backoff (3000 ms) |
| `sleevState` | Object | Sleev gateway lifecycle state (`{ binary, gatewayProcess, signInProcess, ready, lastError }`) |
| `usageCache` | Object | Cached upstream usage data (5-min TTL) |
| `lastConcurrency` | Object | Last fetched concurrency data |

### 3. Shell-Tool Guard (proxy.js:120-288)

`isGitCommand(cmd)` detects shell commands that start with or invoke `git` (`git clean -fd`, `bash -c "git status"`, `cmd /c git ...`, quoted Windows paths to `git.exe`, etc.) while ignoring false positives such as `echo git` or `python script.py git`.

`sanitizeShellToolCall(tc)` and `sanitizeChatCompletionResponse(body)` modify returned assistant `tool_calls` whose tool name matches `bash | shell | run_command_in_terminal | execute_command | run_in_terminal | send_to_terminal | run_vscode_command | create_and_run_task | terminal`. When a matched command is detected, the tool argument is rewritten to `echo "BLOCKED: git commands are disabled by proxy policy"` before the response reaches the client.

SSE streaming responses are also sanitized via `sanitizeSseResponse(text)` (line 226), which buffers the full stream, assembles partial tool_calls, runs the shell guard, and re-emits sanitized SSE events.

Applies to:
- Non-streaming chat responses
- Streaming SSE responses (buffered and re-emitted)
- Cached responses on cache hit

### 3b. Anthropic Messages API Pass-Through (proxy.js:2301-2412)

The proxy exposes `/v1/messages` (and `/messages`) for Anthropic-compatible clients (e.g., opencode with `@ai-sdk/anthropic`). Since the upstream UMANS API already natively supports Anthropic format at `/v1/messages`, the proxy **passes through** requests directly without translation:

- `proxyAnthropicRequest()` (line 2301) — Acquires a key from the pool (with session affinity), forwards the Anthropic request body to `upstream.messages()`, and pipes the response directly back to the client via `await pipeBodyToResponse()`.
- `handleAnthropicMessages()` (line 2390) — Entry point for `/v1/messages`; applies `limitImagesInMessages` cap, then queues or dispatches.
- No shell-tool guard or cache for Anthropic pass-through (upstream handles these).
- **Vision handoff** is applied before the upstream call: if the resolved model has `supports_vision: "via-handoff"`, images are extracted and sent to the handoff model (default `umans-kimi-k2.7`), then replaced with text descriptions in the payload.
- **Key health**: `markHealthy()` is called on success (line 2379); `markUnhealthy()` only on 503 upstream or network-level fetch failures (not on 500, which is usually a payload issue).
- **Concurrency queue**: Anthropic requests participate in the same bounded queue as OpenAI requests.

### 3c. Vision Handoff (proxy.js:1139-1295)

Models whose `capabilities.supports_vision === "via-handoff"` (e.g. `umans-glm-5.2`, `umans-glm-5.1`) cannot process images natively. The proxy intercepts these requests and delegates image analysis to a vision-capable handoff model:

1. `needsVisionHandoff(resolvedModel)` (line 1154) — checks `modelInfoMap` for `via-handoff` flag.
2. `collectImageParts(payload)` (line 1173) — walks `payload.system` and `payload.messages`, collecting image parts in both OpenAI (`image_url`) and Anthropic (`image` with `source.base64`/`source.url`) formats.
3. `analyzeImageViaHandoff(dataUri, slot, ...)` (line 1219) — makes a non-streaming `chatCompletions` call to the handoff model (default `umans-kimi-k2.7`) with a system analysis prompt + the image.
4. `performVisionHandoff(payload, resolvedModel, ...)` (line 1270) — replaces each image part in-place with a `{type: "text", text: "[User pasted image]\n<description>"}` block.

**Config keys**: `VISION_HANDOFF_ENABLED` (default `true`), `VISION_HANDOFF_MODEL` (default `umans-kimi-k2.7`), `VISION_HANDOFF_PROMPT` (default built-in analysis prompt when empty).

Applied to both the OpenAI path (`proxyChatRequest`) and the Anthropic path (`proxyAnthropicRequest`) after model resolution and before the upstream call. On the OpenAI path, the handoff runs after the cache check, so cache hits skip the handoff entirely.
- Concurrency queue supports Anthropic requests alongside OpenAI requests.

### 3d. Sleev Context-Compression Gateway (proxy.js:1299-1517)

The proxy manages an optional [Sleev](https://sleev.ai) gateway that compresses context before forwarding to the proxy. Topology: `opencode → Sleev (compress) → UMANS-PROXY → UMANS`.

- `resolveSleevBinary()` (line 1308) — Resolves the Sleev binary from `node_modules/.bin/sleev` or global PATH.
- `isSleevLoggedIn()` / `isSleevGatewayHealthy()` (lines 1321, 1332) — CLI status checks.
- `startSleevSignIn()` (line 1353) — Spawns `sleev auth login` for interactive OAuth browser sign-in (180s timeout).
- `spawnSleevGateway()` (line 1390) — Binds the gateway to `127.0.0.1:17321` and spawns the daemon process.
- `startSleev()` (line 1443) — Full startup: binary resolution → sign-in check → setup → gateway spawn → health wait.
- `stopSleev()` (line 1495) — Kills gateway and sign-in child processes.
- `getSleevStatus()` (line 1508) — Returns `{ enabled, ready, binary, lastError, loggedIn, gatewayBase }`.
- **Config key**: `SLEEV_ENABLED` (default `false`). Env var: `SLEEV_ENABLED`.
- When enabled and ready, `setupOpencodeConfig()` points opencode at the Sleev gateway (with `sleeve-harness` and `sleeve-base-url` headers) instead of the proxy directly, and disables opencode's own context pruning (`compaction.prune = false`).
- Graceful shutdown hooks kill the Sleev gateway on SIGINT/SIGTERM/exit.

### 4. Retry Logic (proxy.js:376-385, 2499-2623)

`retryLoop(fn)` retries the upstream `/v1/chat/completions` request up to `MAX_RETRIES` times with escalating delays (`3s, 6s, 9s…`).

- Retries occur on:
  - **HTTP 500** — regardless of response body / message
  - **HTTP 503** — regardless of response body / message
  - Network/fetch failures (treated as 502) that throw before a response is received
- On each retry the current key is marked unhealthy so the key pool rotates to the next healthy key. On retry attempts after the first, a fresh key is acquired from the pool if multiple keys are available (key rotation on retry).
- Non-retryable HTTP errors (e.g. 400, 401, 404, 429 without a configured rate-limit map) are returned immediately.


### 4. Response Cache (proxy.js:404-450)

LRU cache for non-streaming LLM responses using Map insertion order.
- **Key**: MD5 of `(model + stream_flag + system + messages + tools)`
- **TTL**: Configurable (default 60s), **Max size**: default 100
- **Stats**: `hits`, `misses`, `evictions`
- `cacheKey(payload, model)` (line 442) — builds MD5 hash
- `GET/DELETE /api/cache` — stats/clear
- Cached responses are passed through the shell-tool guard before being returned to the client.

### 6. Key Pool (proxy.js:990-1074)

Round-robin multi-key pool with cooldown/unhealthy marking. The `KEYS` array is persisted in config and loaded on startup.
- `acquire(preferredIndex)` — Round-robins, returns `{ key, name, index }`, sets `config.apiKey` + `upstream.apiKey`. Uses a mutex for thread-safe acquisition. Supports session affinity via `preferredIndex`.
- `markUnhealthy(index, status)` — Cooldown varies by status (503→60s, 502→30s, else 10s)
- `markHealthy(index)` — Resets state
- `get state()` — Returns array with masked tokens (first 10 + `...` + last 4)
- `get total()` / `get healthyCount()` — Pool stats

### 7. Upstream Client & Model Catalog (proxy.js:1519-1616)

- `UpstreamClient` class (line 1519) with `getUserInfo()` (GET `/v1/models/info`, 10s timeout), `chatCompletions(body)` (POST `/v1/chat/completions`), and `messages(body)` (POST `/v1/messages` for Anthropic pass-through).
- `UPSTREAM_AGENT` — Keep-alive HTTPS agent (128 sockets, 60s keepalive, 300s timeout)
- `fetchModelCatalog()` (line 1578) — GET `/v1/models/info` with 15s timeout
- `getCatalogData()` (line 1592) — Cached 5-min catalog fetcher with dedup promise (`modelCatalogFetchPromise`) to prevent concurrent fetch races. Populates `modelDisplayNameMap` and `modelInfoMap`.
- `fetchUpstreamModels()` (line 2188) — Fetches `/v1/models` for pricing data (5-min cache)

### 8. Tool Schema Normalization (proxy.js:1769-1874)

Normalizes JSON Schema in tools to handle `$ref`, `$defs`, `definitions`, nullable patterns.
- Key functions: `normalizeToolSchemas`, `normalizeSchemaMap`, `tryResolveRef`, `simplifyNullableCombinator`, `normalizeTypeField`, `normalizeEnumField`

### 9. Stream/Body Utilities (proxy.js:1876-1953)

- `isNodeStream(body)` — Duck-type check for Node.js streams
- `readBodyText(body)` — Handles Node streams, Web ReadableStreams, and async iterables
- `pipeBodyToResponse(body, res)` — Pipes upstream response to HTTP response with abort handling and cleanup

### 10. HTTP Handler Helpers (proxy.js:2110-2158)

- `authorized(req)` — Checks `x-api-key` or `Authorization: Bearer ***` against `config.apiKeys`
- `readBody(req)` — Promisified chunk collector with `MAX_BODY_SIZE` cap
- `writeJSON(res, status, payload)` — Safe JSON response writer (handles encode failures)
- `writeOpenAIError(res, status, message, type, code)` — OpenAI-format error response
- `writeAnthropicError(res, status, message, type)` — Anthropic-format error response (line 292)
- `writeAnthropicPassthroughError(res, status, body)` — Parses upstream Anthropic error body (line 298)
- `writePassthroughError(res, status, body)` — OpenAI-format passthrough error (line 2625)

### 11. Core HTTP Handlers (proxy.js:2160-2629)

- `handleHealthz` (line 2160) — Returns uptime, token_state, models_count, runtime, cache stats, sleev status
- `handleModels` (line 2209) — OpenAI-format model list from catalog. **Pricing format**: upstream per-million prices are converted to per-token (divided by 1,000,000) for Hermes/opencode compatibility. Each model entry includes `context_length`, `limit`, `display_name`, and `pricing` fields when available.
- `processQueue()` (line 2263) — Dequeues from `requestQueue` while `activeRequests < limit`. Dispatches to `proxyAnthropicRequest` or `proxyChatRequest` based on `format`.
- `handleChatCompletions` (line 2281) — Parses body, checks queue overflow (`MAX_QUEUE_SIZE`), queues or executes via `proxyChatRequest`
- `handleAnthropicMessages` (line 2390) — Entry point for `/v1/messages`; applies image cap, queues or executes via `proxyAnthropicRequest`
- `proxyChatRequest` (line 2414) — Full proxy pipeline: key acquire → session label → reasoning strip → image-attachment limit (`limitImagesInMessages`) → cache check → model resolve → tool normalize → reasoning caps → rate limit → **retry-wrapped upstream call** (see Retry Logic) → shell-tool guard → stream/non-stream response. The full request body of the first request in a new session is logged to the console. HTTP errors are logged to `.logs/` via `logHttpError`.
- `proxyAnthropicRequest` (line 2301) — Anthropic pass-through: key acquire → session label → model resolve → vision handoff → upstream `messages()` call → `await pipeBodyToResponse()` → key health marking.
- `validateApiKey()` (line 2631) — Calls `getUserInfo()`, populates `userInfoCache` + `modelDisplayNameMap` + `modelInfoMap`, returns boolean

### 12. Request Router (proxy.js:2645-3052)

| Route | Methods | Description |
|---|---|---|
| `/` or `/dashboard` | GET | Serve `dashboard.html` with current wallpaper embedded as base64 in `<head>` to prevent white flash. Kicks off background FreeGen refresh after serving. |
| `/api/config` | GET/POST | Config read/write (masks API key). POST updates keys, wallpaperSource, sleevEnabled, etc. |
| `/api/validate` | GET | Validate API key → `{ valid, hasApiKey }` |
| `/api/models` | GET | Returns `{ models, disabled_models, model_display_names }` |
| `/api/bg` | GET | Bing wallpaper proxy (peapix.com), cached daily |
| `/api/bg-wallhaven` | GET | Wallhaven wallpaper proxy, cached hourly |
| `/api/bg-freegen` | GET/POST | FreeGen AI wallpaper generator. `GET` returns current cached wallpaper; `POST` generates and returns new image (`prompt`, `ratio`, `wait` JSON body). Background generation writes to `.cache/wallpaper-freegen.pending.jpg` and atomically swaps to `.cache/wallpaper-freegen.jpg` when done. |
| `/api/keys` | GET/POST | Multi-key CRUD (add/update/delete). Persists `KEYS` array to config. |
| `/api/cache` | GET/DELETE | Cache stats/clear |
| `/api/umans/usage` | GET | UMANS usage data (proxied from upstream `/usage` with 5-min cache) |
| `/api/umans/usage-history` | GET | Usage history (currently returns empty buckets) |
| `/api/umans/concurrency` | GET | Concurrent sessions, limit, active count, queue depth, user_id |
| `/api/umans/user` | GET | Stub: returns `{ loggedIn: true, email: '' }` (login/logout endpoints removed) |
| `/api/sleev` | GET/POST | Get Sleev gateway status / toggle Sleev on/off |
| `/api/restart` | POST | Triggers `process.exit(42)` after 500ms (server.close + graceful shutdown) |
| `/healthz` | GET | Health check (includes sleev status) |
| `/v1/models` | GET | OpenAI-format models (pricing in per-token format) |
| `/v1/models/info` | GET | Raw model catalog (modelInfoMap) |
| `/v1/chat/completions` | POST | OpenAI chat (concurrency-queued, bounded) |
| `/v1/messages` or `/messages` | POST | Anthropic Messages API (pass-through, concurrency-queued) |

### 13. Opencode Config Discovery & Setup (proxy.js:3054-3259)

- `discoverOpencodeConfigs()` (line 3054) — Native filesystem discovery on Windows: scans `C:\Users` for directories and checks each for `.opencode/opencode.json` and `.config/opencode/opencode.json`, plus the `systemprofile` variant. Falls back to `~/.config/opencode/` and `~/.opencode/`. Non-Windows: returns existing parent dirs of the two fallback paths. Results are cached 5 minutes.
- `debouncedSetupOpencodeConfig()` (line 3116) — Debounced wrapper that prevents concurrent setup runs.
- `setupOpencodeConfig()` (line 3132) — Writes ALL models from `getEffectiveModels()` to every discovered `opencode.json`. Each model entry includes `id`, `name`, `reasoning`, `temperature`, `tool_call`, `attachment`, `modalities`, and `limit` (context/output). Reasoning variants are built from UMANS capability levels. Creates `openconfig.b4umans.json` backup before first edit. Provider key: `umans`, uses `@ai-sdk/openai-compatible` (OpenAI-compatible, baseURL `http://localhost:{port}/v1`).
- When Sleev is enabled and ready, the provider entry points to the Sleev gateway (`http://127.0.0.1:17321/v1`) with `sleeve-harness` and `sleeve-base-url` headers, and opencode's own context pruning is disabled (`compaction.prune = false`).
- Integrates with [models.dev](https://models.dev) catalog (`fetchModelsDevCatalog`, line 1618) for reasoning metadata enrichment.

### 14. Usage Tracking & Concurrency (proxy.js:948-986)

- `fetchUsage()` (line 951) — Fetches usage data from upstream `/usage` endpoint with 5-min cache
- `fetchConcurrency()` (line 966) — Extracts `usage.concurrent_sessions`, `limits.concurrency.limit`, and `user_id` from cached usage data
- `getEffectiveConcurrency()` (line 976) — Returns `{ concurrent, limit, overridden, user_id }`. If `config.overrideConcurrency > 0`, the effective concurrency limit is capped to `min(override, apiLimit)` (or override when the API limit is unknown).
- **Note**: `loginToApp()`, `EMAIL`, `PASSWORD`, and `APP_BASE` have been removed. The `/api/umans/login` and `/api/umans/logout` endpoints no longer exist. `/api/umans/user` is a stub returning `{ loggedIn: true, email: '' }`.

### 15. Dashboard (dashboard.html, ~824 lines)

- **Window Card** — Stat Cards: Requests, Tokens, Cached % (3 inline stat cards). No Concurrent stat in this card.
- **Concurrency Card** — Shows Active, Queued, Limit stats with progress bar and detail grid. No badge in the card header. User ID is shown in the detail grid with click-to-reveal masking (not blur/scramble).
- **API Key section** — Key pool display with SS Mode (blur on hover). Collapsible.
- **Models section** — View-only list of models from catalog, with enable/disable toggle per model. Collapsible.
- **Quick Actions** — Check Health, Test Connection, Refresh Usage, Restart Proxy. Expanded by default.
- **Environment** — Runtime, Port, Started At, SS Mode toggle, Wallpaper selector (None/Bing/Wallhaven/FreeGen), FreeGen prompt input + Generate button, Sleev toggle with status display. Collapsible.
- **Key Management Modal** — Add/edit/delete API keys with inline editing. Shows account info with User ID (click-to-reveal masking via `.masked-userid` with `data-userid` attribute — dots displayed by default, click to reveal real ID, click again to re-mask). No email field. Copy-to-clipboard button for User ID.
- **Sleev Integration** — Toggle in Environment card. When sign-in is required, shows `npx sleev auth login` command with copy button. Polls `/api/sleev` for status updates every 3s.
- **Glass UI** — Procedural SVG filter-based glassmorphism (`feDisplacementMap`, `feColorMatrix`, `feGaussianBlur`). Liquid glass effect computed per-card via `initLiquidGlass()`.
- **Wallpaper Loader** — Transparent overlay (`background:transparent`) shown until wallpaper is loaded, then fades out. `body` CSS does not set `background-color` (server-injected `<style>` in `<head>` handles it).
- **Auto-refresh** — Status every 15s, usage every 30s, concurrency every 15s.
- **No Test Chat** — Removed entirely. No model selector or streaming chat panel.
- **No i18n/Autotranslate** — All `data-i18n` attributes, `t()` function, translate overlay, and LOCALE config removed from dashboard. The i18n catalog and `/api/i18n` endpoint still exist in proxy.js but are unused by the dashboard.

### 16. Dashboard ↔ UMANS API Data Flow

The dashboard does not talk to UMANS directly. All UMANS data passes through the proxy endpoints below, which cache responses for 5 minutes and forward the raw UMANS payload.

| Dashboard source | Proxy endpoint | Upstream call | Purpose |
|---|---|---|---|
| Requests / Tokens / Cached % (Window card) | `GET /api/umans/usage` | Upstream usage API | Current usage window |
| Concurrency card (Active / Queued / Limit / User ID) | `GET /api/umans/concurrency` | Upstream usage API (via `fetchConcurrency`) | Active sessions, limit, queue depth |

#### `/api/umans/usage` response shape

Proxy forwards an object shaped like:

```json
{
  "usage": {
    "requests_in_window": 246,
    "tokens_in": 24000000,
    "tokens_out": 11732073,
    "tokens_cached": 9360000
  },
  "window": { /* optional date/scope metadata from UMANS */ },
  "plan": { /* optional plan info, e.g. { "display_name": "..." } */ }
}
```

The dashboard derives:
- `Requests = usage.requests_in_window`
- `Tokens = usage.tokens_in + usage.tokens_out`
- `Cached % = (usage.tokens_cached / usage.tokens_in) * 100`

It will prefer fields under `u.window` if that object contains usage fields, falling back to `u.usage`.

#### `/api/umans/usage-history` response shape

Currently returns empty buckets (`{ history: { buckets: [] } }`). The 90-day usage history table has been removed from the dashboard.

#### Window Token Estimation Workaround

UMANS sometimes returns mismatched scopes: `requests_in_window` is window-scoped, but `tokens_in`/`tokens_out` equal the 90-day total. In that case the numbers make no sense together, e.g.:

| | Requests | Tokens |
|---|---|---|
| Window | 246 | 35,732,073 |
| 90-Day | 643 | 35,732,073 |

The dashboard detects this signature (`winReqs > 0 && winReqs < histReqs && winTokens >= histTokens`) and replaces the raw window token value with a proportional estimate derived from the per-day history rows:

1. Sort buckets newest → oldest.
2. Walk backward, taking full days until the remaining request budget is smaller than the next day.
3. Prorate the last day by `remainingReqs / day.requests`.
4. Aggregate tokens, input tokens, and cached tokens the same way.
5. Change the card label to **“Tokens (est.)”** with a tooltip explaining the fallback.

The estimate assumes requests are spread roughly evenly through a day. It is only applied when the bug is detected; otherwise the dashboard shows the UMANS-supplied numbers verbatim.

## Startup Sequence

1. `loadConfig()` — Load `.config/config.json` + env var overrides (including `KEYS` array)
2. `ResponseCache` — Init with config values
3. `KeyPool` — Init from `config.keys` or single default key
4. `UpstreamClient` — Init HTTP client
5. `validateApiKey()` — Verify via `/v1/models/info`, populates `modelDisplayNameMap` + `modelInfoMap`
6. `fetchConcurrency()` — Fetch concurrent sessions & limit from usage API
7. `getModelsDevCatalog()` — Preload models.dev reasoning metadata
8. `startSleev()` — If `SLEEV_ENABLED`, start Sleev gateway (sign-in → setup → spawn → health check)
9. `http.createServer(handleRequest).listen(port, '127.0.0.1')` — Start HTTP server on port 8084 (with port-retry on EADDRINUSE)
10. `setupOpencodeConfig()` — Discover + write ALL models to all opencode.json configs, deferred 100ms after server is listening. Also opens browser to dashboard on first run.
11. Graceful shutdown hooks registered (SIGINT, SIGTERM, beforeExit, exit) — stop Sleev gateway and close server.

## FreeGen AI Wallpaper

The proxy integrates [FreeGen.app](https://freegen.app/) as a background source. It replicates the site's flow:

1. Call `POST https://prompt-signer.freegen.app/api/test` with the prompt to get `ts` + `sig`.
2. Call `POST https://image-generator.freegen.app/api/test` with `{ prompt, ts, sig, ratio_id }` to get a `job_id`.
3. Open a native `WebSocket` to `wss://websocket-bridge.freegen.app/ws` (with `Origin: https://freegen.app`) and subscribe to the `job_id`. The server pushes a `result` message with `image_data`, or an `error`.
4. Download the image, write it to `.cache/wallpaper-freegen.pending.jpg`, then `fs.renameSync` it to `.cache/wallpaper-freegen.jpg` so the swap is atomic and never exposes a partial image.

### Background-generation behavior

- Dashboard `GET /`/`/dashboard` embeds the current FreeGen wallpaper as base64 in the HTML `<head>` so the page background is visible immediately without a white flash.
- After serving the page, the proxy kicks off a **background** FreeGen generation for the next dashboard load. That generation writes to the pending file and atomically swaps it on completion.
- The dashboard's **FreeGen** mode adds a prompt input and **Generate** button. Clicking it calls `POST /api/bg-freegen` with `wait: true` and applies the returned image immediately via `URL.createObjectURL`, also saving the prompt to config.

### Endpoints

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/api/bg-freegen` | GET | — | Current cached `.cache/wallpaper-freegen.jpg` JPEG, or 404. With `?wait=1`, blocks until a new wallpaper is generated. |
| `/api/bg-freegen` | POST | `{ prompt, ratio?, wait? }` | `wait: true` returns the generated JPEG and applies `wallpaperSource: 'freegen'`. `wait: false` returns `202 Accepted` and generates in the background. |

### Configuration

- Config key `FREEGEN_PROMPT` / env var `FREEGEN_PROMPT` — default prompt used when `wallpaperSource` is `freegen`.
- Config key `wallpaperSource` — one of `none`, `bing`, `wallhaven`, or `freegen`.
- Dashboard exposes `freegenPrompt` and `wallpaperSource` in `/api/config` and persists them on change.

## Testing

```bash
node --check proxy.js          # Syntax check
node proxy.js                  # Start proxy
curl http://localhost:8084/healthz
curl http://localhost:8084/v1/models
curl http://localhost:8084/api/umans/usage
curl http://localhost:8084/api/umans/concurrency
curl http://localhost:8084/api/sleev
```

## Dependencies

Zero external npm dependencies — uses only Node.js built-in modules: `fs`, `path`, `os`, `http`, `https`, `url`, `crypto`, `child_process` (for Sleev), plus native `fetch` (Node 18+) and native `WebSocket` (Node 24+) for the FreeGen integration.

## Data Storage

- `.config/config.json` — Full proxy config including API keys, `KEYS` array (persisted key pool), enabled/disabled models, display names, `OVERRIDE_CONCURRENCY`, `MAX_IMAGES`, `wallpaperSource`, `FREEGEN_PROMPT`, `SLEEV_ENABLED`, vision handoff settings, `DISABLED_MODELS`
- `.cache/wallpaper.jpg` — Cached Bing wallpaper
- `.cache/wallpaper-haven.jpg` — Cached Wallhaven wallpaper
- `.cache/wallpaper-freegen.jpg` — Current FreeGen AI wallpaper
- `.cache/wallpaper-freegen.pending.jpg` — In-progress FreeGen wallpaper; renamed to `.cache/wallpaper-freegen.jpg` only when complete
- `.logs/errors-*.log` — Rotating HTTP error logs with redacted headers/bodies

## Concurrency Queue

- `activeRequests` — Counter of in-flight upstream requests
- `requestQueue` — FIFO array of pending requests
- `MAX_QUEUE_SIZE` (256) — Hard cap on queue depth. When the queue is full, new requests are rejected with HTTP 503 (`queue_full` / `overloaded_error`).
- `processQueue()` — Dequeues when `activeRequests < limit`
- Each completed request calls `processQueue()` via `.finally()`
- Both OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) paths participate in the same queue.

## Notes for Opencode Agents

When working on UMANS-Proxy through opencode, keep the following in mind to avoid common tool failures.

### Edit tool / exact replacements

Opencode's `edit` tool requires an exact text match for `oldString`. If the error `Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.` appears, follow these steps:

1. **Read the file first** with the `read` tool and copy the exact block you want to replace, including all spaces, tabs, and line endings.
2. **Paste that verbatim** into the `edit` call's `oldString` parameter.
3. **Include more surrounding lines** if the same string appears multiple times in the file (or use `replaceAll: true` only when you intend to replace every occurrence).
4. If matching remains difficult, use the `write` tool to overwrite the entire file instead.

### Web research

- Use `webfetch` to retrieve content from a known URL.
- Do **not** call `websearch`; it is not available unless the OpenCode provider or `OPENCODE_ENABLE_EXA` is enabled. Prefer `webfetch` for documentation or GitHub source lookups.

### Provider configuration

- The proxy auto-writes a `umans` provider into every discovered `opencode.json`.
- The generated config explicitly sets `"instructions": ["AGENTS.md", "skills.md"]` so this guide is loaded on startup. (Note: `skills.md` may not exist in all repos; opencode silently ignores missing instruction files.)
- After the proxy updates `opencode.json`, restart opencode for the changes to take effect.
