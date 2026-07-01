# UMANS-Dash — Developer Guide

## Project Structure

```
UMANS-DASH/
├── proxy.js              # Main proxy implementation + request router (~2994 lines)
├── dashboard.html        # Dashboard with usage/concurrency/history cards, Quick Settings, key management, model list (~1556 lines)
├── .config/
│   └── config.json       # Runtime configuration (API key, KEYS array, enabled models, etc.)
├── .cache/               # Cached assets (auto-created)
│   ├── wallpaper.jpg           # Cached Bing wallpaper
│   ├── wallpaper-haven.jpg      # Cached Wallhaven wallpaper
│   └── wallpaper-freegen.jpg   # Current FreeGen AI wallpaper (pending swap file: wallpaper-freegen.pending.jpg)
├── .logs/                # HTTP error logs (auto-created, per-session rotating files)
├── screenshots/          # Dashboard screenshots for README
├── package.json          # Project metadata (MIT, no deps)
├── LICENSE               # MIT license
├── README.md             # User documentation
└── AGENTS.md             # This file
```

## Key Components

### 1. Constants & Config (proxy.js:1-120, 236-396)

- `UMANS_API_BASE` — `https://api.code.umans.ai/v1`
- `API_KEY_ENV_VAR` — `UMANS_API_KEY`
- `MODELS_DEV_CATALOG_URL` — `https://models.dev/api.json` (external reasoning metadata)
- `SLEEV_GATEWAY_HOST` / `SLEEV_GATEWAY_PORT` / `SLEEV_GATEWAY_BASE` — Sleev gateway connection (`127.0.0.1:17321`)
- `IS_BUN` — Detected at runtime (`typeof Bun !== 'undefined'`)
- `RUNTIME_VERSION` — Bun or Node version string
- Error logging system (`initErrorLogger`, `redactHeaders`, `redactBodyJson`, `logHttpError`) — writes rotating error logs to `.logs/errors-*.log` with header/body redaction
- `ImageHandoffCache` class (line 236) — LRU cache for vision handoff image descriptions. Keyed by SHA-256 hash of image data URI. 24h TTL, 50 entries max. Stats exposed in `/healthz`.
- `loadConfig()` (line 277) — Loads `.config/config.json` with env var overrides (`LISTEN_ADDR`, `UPSTREAM_BASE_URL`, `REQUEST_TIMEOUT`, `UMANS_API_KEY`, `API_KEYS`, `OVERRIDE_CONCURRENCY`, `MAX_IMAGES`, `SLEEV_ENABLED`, `VISION_HANDOFF_ENABLED`, `VISION_HANDOFF_MODEL`, `VISION_HANDOFF_PROMPT`, `VISION_HANDOFF_CACHE_ENABLED`, `VISION_HANDOFF_CACHE_TTL`). All `VISION_HANDOFF_*` flags (including `VISION_HANDOFF_ENABLED`) have matching env-var overrides. Loads the `KEYS` array from config for key pool persistence. `config.locale` is retained but deprecated (only consumed by the now-removed i18n feature).
- `parseDuration()` (line 346) — Parses strings like `15m`, `6h`, `30s` to ms. Bare digit strings (e.g. `"30000"`) are treated as milliseconds. Unparseable strings return `0`.
- `maskToken(key)` (line 357) — Masks an API key for display as `prefix...suffix`
- `parseListenPort(addr)` (line 366) — Parses `LISTEN_ADDR` into a port number
- `saveConfig()` (line 369) / `debouncedSaveConfig()` (line 394) — Writes config **atomically** (temp file `config.json.tmp` then `fs.renameSync`) to avoid partial writes, debounced 500ms, including `KEYS` array persistence. `ENABLED_MODELS` is still read/written for backwards compatibility but is deprecated.

### 2. Global State (proxy.js:88-213)

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
| `lastConcurrency` | Object | Last fetched concurrency data `{ concurrent, limit, hard_cap, user_id }` |
| `throttledCount` | Number | Proxy-side 503 queue-full rejection counter (reset on new usage window) |
| `throttledWindowStart` | String/null | Tracks current usage window start for throttle-reset logic |
| `imageHandoffCache` | ImageHandoffCache | LRU cache for vision handoff image descriptions (24h TTL, 50 entries) |
| `usageHistoryCache` | Object | Cached upstream usage history data (5-min TTL) |

