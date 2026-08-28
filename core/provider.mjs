// Providers: openrouter (real) and mock (deterministic, no network, no spend).
import fs from 'node:fs';
import path from 'node:path';

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
        'X-Title': 'persona-recruiter'
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
    await sleep(retryDelayMs);
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
export function defaultProvider() {
  const name = providerName();
  return {
    name,
    call: name === 'mock' ? callMock : callOpenRouter,
    validates: name !== 'mock'
  };
}
