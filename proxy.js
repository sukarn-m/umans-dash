// UMANS-Proxy - v2026-06-12
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const UMANS_API_BASE = 'https://api.code.umans.ai/v1';
const API_KEY_ENV_VAR = 'UMANS_API_KEY';
const APP_BASE = 'https://app.umans.ai';
const MODELS_DEV_CATALOG_URL = 'https://models.dev/api.json';

const FREEGEN_PROMPT_SIGNER = 'https://prompt-signer.freegen.app/api/test';
const FREEGEN_IMAGE_GENERATOR = 'https://image-generator.freegen.app/api/test';
const FREEGEN_WS_BRIDGE = 'wss://websocket-bridge.freegen.app/ws';

const SLEEV_GATEWAY_HOST = '127.0.0.1';
const SLEEV_GATEWAY_PORT = 17321;
const SLEEV_GATEWAY_BASE = `http://${SLEEV_GATEWAY_HOST}:${SLEEV_GATEWAY_PORT}`;

let ERROR_LOG_FILE = null;
const ERROR_LOG_DIR = '.logs';

function initErrorLogger() {
  if (ERROR_LOG_FILE) return;
  const dir = path.join(__dirname, ERROR_LOG_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  ERROR_LOG_FILE = path.join(dir, `errors-${ts}.log`);
}

function redactHeaders(headers) {
  const sensitive = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie', 'api-key']);
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const low = k.toLowerCase();
    if (sensitive.has(low) || low.includes('auth') || low.includes('token') || low.includes('key') || low.includes('password') || low.includes('secret')) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redactBodyJson(body) {
  try {
    if (!body || typeof body !== 'string') return body;
    const parsed = JSON.parse(body);
    function walk(o) {
      if (!o || typeof o !== 'object') return o;
      if (Array.isArray(o)) return o.map(walk);
      const out = {};
      for (const [k, v] of Object.entries(o)) {
        const low = k.toLowerCase();
        if (low === 'api_key' || low === 'apikey' || low.includes('token') || low.includes('password') || low.includes('secret') || low.includes('authorization')) {
          out[k] = '[REDACTED]';
        } else if (k === 'messages' && Array.isArray(v)) {
          out[k] = v.map(walk);
        } else if (k === 'content' && typeof v === 'string' && v.length > 2000) {
          out[k] = v.slice(0, 2000) + '...[truncated]';
        } else if (typeof v === 'object') {
          out[k] = walk(v);
        } else {
          out[k] = v;
        }
      }
      return out;
    }
    return JSON.stringify(walk(parsed), null, 2);
  } catch (e) {
    return body;
  }
}

const ERROR_LOG_LOCK = Promise.resolve();
async function logHttpError(record) {
  initErrorLogger();
  await ERROR_LOG_LOCK;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...record,
  }, null, 2);
  fs.appendFileSync(ERROR_LOG_FILE, `--- HTTP ERROR ---\n${line}\n\n`);
}

const IS_BUN = typeof Bun !== 'undefined';
const RUNTIME_VERSION = IS_BUN ? Bun.version : process.version.replace('v', '');

let config = null;
let userInfoCache = { data: null, time: 0, ttl: 60000 };
let startTime = new Date();
let keyPool = null;
let globalSessionCounter = 0;
let conversationMap = new Map(); // fingerprint -> { tokenIndex, requestCount, sessNum }
const CONVERSATION_MAP_MAX = 10000;

function touchConversation(fingerprint) {
  const session = conversationMap.get(fingerprint);
  if (session) {
    conversationMap.delete(fingerprint);
    conversationMap.set(fingerprint, session);
  }
  return session;
}

function trackConversationSession(fingerprint, session) {
  if (!fingerprint) return;
  if (conversationMap.size >= CONVERSATION_MAP_MAX) {
    const target = Math.floor(CONVERSATION_MAP_MAX * 0.8);
    const iter = conversationMap.keys();
    while (conversationMap.size > target) {
      const key = iter.next().value;
      if (key === undefined) break;
      conversationMap.delete(key);
    }
  }
  conversationMap.delete(fingerprint);
  conversationMap.set(fingerprint, session);
}

// ── Shell-command guard ─────────────────────────────────────────────────────
// Blocks tool_calls that execute shell commands starting with "git" (case-
// insensitive), e.g. "git clean -fd", "git reset", or wrappers like
// "bash -c 'git status'". Works like GC3OC's tool-salvager, but installed
// directly in the chat-completion proxy path.
const SHELL_TOOL_NAMES = /^(bash|shell|run_command_in_terminal|execute_command|run_in_terminal|send_to_terminal|run_vscode_command|create_and_run_task|terminal)$/i;
// Direct "git" executable, including quoted paths with spaces and "git.exe" on Windows.
const GIT_EXECUTABLE_RE = /^(?:[\s]*["'])?(?:[a-zA-Z]:)?(?:[\\\/][^"']+)*[\\\/]?git(?:\.exe)?\b/i;
// Simple shell wrappers: bash -c "...", cmd /c ..., powershell -Command "...", etc.
const SHELL_WRAPPER_RE = /^(?:bash|sh|zsh|cmd|command|powershell|pwsh|fish|csh|ksh)(?:\.exe)?(?:\s+(?:\-[a-zA-Z]+|\/[a-zA-Z])+)*\s+(?:['"]|\-c\s+|\/c\s+)/i;
// Common git subcommands; used to avoid false positives when "git" is just a word argument.
const GIT_SUBCOMMAND_RE = /\b(git)\s+(?:add|commit|push|pull|clone|fetch|merge|rebase|reset|checkout|clean|rm|mv|status|log|diff|branch|tag|cherry|revert|stash|bisect|blame|init|remote|config|submodule|sparse|worktree|reflog|show|describe|rev|ls|cat)\b/i;

function isGitCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return false;
  const trimmed = cmd.trim();
  if (GIT_EXECUTABLE_RE.test(trimmed)) return true;
  if (SHELL_WRAPPER_RE.test(trimmed) && GIT_SUBCOMMAND_RE.test(trimmed)) return true;
  return false;
}

function sanitizeShellToolCall(tc) {
  if (!tc || !tc.function) return tc;
  if (!SHELL_TOOL_NAMES.test(tc.function.name || '')) return tc;
  let args;
  try {
    args = JSON.parse(tc.function.arguments || '{}');
  } catch {
    return tc;
  }
  const cmd = args.command;
  if (!isGitCommand(cmd)) return tc;

  const blockedMsg = 'echo "BLOCKED: git commands are disabled by proxy policy"';
  console.log(`[ShellGuard] blocked ${tc.function.name}: ${cmd.substring(0, 200)}`);
  return {
    ...tc,
    function: {
      ...tc.function,
      arguments: JSON.stringify({ ...args, command: blockedMsg }),
    },
  };
}

function sanitizeChatCompletionResponse(body) {
  if (!body || typeof body !== 'object') return body;
  if (!Array.isArray(body.choices)) return body;
  for (const choice of body.choices) {
    const msg = choice.message;
    if (!msg || !Array.isArray(msg.tool_calls)) continue;
    msg.tool_calls = msg.tool_calls.map(sanitizeShellToolCall);
  }
  return body;
}

// ── SSE stream sanitizer ──────────────────────────────────────────────────
// Buffers an OpenAI-style streaming response, assembles partial tool_calls,
// runs the shell guard, and re-emits sanitized SSE events. We accept the small
// latency trade-off because agent tool-call streams are short, and rewriting
// partial tool_call argument chunks mid-stream is fragile.
function parseSseEvents(text) {
  const events = [];
  let currentEvent = null;
  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      if (currentEvent) { events.push(currentEvent); currentEvent = null; }
    } else if (line.startsWith('event:')) {
      if (!currentEvent) currentEvent = { data: '' };
      currentEvent.event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      if (!currentEvent) currentEvent = { data: '' };
      // Preserve newlines inside data by replacing literal "data:" lines
      if (line === 'data:') {
        currentEvent.data += '\n';
      } else {
        currentEvent.data += line.slice(5).trimStart() + '\n';
      }
    } else if (line.startsWith('id:')) {
      if (!currentEvent) currentEvent = { data: '' };
      currentEvent.id = line.slice(3).trim();
    } else if (line.startsWith('retry:')) {
      if (!currentEvent) currentEvent = { data: '' };
      currentEvent.retry = line.slice(6).trim();
    }
  }
  if (currentEvent) events.push(currentEvent);
  for (const e of events) e.data = e.data.replace(/\n$/, '');
  return events;
}

function serializeSseEvents(events) {
  return events.map((e) => {
    let out = [];
    if (e.event) out.push(`event: ${e.event}`);
    if (e.id) out.push(`id: ${e.id}`);
    if (e.retry) out.push(`retry: ${e.retry}`);
    if (e.data !== undefined && e.data !== null) {
      for (const line of String(e.data).split(/\r?\n/)) {
        out.push(`data: ${line}`);
      }
    }
    out.push('');
    return out.join('\n');
  }).join('\n') + '\n';
}

function sanitizeSseResponse(text) {
  const events = parseSseEvents(text);
  const accum = {};
  for (const e of events) {
    if (e.event === 'ping' || !e.data) continue;
    let obj;
    try { obj = JSON.parse(e.data); } catch { continue; }
    const delta = obj.choices?.[0]?.delta;
    if (!delta?.tool_calls) continue;
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!accum[idx]) accum[idx] = { index: idx, id: '', type: 'function', function: { name: '', arguments: '' } };
      const a = accum[idx];
      if (tc.id) a.id = tc.id;
      if (tc.type) a.type = tc.type;
      if (tc.function?.name) a.function.name += tc.function.name;
      if (tc.function?.arguments != null) a.function.arguments += tc.function.arguments;
    }
  }
  const indices = Object.keys(accum).map(Number).sort((a, b) => a - b);
  const originalTools = indices.map(i => accum[i]);
  const sanitizedTools = originalTools.map(sanitizeShellToolCall);
  let anyBlocked = false;
  for (let i = 0; i < sanitizedTools.length; i++) {
    if (sanitizedTools[i] !== originalTools[i]) { anyBlocked = true; break; }
  }
  if (!anyBlocked) return text;

  // Replace blocked tool call argument chunks with the final blocked command.
  const firstEmitted = new Set();
  const outEvents = [];
  for (const e of events) {
    if (e.event === 'ping' || !e.data) { outEvents.push(e); continue; }
    let obj;
    try { obj = JSON.parse(e.data); } catch { outEvents.push(e); continue; }
    const delta = obj.choices?.[0]?.delta;
    const toolCalls = delta?.tool_calls;
    if (!Array.isArray(toolCalls)) { outEvents.push(e); continue; }
    let modified = false;
    for (const tc of toolCalls) {
      const idx = tc.index ?? 0;
      const sanitized = sanitizedTools[indices.indexOf(idx)];
      if (!sanitized || sanitized === originalTools[indices.indexOf(idx)] || !tc.function) continue;
      if (!firstEmitted.has(idx)) {
        tc.function.name = sanitized.function.name;
        tc.function.arguments = sanitized.function.arguments;
        firstEmitted.add(idx);
      } else {
        // This and any further args chunks for this tool become no-ops.
        tc.function.arguments = '';
      }
      modified = true;
    }
    if (modified) {
      // Remove tool_call entries that have no payload (empty trailing chunks).
      delta.tool_calls = toolCalls.filter(tc => tc.id || tc.function?.name || tc.function?.arguments);
      outEvents.push({ ...e, data: JSON.stringify(obj) });
    } else {
      outEvents.push(e);
    }
  }
  return serializeSseEvents(outEvents);
}

// ── Anthropic error helpers ───────────────────────────────────────────────

function writeAnthropicError(res, statusCode, message, errorType) {
  if (!message) message = http.STATUS_CODES[statusCode] || 'Unknown error';
  const typeMap = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error', 500: 'api_error', 503: 'overloaded_error' };
  writeJSON(res, statusCode, { type: 'error', error: { type: errorType || typeMap[statusCode] || 'api_error', message } });
}

function writeAnthropicPassthroughError(res, statusCode, body) {
  const trimmed = (body || '').trim();
  let message = trimmed;
  let errorType = 'api_error';
  try { const p = JSON.parse(trimmed); message = p.error?.message || p.message || trimmed; errorType = p.error?.type || 'api_error'; } catch {}
  writeJSON(res, statusCode, { type: 'error', error: { type: errorType, message } });
}

let activeRequests = 0;
let requestQueue = [];

let modelCatalogCache = null;
let modelCatalogCacheTime = 0;
let modelDisplayNameMap = {};
let modelInfoMap = {};
const MODEL_CATALOG_CACHE_TTL = 5 * 60 * 1000;

function getOrderedModelIds() {
  const ids = Object.keys(modelInfoMap);
  // Keep a stable, deterministic order: display_name then id
  ids.sort((a, b) => {
    const da = (modelDisplayNameMap[a] || a).toLowerCase();
    const db = (modelDisplayNameMap[b] || b).toLowerCase();
    if (da < db) return -1;
    if (da > db) return 1;
    return a.localeCompare(b);
  });
  return ids;
}

function getEffectiveModels() {
  // Use all UMANS catalog models as the authoritative model list.
  const catalogIds = getOrderedModelIds();
  const all = catalogIds.length > 0 ? catalogIds : (config?.enabledModels || []);
  const disabled = config?.disabledModels;
  if (!disabled || disabled.length === 0) return all;
  const disabledSet = new Set(disabled);
  return all.filter(m => !disabledSet.has(m));
}

function getAllCatalogModels() {
  const catalogIds = getOrderedModelIds();
  return catalogIds.length > 0 ? catalogIds : (config?.enabledModels || []);
}

let modelsDevCache = null;
let modelsDevCacheTime = 0;
const MODELS_DEV_CACHE_TTL = 5 * 60 * 1000;

let opencodeConfigPathsCache = null;
let opencodeConfigPathsCacheTime = 0;
const OPENCODE_CONFIG_PATHS_TTL = 5 * 60 * 1000;
let opencodeDiscoveryFailedLogged = false;
let opencodeSetupTimeout = null;
let opencodeSetupPending = false;

// --- FreeGen background wallpaper state ---
let freegenGenerating = false;
let freegenGenerationPromise = null;
let freegenLastError = null;

const RATE_LIMIT_MAP = {};
const rateLimitTimestamps = new Map();

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 3000;

async function retryLoop(fn) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await fn({ attempt, isLast: attempt === MAX_RETRIES });
    if (!result.retry) return result;
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS + (3000 * (attempt - 1));
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function enforceRateLimit(model) {
  const delay = RATE_LIMIT_MAP[model];
  if (!delay) return;
  const last = rateLimitTimestamps.get(model) || 0;
  const wait = delay - (Date.now() - last);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  rateLimitTimestamps.set(model, Date.now());
}

function extractUserPrompt(payload) {
  const msgs = payload.messages;
  if (!Array.isArray(msgs)) return '';
  const user = msgs.findLast(m => m.role === 'user');
  if (!user) return '';
  return msgText(user).replace(/^\[[^\]]+\]\s*/, '');
}

class ResponseCache {
  constructor(maxSize = 100, ttlMs = 60000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this._map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
  get(key) {
    const entry = this._map.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() - entry.time > this.ttlMs) {
      this._map.delete(key);
      this.misses++;
      return null;
    }
    this._map.delete(key);
    this._map.set(key, entry);
    this.hits++;
    return entry.value;
  }
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._map.size >= this.maxSize) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
      this.evictions++;
    }
    this._map.set(key, { value, time: Date.now() });
  }
  get stats() {
    return { size: this._map.size, maxSize: this.maxSize, ttlMs: this.ttlMs, hits: this.hits, misses: this.misses, evictions: this.evictions };
  }
  clear() { this._map.clear(); this.hits = 0; this.misses = 0; this.evictions = 0; }
  get enabled() { return this.maxSize > 0 && this.ttlMs > 0; }
}

function cacheKey(payload, requestedModel) {
  const parts = [requestedModel, payload.stream ? 'stream:1' : 'stream:0'];
  if (payload.system) parts.push(typeof payload.system === 'string' ? payload.system : JSON.stringify(payload.system));
  if (payload.messages) parts.push(JSON.stringify(payload.messages));
  if (payload.tools) parts.push(JSON.stringify(payload.tools));
  return crypto.createHash('md5').update(parts.join('||')).digest('hex');
}

let responseCache = new ResponseCache();