### 3. Anthropic Messages API Pass-Through (proxy.js:2218-2332)

The proxy exposes `/v1/messages` (and `/messages`) for Anthropic-compatible clients (e.g., opencode with `@ai-sdk/anthropic`). Since the upstream UMANS API already natively supports Anthropic format at `/v1/messages`, the proxy **passes through** requests directly without translation:

- `proxyAnthropicRequest()` (line 2218) — Acquires a key from the pool (with session affinity), forwards the Anthropic request body to `upstream.messages()`, and pipes the response directly back to the client via `await pipeBodyToResponse()`.
- `handleAnthropicMessages()` (line 2308) — Entry point for `/v1/messages`; applies `limitImagesInMessages` cap, then queues or dispatches.
- No response cache (removed — see section 3c for the only caching that remains).
- **Vision handoff** is applied before the upstream call: if the resolved model has `supports_vision: "via-handoff"`, images are extracted and sent to the handoff model (default `umans-coder`), then replaced with text descriptions in the payload.
- **Key health**: `markHealthy()` is called on success; `markUnhealthy()` only on 503 upstream or network-level fetch failures (not on 500, which is usually a payload issue).
- **Concurrency queue**: Anthropic requests participate in the same bounded queue as OpenAI requests.

### 3b. Vision Handoff (proxy.js:1038-1212)

Models whose `capabilities.supports_vision === "via-handoff"` (e.g. `umans-glm-5.2`, `umans-glm-5.1`) cannot process images natively. The proxy intercepts these requests and delegates image analysis to a vision-capable handoff model:

1. `needsVisionHandoff(resolvedModel)` (line 1038) — checks `modelInfoMap` for `via-handoff` flag.
2. `collectImageParts(payload)` (line 1057) — walks `payload.system` and `payload.messages`, collecting image parts in both OpenAI (`image_url`) and Anthropic (`image` with `source.base64`/`source.url`) formats.
3. `analyzeImageViaHandoff(dataUri, slot, ...)` (line 1103) — makes a non-streaming `chatCompletions` call to the handoff model (default `umans-coder`) with a system analysis prompt + the image. If the handoff cache is enabled, checks `imageHandoffCache` first (SHA-256 of image data URI). On cache miss, calls upstream and caches the description on success.
4. `performVisionHandoff(payload, resolvedModel, ...)` (line 1171) — replaces each image part in-place with a `{type: "text", text: "[Image content — analyzed by vision module, shown as text because the active model cannot see images:]\n<description>"}` block. The label makes clear to the primary model that the text is authoritative image content, not user commentary.

**Config keys**: `VISION_HANDOFF_ENABLED` (default `false`), `VISION_HANDOFF_MODEL` (default `umans-coder`), `VISION_HANDOFF_PROMPT` (default built-in analysis prompt when empty), `VISION_HANDOFF_CACHE_ENABLED` (default `false`), `VISION_HANDOFF_CACHE_TTL` (default `24h`).

Applied to both the OpenAI path (`proxyChatRequest`) and the Anthropic path (`proxyAnthropicRequest`) after model resolution and before the upstream call.

The vision handoff cache (`ImageHandoffCache`) stores image analysis results keyed by SHA-256 hash of the image data URI, so repeated identical images skip re-analysis within the TTL window. Cache stats (hits, misses, entries) are exposed in `/healthz` and rendered in the dashboard's Quick Settings under the Handoff Cache toggle.

### 3c. Sleev Context-Compression Gateway (proxy.js:1214-1424)

