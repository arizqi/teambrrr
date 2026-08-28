// Providers: openrouter (real), local (any OpenAI-compatible server on this
// machine, no API key, no spend) and mock (deterministic, no network).
//
// Local models are routed by their id rather than by a separate provider
// object: a candidate whose model starts with "local/" goes to callLocal, and
// everything else goes where it always went. That is what lets a local
// candidate be auditioned, ranked, offered and hired by the same code as a
// remote one, and lets a room with no OpenRouter key at all still work.
import fs from 'node:fs';
import path from 'node:path';
import { isLocalModel, parseLocalModel, localHosts, chatUrlFor } from './local-models.mjs';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 30_000;
const KEY_FILE = path.join(process.env.HOME || '', '.claude', '.openrouter_key');

// GUI-launched hosts don't inherit shell env, so fall back to a key file.
// Read lazily per call so a key added mid-session works without a restart.
export function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (k) return k;
  } catch {}
  return null;
}

export function providerName() {
  if (process.env.PERSONA_RECRUITER_PROVIDER === 'mock') return 'mock';
  if (!apiKey()) return 'mock';
  return 'openrouter';
}

// `cacheFile` is an absolute path (<stateDir>/models-cache.json).
// Returns { models: {id: {pricing, name, context_length}}, source } or null.
export async function loadModels(cacheFile, { allowFetch = true } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (j.fetched_at && Date.now() - j.fetched_at < TTL_MS && j.models) {
      return { models: j.models, source: 'cache' };
    }
  } catch {}
  if (!allowFetch || !apiKey()) return null;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey()}` },
      signal: ac.signal
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const body = await res.json();
    const models = {};
    for (const m of body.data || []) {
      models[m.id] = { name: m.name, pricing: m.pricing, context_length: m.context_length };
    }
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ fetched_at: Date.now(), models }, null, 2));
    return { models, source: 'network' };
  } catch {
    return null;
  }
}

export function priceOf(models, model) {
  const m = models?.[model];
  if (!m?.pricing) return null;
  const inP = Number(m.pricing.prompt);
  const outP = Number(m.pricing.completion);
  if (!Number.isFinite(inP) || !Number.isFinite(outP)) return null;
  return { prompt: inP, completion: outP };
}

function costFrom(usage, price) {
  if (usage && typeof usage.cost === 'number') return usage.cost;
  if (!usage || !price) return null;
  const pt = usage.prompt_tokens ?? 0;
  const ct = usage.completion_tokens ?? 0;
  return pt * price.prompt + ct * price.completion;
}

export async function callMock({ name, model, messages }) {
  // Test seam. A hook runs in its own process, so there is no provider to inject;
  // this lets a spawned hook be driven down a specific branch (a watcher that
  // passes vs one that objects) with no network and no spend.
  const fixed = process.env.PERSONA_RECRUITER_MOCK_TEXT;
  if (fixed) return { text: fixed, cost: 0, usage: { prompt_tokens: 0, completion_tokens: 0 } };

  const digest = messages.find((m) => m.__digest)?.content || '';
  const last = messages[messages.length - 1]?.content || '';
  const reply =
    `mock(${name}) sees channel: "${String(digest).slice(0, 200)}" ` +
    `| asked: "${String(last).slice(0, 200)}"`;
  return { text: reply, cost: 0, usage: { prompt_tokens: 0, completion_tokens: 0 } };
}

export async function callOpenRouter({ model, messages, params, price }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/bountihq',
        'X-Title': 'teambrrr'
      },
      body: JSON.stringify({
        model,
        messages: messages.map(({ role, content }) => ({ role, content })),
        ...(params || {})
      }),
      signal: ac.signal
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(`OpenRouter ${res.status}: ${body.slice(0, 400)}`);
    e.status = res.status; // room.mjs retries 429 / 5xx
    throw e;
  }
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content ?? '';
  return { text, cost: costFrom(j.usage, price), usage: j.usage || null };
}

// --- local -------------------------------------------------------------------
// Any OpenAI-compatible server on this machine: Ollama's /v1 shim, llama-server,
// or whatever else the user configured. No Authorization header — sending one
// to a local server is at best noise and at worst a leaked key.
//
// Cost is always exactly 0, and it is still returned as a number rather than
// null so the row goes through the same ledger arithmetic as a paid one. A
// local model is free, not unpriced.
export const LOCAL_TIMEOUT_MS = 120_000;

// Throughput, measured rather than claimed: completion tokens over the wall
// clock of this one call. Null when the server did not report usage.
export function tokensPerSec(usage, ms) {
  const out = Number(usage?.completion_tokens);
  if (!Number.isFinite(out) || out <= 0 || !Number.isFinite(ms) || ms <= 0) return null;
  return Number((out / (ms / 1000)).toFixed(1));
}

export async function callLocal({ model, messages, params, hosts, fetchImpl = fetch, timeoutMs = LOCAL_TIMEOUT_MS } = {}) {
  const parsed = parseLocalModel(model);
  if (!parsed) throw new Error(`not a local model id: "${model}" (expected local/<host>/<model>)`);
  const table = hosts || localHosts();
  const cfg = table[parsed.host];
  if (!cfg) {
    throw new Error(`unknown local host "${parsed.host}" — configure it in <state>/config.json under local_hosts`);
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(chatUrlFor(cfg), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: parsed.model,
        messages: messages.map(({ role, content }) => ({ role, content })),
        ...(params || {})
      }),
      signal: ac.signal
    });
  } catch (e) {
    // The server is not there. This is the ordinary case on a laptop, so it is
    // reported as a transient 503 rather than a hard failure: callWithRetry
    // then uses the recruit's fallback_model if — and only if — they were hired
    // with one. With no fallback, this message is what the user sees.
    const err = new Error(
      `local host "${parsed.host}" is not running at ${cfg.base_url} — start it with: ${cfg.start_command}`
    );
    err.status = 503;
    err.local_down = true;
    throw err;
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(`local/${parsed.host} ${res.status}: ${body.slice(0, 400)}`);
    e.status = res.status;
    throw e;
  }
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content ?? '';
  const usage = j.usage || null;
  // Floored at 1ms: a sub-millisecond reading is clock resolution, not an
  // absence of a measurement, and dividing by it would throw the rate away.
  const latency_ms = Math.max(1, Date.now() - started);
  return { text, cost: 0, usage, local: true, host: parsed.host, latency_ms, tokens_per_sec: tokensPerSec(usage, latency_ms) };
}

// --- retry ------------------------------------------------------------------
// One shared call path for every caller (ask, discuss, audition): retry once on
// a transient status, then once more on the fallback model if there is one.
export const RETRYABLE = (e) => e?.status === 429 || (e?.status >= 500 && e?.status < 600);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callWithRetry({
  provider, name, model, fallback_model, messages, params, price, retryDelayMs = 2000
} = {}) {
  const attempt = (m) => provider.call({ name, model: m, messages, params, price });
  try {
    return await attempt(model);
  } catch (e1) {
    if (!RETRYABLE(e1)) throw e1;
    // A refused connection will still be refused in two seconds; only wait for
    // things that are plausibly transient.
    if (!e1.local_down) await sleep(retryDelayMs);
    try {
      return await attempt(model);
    } catch (e2) {
      if (!fallback_model) throw e2;
      try {
        const r = await attempt(fallback_model);
        return { ...r, model: fallback_model, fellBack: true };
      } catch { throw e2; }
    }
  }
}

// The object room.mjs actually talks to. Swap it out in tests.
//
// The provider is named for where the *remote* calls go, because that is what
// determines whether model ids get validated against a catalog and whether any
// money can be spent. Local ids are routed underneath that name: a room with no
// OpenRouter key is still a "mock" room for remote models, but its local
// recruits are real. Forcing PERSONA_RECRUITER_PROVIDER=mock overrides
// everything, so a test never reaches a socket.
export function defaultProvider() {
  const name = providerName();
  if (process.env.PERSONA_RECRUITER_PROVIDER === 'mock') {
    return { name: 'mock', call: callMock, validates: false, local: false };
  }
  const remote = name === 'mock' ? callMock : callOpenRouter;
  return {
    name,
    call: (req) => (isLocalModel(req?.model) ? callLocal(req) : remote(req)),
    validates: name !== 'mock',
    local: true
  };
}