function loadConfig() {
  const configPath = path.join(__dirname, '.config', 'config.json');
  let   rawConfig = {
    LISTEN_ADDR: '127.0.0.1:8084',
    UPSTREAM_BASE_URL: UMANS_API_BASE,
    REQUEST_TIMEOUT: '15m',
    CACHE_TTL: '60s',
    CACHE_MAX_SIZE: 100,
    CACHE_ENABLED: true,
    OVERRIDE_CONCURRENCY: 0,
    MAX_IMAGES: 9,
  };
  if (fs.existsSync(configPath)) {
    try {
      rawConfig = { ...rawConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch (e) { console.error('Failed to parse config.json:', e.message); }
  }
  if (process.env.LISTEN_ADDR) rawConfig.LISTEN_ADDR = process.env.LISTEN_ADDR;
  if (process.env.UPSTREAM_BASE_URL) rawConfig.UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL;
  if (process.env.REQUEST_TIMEOUT) rawConfig.REQUEST_TIMEOUT = process.env.REQUEST_TIMEOUT;
  if (process.env[API_KEY_ENV_VAR]) rawConfig.API_KEY = process.env[API_KEY_ENV_VAR];
  if (process.env.API_KEYS) rawConfig.API_KEYS = process.env.API_KEYS.split(',').map(t => t.trim()).filter(Boolean);
  if (process.env.CACHE_TTL) rawConfig.CACHE_TTL = process.env.CACHE_TTL;
  if (process.env.CACHE_MAX_SIZE) rawConfig.CACHE_MAX_SIZE = parseInt(process.env.CACHE_MAX_SIZE);
  if (process.env.CACHE_ENABLED) rawConfig.CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';
  if (process.env.OVERRIDE_CONCURRENCY) rawConfig.OVERRIDE_CONCURRENCY = parseInt(process.env.OVERRIDE_CONCURRENCY);
  if (process.env.MAX_IMAGES) rawConfig.MAX_IMAGES = parseInt(process.env.MAX_IMAGES);
  if (process.env.SLEEV_ENABLED !== undefined) rawConfig.SLEEV_ENABLED = process.env.SLEEV_ENABLED !== 'false';

  const requestTimeout = parseDuration(rawConfig.REQUEST_TIMEOUT);
  if (!rawConfig.LISTEN_ADDR) throw new Error('LISTEN_ADDR cannot be empty');
  if (requestTimeout <= 0) throw new Error('REQUEST_TIMEOUT must be greater than zero');

  let baseURL = (rawConfig.UPSTREAM_BASE_URL || UMANS_API_BASE).trim().replace(/\/+$/, '');
  const apiKey = rawConfig.API_KEY || process.env[API_KEY_ENV_VAR] || '';

  let keys = [];
  if (apiKey) keys.push({ name: 'Default', key: apiKey, session: '' });
  const rawModels = rawConfig.ENABLED_MODELS;
  const enabledModels = Array.isArray(rawModels) ? rawModels : [];

  return {
    listenAddr: rawConfig.LISTEN_ADDR,
    upstreamBaseURL: baseURL,
    apiKey,
    requestTimeout,
    apiKeys: [...new Set(rawConfig.API_KEYS || [])],
    enabledModels,
    modelDisplayNames: rawConfig.MODEL_DISPLAY_NAMES || {},
    keys,
    cacheTtl: parseDuration(rawConfig.CACHE_TTL || '60s') || 60000,
    cacheMaxSize: Math.max(0, rawConfig.CACHE_MAX_SIZE || 100),
    cacheEnabled: rawConfig.CACHE_ENABLED !== false,
    email: rawConfig.EMAIL || '',
    password: rawConfig.PASSWORD || '',
    appSession: rawConfig.APP_SESSION || '',
    wallpaperSource: rawConfig.wallpaperSource || 'freegen',
    freegenPrompt: rawConfig.FREEGEN_PROMPT || 'epic cinematic landscape, mountains at sunset, vibrant colors, ultra detailed, 16:9 wallpaper',
    overrideConcurrency: Math.max(0, rawConfig.OVERRIDE_CONCURRENCY || 0),
    maxImages: Math.max(1, rawConfig.MAX_IMAGES || 9),
    disabledModels: Array.isArray(rawConfig.DISABLED_MODELS) ? rawConfig.DISABLED_MODELS : [],
    locale: rawConfig.LOCALE || null,
    visionHandoffEnabled: rawConfig.VISION_HANDOFF_ENABLED !== false,
    visionHandoffModel: rawConfig.VISION_HANDOFF_MODEL || 'umans-kimi-k2.7',
    visionHandoffPrompt: rawConfig.VISION_HANDOFF_PROMPT || '',
    sleevEnabled: rawConfig.SLEEV_ENABLED === true,
  };
}

function parseDuration(str) {
  if (!str) return 0;
  const match = str.match(/^(\d+)(h|m|s)$/);
  if (!match) return 0;
  const value = parseInt(match[1]);
  const unit = match[2];
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 's') return value * 1000;
  return 0;
}

const MAX_BODY_SIZE = 5 * 1024 * 1024;

function maskToken(key) {
  return key ? key.substring(0, 10) + '...' + key.substring(key.length - 4) : '';
}

function parseListenPort(addr) {
  return parseInt((addr || '').split(':').pop()) || 8084;
}

function saveConfig(cfg) {
  const configPath = path.join(__dirname, '.config', 'config.json');
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    LISTEN_ADDR: cfg.listenAddr,
    UPSTREAM_BASE_URL: cfg.upstreamBaseURL,
    API_KEY: cfg.apiKey,
    REQUEST_TIMEOUT: `${cfg.requestTimeout / (60 * 1000)}m`,
    API_KEYS: cfg.apiKeys,
    ENABLED_MODELS: cfg.enabledModels,
    MODEL_DISPLAY_NAMES: cfg.modelDisplayNames || {},
    CACHE_TTL: `${(cfg.cacheTtl || 60000) / 1000}s`,
    CACHE_MAX_SIZE: cfg.cacheMaxSize || 100,
    CACHE_ENABLED: cfg.cacheEnabled !== false,
    EMAIL: cfg.email || '',
    PASSWORD: cfg.password || '',
    APP_SESSION: cfg.appSession || '',
    wallpaperSource: cfg.wallpaperSource || 'freegen',
    FREEGEN_PROMPT: cfg.freegenPrompt || 'epic cinematic landscape, mountains at sunset, vibrant colors, ultra detailed, 16:9 wallpaper',
    OVERRIDE_CONCURRENCY: cfg.overrideConcurrency || 0,
    MAX_IMAGES: cfg.maxImages || 9,
    DISABLED_MODELS: cfg.disabledModels || [],
    LOCALE: cfg.locale || null,
    VISION_HANDOFF_ENABLED: cfg.visionHandoffEnabled !== false,
    VISION_HANDOFF_MODEL: cfg.visionHandoffModel || 'umans-kimi-k2.7',
    VISION_HANDOFF_PROMPT: cfg.visionHandoffPrompt || '',
    SLEEV_ENABLED: cfg.sleevEnabled === true,
  }, null, 2));
}

let _saveConfigTimer = null;
function debouncedSaveConfig(cfg) {
  if (_saveConfigTimer) clearTimeout(_saveConfigTimer);
  _saveConfigTimer = setTimeout(() => {
    saveConfig(cfg);
    _saveConfigTimer = null;
  }, 500);
}

// --- i18n: UI string catalog for dashboard translation ---
const I18N_STRINGS = {
  app_title: 'UMANS Proxy',
  status_checking: 'Checking...',
  status_online: 'Online',
  status_offline: 'Offline',
  status_reconnecting: 'Reconnecting...',

  section_window: 'Window',
  label_requests: 'Requests',
  label_tokens: 'Tokens',
  label_tokens_est: 'Tokens (est.)',
  label_cached_pct: 'Cached %',

  section_usage_history: '90-Day Usage History',
  header_date: 'Date',
  header_requests: 'Requests',
  header_tokens: 'Tokens',
  header_cached_pct: 'Cached%',
  page_n_of_m: '{p}/{m}',

  section_api_key: 'API Key',
  btn_manage: 'Manage',
  key_status_active: 'Active',
  key_status_inactive: 'Inactive',
  key_status_none: 'None',
  key_status_checking: 'Checking...',
  tokens_none: 'No API keys',

  section_models: 'Models',
    models_managed_hint: 'All UMANS models are loaded automatically from the API catalog.',
    models_none: 'No UMANS models loaded. Check the API key on the Test Connection button.',

  section_quick_actions: 'Quick Actions',
  btn_check_health: 'Check Health',
  btn_test_connection: 'Test Connection',
  btn_refresh_usage: 'Refresh Usage',
  btn_restart_proxy: 'Restart Proxy',

  section_test_chat: 'Test Chat',
  test_chat_ctx: 'Ctx',
  test_chat_stream: 'Stream',
  test_chat_clear_title: 'Clear conversation',
  test_chat_empty: 'Select a model and ask anything to test.',
  test_chat_placeholder: 'Type a message...',
  test_chat_send: 'Send',
  test_chat_thinking: 'Thinking',
  test_chat_role_you: 'You',
  test_chat_role_error: 'Error',
  test_chat_typing_indicator: '{model} is typing...',

  section_environment: 'Environment',
  env_runtime: 'Runtime',
  env_port: 'Port',
  env_started_at: 'Started At',
  env_ss_mode: 'SS Mode',
  ss_mode_on: 'On',
  ss_mode_off: 'Off',
  env_sleev: 'Sleev (compress)',
  env_wallpaper: 'Wallpaper',
  wp_none: 'None',
  wp_bing: 'Bing',
  wp_wallhaven: 'Wallhaven',
  wp_freegen: 'AI (FreeGen)',
  freegen_prompt: 'AI (FreeGen) Prompt',
  freegen_placeholder: 'Describe your wallpaper...',
  freegen_default: 'Default',
  freegen_generate: 'Generate',
  freegen_status_generating: 'Generating via FreeGen (this may take ~10-30s)...',
  freegen_status_applied: 'Wallpaper applied.',
  freegen_status_error_prefix: 'Error:',

  modal_manage_keys: 'Manage Keys',
  modal_add_key: 'Add New Key',
  key_name_placeholder: 'Key name',
  key_value_placeholder: 'UMANS API key (sk-...)',
  btn_add_key: 'Add Key',
  btn_close: 'Close',
  btn_save: 'Save',
  btn_cancel: 'Cancel',
  btn_delete: 'Delete',
  btn_login: 'Login',
  btn_logout: 'Logout',
  label_account: 'Account',
  label_keys: 'Keys',
  label_user_id: 'User ID',
  label_name: 'Name',
  label_key: 'Key',
  label_email: 'Email',
  status_logged_in: 'Logged in',
  status_not_logged_in: 'Not logged in',
  account_none: 'No API keys configured.',

  modal_umans_login: 'UMANS Login',
  label_username: 'Email',
  username_placeholder: 'email@example.com',
  label_password: 'Password',
  password_placeholder: 'password',
  btn_save_and_login: 'Save & Login',
  login_logging_in: 'Logging in...',
  login_logged_in: 'Logged in as {email}',
  login_failed: 'Login failed: {error}',
  login_error: 'Error: {error}',

  modal_logout: 'Logout',
  logout_confirm: 'Log out from UMANS account?',

  overlay_translating: 'Translating',
  overlay_translating_sub: 'Translating UI to {lang}...',
  autotranslate_label: 'AUTOTRANSLATION',
  forced_locale_hint: '(forced: {locale})',

  toast_failed_prefix: 'Failed:',
  toast_failed_load_config: 'Failed to load configuration',
  toast_failed_load_keys: 'Failed to load keys',
  toast_health_ok: 'Health OK',
  toast_health_failed: 'Health check failed',
  toast_connected: 'Connected! {n} models',
  toast_connection_failed: 'Connection test failed',
  toast_usage_refreshed: 'Usage refreshed',
  toast_models_refreshed: 'Models refreshed',
  toast_key_added: 'Key added',
  toast_key_updated: 'Key updated',
  toast_key_deleted: 'Key deleted',
  toast_key_required: 'Key required',
  toast_login_success: 'Login successful',
  toast_login_failed: 'Login failed',
  toast_logout_success: 'Logged out',
  toast_logout_failed: 'Logout failed',
  toast_freegen_failed: 'FreeGen generation failed: {error}',
  toast_freegen_missing_prompt: 'Enter a FreeGen prompt',
  toast_user_id_copied: 'User ID copied',
  toast_copy_failed: 'Copy failed',
  toast_translation_failed: 'Translation failed: {error}',
  restart_confirm: 'Restart the proxy?',
  restart_waiting: 'Restarting...',
  restart_back_online: 'Proxy is back online!',
  restart_timeout: 'Proxy did not come back',
  label_no_data: 'No usage data yet',
  toast_freegen_applied: 'FreeGen wallpaper generated!',
  btn_edit: 'Edit',
  label_lbl_requests_long: 'REQUESTS',
  label_lbl_tokens_long: 'TOKENS',
};

function getI18nCachePath(locale) {
  return path.join(__dirname, '.cache', 'i18n', `${locale}.json`);
}

function loadI18nCache(locale) {
  const fp = getI18nCachePath(locale);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (e) { return null; }
}

function saveI18nCache(locale, data) {
  const fp = getI18nCachePath(locale);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function splitI18nForBatch(items, batchSize) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

function parseI18nBatchResponse(text, expectedKeys) {
  const result = {};
  const lines = text.split(/\r?\n/);
  const byIdx = new Map();
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    const sepIdx = trimmed.indexOf('|');
    if (sepIdx <= 0) continue;
    const numStr = trimmed.slice(0, sepIdx).replace(/[^0-9]/g, '');
    if (!numStr) continue;
    const idx = parseInt(numStr, 10);
    if (Number.isNaN(idx) || idx < 1) continue;
    let value = trimmed.slice(sepIdx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value) byIdx.set(idx, value);
  }
  for (let i = 0; i < expectedKeys.length; i++) {
    const key = expectedKeys[i];
    const idx = i + 1;
    if (byIdx.has(idx)) result[key] = byIdx.get(idx);
    else result[key] = I18N_STRINGS[key];
  }
  return result;
}