The proxy manages an optional [Sleev](https://sleev.ai) gateway that compresses context before forwarding to the proxy. Topology: `opencode → Sleev (compress) → UMANS-DASH → UMANS`.

- `resolveSleevBinary()` (line 1214) — Resolves the Sleev binary from `node_modules/.bin/sleev` or global PATH.
- `isSleevLoggedIn()` / `isSleevGatewayHealthy()` (lines 1227, 1238) — CLI status checks.
- `startSleevSignIn()` (line 1259) — Spawns `sleev auth login` for interactive OAuth browser sign-in (180s timeout).
- `spawnSleevGateway()` (line 1296) — Binds the gateway to `127.0.0.1:17321` and spawns the daemon process.
- `startSleev()` (line 1349) — Full startup: binary resolution → sign-in check → setup → gateway spawn → health wait.
- `stopSleev()` (line 1401) — Kills gateway and sign-in child processes.
- `getSleevStatus()` (line 1414) — Returns `{ enabled, ready, binary, lastError, loggedIn, gatewayBase }`.
- **Config key**: `SLEEV_ENABLED` (default `false`). Env var: `SLEEV_ENABLED`.
- When enabled and ready, `setupOpencodeConfig()` points opencode at the Sleev gateway (with `sleeve-harness` and `sleeve-base-url` headers) instead of the proxy directly, and disables opencode's own context pruning (`compaction.prune = false`).
- Graceful shutdown hooks kill the Sleev gateway on SIGINT/SIGTERM/exit.

### 4. Retry Logic (proxy.js:214-235, 2499-2520)

`retryLoop(fn)` retries the upstream `/v1/chat/completions` request up to `MAX_RETRIES` times with escalating delays (`3s, 6s, 9s…`).

- Retries occur on:
  - **HTTP 500** — regardless of response body / message
  - **HTTP 503** — regardless of response body / message
  - Network/fetch failures (treated as 502) that throw before a response is received
- On each retry the current key is marked unhealthy so the key pool rotates to the next healthy key. On retry attempts after the first, a fresh key is acquired from the pool if multiple keys are available (key rotation on retry).
- Non-retryable HTTP errors (e.g. 400, 401, 404, 429 without a configured rate-limit map) are returned immediately.

### 5. Key Pool (proxy.js:855-948)

Round-robin multi-key pool with cooldown/unhealthy marking. The `KEYS` array is persisted in config and loaded on startup.
- `acquire(preferredIndex)` — Round-robins, returns `{ key, name, index }`, sets `config.apiKey` + `upstream.apiKey`. Uses a mutex for thread-safe acquisition. Supports session affinity via `preferredIndex`.
- `markUnhealthy(index, status)` — Cooldown varies by status (503→60s, 502→30s, else 10s)
- `markHealthy(index)` — Resets state
- `get state()` — Returns array with masked tokens (first 10 + `...` + last 4)
- `get total()` / `get healthyCount()` — Pool stats

### 6. Upstream Client & Model Catalog (proxy.js:1425-1674)

- `UpstreamClient` class (line 1425) with `getUserInfo()` (GET `/v1/models/info`, 10s timeout), `chatCompletions(body)` (POST `/v1/chat/completions`), and `messages(body)` (POST `/v1/messages` for Anthropic pass-through).
- `UPSTREAM_AGENT` — Keep-alive HTTPS agent (128 sockets, 60s keepalive, 300s timeout)
- `fetchModelCatalog()` (line 1484) — GET `/v1/models/info` with 15s timeout
- `getCatalogData()` (line 1498) — Cached 5-min catalog fetcher with dedup promise (`modelCatalogFetchPromise`) to prevent concurrent fetch races. Populates `modelDisplayNameMap` and `modelInfoMap`.
- `fetchModelsDevCatalog()` (line 1524) — Fetches models.dev catalog for reasoning metadata enrichment.
- `fetchUpstreamModels()` (line 2106) — Fetches `/v1/models` for pricing data (5-min cache)

### 7. Tool Schema Normalization (proxy.js:1675-1780)

Normalizes JSON Schema in tools to handle `$ref`, `$defs`, `definitions`, nullable patterns.
- Key functions: `normalizeToolSchemas`, `normalizeSchemaMap`, `tryResolveRef`, `simplifyNullableCombinator`, `normalizeTypeField`, `normalizeEnumField`

### 8. Stream/Body Utilities (proxy.js:1782-1870)

- `isNodeStream(body)` — Duck-type check for Node.js streams
- `readBodyText(body)` — Handles Node streams, Web ReadableStreams, and async iterables
- `pipeBodyToResponse(body, res)` — Pipes upstream response to HTTP response with abort handling, cleanup, and **backpressure handling**. When `res.write()` returns `false` and the body is a Node stream, the upstream is paused (`body.pause()`) and resumed on `res` `drain`. A `paused` boolean guard ensures only one `drain` listener is registered at a time (prevents listener accumulation across consecutive backpressure events). Client disconnects are detected via `res.on('close')`, which triggers an idempotent `finish()` cleanup that removes the listener and destroys the upstream body. `finish()` is invoked in all 6 resolve paths, guaranteeing no leaked listeners or streams.

### 9. HTTP Handler Helpers (proxy.js:2023-2073)

- `authorized(req)` — Checks `x-api-key` or `Authorization: Bearer <key>` against `config.apiKeys`
- `readBody(req)` — Promisified chunk collector with `MAX_BODY_SIZE` cap. On size overflow, calls `req.destroy()` before rejecting so the underlying socket is torn down promptly.
- `writeJSON(res, status, payload)` — Safe JSON response writer (handles encode failures)
- `writeOpenAIError(res, status, message, type, code)` — OpenAI-format error response
- `writeAnthropicError(res, status, message, type)` — Anthropic-format error response (line 128)
- `writeAnthropicPassthroughError(res, status, body)` — Parses upstream Anthropic error body (line 134)
- `writePassthroughError(res, status, body)` — OpenAI-format passthrough error (line 2520)

### 10. Core HTTP Handlers (proxy.js:2074-2556)

- `handleHealthz` (line 2074) — Returns uptime, token_state, models_count, runtime, sleev status, vision handoff status + cache stats
- `handleModels` (line 2127) — OpenAI-format model list from catalog. **Pricing format**: upstream per-million prices are converted to per-token (divided by 1,000,000) for Hermes/opencode compatibility. Each model entry includes `context_length`, `max_output_tokens`, `display_name`, and `pricing` fields when available. The output token limit is exposed as a top-level `max_output_tokens` field (not nested inside a `limit` object) to avoid key collisions with Hermes' pricing alias extractor, which walks all nested dicts and would otherwise match `limit.output` as a pricing value.
- `processQueue()` (line 2178) — Dequeues from `requestQueue` while `activeRequests < limit`. Dispatches to `proxyAnthropicRequest` or `proxyChatRequest` based on `format`.
- `handleChatCompletions` (line 2197) — Parses body, checks queue overflow (`MAX_QUEUE_SIZE`), queues or executes via `proxyChatRequest`
- `handleAnthropicMessages` (line 2308) — Entry point for `/v1/messages`; applies image cap, queues or executes via `proxyAnthropicRequest`
- `proxyChatRequest` (line 2333) — Full proxy pipeline: key acquire → session label → reasoning strip → image-attachment limit (`limitImagesInMessages`, skips handoff models) → model resolve → tool normalize → reasoning caps → `normalizeThinkingPayload` (camelCase → snake_case) → SSE keepalive flush (if vision handoff will run on a streaming request) → vision handoff → rate limit → **retry-wrapped upstream call** (see Retry Logic) → stream/non-stream response. On the first request in a new session, the user prompt is logged to the console truncated to 80 chars. HTTP errors are logged to `.logs/` via `logHttpError`.
- `normalizeThinkingPayload(payload)` (line 967) — Rewrites camelCase `budgetTokens` back to snake_case `budget_tokens` for UMANS Pydantic compatibility. The `@ai-sdk/openai-compatible` provider camelCases snake_case keys from opencode.json, but the upstream rejects camelCase. Applied on both OpenAI and Anthropic paths.
- **SSE streaming path**: The upstream SSE stream is piped directly to the client via `pipeBodyToResponse()` for real-time streaming, with client-disconnect detection (the upstream body is destroyed if the client closes mid-stream).
- **SSE keepalive during vision handoff** — When a streaming request will trigger vision handoff, the proxy flushes SSE headers + a keepalive comment before the handoff runs. This prevents client timeouts and duplicate sessions from retries while the handoff makes its multi-second round-trip. `writeJSON` detects `headersSent` and emits errors as SSE events instead of crashing.
- `proxyAnthropicRequest` (line 2218) — Anthropic pass-through: key acquire → session label → model resolve → `normalizeThinkingPayload` → vision handoff → upstream `messages()` call → `await pipeBodyToResponse()` → key health marking. First-prompt console logs are truncated to 80 chars (same as the OpenAI path).
- `validateApiKey()` (line 2526) — Calls `getUserInfo()`, populates `userInfoCache` + `modelDisplayNameMap` + `modelInfoMap`, returns boolean

### 11. Request Router (proxy.js:2557-2955)

| Route | Methods | Description |
|---|---|---|
| `/` or `/dashboard` | GET | Serve `dashboard.html` with current wallpaper embedded as base64 in `<head>` to prevent white flash. Kicks off background FreeGen refresh after serving. |
| `/api/config` | GET/POST | Config read/write (masks API key). POST updates keys, wallpaperSource, sleevEnabled, visionHandoffEnabled, visionHandoffCacheEnabled, etc. Returns `restartRequired: true` when `listenAddr` changes. |
| `/api/validate` | GET | Validate API key → `{ valid, hasApiKey }` |
| `/api/models` | GET | Returns `{ models, disabled_models, model_display_names }` |
| `/api/bg` | GET | Bing wallpaper proxy (peapix.com), cached daily |
| `/api/bg-wallhaven` | GET | Wallhaven wallpaper proxy, cached hourly |
| `/api/bg-freegen` | GET/POST | FreeGen AI wallpaper generator. `GET` returns current cached wallpaper; `POST` generates and returns new image (`prompt`, `ratio`, `wait` JSON body). Background generation writes to `.cache/wallpaper-freegen.pending.jpg` and atomically swaps to `.cache/wallpaper-freegen.jpg` when done. |
| `/api/keys` | GET/POST | Multi-key CRUD (add/update/delete). All responses return only a masked `safe` array (`{ name, token_masked, has_token, has_session }`) — **raw keys are never returned**. Persists `KEYS` array to config. |
| `/api/umans/usage` | GET | UMANS usage data (proxied from upstream `/usage` with 5-min cache; `?fresh=1` bypasses cache) |
| `/api/umans/usage-history` | GET | UMANS usage history (proxied from upstream `/usage/history` with 5-min cache; `?fresh=1` bypasses cache). Supports `from`, `to`, `granularity`, `scope` query params. |
| `/api/umans/concurrency` | GET | Concurrent sessions, limit, hard_cap, active count, queue depth, user_id (`?fresh=1` bypasses cache) |
| `/api/umans/user` | GET | UMANS user info. Returns `user_id` sourced from `lastConcurrency` (falls back to `userInfoCache`), not a hardcoded stub. |
| `/api/sleev` | GET/POST | Get Sleev gateway status / toggle Sleev on/off |
| `/api/restart` | POST | Triggers `process.exit(42)` after 500ms (server.close + graceful shutdown) |
| `/healthz` | GET | Health check (includes sleev status, vision handoff status + cache stats) |
| `/v1/models` | GET | OpenAI-format models (pricing in per-token format) |
| `/v1/models/info` | GET | Raw model catalog (modelInfoMap) |
| `/v1/chat/completions` | POST | OpenAI chat (concurrency-queued, bounded) |
| `/v1/messages` or `/messages` | POST | Anthropic Messages API (pass-through, concurrency-queued) |

### 12. Opencode Config Discovery & Setup (proxy.js:2960-3180)

- `discoverOpencodeConfigs()` (line 2960) — Native filesystem discovery on Windows: scans `C:\Users` for directories and checks each for `.opencode/opencode.json` and `.config/opencode/opencode.json`, plus the `systemprofile` variant. Falls back to `~/.config/opencode/` and `~/.opencode/`. Non-Windows: returns existing parent dirs of the two fallback paths. Results are cached 5 minutes.
- `debouncedSetupOpencodeConfig()` (line 3022) — Debounced wrapper that prevents concurrent setup runs.
- `setupOpencodeConfig()` (line 3053) — Writes ALL models from `getEffectiveModels()` to every discovered `opencode.json`. Each model entry includes `id`, `name`, `reasoning`, `temperature`, `tool_call`, `attachment`, `modalities`, and `limit` (context/output). Reasoning variants are built from UMANS capability levels. Creates `openconfig.b4umans.json` backup before first edit. Provider key: `umans`, uses `@ai-sdk/openai-compatible` (OpenAI-compatible, baseURL `http://localhost:{port}/v1`).
- When Sleev is enabled and ready, the provider entry points to the Sleev gateway (`http://127.0.0.1:17321/v1`) with `sleeve-harness` and `sleeve-base-url` headers, and opencode's own context pruning is disabled (`compaction.prune = false`).
- Integrates with [models.dev](https://models.dev) catalog (`fetchModelsDevCatalog`, line 1524) for reasoning metadata enrichment.

### 13. Usage Tracking, History & Concurrency (proxy.js:773-870)

- `bumpThrottled()` (line 773) — Increments `throttledCount`; called when the concurrency queue is full and a 503 is returned to the client.
- `fetchUsageHistory({ from, to, granularity, scope }, fresh)` (line 779) — Fetches usage history from upstream `/usage/history` endpoint with 5-min cache. Supports `from`, `to`, `granularity` (day/hour), and `scope` query params. Cache key includes all params.
- `fetchUsage(fresh = false)` (line 802) — Fetches usage data from upstream `/usage` endpoint with 5-min cache. When `fresh` is `true`, bypasses the cache and always re-fetches. Also detects usage-window changes (via `window.started_at`) and resets `throttledCount` when a new window begins.
- `fetchConcurrency(fresh = false)` (line 823) — Extracts `usage.concurrent_sessions`, `limits.concurrency.limit`, `limits.concurrency.hard_cap`, and `user_id` from cached usage data. Passes `fresh` through to `fetchUsage`.
- `getEffectiveConcurrency()` (line 837) — Returns `{ concurrent, limit, hard_cap, overridden, user_id }`. The proxy gates on `hard_cap ?? limit` (burst capacity) before queueing. If `config.overrideConcurrency > 0`, the effective `hard_cap` is capped to `min(override, apiHardCap)` (or override when the API hard_cap is unknown).
- **Note**: `loginToApp()`, `EMAIL`, `PASSWORD`, and `APP_BASE` have been removed. The `/api/umans/login` and `/api/umans/logout` endpoints no longer exist.

### 14. Dashboard (dashboard.html, ~1556 lines)

- **5-hour Window Card** — Stat Cards: Requests, Throttled, Cached % (3 inline stat cards using auto-fit grid). Detail grid: Start Time, Tokens In, Tokens Out. Throttled counts proxy-side 503 queue-full rejections (reset when usage window changes). A plan badge is shown in the card header when `plan.display_name` is available. Error % stat shows the true error rate in Tokens mode, filter-aware in Requests mode.
- **Current Concurrency Card** — 4 stat cards: Active (green border), Queued (blue border), Limit (soft, yellow border), Burst (hard cap, orange border). Progress bar: solid fill = proxy active count (green in soft-cap region, gradient green→orange in burst region), dotted overlay = upstream concurrent sessions. Bottom border bars: yellow for soft-cap zone, orange for burst zone. Percentage is scaled to 100% at soft cap, 200% at hard cap. Detail grid: Queued (shown only when > 0). User ID is displayed in the header bar (click-to-reveal masking).
- **Usage History Card** — Bar chart with Y-axis labels, dashed grid lines, and X-axis labels. Click a bar to filter the table to that date. Table shows consolidated per-date rows (Date, Requests, Tokens In, Tokens Out, Cache %, Peak) with clickable sort headers. Click a row to expand an animated detail table showing per-model breakdown (Model, Requests, Tokens In, Tokens Out, Cache %) with its own sortable headers. Metric toggle (Tokens/Requests) controls chart scale and default sort. Status legend (OK/Cancelled/Error) shown only in Requests mode; hidden in Tokens mode (only OK statuses shown).
- **User ID in header bar** — Displayed left of the Online indicator. Click-to-reveal masking via `.masked-userid` with `data-userid` attribute.
- **API Key section** — Key pool display with status badges. Collapsible. Shows key count badge in header.
- **Models section** — View-only list of models from catalog, with enable/disable toggle per model (via `DISABLED_MODELS`). Collapsible.
- **Quick Settings** (expanded by default) — Automatic Refresh button group (30s/1m/2m/5m=298s), Wallpaper selector (None/Bing/Wallhaven/FreeGen), FreeGen prompt + Generate button, Context Compression (Sleev) toggle with info tooltip, Vision Handoff toggle with info tooltip, Handoff Cache toggle (shown only when Vision Handoff is enabled) with cache stats line.
- **Quick Actions** (collapsed) — Check Health, Test Connection, Manual Refresh, Restart Proxy.
- **Environment** (collapsed) — Runtime, Port, Started At.
- **Key Management Modal** — Add/edit/delete API keys with inline editing. Shows account info with User ID (click-to-reveal masking, copy-to-clipboard button).
- **Sleev Integration** — Toggle in Quick Settings. When sign-in is required, shows `npx sleev auth login` command with copy button. Polls `/api/sleev` for status updates every 3s.
- **Glass UI** — Procedural SVG filter-based glassmorphism (`feDisplacementMap`, `feColorMatrix`, `feGaussianBlur`). Liquid glass effect computed per-card via `initLiquidGlass()`.
- **Wallpaper Loader** — Transparent overlay shown until wallpaper is loaded, then fades out. `body` CSS does not set `background-color` (server-injected `<style>` in `<head>` handles it).
- **Auto-refresh** — Status every 15s, usage via configurable interval (default 30s, set in Quick Settings), concurrency every 15s. Dashboard always fetches usage and concurrency with `?fresh=1` to bypass server-side cache. Usage history refreshes every 5 minutes.
- **Card Grid** — Stat cards use CSS grid with JS-driven equal-column layout (`layoutStatGrids()`) that picks the largest divisor of the item count keeping each column at least 120px wide, ensuring equal columns per row.
- **No Test Chat** — Removed entirely.
- **No i18n/Autotranslate** — All `data-i18n` attributes, `t()` function, translate overlay, and LOCALE config removed from dashboard. The dead i18n code in proxy.js has also been removed entirely (~363 lines: `I18N_STRINGS`, `handleI18n`, all translation helpers, and the `/api/i18n` route). `config.locale` is retained with a deprecation comment for backwards compatibility but does nothing.

### 15. Dashboard ↔ UMANS API Data Flow

The dashboard does not talk to UMANS directly. All UMANS data passes through the proxy endpoints below, which cache responses for 5 minutes and forward the raw UMANS payload.

| Dashboard source | Proxy endpoint | Upstream call | Purpose |
|---|---|---|---|
| Requests / Throttled / Cached % / Error % / Start Time / Tokens In / Tokens Out (5-hour Window card) | `GET /api/umans/usage` | Upstream usage API | Current usage window; throttled is proxy-side 503 queue-full count |
| Concurrency card (Active / Queued / Limit / Burst / User ID) | `GET /api/umans/concurrency` | Upstream usage API (via `fetchConcurrency`) | Active sessions, soft limit, hard cap, queue depth |
| Usage History card (chart + table) | `GET /api/umans/usage-history` | Upstream `/usage/history` | Per-bucket, per-model usage breakdown with tokens_cached_read |

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
  "plan": { /* optional plan info, e.g. { "display_name": "..." } */ },
  "throttled": 0
}
```

The dashboard derives:
- `Requests = usage.requests_in_window`
- `Throttled = throttled` (proxy-side count of 503 queue-full rejections, reset when usage window changes)
- `Cached % = (usage.tokens_cached / usage.tokens_in) * 100`
- `Error %` — computed from all buckets in Tokens mode (unfiltered), or from visible statuses in Requests mode
- `Start Time = window.started_at`
- `Tokens In = usage.tokens_in`
- `Tokens Out = usage.tokens_out`

## Startup Sequence

1. `loadConfig()` — Load `.config/config.json` + env var overrides (including `KEYS` array)
2. `imageHandoffCache.resize(50, config.visionHandoffCacheTtl)` — Configure handoff cache TTL
3. `KeyPool` — Init from `config.keys` or single default key
4. `UpstreamClient` — Init HTTP client
5. `validateApiKey()` — Verify via `/v1/models/info`, populates `modelDisplayNameMap` + `modelInfoMap`
6. `fetchConcurrency()` — Fetch concurrent sessions & limit from usage API
7. `getModelsDevCatalog()` — Preload models.dev reasoning metadata
8. `startSleev()` — If `SLEEV_ENABLED`, start Sleev gateway (sign-in → setup → spawn → health check)
9. `http.createServer(handleRequest).listen(port, '127.0.0.1')` — Start HTTP server on port 8084 (with port-retry on EADDRINUSE)
10. `setupOpencodeConfig()` — Discover + write ALL models to all opencode.json configs, deferred 100ms after server is listening. Also opens browser to dashboard on first run.
11. Graceful shutdown hooks registered (SIGINT, SIGTERM, beforeExit, exit) — `gracefulShutdown()` stops the Sleev gateway, closes the server, then polls `activeRequests` every 100ms (5s timeout) before calling `process.exit(0)` so in-flight requests can drain.

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
curl http://localhost:8084/api/umans/usage-history
curl http://localhost:8084/api/umans/concurrency
curl http://localhost:8084/api/sleev
```

## Dependencies

Zero external npm dependencies — uses only Node.js built-in modules: `fs`, `path`, `os`, `http`, `https`, `url`, `crypto`, `child_process` (for Sleev), plus native `fetch` (Node 18+) and native `WebSocket` (Node 24+) for the FreeGen integration.

## Data Storage

- `.config/config.json` — Full proxy config including API keys, `KEYS` array (persisted key pool), enabled/disabled models, display names, `OVERRIDE_CONCURRENCY`, `MAX_IMAGES`, `wallpaperSource`, `FREEGEN_PROMPT`, `SLEEV_ENABLED`, `VISION_HANDOFF_ENABLED`, `VISION_HANDOFF_MODEL`, `VISION_HANDOFF_PROMPT`, `VISION_HANDOFF_CACHE_ENABLED`, `VISION_HANDOFF_CACHE_TTL`, `DISABLED_MODELS`
- `.cache/wallpaper.jpg` — Cached Bing wallpaper
- `.cache/wallpaper-haven.jpg` — Cached Wallhaven wallpaper
- `.cache/wallpaper-freegen.jpg` — Current FreeGen AI wallpaper
- `.cache/wallpaper-freegen.pending.jpg` — In-progress FreeGen wallpaper; renamed to `.cache/wallpaper-freegen.jpg` only when complete
- `.logs/errors-*.log` — Rotating HTTP error logs with redacted headers/bodies

## Concurrency Queue

- `activeRequests` — Counter of in-flight upstream requests
- `requestQueue` — FIFO array of pending requests
- `MAX_QUEUE_SIZE` (256) — Hard cap on queue depth. When the queue is full, new requests are rejected with HTTP 503 (`queue_full` / `overloaded_error`).
- `processQueue()` — Dequeues when `activeRequests < gate` (where gate = `hard_cap ?? limit`)
- Each completed request calls `processQueue()` via `.finally()`
- Both OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) paths participate in the same queue.

## Removed Features

The following features have been completely removed from the codebase:

- **Git Guard / Shell-Tool Guard** — Removed entirely. No `isGitCommand`, `sanitizeShellToolCall`, `sanitizeChatCompletionResponse`, or `sanitizeSseResponse` functions. SSE streaming always pipes directly to the client. No `SHELL_TOOL_GUARD` config key.
- **General Response Cache** — Removed entirely. No `ResponseCache` class, `cacheKey()`, or `responseCache` instance. No `CACHE_ENABLED`, `CACHE_TTL`, `CACHE_MAX_SIZE` config keys. No `/api/cache` endpoint. No cache stats in `/healthz` or the dashboard. The only caching that remains is the `ImageHandoffCache` for vision handoff (see section 3b).
- **i18n / Autotranslate** — Removed entirely (~363 lines). No `I18N_STRINGS` catalog, `handleI18n`, translation helpers, or `/api/i18n` route. `config.locale` is retained with a deprecation comment but serves no function.

## Notes for Opencode Agents

When working on UMANS-Dash through opencode, keep the following in mind to avoid common tool failures.

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