async function callUmansFlashTranslate(promptText) {
  const apiKey = config?.apiKey || config?.keys?.[0]?.key || '';
  if (!apiKey) throw new Error('no api key configured for translation');
  const baseURL = (config?.upstreamBaseURL || UMANS_API_BASE).replace(/\/+$/, '');
  const requestURL = `${baseURL}/chat/completions`;
  const body = {
    model: 'umans-flash',
    messages: [
      { role: 'system', content: 'You are a precise UI translator. Translate each numbered line into the requested target language. Preserve placeholders like {model}, {name}, {time}, {user}, {email}, {n}, {p}, {m}, {lang}, {locale}, {error} exactly. Keep short labels concise. Output one translation per line in the format NUMBER|TRANSLATION and nothing else.' },
      { role: 'user', content: promptText },
    ],
    temperature: 0.2,
    stream: false,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const resp = await fetch(requestURL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      agent: UPSTREAM_AGENT,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`upstream ${resp.status}: ${errText}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') throw new Error('no translation content returned');
    return content;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function buildTranslatePrompt(locale, entries) {
  const lines = entries.map(([key, value], i) => `${i + 1}|${value}`).join('\n');
  return `You are translating UI strings of a software dashboard to ${locale}.

For each numbered line, output the translation in EXACTLY this format:
NUMBER|TRANSLATION

Rules:
- Keep ALL placeholders exactly as written: {model}, {name}, {time}, {user}, {email}, {n}, {p}, {m}, {lang}, {locale}, {error}
- Keep product names (UMANS, FreeGen) and technical terms (API, URL, HTTP, SS Mode) untranslated where idiomatic
- Keep short labels concise (button labels = 1-2 words in target language)
- Preserve capitalization style of the source
- Do NOT add numbering, commentary, or extra lines
- Output one line per input line, in the same order, from 1 to ${entries.length}
- Translate ALL ${entries.length} lines, even if some are similar

Input:\n${lines}`;
}

const I18N_TRANSLATE_MAX_RETRIES = 3;
const I18N_TRANSLATE_RETRY_DELAY_MS = 5000;

function isRetryableTranslateError(err) {
  const msg = err?.message || String(err);
  if (/upstream 5\d\d/i.test(msg)) return true;
  if (/upstream 429/i.test(msg)) return true;
  if (/fetch failed|aborted|network|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)) return true;
  return false;
}

async function callUmansFlashTranslateWithRetry(promptText) {
  let lastErr;
  for (let attempt = 1; attempt <= I18N_TRANSLATE_MAX_RETRIES; attempt++) {
    try {
      return await callUmansFlashTranslate(promptText);
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      if (!isRetryableTranslateError(e) || attempt === I18N_TRANSLATE_MAX_RETRIES) throw e;
      const delay = I18N_TRANSLATE_RETRY_DELAY_MS * attempt;
      console.log(`[i18n] Translate attempt ${attempt}/${I18N_TRANSLATE_MAX_RETRIES} failed (${msg.slice(0, 160)}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function translateCatalogForLocale(locale) {
  const entries = Object.entries(I18N_STRINGS);
  const BATCH_SIZE = 100;
  const batches = splitI18nForBatch(entries, BATCH_SIZE);
  const merged = {};
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const promptText = buildTranslatePrompt(locale, batch);
    const expectedKeys = batch.map(([k]) => k);
    const respText = await callUmansFlashTranslateWithRetry(promptText);
    const parsed = parseI18nBatchResponse(respText, expectedKeys);
    Object.assign(merged, parsed);
    console.log(`[i18n] Translated batch ${b + 1}/${batches.length} for ${locale} (${batch.length} strings)`);
  }
  return { locale, generated_at: new Date().toISOString(), source: 'umans-flash', strings: merged };
}

async function ensureI18nForLocale(locale) {
  if (!locale || locale === 'en') return { locale: 'en', source: 'builtin', generated_at: null, strings: I18N_STRINGS };
  const apiKey = config?.apiKey || config?.keys?.[0]?.key || '';
  if (!apiKey) {
    console.log('[i18n] No API key, falling back to English');
    return { locale: 'en', source: 'builtin', generated_at: null, strings: I18N_STRINGS };
  }
  const cached = loadI18nCache(locale);
  if (cached && cached.strings) return cached;
  console.log(`[i18n] Generating translations for locale=${locale}...`);
  try {
    const result = await translateCatalogForLocale(locale);
    saveI18nCache(locale, result);
    console.log(`[i18n] Cached ${Object.keys(result.strings).length} strings for ${locale}`);
    return result;
  } catch (e) {
    console.error(`[i18n] Translation failed for ${locale}: ${e.message}`);
    return { locale: 'en', source: 'builtin', generated_at: null, strings: I18N_STRINGS };
  }
}

function getDashboardLocale(reqUrl) {
  if (config?.locale) {
    const forced = String(config.locale).toLowerCase().split(/[-_]/)[0].slice(0, 8);
    if (forced) return forced;
  }
  const nav = (reqUrl.searchParams.get('nav') || '').toLowerCase().split(/[-_]/)[0];
  if (nav) return nav;
  const queryLocale = reqUrl.searchParams.get('locale');
  if (queryLocale) return String(queryLocale).toLowerCase().split(/[-_]/)[0].slice(0, 8);
  return 'en';
}

function buildI18nBundle(locale) {
  if (!locale || locale === 'en') {
    return { locale: 'en', source: 'builtin', generated_at: null, strings: I18N_STRINGS };
  }
  const cached = loadI18nCache(locale);
  if (cached && cached.strings) return cached;
  return { locale, source: 'pending', generated_at: null, strings: I18N_STRINGS };
}

async function handleI18n(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  const url = new URL(req.url, 'http://localhost');
  const hasKey = !!(config?.apiKey || config?.keys?.some(k => k.key));
  const forcedLocale = config?.locale ? String(config.locale).toLowerCase().split(/[-_]/)[0].slice(0, 8) : null;
  if (url.searchParams.get('config') === '1') {
    const nav = getDashboardLocale(url);
    writeJSON(res, 200, { has_key: hasKey, forced_locale: forcedLocale, fallback_locale: forcedLocale || (hasKey ? nav || 'en' : 'en') });
    return;
  }
  const locale = getDashboardLocale(url);
  if (!hasKey || locale === 'en') {
    writeJSON(res, 200, { ...buildI18nBundle('en'), has_key: hasKey, forced_locale: forcedLocale, fallback_locale: 'en' });
    return;
  }
  const bundle = url.searchParams.get('generate') === '1'
    ? await ensureI18nForLocale(locale)
    : buildI18nBundle(locale);
  writeJSON(res, 200, { ...bundle, has_key: true, forced_locale: forcedLocale, fallback_locale: locale });
}

let usageCache = { data: null, time: 0, ttl: 5 * 60 * 1000 };
let usageHistoryCache = { data: null, time: 0, ttl: 5 * 60 * 1000 };
let concurrencyCache = { concurrent: null, limit: null, user_id: null, time: 0, ttl: 5 * 60 * 1000 };

function makeAppCookie(sessionToken) {
  return `__Secure-authjs.session-token=${sessionToken}`;
}

function getUsageDbPath() {
  return path.join(__dirname, '.cache', 'usage.db');
}

function toISODateString(d) {
  if (typeof d === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const iso = new Date(d);
    if (isNaN(iso.getTime())) return null;
    return iso.toISOString().slice(0, 10);
  }
  if (typeof d === 'number') {
    const iso = new Date(d < 1e10 ? d * 1000 : d);
    if (isNaN(iso.getTime())) return null;
    return iso.toISOString().slice(0, 10);
  }
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function getUsageHistoryDateRange(now) {
  const n = now || new Date();
  const to = toISODateString(n);
  const from = toISODateString(new Date(n.getTime() - 89 * 24 * 60 * 60 * 1000));
  return { from, to, today: to };
}

function generateDateStrings(from, to) {
  const list = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return list;
  for (let t = start.getTime(); t <= end.getTime(); t += 24 * 60 * 60 * 1000) {
    list.push(toISODateString(new Date(t)));
  }
  return list;
}

function toContiguousRanges(dates) {
  if (!dates.length) return [];
  const sorted = [...dates].sort();
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const prevDate = new Date(`${prev}T00:00:00Z`);
    const currDate = new Date(`${curr}T00:00:00Z`);
    if (currDate.getTime() - prevDate.getTime() === 24 * 60 * 60 * 1000) {
      prev = curr;
    } else {
      ranges.push([start, prev]);
      start = curr;
      prev = curr;
    }
  }
  ranges.push([start, prev]);
  return ranges;
}

function normalizeUsageBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const dateField = bucket.bucket || bucket.timestamp || bucket.date || bucket.time || bucket.day;
  if (!dateField) return null;
  const d = toISODateString(dateField);
  if (!d) return null;
  return {
    bucket: d,
    requests: bucket.requests ?? bucket.request_count ?? 0,
    tokens_in: bucket.tokens_in ?? bucket.input_tokens ?? 0,
    tokens_out: bucket.tokens_out ?? bucket.output_tokens ?? 0,
    tokens_cached_read: bucket.tokens_cached_read ?? bucket.tokens_cached ?? bucket.cached_tokens ?? 0,
  };
}

let usageDb = null;
let usageDbFailed = false;

function getSqliteImpl() {
  if (IS_BUN) {
    try { return require('bun:sqlite'); } catch (e) {
      console.warn('[usage-cache] bun:sqlite not available:', e.message);
    }
  }
  // Node.js 22+ built-in SQLite
  if (typeof process.emitWarning === 'function') {
    const original = process.emitWarning;
    process.emitWarning = () => {};
    try { return require('node:sqlite'); } finally { process.emitWarning = original; }
  }
  try { return require('node:sqlite'); } catch {}
  return null;
}

function dbExec(db, sql) {
  if (db.exec) return db.exec(sql);
  if (db.run) return db.run(sql);
  if (db.execSync) return db.execSync(sql);
  throw new Error('Database has no exec/run method');
}

function dbPrepare(db, sql) {
  if (db.prepare) return db.prepare(sql);
  if (db.query) return db.query(sql);
  if (db.prepareV2) return db.prepareV2(sql);
  throw new Error('Database has no prepare/query method');
}

function openUsageDb() {
  if (usageDb) return usageDb;
  if (usageDbFailed) return null;
  try {
    const impl = getSqliteImpl();
    if (!impl) throw new Error('No built-in SQLite module available');
    const dbPath = getUsageDbPath();
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let db;
    if (impl.DatabaseSync) db = new impl.DatabaseSync(dbPath);
    else if (impl.Database) db = new impl.Database(dbPath);
    else throw new Error('Unsupported SQLite module');
    dbExec(db, `
      CREATE TABLE IF NOT EXISTS usage_history (
        bucket TEXT PRIMARY KEY,
        requests INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        tokens_cached_read INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    usageDb = db;
    return db;
  } catch (e) {
    usageDbFailed = true;
    console.warn('[usage-cache] SQLite not available, using memory-only cache:', e.message);
    return null;
  }
}

function loadUsageHistoryBuckets(db, from, to) {
  const map = {};
  try {
    const stmt = dbPrepare(db, 'SELECT * FROM usage_history WHERE bucket >= ? AND bucket <= ? ORDER BY bucket ASC');
    const rows = stmt.all(from, to);
    for (const row of rows) {
      const b = normalizeUsageBucket(row);
      if (b) map[b.bucket] = b;
    }
  } catch (e) {
    console.warn('[usage-cache] failed to load cached buckets:', e.message);
  }
  return map;
}

function getEarliestDataDate(db) {
  try {
    const stmt = dbPrepare(db, 'SELECT bucket FROM usage_history WHERE requests > 0 ORDER BY bucket ASC LIMIT 1');
    const row = stmt.get();
    return row ? row.bucket : null;
  } catch (e) {
    console.warn('[usage-cache] failed to get earliest data date:', e.message);
    return null;
  }
}

function upsertUsageHistoryBucket(db, bucket) {
  if (!bucket || !bucket.bucket) return false;
  try {
    const stmt = dbPrepare(db, `
      INSERT INTO usage_history (bucket, requests, tokens_in, tokens_out, tokens_cached_read)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(bucket) DO UPDATE SET
        requests = excluded.requests,
        tokens_in = excluded.tokens_in,
        tokens_out = excluded.tokens_out,
        tokens_cached_read = excluded.tokens_cached_read,
        created_at = strftime('%s', 'now')
    `);
    stmt.run(
      bucket.bucket,
      bucket.requests || 0,
      bucket.tokens_in || 0,
      bucket.tokens_out || 0,
      bucket.tokens_cached_read || 0
    );
    return true;
  } catch (e) {
    console.warn('[usage-cache] failed to cache bucket:', e.message);
    return false;
  }
}

function looksLikeUsageBucketArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  return arr.some(item => item && typeof item === 'object' &&
    (item.bucket || item.date || item.timestamp || item.time || item.day) &&
    (item.requests !== undefined || item.request_count !== undefined ||
     item.tokens_in !== undefined || item.input_tokens !== undefined ||
     item.tokens_out !== undefined || item.output_tokens !== undefined));
}

function findUsageBuckets(obj, depth = 0) {
  if (depth > 5 || !obj || typeof obj !== 'object') return null;
  if (looksLikeUsageBucketArray(obj)) return obj;
  for (const key of Object.keys(obj)) {
    const found = findUsageBuckets(obj[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function extractUsageBuckets(data) {
  if (!data) return null;
  if (Array.isArray(data)) return looksLikeUsageBucketArray(data) ? data : null;
  // Fast path for known shapes
  const fast = data.buckets || data.entries || data.data ||
               (data.history && (data.history.buckets || data.history.entries || data.history.data)) ||
               (data.usage && (data.usage.buckets || data.usage.entries || data.usage.data));
  if (Array.isArray(fast) && fast.length > 0) return fast;
  // Recursive fallback
  return findUsageBuckets(data);
}

async function fetchHistoryRange(from, to) {
  const fromIso = `${from}T00:00:00Z`;
  const toIso = `${to}T23:59:59Z`;
  const url = `https://app.umans.ai/api/usage/history?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&granularity=day`;
  console.log(`[usage-history] GET ${url}`);
  const resp = await fetch(url, {
    headers: { 'Cookie': makeAppCookie(config.appSession), 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    console.warn(`[usage-history] upstream returned ${resp.status} for ${from}..${to}`);
    return null;
  }
  const data = await resp.json();
  const buckets = extractUsageBuckets(data);
  if (!buckets) {
    const keys = data && typeof data === 'object' ? Object.keys(data).join(',') : String(data);
    console.warn(`[usage-history] no bucket array found in response. top-level keys: ${keys}`);
  }
  return buckets ? { buckets } : null;
}

async function fetchUsage() {
  if (!config.appSession) return null;
  if (usageCache.data && Date.now() - usageCache.time < usageCache.ttl) return usageCache.data;
  try {
    const resp = await fetch('https://app.umans.ai/api/usage?context=personal', {
      headers: { 'Cookie': makeAppCookie(config.appSession), 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    usageCache = { data, time: Date.now(), ttl: 5 * 60 * 1000 };
    return data;
  } catch (e) { return usageCache.data; }
}

async function fetchUsageHistory() {
  if (!config.appSession) {
    console.warn('[usage-history] no app session, skipping fetch');
    return null;
  }
  if (usageHistoryCache.data && Date.now() - usageHistoryCache.time < usageHistoryCache.ttl) {
    console.log('[usage-history] serving from in-memory cache', usageHistoryCache.data.buckets?.length || 0, 'buckets');
    return usageHistoryCache.data;
  }
  const range = getUsageHistoryDateRange();
  const db = openUsageDb();
  const cached = db ? loadUsageHistoryBuckets(db, range.from, range.to) : {};
  delete cached[range.today];

  // Determine the earliest day the API actually has data for, so we don't
  // endlessly re-request older days that the API will never return.
  // Once at least one non-zero day has been cached, any missing day older than
  // the oldest cached day is treated as a pre-account "no data" day and is
  // backfilled as a zero bucket instead of being fetched.
  const cachedDates = Object.keys(cached).sort();
  const oldestCachedDate = cachedDates.length > 0 ? cachedDates[0] : null;
  // Also check the DB for the earliest day with real (non-zero) usage, which
  // survives even if older zero-rows get evicted or the window rolls past them.
  let earliestDataDate = oldestCachedDate;
  if (db) {
    const earliestFromDb = getEarliestDataDate(db);
    if (earliestFromDb) {
      earliestDataDate = earliestDataDate
        ? [earliestDataDate, earliestFromDb].sort()[0]
        : earliestFromDb;
    }
  }
  earliestDataDate = earliestDataDate || null;

  const allDates = generateDateStrings(range.from, range.to);
  const missing = allDates.filter(d => !cached[d]);
  // Days older than the earliest known data day are pre-account days the API
  // will never return. Backfill them as zeros and persist so we stop asking.
  const preAccount = missing.filter(d => earliestDataDate && d < earliestDataDate);
  const toFetch = missing.filter(d => !(earliestDataDate && d < earliestDataDate));
  for (const d of preAccount) {
    if (d === range.today) continue;
    const zero = { bucket: d, requests: 0, tokens_in: 0, tokens_out: 0, tokens_cached_read: 0 };
    cached[d] = zero;
    if (db) upsertUsageHistoryBucket(db, zero);
  }
  console.log(`[usage-history] range ${range.from}..${range.today}, cached ${Object.keys(cached).length}, missing ${missing.length}, toFetch ${toFetch.length}, preAccount ${preAccount.length}`);
  const mergedMap = { ...cached };
  let fetchedAny = false;
  let failedChunks = 0;
  if (toFetch.length > 0) {
    const ranges = toContiguousRanges(toFetch);
    console.log(`[usage-history] fetching ${ranges.length} chunk(s):`, ranges);
    for (const [rFrom, rTo] of ranges) {
      try {
        const data = await fetchHistoryRange(rFrom, rTo);
        if (data?.buckets) {
          fetchedAny = true;
          console.log(`[usage-history] chunk ${rFrom}..${rTo} returned ${data.buckets.length} raw buckets`);
          const returnedDates = new Set();
          for (const raw of data.buckets) {
            const bucket = normalizeUsageBucket(raw);
            if (!bucket) {
              console.warn('[usage-history] skipped unparseable bucket:', raw);
              continue;
            }
            mergedMap[bucket.bucket] = bucket;
            returnedDates.add(bucket.bucket);
            if (db && bucket.bucket !== range.today) {
              upsertUsageHistoryBucket(db, bucket);
            }
          }
          // The API omits zero-usage days, so cache them explicitly to avoid re-requesting.
          for (const d of generateDateStrings(rFrom, rTo)) {
            if (d !== range.today && !returnedDates.has(d)) {
              const zero = { bucket: d, requests: 0, tokens_in: 0, tokens_out: 0, tokens_cached_read: 0 };
              mergedMap[d] = zero;
              if (db) upsertUsageHistoryBucket(db, zero);
            }
          }
        }
      } catch (e) {
        failedChunks++;
        console.warn(`[usage-history] chunk ${rFrom}..${rTo} failed:`, e.message);
        // Continue with the next chunk instead of aborting entirely.
      }
    }
  }
  if (!fetchedAny && failedChunks > 0 && Object.keys(mergedMap).length === 0) {
    console.warn('[usage-history] all chunks failed and nothing cached, returning stale cache');
    // Don't update usageHistoryCache so the next poll can retry sooner.
    return usageHistoryCache.data;
  }
  if (!fetchedAny && Object.keys(mergedMap).length === 0) {
    console.warn('[usage-history] nothing fetched and nothing cached, returning stale cache');
    return usageHistoryCache.data;
  }
  const buckets = Object.keys(mergedMap).sort().reverse().map(d => mergedMap[d]);
  console.log(`[usage-history] returning ${buckets.length} buckets`);
  const result = { buckets };
  usageHistoryCache = { data: result, time: Date.now(), ttl: 5 * 60 * 1000 };
  return result;
}

async function fetchConcurrency() {
  const apiKey = config?.apiKey || '';
  const baseURL = config?.upstreamBaseURL || UMANS_API_BASE;
  if (!apiKey) return { concurrent: 0, limit: null, user_id: null };
  if (concurrencyCache.concurrent !== null && Date.now() - concurrencyCache.time < concurrencyCache.ttl) {
    return { concurrent: concurrencyCache.concurrent, limit: concurrencyCache.limit, user_id: concurrencyCache.user_id };
  }
  try {
    const resp = await fetch(`${baseURL}/usage`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return { concurrent: 0, limit: null, user_id: null };
    const data = await resp.json();
    const concurrent = data?.usage?.concurrent_sessions ?? 0;
    const limit = data?.limits?.concurrency?.limit ?? null;
    const user_id = data?.user_id ?? null;
    concurrencyCache = { concurrent, limit, user_id, time: Date.now(), ttl: 5 * 60 * 1000 };
    return { concurrent, limit, user_id };
  } catch (e) {
    if (concurrencyCache.concurrent !== null) return { concurrent: concurrencyCache.concurrent, limit: concurrencyCache.limit, user_id: concurrencyCache.user_id };
    return { concurrent: 0, limit: null, user_id: null };
  }
}

function getEffectiveConcurrency() {
  const apiLimit = concurrencyCache.limit;
  const apiConcurrent = concurrencyCache.concurrent || 0;
  const apiUserId = concurrencyCache.user_id || null;
  const override = config?.overrideConcurrency || 0;
  if (override > 0) {
    const effectiveLimit = apiLimit !== null ? Math.min(override, apiLimit) : override;
    return { concurrent: apiConcurrent, limit: effectiveLimit, overridden: true, user_id: apiUserId };
  }
  return { concurrent: apiConcurrent, limit: apiLimit, overridden: false, user_id: apiUserId };
}

async function loginToApp() {
  if (!config.email || !config.password) return false;
  try {
    const csrfResp = await fetch('https://app.umans.ai/api/auth/csrf', {
      signal: AbortSignal.timeout(10000),
    });
    if (!csrfResp.ok) return false;
    const csrfData = await csrfResp.json();
    const csrfToken = csrfData.csrfToken;
    if (!csrfToken) return false;
    const setCookie = csrfResp.headers.get('set-cookie') || '';
    const cookieMatch = setCookie.match(/__Host-authjs\.csrf-token=([^;]+)/);
    const csrfCookie = cookieMatch ? `__Host-authjs.csrf-token=${cookieMatch[1]}` : '';

    const loginResp = await fetch('https://app.umans.ai/api/auth/callback/credentials', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': csrfCookie,
      },
      body: new URLSearchParams({
        csrfToken,
        email: config.email,
        password: config.password,
        callbackUrl: 'https://app.umans.ai/billing',
        json: 'true',
      }).toString(),
      signal: AbortSignal.timeout(15000),
      redirect: 'manual',
    });
    const loginCookies = loginResp.headers.get('set-cookie') || '';
    const sessionMatch = loginCookies.match(/__Secure-authjs\.session-token=([^;]+)/);
    if (sessionMatch) {
      config.appSession = sessionMatch[1];
      debouncedSaveConfig(config);
      return true;
    }
    return false;
  } catch (e) { return false; }
}

const msgText = (m) => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.find(p => p?.type === 'text')?.text || '' : '');

class KeyPool {
  constructor(keys) {
    this._entries = keys.map(k => ({ key: k.key, name: k.name, healthy: true, lastError: 0, cooldownMs: 30000 }));
    this._index = 0;
    this._mutex = Promise.resolve();
  }

  _lock(fn) {
    let release;
    const p = new Promise(r => release = r);
    const old = this._mutex;
    this._mutex = p;
    const chained = old.then(() => fn());
    return chained.finally(() => release());
  }

  acquire(preferredIndex) {
    return this._lock(() => {
      if (this._entries.length === 0) return null;
      const now = Date.now();
      if (preferredIndex != null) {
        const pref = this._entries[preferredIndex];
        if (pref && (pref.healthy || now - pref.lastError > pref.cooldownMs)) {
          pref.healthy = true;
          config.apiKey = pref.key;
          if (upstream) upstream.apiKey = pref.key;
          return { key: pref.key, name: pref.name, index: preferredIndex };
        }
      }
      for (let attempt = 0; attempt < this._entries.length; attempt++) {
        const idx = this._index++ % this._entries.length;
        const entry = this._entries[idx];
        if (entry.healthy || now - entry.lastError > entry.cooldownMs) {
          entry.healthy = true;
          config.apiKey = entry.key;
          if (upstream) upstream.apiKey = entry.key;
          return { key: entry.key, name: entry.name, index: idx };
        }
      }
      return null;
    });
  }

  markUnhealthy(index, status) {
    const entry = this._entries[index];
    if (entry) {
      entry.healthy = false;
      entry.lastError = Date.now();
      if (status >= 503) entry.cooldownMs = 60000;
      else if (status >= 502) entry.cooldownMs = 30000;
      else entry.cooldownMs = 10000;
    }
  }

  markHealthy(index) {
    const entry = this._entries[index];
    if (entry) { entry.healthy = true; entry.lastError = 0; }
  }

  get total() { return this._entries.length; }

  get healthyCount() {
    const now = Date.now();
    return this._entries.filter(e => e.healthy || now - e.lastError > e.cooldownMs).length;
  }

  get state() {
    const now = Date.now();
    return this._entries.map((e, i) => {
      const cool = !e.healthy ? Math.max(0, e.cooldownMs - (now - e.lastError)) : 0;
      let status = 'none';
      if (e.key) {
        if (e.healthy || cool === 0) status = 'active';
        else status = 'cooldown';
      }
      return {
        name: e.name,
        status,
        healthy: e.healthy,
        remainingCooldown: cool,
        token: maskToken(e.key),
      };
    });
  }
}

function fingerprintPayload(payload) {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) return null;
  const text = (m) => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.find(p => p?.type === 'text')?.text || '' : '');
  const idx = msgs.findIndex(m => m.role === 'user');
  if (idx < 0) return null;
  const raw = text(msgs[idx]);
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
}

function stripReasoningContent(payload) {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) return;
  for (const m of msgs) {
    if (m.role === 'assistant') {
      delete m.reasoning_content;
      delete m.reasoningContent;
    }
  }
}

function limitImagesInMessages(payload, maxImages) {
  if (!maxImages || maxImages <= 0) return;

  const imageParts = [];

  function walkContentArray(content, time) {
    if (!Array.isArray(content)) return;
    for (let pi = 0; pi < content.length; pi++) {
      const part = content[pi];
      if (part && (part.type === 'image_url' || part.type === 'image')) {
        imageParts.push({ content, pi, time });
      }
      if (part && Array.isArray(part.content)) {
        walkContentArray(part.content, time);
      }
    }
  }

  if (payload && Array.isArray(payload.system)) {
    walkContentArray(payload.system, -1);
  }

  const msgs = payload?.messages;
  if (Array.isArray(msgs)) {
    for (let mi = 0; mi < msgs.length; mi++) {
      const m = msgs[mi];
      if (!m) continue;
      if (Array.isArray(m.content)) {
        walkContentArray(m.content, mi);
      }
    }
  }

  if (imageParts.length <= maxImages) return;

  imageParts.sort((a, b) => a.time - b.time);

  for (let i = 0; i < imageParts.length - maxImages; i++) {
    const { content, pi } = imageParts[i];
    content[pi] = { type: 'text', text: '(Image previously shared)' };
  }
}

// ── Vision handoff ──────────────────────────────────────────────────────────
// Models whose capabilities.supports_vision === "via-handoff" cannot process
// images natively. The proxy intercepts images in requests to such models,
// sends each image to a vision-capable handoff model (default: umans-kimi-k2.7),
// and replaces the image part with the text description returned by the
// handoff model before forwarding the request to the original model.

const DEFAULT_VISION_HANDOFF_PROMPT = `The user has pasted an image into their chat. Describe what you see as if you are directly observing the image. Be thorough but concise. Include:
- All visible elements (objects, text, UI elements, people, etc.)
- Exact transcription of any text
- The context and purpose of the image
- Any relevant technical details

Describe it naturally, as if explaining to someone what you're looking at right now.`;

function needsVisionHandoff(resolvedModel) {
  if (!config.visionHandoffEnabled) return false;
  const info = modelInfoMap[resolvedModel];
  if (!info || !info.capabilities) return false;
  return info.capabilities.supports_vision === 'via-handoff';
}

// Resolve a requested model ID to its umans- catalog ID.
function resolveModelId(requestedModel) {
  if (!requestedModel) return requestedModel;
  if (requestedModel.startsWith('umans-')) return requestedModel;
  const prefixed = 'umans-' + requestedModel;
  const allModels = getEffectiveModels();
  if (allModels.includes(prefixed)) return prefixed;
  const direct = allModels.find(m => m === requestedModel);
  return direct || requestedModel;
}

// Walk a content array (OpenAI or Anthropic format) and collect image parts.
function collectImageParts(payload) {
  const parts = [];

  function walkContentArray(content) {
    if (!Array.isArray(content)) return;
    for (let i = 0; i < content.length; i++) {
      const part = content[i];
      if (!part || typeof part !== 'object') continue;

      // OpenAI image_url format
      if (part.type === 'image_url' && part.image_url && part.image_url.url) {
        parts.push({ container: content, index: i, dataUri: part.image_url.url });
      }
      // Anthropic image format
      else if (part.type === 'image' && part.source) {
        if (part.source.type === 'base64' && part.source.media_type && part.source.data) {
          parts.push({ container: content, index: i, dataUri: `data:${part.source.media_type};base64,${part.source.data}` });
        } else if (part.source.type === 'url' && part.source.url) {
          parts.push({ container: content, index: i, dataUri: part.source.url });
        }
      }

      // Recurse into nested content arrays (e.g. tool_result blocks)
      if (Array.isArray(part.content)) {
        walkContentArray(part.content);
      }
    }
  }

  // Anthropic system blocks
  if (payload && Array.isArray(payload.system)) {
    walkContentArray(payload.system);
  }

  // Messages
  if (payload && Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      if (m && Array.isArray(m.content)) {
        walkContentArray(m.content);
      }
    }
  }

  return parts;
}

async function analyzeImageViaHandoff(dataUri, slot, reqStart, sessNum, imageIndex) {
  const handoffModel = config.visionHandoffModel || 'umans-kimi-k2.7';
  const prompt = config.visionHandoffPrompt || DEFAULT_VISION_HANDOFF_PROMPT;

  const handoffPayload = {
    model: handoffModel,
    stream: false,
    messages: [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What do you see in this image?' },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
  };

  try {
    console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[handoff→${handoffModel}]-analyzing image #${imageIndex + 1}`);
    const resp = await upstream.chatCompletions(handoffPayload);

    if (resp.status >= 400) {
      const errText = await readBodyText(resp.body).catch(() => '');
      console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[handoff→${handoffModel}]-ERROR:${resp.status} ${(errText || '').substring(0, 200)}`);
      return `[Image analysis failed: upstream returned HTTP ${resp.status}]`;
    }

    const bodyText = await readBodyText(resp.body);
    const parsed = JSON.parse(bodyText);
    const description = parsed?.choices?.[0]?.message?.content || '';

    if (!description) {
      return '[Image analysis failed: no text in handoff response]';
    }

    console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[handoff→${handoffModel}]-image #${imageIndex + 1} described (${description.length} chars)`);
    return description;
  } catch (e) {
    console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[handoff→${handoffModel}]-ERROR: ${e.message}`);
    return `[Image analysis failed: ${e.message}]`;
  }
}

// Replace all image parts in the payload with text descriptions from the
// handoff model. Returns the number of images that were handed off.
async function performVisionHandoff(payload, resolvedModel, slot, sessNum, reqStart) {
  if (!needsVisionHandoff(resolvedModel)) return 0;

  const imageParts = collectImageParts(payload);
  if (imageParts.length === 0) return 0;

  const handoffModel = config.visionHandoffModel || 'umans-kimi-k2.7';
  console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[${resolvedModel}]-vision-handoff: ${imageParts.length} image(s) → ${handoffModel}`);

  // Analyze all images in parallel
  const descriptions = await Promise.all(
    imageParts.map((ip, i) => analyzeImageViaHandoff(ip.dataUri, slot, reqStart, sessNum, i))
  );

  // Replace each image part in-place with a text part
  for (let i = 0; i < imageParts.length; i++) {
    const { container, index } = imageParts[i];
    const label = imageParts.length > 1 ? `[User pasted image ${i + 1}]\n` : '[User pasted image]\n';
    container[index] = {
      type: 'text',
      text: label + descriptions[i],
    };
  }

  return imageParts.length;
}

const UPSTREAM_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 128, timeout: 300000, maxFreeSockets: 64, scheduling: 'lifo' });

// ── Sleev context-compression gateway manager ──────────────────────────────
// Topology A (Sleev in front): opencode → Sleev (compress) → UMANS-PROXY → UMANS
// Sleev is installed as a project dependency (package.json) and spawns a local
// gateway daemon. First-run sign-in opens the browser for OAuth callback. The
// proxy manages the gateway lifecycle (spawn on boot, kill on exit).
const { execSync, spawn } = require('child_process');
const SLEEV_HARNESS_HEADER = 'sleeve-harness';
const SLEEV_BASE_URL_HEADER = 'sleeve-base-url';

function resolveSleevBinary() {
  // 1. Local project dependency (node_modules/.bin/sleev)
  const localBin = path.join(__dirname, 'node_modules', '.bin', 'sleev') + (process.platform === 'win32' ? '.cmd' : '');
  if (fs.existsSync(localBin)) return localBin;
  // 2. Global PATH lookup
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const resolved = execSync(`${which} sleev`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {}
  return null;
}

function isSleevLoggedIn(binPath) {
  const useShell = binPath.endsWith('.cmd') || binPath.endsWith('.bat');
  try {
    const out = execSync(`"${binPath}" auth status`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 8000, shell: useShell });
    if (out.includes('"signedIn"')) return /"signedIn"\s*:\s*true/.test(out);
    return /logged in|authenticated|signed in/i.test(out);
  } catch {
    return false;
  }
}

function isSleevGatewayHealthy(binPath) {
  const useShell = binPath.endsWith('.cmd') || binPath.endsWith('.bat');
  try {
    const out = execSync(`"${binPath}" gateway status`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 8000, shell: useShell });
    return /"running"\s*:\s*true/.test(out) && /"healthy"\s*:\s*true/.test(out);
  } catch {
    return false;
  }
}

function runSleevSetup(binPath) {
  const useShell = binPath.endsWith('.cmd') || binPath.endsWith('.bat');
  try {
    execSync(`"${binPath}" setup`, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 15000, shell: useShell });
    return true;
  } catch (e) {
    console.error(`[Sleev] setup failed: ${e.message}`);
    return false;
  }
}

async function startSleevSignIn(binPath) {
  // `sleev auth login` opens a browser for OAuth and blocks until the
  // callback completes. We spawn it and watch for completion.
  return new Promise((resolve) => {
    let stdout = '';
    const useShell = binPath.endsWith('.cmd') || binPath.endsWith('.bat');
    const child = spawn(binPath, ['auth', 'login'], { stdio: ['ignore', 'pipe', 'pipe'], shell: useShell });
    sleevState.signInProcess = child;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('close', (code) => {
      sleevState.signInProcess = null;
      resolve(code === 0 || /success|logged in|authenticated/i.test(stdout));
    });
    child.on('error', () => { sleevState.signInProcess = null; resolve(false); });
    // Safety timeout: don't block the proxy forever if the user walks away.
    setTimeout(() => {
      try { child.kill(); } catch {}
      sleevState.signInProcess = null;
      resolve(false);
    }, 180000);
  });
}

const sleevState = {
  binary: null,
  gatewayProcess: null,
  signInProcess: null,
  ready: false,
  lastError: null,
};

function spawnSleevGateway(binPath) {
  if (sleevState.gatewayProcess) return true;
  const useShell = binPath.endsWith('.cmd') || binPath.endsWith('.bat');
  try {
    // `bind` sets host/port; `--restart` re-applies if already bound.
    execSync(`"${binPath}" gateway bind --host ${SLEEV_GATEWAY_HOST} --port ${SLEEV_GATEWAY_PORT} --restart`, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000, shell: useShell });
    // `start` launches the daemon process.
    const child = spawn(binPath, ['gateway', 'start'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
    });
    sleevState.gatewayProcess = child;
    let stderrBuf = '';
    child.stdout.on('data', (d) => { const s = d.toString().trim(); if (s) console.log(`[Sleev] ${s}`); });
    child.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) { console.error(`[Sleev] ${s}`); stderrBuf += s + ' '; } });
    child.on('exit', (code, signal) => {
      console.log(`[Sleev] Gateway process exited (code=${code}, signal=${signal})`);
      sleevState.gatewayProcess = null;
      sleevState.ready = false;
      if (code !== 0 && stderrBuf) sleevState.lastError = stderrBuf.trim();
    });
    child.on('error', (e) => {
      console.error(`[Sleev] Failed to spawn gateway: ${e.message}`);
      sleevState.gatewayProcess = null;
      sleevState.lastError = e.message;
    });
    return true;
  } catch (e) {
    sleevState.lastError = e.message;
    console.error(`[Sleev] Bind/spawn failed: ${e.message}`);
    return false;
  }
}

async function pingSleevGateway() {
  try {
    const resp = await fetch(`${SLEEV_GATEWAY_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitForSleevGateway(maxWaitMs = 15000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await pingSleevGateway()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function startSleev() {
  if (!config.sleevEnabled) return false;
  const bin = resolveSleevBinary();
  if (!bin) {
    sleevState.lastError = 'sleev binary not found — install with `npm install -g sleev`';
    console.error(`[Sleev] ${sleevState.lastError}`);
    return false;
  }
  sleevState.binary = bin;

  // Fast path: gateway already running and healthy (e.g. started outside proxy)
  if (isSleevGatewayHealthy(bin)) {
    sleevState.ready = true;
    sleevState.lastError = null;
    console.log('[Sleev] Gateway already running and healthy.');
    return true;
  }

  if (!isSleevLoggedIn(bin)) {
    console.log('[Sleev] Not signed in. Attempting browser sign-in via `sleev auth login`...');
    console.log('[Sleev] If this fails, run `npx sleev auth login` in a terminal, then restart the proxy.');
    const ok = await startSleevSignIn(bin);
    if (!ok) {
      sleevState.lastError = 'sign-in required — run `npx sleev auth login` manually, then restart';
      console.error('[Sleev] Interactive sign-in did not complete.');
      return false;
    }
    console.log('[Sleev] Sign-in successful.');
  }

  console.log('[Sleev] Running setup...');
  if (!runSleevSetup(bin)) {
    sleevState.lastError = 'sleev setup failed — run `npx sleev setup` manually, then restart';
    console.error('[Sleev] Setup failed.');
    return false;
  }

  console.log(`[Sleev] Starting gateway on ${SLEEV_GATEWAY_HOST}:${SLEEV_GATEWAY_PORT}...`);
  if (!spawnSleevGateway(bin)) return false;

  const ready = await waitForSleevGateway();
  if (!ready) {
    sleevState.lastError = 'gateway did not become healthy within timeout';
    console.error(`[Sleev] ${sleevState.lastError}`);
    return false;
  }
  sleevState.ready = true;
  sleevState.lastError = null;
  console.log('[Sleev] Gateway ready. Chat traffic will route through Sleev for context compression.');
  return true;
}

function stopSleev() {
  if (sleevState.signInProcess) {
    try { sleevState.signInProcess.kill(); } catch {}
    sleevState.signInProcess = null;
  }
  if (sleevState.gatewayProcess) {
    console.log('[Sleev] Stopping gateway...');
    try { sleevState.gatewayProcess.kill(); } catch {}
    sleevState.gatewayProcess = null;
  }
  sleevState.ready = false;
}

async function getSleevStatus() {
  return {
    enabled: config.sleevEnabled === true,
    ready: sleevState.ready,
    binary: sleevState.binary ? path.basename(sleevState.binary) : null,
    lastError: sleevState.lastError,
    loggedIn: sleevState.binary ? isSleevLoggedIn(sleevState.binary) : false,
    gatewayBase: SLEEV_GATEWAY_BASE,
  };
}

class UpstreamClient {
  constructor(cfg) {
    this.baseURL = cfg.upstreamBaseURL;
    this.timeout = cfg.requestTimeout;
    this.apiKey = cfg.apiKey;
  }

  headers(stream = false) {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': stream ? 'text/event-stream' : 'application/json',
      'Connection': 'keep-alive',
    };
  }

  anthropicHeaders(stream = false) {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'Accept': stream ? 'text/event-stream' : 'application/json',
      'Connection': 'keep-alive',
    };
  }

  async getUserInfo() {
    const requestURL = `${this.baseURL}/models/info`;
    const resp = await fetch(requestURL, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Connection': 'keep-alive' },
      signal: AbortSignal.timeout(10000),
      agent: UPSTREAM_AGENT,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  }

  async chatCompletions(body) {
    const requestURL = `${this.baseURL}/chat/completions`;
    const isStream = body && body.stream === true;
    const resp = await fetch(requestURL, {
      method: 'POST',
      headers: this.headers(isStream),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
      agent: UPSTREAM_AGENT,
    });
    const responseHeaders = {};
    resp.headers.forEach((v, k) => responseHeaders[k] = v);
    return { status: resp.status, headers: responseHeaders, body: resp.body };
  }

  async messages(body) {
    const requestURL = `${this.baseURL}/messages`;
    const isStream = body && body.stream === true;
    const resp = await fetch(requestURL, {
      method: 'POST',
      headers: this.headers(isStream),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
      agent: UPSTREAM_AGENT,
    });
    const responseHeaders = {};
    resp.headers.forEach((v, k) => responseHeaders[k] = v);
    return { status: resp.status, headers: responseHeaders, body: resp.body };
  }
}

async function fetchModelCatalog() {
  const apiKey = config?.apiKey || '';
  const baseURL = config?.upstreamBaseURL || UMANS_API_BASE;
  const url = `${baseURL}/models/info`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: apiKey ? { 'Authorization': `Bearer ${apiKey}`, 'Connection': 'keep-alive' } : {},
    signal: AbortSignal.timeout(15000),
    agent: UPSTREAM_AGENT,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

async function getCatalogData() {
  if (modelCatalogCache && Date.now() - modelCatalogCacheTime < MODEL_CATALOG_CACHE_TTL) {
    return modelCatalogCache;
  }
  const data = await fetchModelCatalog();
  modelCatalogCache = data;
  modelCatalogCacheTime = Date.now();
  if (data && typeof data === 'object' && !Array.isArray(data.data)) {
    modelDisplayNameMap = {};
    modelInfoMap = {};
    for (const [id, info] of Object.entries(data)) {
      if (!info || typeof info !== 'object') continue;
      modelInfoMap[id] = info;
      if (info.display_name) modelDisplayNameMap[id] = info.display_name.replace(/^Umans\s+/i, '');
    }
  }
  return data;
}

async function fetchModelsDevCatalog() {
  const resp = await fetch(MODELS_DEV_CATALOG_URL, {
    method: 'GET',
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

async function getModelsDevCatalog() {
  if (modelsDevCache && Date.now() - modelsDevCacheTime < MODELS_DEV_CACHE_TTL) {
    return modelsDevCache;
  }
  try {
    const data = await fetchModelsDevCatalog();
    modelsDevCache = data;
    modelsDevCacheTime = Date.now();
    return data;
  } catch (e) {
    console.log(`[Models.dev] Catalog fetch failed: ${e.message}`);
    return null;
  }
}

function deriveModelsDevId(umansId) {
  // UMANS exposes models as e.g. "umans-kimi-k2.6" or "umans-glm-5.1".
  // models.dev has a dedicated "umans-ai" provider where the model id is
  // identical to the UMANS id. For other cases the model-id often matches
  // the suffix after the "umans-" prefix.
  return umansId.replace(/^umans-/, '');
}

function umansIdCandidates(umansId) {
  // Generate the possible model IDs we should look up in models.dev.
  const candidates = [umansId]; // exact umans-ai id
  const base = deriveModelsDevId(umansId);
  if (base !== umansId) candidates.push(base);
  return candidates;
}

function findModelsDevEntry(catalog, umansId) {
  if (!catalog || typeof catalog !== 'object') return null;
  const candidates = umansIdCandidates(umansId);

  // UMANS-specific models are present in models.dev under the "umans-ai"
  // provider with the exact same id (e.g. "umans-kimi-k2.7"). Prefer that.
  if (catalog['umans-ai'] && catalog['umans-ai'].models) {
    for (const candidate of candidates) {
      const model = catalog['umans-ai'].models[candidate];
      if (model) {
        return { providerId: 'umans-ai', modelId: candidate, model };
      }
    }
  }

  // Prefer canonical providers so we get the most authoritative metadata.
  const canonicalProviders = [
    'openai', 'anthropic', 'google', 'mistral', 'meta', 'xai', 'deepseek',
    'moonshotai', 'zhipuai', 'alibaba', 'nvidia', 'cohere', 'minimax',
    'stepfun', 'xiaomi',
  ];
  for (const providerId of canonicalProviders) {
    const provider = catalog[providerId];
    if (!provider || typeof provider !== 'object' || !provider.models) continue;
    for (const candidate of candidates) {
      const model = provider.models[candidate];
      if (model) {
        return { providerId, modelId: candidate, model };
      }
    }
  }
  // Fallback: scan every provider's models for an id that equals a candidate.
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!provider || typeof provider !== 'object' || !provider.models) continue;
    for (const candidate of candidates) {
      const model = provider.models[candidate];
      if (model) {
        return { providerId, modelId: candidate, model };
      }
    }
  }
  // Last resort: match by nested model.id field.
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!provider || typeof provider !== 'object' || !provider.models) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model && candidates.includes(model.id)) {
        return { providerId, modelId, model };
      }
    }
  }
  return null;
}

function parseLevels(raw) {
  if (Array.isArray(raw)) return raw.filter(v => typeof v === 'string' && v.length > 0);
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  return [];
}

function inferReasoningModeFromCapabilities(reasoningCaps) {
  if (!reasoningCaps || typeof reasoningCaps !== 'object') return null;
  if (reasoningCaps.supported === true) return true;
  const levels = parseLevels(reasoningCaps.levels);
  if (levels.length > 0) return true;
  return null;
}

function resolveReasoningMode(devEntry, reasoningCaps) {
  if (devEntry && Array.isArray(devEntry.model.reasoning_options) && devEntry.model.reasoning_options.length > 0) {
    return true;
  }
  const capsMode = inferReasoningModeFromCapabilities(reasoningCaps);
  if (capsMode !== null) return capsMode;
  return true;
}

// Map a UMANS reasoning level to a thinking budget (tokens). These are
// conservative caps that work well with the UMANS upstream; the upstream
// ultimately decides how much reasoning to emit.
const REASONING_LEVEL_BUDGETS = {
  low: 8000,
  medium: 16000,
  high: 16000,
  max: 32000,
};

// Build opencode variants from the UMANS reasoning levels list.
// Only levels that actually appear in `levels` become variants, so the
// opencode dropdown only shows reasoning modes the model supports.
// "none" is intentionally not a variant — selecting it would disable
// reasoning, which the base (non-variant) entry already represents.
function buildReasoningVariants(reasoningCaps) {
  if (!reasoningCaps || reasoningCaps.supported !== true) return null;
  if (reasoningCaps.can_disable === false) return null;
  const levels = parseLevels(reasoningCaps.levels);
  const variants = {};
  let added = false;
  for (const lvl of levels) {
    if (lvl === 'none') continue;
    const budget = REASONING_LEVEL_BUDGETS[lvl];
    if (!budget) continue;
    variants[lvl] = { thinking: { type: 'adaptive', budgetTokens: budget } };
    added = true;
  }
  return added ? variants : null;
}

function cloneObj(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizeToolSchemas(tools) {
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const fn = tool.function;
    if (!fn || typeof fn !== 'object') continue;
    const params = fn.parameters;
    if (!params || typeof params !== 'object') continue;
    fn.parameters = normalizeSchemaMap(params, extractDefinitions(params), 12);
  }
}

function extractDefinitions(schema) {
  const merged = {};
  if (schema.definitions && typeof schema.definitions === 'object') Object.assign(merged, schema.definitions);
  if (schema['$defs'] && typeof schema['$defs'] === 'object') Object.assign(merged, schema['$defs']);
  return Object.keys(merged).length > 0 ? merged : null;
}

function normalizeSchemaMap(node, defs, maxDepth) {
  if (maxDepth <= 0) return cloneObj(node);
  defs = mergeDefinitions(defs, extractDefinitions(node));
  const replaced = tryResolveRef(node, defs);
  if (replaced && typeof replaced === 'object' && !Array.isArray(replaced)) {
    return normalizeSchemaMap(replaced, defs, maxDepth - 1);
  }
  const normalized = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'definitions' || key === '$defs' || key === 'nullable') continue;
    normalized[key] = normalizeSchemaValue(value, defs, maxDepth - 1);
  }
  simplifyNullableCombinator(normalized, 'anyOf');
  simplifyNullableCombinator(normalized, 'oneOf');
  normalizeTypeField(normalized);
  normalizeEnumField(normalized);
  if (normalized.const === null) delete normalized.const;
  return normalized;
}

function normalizeSchemaValue(value, defs, maxDepth) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return normalizeSchemaMap(value, defs, maxDepth);
  if (Array.isArray(value)) return value.map(v => normalizeSchemaValue(v, defs, maxDepth));
  return value;
}

function mergeDefinitions(parent, local) {
  if (!parent) return local;
  if (!local) return parent;
  return { ...parent, ...local };
}

function tryResolveRef(node, defs) {
  if (!defs || typeof node.$ref !== 'string' || Object.keys(node).length !== 1) return null;
  const ref = node.$ref;
  let name = '';
  if (ref.startsWith('#/definitions/')) name = ref.slice('#/definitions/'.length);
  else if (ref.startsWith('#/$defs/')) name = ref.slice('#/$defs/'.length);
  if (!name || !defs[name]) return null;
  const def = defs[name];
  return typeof def === 'object' && !Array.isArray(def) ? cloneObj(def) : def;
}

function simplifyNullableCombinator(schema, key) {
  const rawOptions = schema[key];
  if (!Array.isArray(rawOptions)) return;
  const filtered = rawOptions.filter(opt => !isNullSchema(opt));
  if (filtered.length === 0) { delete schema[key]; return; }
  if (filtered.length === 1 && filtered[0] && typeof filtered[0] === 'object' && !Array.isArray(filtered[0])) {
    delete schema[key];
    Object.assign(schema, filtered[0]);
    return;
  }
  schema[key] = filtered;
}

function isNullSchema(schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type === 'null') return true;
  if (schema.const === null) return true;
  if (Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === null) return true;
  return false;
}

function normalizeTypeField(schema) {
  const rawType = schema.type;
  if (typeof rawType === 'string') return;
  if (!Array.isArray(rawType)) return;
  const nonNull = rawType.filter(t => typeof t === 'string' && t !== 'null' && t.trim());
  if (nonNull.length === 0) delete schema.type;
  else schema.type = nonNull[0];
}

function normalizeEnumField(schema) {
  const enumValues = schema.enum;
  if (!Array.isArray(enumValues)) return;
  const seen = new Set();
  const filtered = [];
  for (const entry of enumValues) {
    if (entry === null) continue;
    const key = `${typeof entry}:${JSON.stringify(entry)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(entry);
  }
  if (filtered.length === 0) { delete schema.enum; return; }
  schema.enum = filtered;
}

function isNodeStream(body) {
  return body && typeof body.pipe === 'function' && typeof body.on === 'function';
}

function readBodyText(body) {
  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      body.on('data', c => chunks.push(c));
      body.on('end', () => resolve(Buffer.concat(chunks).toString()));
      body.on('error', reject);
    });
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    return new Promise((resolve, reject) => {
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) { resolve(Buffer.concat(chunks).toString()); return; }
          chunks.push(Buffer.from(value));
          pump();
        }).catch(reject);
      }
      pump();
    });
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    return (async () => {
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString();
    })();
  }
  return String(body);
}

function pipeBodyToResponse(body, res) {
  let closed = false;
  const onClose = () => { closed = true; };
  res.on('close', onClose);

  function safeWrite(chunk) {
    if (!closed) {
      try { res.write(chunk); } catch (e) { closed = true; }
    }
  }

  function safeEnd() {
    if (!closed) {
      try { res.end(); } catch (e) { /* ignore */ }
    }
  }

  if (isNodeStream(body)) {
    return new Promise((resolve) => {
      body.on('data', chunk => safeWrite(chunk));
      body.on('end', () => { safeEnd(); resolve(); });
      body.on('error', () => { safeEnd(); resolve(); });
    });
  }
  return new Promise((resolve) => {
    const reader = body.getReader();
    function pump() {
      if (closed) { resolve(); return; }
      reader.read().then(({ done, value }) => {
        if (closed) { resolve(); return; }
        if (done) { safeEnd(); resolve(); return; }
        safeWrite(value);
        pump();
      }).catch(() => { safeEnd(); resolve(); });
    }
    pump();
  });
}

// --- FreeGen wallpaper helpers ---
async function fetchFreegenSigned(prompt) {
  const resp = await fetch(FREEGEN_PROMPT_SIGNER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`signer ${resp.status}`);
  const data = await resp.json();
  if (!data.ts || !data.sig) throw new Error('signer missing ts/sig');
  return data;
}

async function fetchFreegenImageUrl(prompt, ratio = '16:9') {
  const { ts, sig } = await fetchFreegenSigned(prompt);
  const resp = await fetch(FREEGEN_IMAGE_GENERATOR, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ prompt, ts, sig, ratio_id: ratio }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) {
    let txt = '';
    try { txt = await resp.text(); } catch {}
    throw new Error(`generator ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  if (data.image_data_url) return data.image_data_url;
  if (data.job_id) return await waitFreegenWs(data.job_id);
  throw new Error('no image_data_url or job_id from freegen');
}

function waitFreegenWs(jobId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') { reject(new Error('WebSocket not available')); return; }
    let ws;
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      try { ws && ws.close(); } catch {}
      reject(new Error('freegen websocket timeout'));
    }, timeoutMs);
    try {
      ws = new WebSocket(FREEGEN_WS_BRIDGE, [], { headers: { Origin: 'https://freegen.app' } });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
      return;
    }
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ type: 'subscribe', job_id: jobId, auth: Date.now().toString() })); } catch (e) { clearTimeout(timer); reject(e); }
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'result' && msg.image_data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(msg.image_data);
      } else if (msg.type === 'error') {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(new Error(msg.message || 'freegen generation error'));
      }
    };
    ws.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      reject(new Error('freegen websocket error'));
    };
    ws.onclose = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('freegen websocket closed'));
    };
  });
}

async function downloadImageToFile(imageUrl, filePath) {
  const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`download ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf || buf.length < 1024) throw new Error('image too small');
  fs.writeFileSync(filePath, buf);
  return buf;
}

let _freegenGenPromise = null;
let _freegenGenRunning = false;

function freegenWallpaperPaths() {
  const cacheDir = path.join(__dirname, '.cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  return {
    current: path.join(cacheDir, 'wallpaper-freegen.jpg'),
    pending: path.join(cacheDir, 'wallpaper-freegen.pending.jpg'),
  };
}

async function generateFreegenWallpaperToDisk({ prompt, ratio = '16:9', forceApply = false } = {}) {
  if (_freegenGenRunning) {
    console.log('[FreeGen] generation already in progress, waiting...');
    return _freegenGenPromise;
  }
  _freegenGenRunning = true;
  freegenLastError = null;
  _freegenGenPromise = (async () => {
    try {
      const { current, pending } = freegenWallpaperPaths();
      const finalPrompt = prompt || config.freegenPrompt || 'epic cinematic landscape, mountains at sunset, vibrant colors, ultra detailed, 16:9 wallpaper';
      console.log(`[FreeGen] generating wallpaper (ratio ${ratio})...`);
      const imageUrl = await fetchFreegenImageUrl(finalPrompt, ratio);
      await downloadImageToFile(imageUrl, pending);
      // Atomically swap on disk
      fs.renameSync(pending, current);
      console.log('[FreeGen] wallpaper saved and activated');
      if (forceApply) {
        config.wallpaperSource = 'freegen';
        debouncedSaveConfig(config);
      }
      return current;
    } catch (e) {
      freegenLastError = e.message;
      console.error('[FreeGen] generation failed:', e.message);
      throw e;
    } finally {
      _freegenGenRunning = false;
      _freegenGenPromise = null;
    }
  })();
  return _freegenGenPromise;
}

function freegenBackgroundRefresh() {
  // Fire-and-forget refresh after dashboard load, for next visit
  if (_freegenGenRunning || !config.freegenPrompt) return;
  console.log('[FreeGen] background refresh queued');
  generateFreegenWallpaperToDisk({ forceApply: false }).catch(() => {});
}

// --- HTTP Handlers ---
function authorized(req) {
  if (!config.apiKeys || config.apiKeys.length === 0) return true;
  const xApiKey = (req.headers['x-api-key'] || '').trim();
  if (xApiKey && config.apiKeys.includes(xApiKey)) return true;
  const authorization = (req.headers['authorization'] || '').trim();
  if (!authorization.startsWith('Bearer ')) return false;
  return config.apiKeys.includes(authorization.substring(7).trim());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_BODY_SIZE) {
        req.pause();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeJSON(res, statusCode, payload) {
  try { res.writeHead(statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); }
  catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"encode failed","type":"server_error"}}'); }
}

function writeOpenAIError(res, statusCode, message, errorType, code) {
  if (!message) message = http.STATUS_CODES[statusCode] || 'Unknown error';
  const payload = { error: { message, type: errorType } };
  if (code) payload.error.code = code;
  writeJSON(res, statusCode, payload);
}

async function handleHealthz(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  let modelsData = userInfoCache.data;
  if (!modelsData || Date.now() - userInfoCache.time > userInfoCache.ttl) {
    try { modelsData = await upstream.getUserInfo(); userInfoCache = { data: modelsData, time: Date.now(), ttl: 60000 }; }
    catch (e) { modelsData = userInfoCache.data; }
  }
  const poolState = keyPool?.state || [];
  writeJSON(res, 200, {
    ok: true,
    started_at: startTime.toISOString(),
    uptime_sec: Math.floor((Date.now() - startTime.getTime()) / 1000),
    api_key_valid: !!modelsData,
    provider: 'umans',
    token_state: poolState,
    valid_tokens: keyPool?.healthyCount || 0,
    total_tokens: keyPool?.total || 0,
    models_count: getEffectiveModels().length,
    runtime: IS_BUN ? 'bun' : 'node',
    runtime_version: RUNTIME_VERSION,
    port: parseListenPort(config.listenAddr),
    cache: { ...responseCache.stats, enabled: config.cacheEnabled },
    sleev: { enabled: config.sleevEnabled === true, ready: sleevState.ready, gateway: SLEEV_GATEWAY_BASE },
  });
}

async function handleModels(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  await getCatalogData(); // ensure model catalog is loaded
  const models = getEffectiveModels();
  const created = Math.floor(startTime.getTime() / 1000);
  writeJSON(res, 200, {
    object: 'list',
    data: models.map(m => ({
      id: m,
      object: 'model',
      created,
      owned_by: 'umans',
      root: m,
      permission: [],
      display_name: modelDisplayNameMap[m] || m.replace(/^umans-/i, ''),
    }))
  });
}

function processQueue() {
  if (requestQueue.length === 0) return;
  const limit = getEffectiveConcurrency().limit;
  if (limit === null) return;
  while (requestQueue.length > 0 && activeRequests < limit) {
    const item = requestQueue.shift();
    if (item.res.writableEnded) continue;
    activeRequests++;
    if (item.format === 'anthropic') {
      proxyAnthropicRequest(item.res, item.payload, item.model, item.writeError, item.writePassthroughError, item.req)
        .finally(() => { activeRequests--; processQueue(); });
    } else {
      proxyChatRequest(item.res, item.payload, item.model, item.writeError, item.writePassthroughError, item.req)
        .finally(() => { activeRequests--; processQueue(); });
    }
  }
}

async function handleChatCompletions(req, res) {
  if (req.method !== 'POST') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeOpenAIError(res, 400, 'failed to read request body', 'invalid_request_error', ''); return; }
  let payload;
  try { payload = JSON.parse(requestBody); } catch (e) { writeOpenAIError(res, 400, 'request body must be valid JSON', 'invalid_request_error', ''); return; }
  const requestedModel = (payload.model || '').trim();
  if (!requestedModel) { writeOpenAIError(res, 400, 'model is required', 'invalid_request_error', ''); return; }

  const limit = getEffectiveConcurrency().limit;
  if (limit !== null && activeRequests >= limit) {
    requestQueue.push({ res, payload, model: requestedModel, writeError: writeOpenAIError, writePassthroughError, req });
    return;
  }
  activeRequests++;
  proxyChatRequest(res, payload, requestedModel, writeOpenAIError, writePassthroughError, req)
    .finally(() => { activeRequests--; processQueue(); });
}

async function proxyAnthropicRequest(res, payload, requestedModel, writeError, writePassthroughError, req) {
  const reqStart = Date.now();
  const isStream = payload.stream === true;

  const fingerprint = fingerprintPayload(payload);
  const cachedSession = fingerprint != null ? touchConversation(fingerprint) : undefined;

  let slot;
  if (cachedSession) {
    slot = await keyPool.acquire(cachedSession.tokenIndex);
  }
  if (!slot) {
    slot = await keyPool.acquire();
  }
  if (!slot) { writeError(res, 503, 'no healthy API keys available', 'server_error', 'no_healthy_keys'); return; }

  let session;
  if (fingerprint != null) {
    if (!cachedSession) {
      session = { tokenIndex: slot.index, requestCount: 1, sessNum: ++globalSessionCounter };
      trackConversationSession(fingerprint, session);
    } else {
      session = cachedSession;
      session.requestCount++;
      session.tokenIndex = slot.index;
      trackConversationSession(fingerprint, session);
    }
  } else {
    session = { tokenIndex: slot.index, requestCount: 1, sessNum: ++globalSessionCounter };
  }
  const sessNum = session.sessNum;

  if (session.requestCount === 1) {
    const firstPrompt = extractUserPrompt(payload);
    console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[anthropic:${requestedModel}]-first-prompt: ${firstPrompt}`);
  } else {
    const promptPreview = extractUserPrompt(payload).substring(0, 80);
    console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[anthropic:${requestedModel}]-${promptPreview}`);
  }

  const resolvedAnthropicModel = resolveModelId(requestedModel);
  await performVisionHandoff(payload, resolvedAnthropicModel, slot, sessNum, reqStart);

  try {
    const result = await upstream.messages(payload);
    const upstreamBody = result.body;
    const upstreamStatus = result.status;

    if (upstreamStatus >= 400) {
      let errText = '';
      try { errText = await readBodyText(upstreamBody); } catch {}
      console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[anthropic:${requestedModel}]-UPSTREAM:${upstreamStatus} ${(errText||'').substring(0,200)}`);
      logHttpError({
        errorType: 'upstream_http_error',
        stage: 'anthropic_passthrough',
        session: { sessNum, slotName: slot.name },
        request: { method: 'POST', url: `http://localhost${req?.url || '/v1/messages'}`, headers: redactHeaders(req?.headers || {}), body: redactBodyJson(JSON.stringify(payload).substring(0, 2000)) },
        upstream: { url: `${upstream.baseURL}/messages`, method: 'POST', status: upstreamStatus, body: (errText || '').substring(0, 500) },
      });
      writePassthroughError(res, upstreamStatus, errText);
      // The Anthropic pass-through has no retry loop, so marking the key
      // unhealthy on a 500/502/503 only poisons the key for subsequent
      // requests with no rotation benefit. A 500 here is almost always a
      // payload/content issue (e.g. UMANS choking on a large tool history),
      // not a per-key problem. Only cool down on network-level failures
      // handled in the catch block below.
      if (upstreamStatus === 503) {
        keyPool.markUnhealthy(slot.index, upstreamStatus);
      }
      return;
    }

    const respHeaders = {
      'Content-Type': isStream ? 'text/event-stream' : 'application/json',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    };
    res.writeHead(upstreamStatus, respHeaders);
    pipeBodyToResponse(upstreamBody, res);
  } catch (e) {
    console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[anthropic:${requestedModel}]-ERROR ${(e.message||'').substring(0,200)}`);
    writePassthroughError(res, 502, e.message || 'upstream fetch failed');
    keyPool.markUnhealthy(slot.index, 502);
  }
}

async function handleAnthropicMessages(req, res) {
  if (req.method !== 'POST') { writeAnthropicError(res, 405, 'method not allowed', 'invalid_request_error'); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeAnthropicError(res, 400, 'failed to read request body', 'invalid_request_error'); return; }
  let anthropicPayload;
  try { anthropicPayload = JSON.parse(requestBody); } catch (e) { writeAnthropicError(res, 400, 'request body must be valid JSON', 'invalid_request_error'); return; }
  const requestedModel = (anthropicPayload.model || '').trim();
  if (!requestedModel) { writeAnthropicError(res, 400, 'model is required', 'invalid_request_error'); return; }
  const isStream = anthropicPayload.stream === true;

  // Anthropic payloads are passed through mostly untouched, but apply the same
  // image-count cap the OpenAI path uses so UMANS never sees > MAX_IMAGES images.
  limitImagesInMessages(anthropicPayload, config.maxImages);

  const limit = getEffectiveConcurrency().limit;
  if (limit !== null && activeRequests >= limit) {
    requestQueue.push({ res, payload: anthropicPayload, model: requestedModel, writeError: writeAnthropicError, writePassthroughError: writeAnthropicPassthroughError, req, format: 'anthropic' });
    return;
  }
  activeRequests++;
  proxyAnthropicRequest(res, anthropicPayload, requestedModel, writeAnthropicError, writeAnthropicPassthroughError, req)
    .finally(() => { activeRequests--; processQueue(); });
}

async function proxyChatRequest(res, payload, requestedModel, writeError, writeUpstreamError, req) {
  const reqStart = Date.now();
  const requestMethod = req?.method;
  const requestUrl = req ? `http://localhost${req.url}` : null;
  const requestHeaders = req ? redactHeaders(req.headers) : null;
  const requestBodyJson = payload ? redactBodyJson(JSON.stringify(payload)) : null;

  const fingerprint = fingerprintPayload(payload);
  let cachedSession = fingerprint != null ? touchConversation(fingerprint) : undefined;

  let slot;
  if (cachedSession) {
    slot = await keyPool.acquire(cachedSession.tokenIndex);
  }
  if (!slot) {
    slot = await keyPool.acquire();
  }
  if (!slot) { writeError(res, 503, 'no healthy API keys available', 'server_error', 'no_healthy_keys'); return; }

  let session;
  if (fingerprint != null) {
    if (!cachedSession) {
      session = { tokenIndex: slot.index, requestCount: 1, sessNum: ++globalSessionCounter };
      trackConversationSession(fingerprint, session);
    } else {
      session = cachedSession;
      session.requestCount++;
      session.tokenIndex = slot.index;
      trackConversationSession(fingerprint, session);
    }
  } else {
    session = { tokenIndex: slot.index, requestCount: 1, sessNum: ++globalSessionCounter };
  }
  const sessNum = session.sessNum;
  const requestedStream = payload.stream === true;

  if (session.requestCount === 1) {
    const firstPrompt = extractUserPrompt(payload);
    console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[${requestedModel}]-first-prompt: ${firstPrompt}`);
  }

  stripReasoningContent(payload);

  const cacheEnabled = config.cacheEnabled && !payload.stream;
  let ck;
  if (cacheEnabled) {
    ck = cacheKey(payload, requestedModel);
    const cached = responseCache.get(ck);
    if (cached) {
      const promptPreview = extractUserPrompt(payload).substring(0, 80);
      console.log(`${reqStart} [${slot.name}]-[${requestedModel}]-cache:HIT ${promptPreview}`);
      try {
        let parsed = null;
        try { parsed = JSON.parse(cached); } catch (e) { /* ignore */ }
        if (parsed) parsed = sanitizeChatCompletionResponse(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(parsed ? JSON.stringify(parsed) : cached);
      }
      catch (e) { /* ignore */ }
      return;
    }
  }

  const promptPreview = extractUserPrompt(payload).substring(0, 80);
  console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[${requestedModel}]-${promptPreview}`);

  const resolvedModel = resolveModelId(requestedModel);
  payload.model = resolvedModel;
  if (payload.tools) {
    const needNorm = payload.tools.some(t => t.function?.parameters?.$defs || t.function?.parameters?.$definitions || t.function?.parameters?.$ref);
    if (needNorm) normalizeToolSchemas(payload.tools);
  }

  const modelInfo = modelInfoMap[resolvedModel] || {};
  const isHandoffModel = needsVisionHandoff(resolvedModel);
  limitImagesInMessages(payload, 1);

  const reasoningCaps = modelInfo.capabilities?.reasoning;
  if (reasoningCaps?.supported === true && reasoningCaps.can_disable === false) {
    payload.thinking = { type: 'adaptive' };
  }

  await performVisionHandoff(payload, resolvedModel, slot, sessNum, reqStart);

  await enforceRateLimit(requestedModel);

  await retryLoop(async ({ attempt, isLast }) => {
    let resp;
    try {
      resp = await upstream.chatCompletions(payload);
    } catch (e) {
      keyPool.markUnhealthy(slot.index, 502);
      if (isLast) {
        writeError(res, 502, e.message, 'server_error', '');
        return { retry: false };
      }
      const delay = RETRY_DELAY_MS + (3000 * (attempt - 1));
      console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[${requestedModel}]-network-retry:${attempt}/${MAX_RETRIES}-waiting:${delay}ms (${e.message})`);
      return { retry: true };
    }

    const contentType = resp.headers['content-type'] || '';

    if (resp.status >= 200 && resp.status < 300) {
      try {
        if (contentType.includes('text/event-stream')) {
          // Buffer the SSE stream so we can sanitize any shell tool_calls before
          // the client sees them. Tool-call argument chunks may be split, so partial
          // interception is unsafe; full-buffering is correct and acceptable for
          // agent tool-call streams.
          let rawSse = '';
          const collectData = (chunk) => { rawSse += Buffer.from(chunk).toString('utf8'); };
          if (resp.body && typeof resp.body.pipe === 'function') {
            await new Promise((resolve) => {
              resp.body.on('data', collectData);
              resp.body.on('end', resolve);
              resp.body.on('error', resolve);
            });
          } else if (resp.body && typeof resp.body.getReader === 'function') {
            const reader = resp.body.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                collectData(value);
              }
            } catch { /* fall through */ }
          }
          const sanitizedSse = sanitizeSseResponse(rawSse);
          res.writeHead(resp.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          try { res.end(sanitizedSse); } catch {}
        } else {
          let bodyText = await readBodyText(resp.body);
          const skipHeaders = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'content-encoding']);
          if (requestedStream) skipHeaders.add('content-type');
          for (const [key, values] of Object.entries(resp.headers)) {
            if (skipHeaders.has(key.toLowerCase())) continue;
            res.setHeader(key, values);
          }
          let parsed = null;
          try { parsed = JSON.parse(bodyText); } catch (e) { /* ignore */ }
          if (parsed) parsed = sanitizeChatCompletionResponse(parsed);
          if (requestedStream) {
            res.writeHead(resp.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            res.end(parsed ? JSON.stringify(parsed) : `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: bodyText }, finish_reason: 'stop' }] })}\n\n`);
          } else {
            const finalBody = parsed ? JSON.stringify(parsed) : bodyText;
            res.writeHead(resp.status);
            res.end(finalBody);
          }
          const cacheBody = parsed ? JSON.stringify(parsed) : bodyText;
          if (ck) responseCache.set(ck, cacheBody);
          console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[${requestedModel}]-body:${cacheBody.substring(0, 800)}`);
        }
      } catch (e) { console.error(`proxy response copy failed: ${e.message}`); }

      return { retry: false };
    }

    const errorBodyStr = await readBodyText(resp.body);

    if (resp.status === 500 || resp.status === 503) {
      keyPool.markUnhealthy(slot.index, resp.status);
      logHttpError({
        errorType: 'upstream_http_error',
        stage: isLast ? 'final_attempt' : 'retryable_attempt',
        attempt,
        session: session ? { sessNum, slotName: slot.name } : null,
        request: {
          method: requestMethod,
          url: requestUrl,
          headers: requestHeaders,
          body: requestBodyJson,
        },
        upstream: {
          url: `${config.upstreamBaseURL}/chat/completions`,
          method: 'POST',
          headers: redactHeaders(resp.headers),
          status: resp.status,
          statusText: http.STATUS_CODES[resp.status] || '',
          body: redactBodyJson(errorBodyStr),
        },
      }).catch(e => console.error('failed to write errors.log:', e.message));
      if (isLast) {
        console.error(`${reqStart} [Session#${sessNum}>${slot.name}]-[${requestedModel}]-error:${resp.status}-FINAL`);
        writeUpstreamError(res, resp.status, errorBodyStr);
        return { retry: false };
      }
      const delay = RETRY_DELAY_MS + (3000 * (attempt - 1));
      console.log(`${reqStart} [Session#${sessNum}>${slot.name}]-[${requestedModel}]-retry:${attempt}/${MAX_RETRIES}-waiting:${delay}ms`);
      return { retry: true };
    }

    if (resp.status >= 500) keyPool.markUnhealthy(slot.index, resp.status);
    console.error(`${reqStart} [Session#${sessNum}>${slot.name}]-[${requestedModel}]-error:${resp.status}`);
    writeUpstreamError(res, resp.status, errorBodyStr);
    return { retry: false };
  });
}
function writePassthroughError(res, statusCode, body) {
  const trimmed = body.trim();
  try { const payload = JSON.parse(trimmed); writeOpenAIError(res, statusCode, payload.error?.message || payload.message || trimmed, payload.error?.type || 'upstream_error', payload.error?.code || ''); }
  catch (e) { writeOpenAIError(res, statusCode, trimmed, 'upstream_error', ''); }
}

async function validateApiKey() {
  if (!config.apiKey) { console.log('No API key configured'); return false; }
  try {
    const data = await upstream.getUserInfo();
    userInfoCache = { data, time: Date.now(), ttl: 60000 };
    if (data && typeof data === 'object' && !Array.isArray(data.data)) {
      modelDisplayNameMap = {};
      modelInfoMap = {};
      for (const [id, info] of Object.entries(data)) {
        if (!info || typeof info !== 'object') continue;
        modelInfoMap[id] = info;
        if (info.display_name) modelDisplayNameMap[id] = info.display_name.replace(/^Umans\s+/i, '');
      }
    }
    console.log(`API key valid, ${Object.keys(modelDisplayNameMap).length} models loaded`);
    return true;
  } catch (e) {
    console.error(`API key validation failed: ${e.message}`);
    return false;
  }
}

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  if (config.apiKeys && config.apiKeys.length > 0 && !authorized(req)) {
    writeOpenAIError(res, 401, 'invalid proxy api key', 'authentication_error', '');
    return;
  }

  if (pathname === '/dashboard' || pathname === '/') {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    if (!fs.existsSync(dashboardPath)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Dashboard not found'); return; }
    let dashboardHtml = fs.readFileSync(dashboardPath, 'utf8');

    // Embed current wallpaper to prevent white flash while dashboard loads
    let bgStyle = '<style>body{background:#0d1117}</style>';
    if (config.wallpaperSource === 'bing') {
      const file = path.join(__dirname, '.cache', 'wallpaper.jpg');
      if (fs.existsSync(file)) {
        try {
          const buf = fs.readFileSync(file);
          bgStyle = '<style>html,body{min-height:100vh;background:#0d1117 url(data:image/jpeg;base64,' + buf.toString('base64') + ') no-repeat center center fixed;background-size:cover}</style>';
        } catch {}
      }
    } else if (config.wallpaperSource === 'wallhaven') {
      const file = path.join(__dirname, '.cache', 'wallpaper-haven.jpg');
      if (fs.existsSync(file)) {
        try {
          const buf = fs.readFileSync(file);
          bgStyle = '<style>html,body{min-height:100vh;background:#0d1117 url(data:image/jpeg;base64,' + buf.toString('base64') + ') no-repeat center center fixed;background-size:cover}</style>';
        } catch {}
      }
    } else if (config.wallpaperSource === 'freegen') {
      const file = path.join(__dirname, '.cache', 'wallpaper-freegen.jpg');
      if (fs.existsSync(file)) {
        try {
          const buf = fs.readFileSync(file);
          bgStyle = '<style>html,body{min-height:100vh;background:#0d1117 url(data:image/jpeg;base64,' + buf.toString('base64') + ') no-repeat center center fixed;background-size:cover}</style>';
        } catch {}
      }
    }
    dashboardHtml = dashboardHtml.replace(/<\/head>/i, bgStyle + '</head>');

    const buf = Buffer.from(dashboardHtml, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': buf.length });
    res.end(buf);

    // After serving current wallpaper, kick off a background refresh (for next visit)
    if (config.wallpaperSource === 'freegen') {
      setTimeout(freegenBackgroundRefresh, 100);
    }
    return;
  }

  if (pathname === '/api/i18n') { await handleI18n(req, res); return; }

  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      const safeConfig = {
        listenAddr: config.listenAddr,
        upstreamBaseURL: config.upstreamBaseURL,
        apiKey: maskToken(config.apiKey),
        enabledModels: config.enabledModels,
        modelDisplayNames: config.modelDisplayNames,
        cacheEnabled: config.cacheEnabled,
        cacheMaxSize: config.cacheMaxSize,
        cacheTtl: config.cacheTtl,
        overrideConcurrency: config.overrideConcurrency,
        maxImages: config.maxImages,
        wallpaperSource: config.wallpaperSource,
        freegenPrompt: config.freegenPrompt || '',
        disabledModels: config.disabledModels || [],
        visionHandoffEnabled: config.visionHandoffEnabled !== false,
        visionHandoffModel: config.visionHandoffModel || 'umans-kimi-k2.7',
        visionHandoffPrompt: config.visionHandoffPrompt || '',
        sleevEnabled: config.sleevEnabled === true,
      };
      writeJSON(res, 200, safeConfig);
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const newConfig = JSON.parse(body);
        if (newConfig.apiKey) config.apiKey = newConfig.apiKey;
        if (newConfig.apiKeys) config.apiKeys = newConfig.apiKeys;
  if (newConfig.listenAddr) config.listenAddr = newConfig.listenAddr;
  // enabledModels is obsolete: the model list now comes from UMANS catalog.
  if (Array.isArray(newConfig.enabledModels)) config.enabledModels = newConfig.enabledModels;
  if (newConfig.modelDisplayNames && typeof newConfig.modelDisplayNames === 'object') config.modelDisplayNames = newConfig.modelDisplayNames;
        if (newConfig.email !== undefined) config.email = newConfig.email;
        if (newConfig.password !== undefined) config.password = newConfig.password;
        if (newConfig.wallpaperSource !== undefined) config.wallpaperSource = newConfig.wallpaperSource;
        if (typeof newConfig.freegenPrompt === 'string') config.freegenPrompt = newConfig.freegenPrompt;
        if (newConfig.overrideConcurrency !== undefined) config.overrideConcurrency = Math.max(0, newConfig.overrideConcurrency);
        if (typeof newConfig.maxImages !== 'undefined') config.maxImages = Math.max(1, newConfig.maxImages);
        if (Array.isArray(newConfig.disabledModels)) config.disabledModels = newConfig.disabledModels;
        if (typeof newConfig.visionHandoffEnabled === 'boolean') config.visionHandoffEnabled = newConfig.visionHandoffEnabled;
        if (typeof newConfig.visionHandoffModel === 'string') config.visionHandoffModel = newConfig.visionHandoffModel.trim();
        if (typeof newConfig.visionHandoffPrompt === 'string') config.visionHandoffPrompt = newConfig.visionHandoffPrompt;
        if (typeof newConfig.sleevEnabled === 'boolean') config.sleevEnabled = newConfig.sleevEnabled;
        if (Array.isArray(newConfig.keys)) {
          config.keys = newConfig.keys;
          keyPool = new KeyPool(config.keys.filter(k => k.key));
        }
        debouncedSaveConfig(config);
        debouncedSetupOpencodeConfig();
        writeJSON(res, 200, { success: true });
      }
      catch (e) { writeJSON(res, 400, { error: e.message }); }
      return;
    }
  }

  if (pathname === '/api/validate' && req.method === 'GET') {
    const valid = await validateApiKey();
    writeJSON(res, 200, { valid, hasApiKey: !!config.apiKey });
    return;
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    await getCatalogData();
    writeJSON(res, 200, { models: getAllCatalogModels(), disabled_models: config.disabledModels || [], model_display_names: modelDisplayNameMap });
    return;
  }

  if (pathname === '/api/bg' && req.method === 'GET') {
    const cacheDir = path.join(__dirname, '.cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const imgCacheFile = path.join(cacheDir, 'wallpaper.jpg');
    const today = new Date().toISOString().split('T')[0];
    const cachedDate = fs.existsSync(imgCacheFile) ? fs.statSync(imgCacheFile).mtime.toISOString().split('T')[0] : '';
    const expireHeader = cachedDate ? { 'Expires': new Date(cachedDate + 'T23:59:59Z').toUTCString() } : { 'Cache-Control': 'public, max-age=86400' };
    if (cachedDate === today && fs.existsSync(imgCacheFile)) {
      const imgData = fs.readFileSync(imgCacheFile);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': imgData.length, ...expireHeader });
      res.end(imgData);
      return;
    }
    try {
      const response = await fetch('https://peapix.com/bing/feed', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const text = await response.text();
      const data = JSON.parse(text);
      const item = Array.isArray(data) ? data[0] : data;
      const imgUrl = item.fullUrl || item.imageUrl || item.url || '';
      if (!imgUrl) { writeJSON(res, 404, { error: 'not found' }); return; }
      const imgResp = await new Promise((resolve, reject) => {
        const u = new URL(imgUrl);
        const mod = u.protocol === 'https:' ? require('https') : require('http');
        mod.get(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }, resolve).on('error', reject);
      });
      const chunks = [];
      imgResp.on('data', c => chunks.push(c));
      imgResp.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(imgCacheFile, buf);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, ...expireHeader });
        res.end(buf);
      });
    } catch (e) {
      if (fs.existsSync(imgCacheFile)) {
        const buf = fs.readFileSync(imgCacheFile);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, ...expireHeader });
        res.end(buf);
        return;
      }
      writeJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/bg-wallhaven' && req.method === 'GET') {
    const cacheDir = path.join(__dirname, '.cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const imgCacheFile = path.join(cacheDir, 'wallpaper-haven.jpg');
    const oneHour = 60 * 60 * 1000;
    if (fs.existsSync(imgCacheFile) && Date.now() - fs.statSync(imgCacheFile).mtimeMs < oneHour) {
      const imgData = fs.readFileSync(imgCacheFile);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': imgData.length });
      res.end(imgData);
      return;
    }
    try {
      const apiUrl = 'https://wallhaven.cc/api/v1/search?categories=100&purity=100&topRange=1M&sorting=toplist&order=desc&page=3';
      const resp = await fetch(apiUrl, { headers: { 'User-Agent': 'umans-proxy/1.0' } });
      if (!resp.ok) throw new Error('Wallhaven API returned ' + resp.status);
      const d = await resp.json();
      const data = d?.data;
      if (!Array.isArray(data) || data.length === 0) throw new Error('No wallpapers found');
      const pick = data[Math.floor(Math.random() * data.length)];
      const imgUrl = pick?.path;
      if (!imgUrl) throw new Error('No image URL');
      const imgResp = await new Promise((resolve, reject) => {
        const u = new URL(imgUrl);
        const mod = u.protocol === 'https:' ? require('https') : require('http');
        mod.get(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }, resolve).on('error', reject);
      });
      const chunks = [];
      imgResp.on('data', c => chunks.push(c));
      imgResp.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(imgCacheFile, buf);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
        res.end(buf);
      });
    } catch (e) {
      if (fs.existsSync(imgCacheFile)) {
        const buf = fs.readFileSync(imgCacheFile);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
        res.end(buf);
        return;
      }
      writeJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/bg-freegen' && req.method === 'GET') {
    const { current } = freegenWallpaperPaths();
    if (fs.existsSync(current)) {
      const imgData = fs.readFileSync(current);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': imgData.length });
      res.end(imgData);
      return;
    }
    // If file missing, try to generate and wait synchronously
    if (req.url.includes('wait=1')) {
      try {
        await generateFreegenWallpaperToDisk();
        const buf = fs.readFileSync(current);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
        res.end(buf);
        return;
      } catch (e) { writeJSON(res, 500, { error: e.message }); return; }
    }
    writeJSON(res, 404, { error: 'freegen wallpaper not generated yet' });
    return;
  }

  if (pathname === '/api/bg-freegen' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body || '{}');
      const prompt = data.prompt || config.freegenPrompt;
      const ratio = data.ratio || '16:9';
      const wait = data.wait !== false;
      if (!prompt) { writeJSON(res, 400, { error: 'prompt required' }); return; }
      // Update default prompt
      config.freegenPrompt = prompt;
      debouncedSaveConfig(config);
      if (wait) {
        const file = await generateFreegenWallpaperToDisk({ prompt, ratio, forceApply: true });
        const buf = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
        res.end(buf);
      } else {
        generateFreegenWallpaperToDisk({ prompt, ratio, forceApply: true }).catch(() => {});
        writeJSON(res, 202, { success: true, message: 'FreeGen wallpaper generation started' });
      }
    } catch (e) { writeJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/keys') {
    if (req.method === 'GET') {
      const safe = (config.keys || []).map(t => ({
        name: t.name,
        token_masked: maskToken(t.key),
        has_token: !!t.key,
        has_session: !!t.session,
      }));
      writeJSON(res, 200, { keys: config.keys || [], safe });
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const data = JSON.parse(body);
        if (data.action === 'add') {
          if (!config.keys) config.keys = [];
          config.keys.push({ name: data.name || `Key ${config.keys.length + 1}`, key: data.key || '', session: '' });
          if (!config.apiKey && data.key) config.apiKey = data.key;
          keyPool = new KeyPool(config.keys.filter(k => k.key));
          debouncedSaveConfig(config);
          debouncedSetupOpencodeConfig();
          writeJSON(res, 200, { success: true, keys: config.keys });
        } else if (data.action === 'update') {
          if (typeof data.index !== 'number' || !config.keys || !config.keys[data.index]) { writeJSON(res, 404, { error: 'Key not found' }); return; }
          if (data.name !== undefined) config.keys[data.index].name = data.name;
          if (data.key !== undefined) config.keys[data.index].key = data.key;
          if (data.index === 0 && config.keys[0].key) config.apiKey = config.keys[0].key;
          keyPool = new KeyPool(config.keys.filter(k => k.key));
          debouncedSaveConfig(config);
          debouncedSetupOpencodeConfig();
          writeJSON(res, 200, { success: true, keys: config.keys });
        } else if (data.action === 'delete') {
          if (typeof data.index !== 'number' || !config.keys || !config.keys[data.index]) { writeJSON(res, 404, { error: 'Key not found' }); return; }
          config.keys.splice(data.index, 1);
          if (config.keys.length === 0) config.keys.push({ name: 'Key 1', key: '', session: '' });
          if (data.index === 0) config.apiKey = config.keys[0].key || '';
          keyPool = new KeyPool(config.keys.filter(k => k.key));
          debouncedSaveConfig(config);
          debouncedSetupOpencodeConfig();
          writeJSON(res, 200, { success: true, keys: config.keys });
        } else {
          writeJSON(res, 400, { error: 'Unknown action' });
        }
      } catch (e) { writeJSON(res, 400, { error: e.message }); }
      return;
    }
  }

  if (pathname === '/api/cache') {
    if (req.method === 'GET') { writeJSON(res, 200, { ...responseCache.stats, enabled: config.cacheEnabled }); return; }
    if (req.method === 'DELETE') { responseCache.clear(); writeJSON(res, 200, { success: true, cache: responseCache.stats }); return; }
  }

  // UMANS Usage endpoints
  if (pathname === '/api/umans/usage' && req.method === 'GET') {
    (async () => {
      try {
        if (!config.appSession) {
          await loginToApp();
        }
        const usageRaw = await fetchUsage();
        const usage = usageRaw?.usage ?? null;
        const win = usageRaw?.window ?? null;
        writeJSON(res, 200, { usage, window: win, loggedIn: !!config.appSession, email: config.email || '' });
      } catch (e) {
        if (!res.writableEnded) writeJSON(res, 500, { error: e.message });
      }
    })();
    return;
  }

  if (pathname === '/api/umans/usage-history' && req.method === 'GET') {
    (async () => {
      try {
        if (!config.appSession) {
          await loginToApp();
        }
        const history = await fetchUsageHistory();
        writeJSON(res, 200, { history, loggedIn: !!config.appSession });
      } catch (e) {
        if (!res.writableEnded) writeJSON(res, 500, { error: e.message });
      }
    })();
    return;
  }

  if (pathname === '/api/umans/concurrency' && req.method === 'GET') {
    (async () => {
      try {
        const data = await fetchConcurrency();
        const effective = getEffectiveConcurrency();
        writeJSON(res, 200, { ...data, ...effective, active: activeRequests, queued: requestQueue.length });
      } catch (e) {
        if (!res.writableEnded) writeJSON(res, 500, { error: e.message });
      }
    })();
    return;
  }

  if (pathname === '/api/umans/login' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { email, password } = JSON.parse(body);
      if (!email || !password) { writeJSON(res, 400, { error: 'Email and password required' }); return; }
      config.email = email;
      config.password = password;
      const success = await loginToApp();
      if (success) {
        debouncedSaveConfig(config);
        writeJSON(res, 200, { success: true, email });
      } else {
        writeJSON(res, 401, { error: 'Login failed' });
      }
    } catch (e) { writeJSON(res, 400, { error: e.message }); }
    return;
  }

  if (pathname === '/api/umans/user' && req.method === 'GET') {
    writeJSON(res, 200, {
      loggedIn: !!config.appSession,
      email: config.email || '',
    });
    return;
  }

  if (pathname === '/api/umans/logout' && req.method === 'POST') {
    config.appSession = '';
    saveConfig(config);
    writeJSON(res, 200, { success: true });
    return;
  }

  if (pathname === '/api/restart' && req.method === 'POST') {
    writeJSON(res, 200, { success: true, message: 'Restarting...' });
    setTimeout(() => { server.close(); process.exit(42); }, 500);
    return;
  }

  if (pathname === '/api/sleev') {
    if (req.method === 'GET') {
      const status = await getSleevStatus();
      writeJSON(res, 200, status);
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        if (typeof parsed.enabled === 'boolean') {
          config.sleevEnabled = parsed.enabled;
          debouncedSaveConfig(config);
          if (parsed.enabled && !sleevState.ready) {
            // Start gateway asynchronously; respond immediately so the
            // dashboard doesn't block on the (possibly interactive) sign-in.
            startSleev().then(ok => {
              if (ok) debouncedSetupOpencodeConfig();
            });
          } else if (!parsed.enabled) {
            stopSleev();
            debouncedSetupOpencodeConfig();
          }
          writeJSON(res, 200, { success: true, enabled: config.sleevEnabled });
        } else {
          writeJSON(res, 400, { error: 'missing "enabled" boolean field' });
        }
      } catch (e) {
        writeJSON(res, 400, { error: e.message });
      }
      return;
    }
  }

  if (pathname === '/healthz') { await handleHealthz(req, res); return; }
  if (pathname === '/v1/models') { await handleModels(req, res); return; }
  if (pathname === '/v1/chat/completions') { await handleChatCompletions(req, res); return; }
  if (pathname === '/v1/messages' || pathname === '/messages') { await handleAnthropicMessages(req, res); return; }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

function discoverOpencodeConfigs() {
  const now = Date.now();
  if (opencodeConfigPathsCache && (now - opencodeConfigPathsCacheTime) < OPENCODE_CONFIG_PATHS_TTL) {
    return opencodeConfigPathsCache;
  }

  const fallbackPaths = [
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    path.join(os.homedir(), '.opencode', 'opencode.json'),
  ];

  const finalize = (paths, source) => {
    const result = [...new Set(paths.filter(p => fs.existsSync(p)))];
    opencodeConfigPathsCache = result;
    opencodeConfigPathsCacheTime = now;
    if (result.length > 0) {
      console.log(`[Opencode] ${source === 'powershell' ? 'PowerShell discovered' : 'Discovered'} ${result.length} config(s): ${result.join(', ')}`);
    }
    return result;
  };

  if (process.platform !== 'win32') {
    return finalize(fallbackPaths, 'fallback');
  }

  if (opencodeDiscoveryFailedLogged) {
    return finalize(fallbackPaths, 'fallback');
  }

  try {
    const { execSync } = require('child_process');
    const userProfiles = [];
    const usersDir = 'C:\\Users';
    try {
      const entries = fs.readdirSync(usersDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) {
          userProfiles.push(path.join(usersDir, ent.name));
        }
      }
    } catch (e) {
      // Ignore permission errors scanning C:\Users
    }

    const candidates = [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'config', 'systemprofile', '.opencode', 'opencode.json'),
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'config', 'systemprofile', '.config', 'opencode', 'opencode.json'),
      ...userProfiles.flatMap(u => [
        path.join(u, '.opencode', 'opencode.json'),
        path.join(u, '.config', 'opencode', 'opencode.json'),
      ]),
    ];
    const found = [...new Set(candidates.filter(p => fs.existsSync(p)))];
    if (found.length > 0) {
      return finalize(found, 'filesystem');
    }
  } catch (e) {
    opencodeDiscoveryFailedLogged = true;
    console.log(`[Opencode] Filesystem discovery failed (${e.message}), using fallback paths`);
  }
  return finalize(fallbackPaths, 'fallback');
}

function debouncedSetupOpencodeConfig() {
  if (opencodeSetupPending) return;
  opencodeSetupPending = true;
  if (opencodeSetupTimeout) clearTimeout(opencodeSetupTimeout);
  opencodeSetupTimeout = setTimeout(() => {
    opencodeSetupTimeout = null;
    try {
      setupOpencodeConfig();
    } catch (e) {
      console.error(`[Opencode] Setup error: ${e.message}`);
    } finally {
      opencodeSetupPending = false;
    }
  }, 500);
}

function setupOpencodeConfig() {
  const displayNames = config.modelDisplayNames || {};
  const port = parseListenPort(config.listenAddr);

  const configPaths = discoverOpencodeConfigs();
  let firstRun = false;

  const fallbackModels = getEffectiveModels();

  const modelsDevCatalog = modelsDevCache || {};

  for (const configFile of configPaths) {
    try {
      const models = {};
      for (const m of fallbackModels) {
        const info = modelInfoMap[m] || {};
        const caps = info.capabilities || {};
        const displayName = displayNames[m] || modelDisplayNameMap[m] || (info.display_name ? info.display_name.replace(/^Umans\s+/i, '') : '') || m.replace(/^umans-/i, '');

        const devEntry = findModelsDevEntry(modelsDevCatalog, m);
        const reasoningMode = resolveReasoningMode(devEntry, caps.reasoning);

        const entry = {
          id: m,
          name: displayName,
          reasoning: reasoningMode,
        };

        const variants = buildReasoningVariants(caps.reasoning);
        if (variants) entry.variants = variants;

        if (typeof caps.context_window === 'number' && caps.context_window > 0) {
          let outputLimit = caps.context_window;
          if (typeof caps.recommended_max_tokens === 'number' && caps.recommended_max_tokens > 0) {
            outputLimit = caps.recommended_max_tokens;
          } else if (typeof caps.max_completion_tokens === 'number' && caps.max_completion_tokens > 0) {
            outputLimit = caps.max_completion_tokens;
          }
          entry.limit = {
            context: caps.context_window,
            output: outputLimit,
          };
        }

        entry.temperature = true;
        if (typeof caps.supports_tools === 'boolean') entry.tool_call = caps.supports_tools;
        if (typeof caps.supports_vision === 'boolean') entry.attachment = caps.supports_vision;

        const inputModalities = ['text'];
        if (caps.supports_vision) inputModalities.push('image');
        entry.modalities = {
          input: inputModalities,
          output: ['text'],
        };

        models[m] = entry;
      }
      const providerEntry = (() => {
        const apiKey = config.apiKeys && config.apiKeys.length > 0 ? config.apiKeys[0] : 'umans-proxy';
        if (config.sleevEnabled && sleevState.ready) {
          // Topology A: opencode → Sleev (compress) → UMANS-PROXY → UMANS.
          // Point opencode at the Sleev gateway; tell Sleev where our proxy is.
          return {
            npm: '@ai-sdk/openai-compatible',
            name: 'Umans.AI-Proxy (Sleev)',
            options: {
              baseURL: `${SLEEV_GATEWAY_BASE}/v1`,
              apiKey,
              headers: {
                [SLEEV_HARNESS_HEADER]: 'opencode',
                [SLEEV_BASE_URL_HEADER]: `http://127.0.0.1:${port}/v1`,
              },
            },
            models,
          };
        }
        return {
          npm: '@ai-sdk/openai-compatible',
          name: 'Umans.AI-Proxy',
          options: {
            baseURL: `http://localhost:${port}/v1`,
            apiKey,
          },
          models,
        };
      })();

      const dir = path.dirname(configFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let existing = { $schema: 'https://opencode.ai/config.json' };
      if (fs.existsSync(configFile)) {
        existing = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const backupFile = path.join(dir, 'openconfig.b4umans.json');
        if (!fs.existsSync(backupFile)) {
          fs.copyFileSync(configFile, backupFile);
          console.log(`[Opencode] Backup created: ${backupFile}`);
          firstRun = true;
        }
      } else {
        firstRun = true;
      }
      if (!existing.provider || typeof existing.provider !== 'object') existing.provider = {};
      existing.provider['umans'] = providerEntry;

      // When Sleev is active, disable opencode's own context pruning so Sleev
      // manages context compression instead.
      if (config.sleevEnabled && sleevState.ready) {
        if (!existing.compaction || typeof existing.compaction !== 'object') existing.compaction = {};
        existing.compaction.prune = false;
      }

      // Ensure project guidance is loaded so opencode follows UMANS-Proxy conventions
      // (e.g. exact edit matching, using webfetch instead of websearch, etc.)
      if (!Array.isArray(existing.instructions)) existing.instructions = [];
      for (const guidance of ['AGENTS.md', 'skills.md']) {
        if (!existing.instructions.includes(guidance)) {
          existing.instructions.push(guidance);
        }
      }

      fs.writeFileSync(configFile, JSON.stringify(existing, null, 2));
      console.log(`[Opencode] Config updated: ${configFile} (${Object.keys(models).length} models)`);
    } catch (e) {
      console.error(`[Opencode] Failed to update ${configFile}: ${e.message}`);
    }
  }
  return firstRun;
}

process.on('uncaughtException', (err) => {
  console.error(`[CRASH] uncaughtException: ${err.message}`);
  console.error(err.stack);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[CRASH] unhandledRejection: ${reason?.message || reason}`);
  if (reason?.stack) console.error(reason.stack);
});

// Shutdown hooks — stop the Sleev gateway child process before we exit so we
// never leave an orphaned daemon behind. Covers normal Ctrl-C, the
// /api/restart exit(42) path, and unexpected terminations.
function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] ${signal} received, cleaning up...`);
  stopSleev();
  if (server) { try { server.close(); } catch {} }
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('beforeExit', () => stopSleev());
process.on('exit', () => stopSleev());

let upstream;
let server;

async function startServer(retryPort = null) {
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│  UMANS-Proxy - Starting...                                  │');
  console.log('└─────────────────────────────────────────────────────────────┘');

  try { config = loadConfig(); } catch (e) { console.error('Failed to load config:', e.message); process.exit(1); }

  responseCache = new ResponseCache(config.cacheMaxSize, config.cacheTtl);

  if (!config.apiKey) {
    console.log('[Warning] No API key configured. Set UMANS_API_KEY env var or add API_KEY to .config/config.json');
  }

  const poolKeys = (config.keys || []).filter(k => k.key);
  keyPool = new KeyPool(poolKeys.length > 0 ? poolKeys : [{ name: 'Default', key: config.apiKey || '' }]);

  upstream = new UpstreamClient(config);
  try {
    await validateApiKey();
  } catch (e) {
    console.log(`[Warning] API key validation skipped: ${e.message}`);
  }

  if (config.email && config.password && !config.appSession) {
    const loggedIn = await loginToApp();
    if (loggedIn) console.log(`[UMANS] App login successful for ${config.email}`);
    else console.log(`[UMANS] App login failed or not attempted`);
  }

  const conc = await fetchConcurrency();
  if (conc.concurrent !== null) {
    const eff = getEffectiveConcurrency();
    console.log(`[Concurrency] sessions: ${eff.concurrent}${eff.overridden ? ' (overridden)' : ''}${conc.limit !== null ? ', limit: ' + eff.limit : ''}`);
  }

  try {
    await getModelsDevCatalog();
  } catch (e) {
    console.log(`[Models.dev] Could not preload reasoning catalog: ${e.message}`);
  }

  // Start the Sleev context-compression gateway if enabled. This must happen
  // before setupOpencodeConfig() runs so the provider entry knows whether
  // to point opencode at the Sleev gateway.
  if (config.sleevEnabled) {
    await startSleev();
  }

  let retryCount = 0;
  const MAX_RETRIES = 3;
  const basePort = parseListenPort(config.listenAddr);
  let port = retryPort || basePort;
  server = http.createServer(handleRequest);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      retryCount++;
      if (retryCount > MAX_RETRIES) {
        port = basePort + 1;
        console.log(`[Warning] Port ${basePort} busy after ${MAX_RETRIES} retries, trying port ${port}`);
        retryCount = 0;
        server.close();
        server.listen(port, '127.0.0.1');
        return;
      }
      console.log(`[Warning] Port ${port} in use (attempt ${retryCount}/${MAX_RETRIES}), retrying in 2s...`);
      setTimeout(() => {
        server.close();
        server.listen(port, '127.0.0.1');
      }, 2000);
      return;
    }
    console.error(`[CRASH] Server error: ${err.message}`);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`\nUMANS-Proxy on http://127.0.0.1:${port}`);
    console.log(`  Provider: UMANS AI`);
    console.log(`  Upstream: ${config.upstreamBaseURL}`);
    console.log(`  Key Pool: ${keyPool?.total || 0} key(s), ${keyPool?.healthyCount || 0} healthy`);
    console.log(`  Enabled Models: ${(config.enabledModels || []).length} (search & add via dashboard)`);
    console.log(`  Response Cache: ${config.cacheEnabled ? 'enabled (' + config.cacheMaxSize + ' entries, ' + (config.cacheTtl / 1000) + 's TTL)' : 'disabled'}`);
    console.log(`  Proxy API Keys: ${config.apiKeys.length > 0 ? config.apiKeys.length + ' (auth enabled)' : 'none (open access)'}`);
    console.log(`  App Account: ${config.email ? config.email + (config.appSession ? ' (logged in)' : ' (not logged in)') : 'not configured'}`);
    console.log('');
    setTimeout(() => {
      try {
        const firstRun = setupOpencodeConfig();
        if (firstRun) {
          const dashboardUrl = `http://localhost:${port}`;
          if (process.platform === 'win32') {
            require('child_process').exec(`start "" "${dashboardUrl}"`);
          } else if (process.platform === 'darwin') {
            require('child_process').exec(`open "${dashboardUrl}"`);
          } else {
            require('child_process').exec(`xdg-open "${dashboardUrl}"`);
          }
        }
      } catch (e) {
        console.error(`[Opencode] Setup error: ${e.message}`);
      }
    }, 100);
  });
}

startServer().catch(e => {
  console.error(`[CRASH] Failed to start server: ${e.message}`);
  setTimeout(() => process.exit(1), 1000);
});
