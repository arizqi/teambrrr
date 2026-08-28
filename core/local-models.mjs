// Local models: discovery and GPU-contention awareness for models running on
// this machine rather than behind OpenRouter.
//
// Two surfaces, one shape. Both hosts speak OpenAI-compatible
// /v1/chat/completions with no API key, so once a candidate is discovered it is
// probed, scored and hired by exactly the same code path as a remote one. The
// only thing that differs is the namespace and the price:
//
//   local/ollama/qwen3.6:35b-a3b        <- GET <ollama>/api/tags
//   local/llama-server/qwen3.6-35b-a3b  <- GET <llama-server>/v1/models
//
// Everything here is graceful about a host being down. A laptop with nothing
// running is the normal case, not an error: discovery reports "not running"
// plus the command that would start it, and the recruiter carries on with
// whatever else it found.
//
// Endpoints are configurable, in precedence order:
//   1. env  ROOM_OLLAMA_URL / ROOM_LLAMA_SERVER_URL
//   2. <stateDir>/config.json  ->  { "local_hosts": { "ollama": { "base_url": ... } } }
//   3. the built-in defaults below

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const LOCAL_PREFIX = 'local';
export const DISCOVERY_TIMEOUT_MS = 3000;

// A model big enough that a second one of its size will not co-exist on the GPU.
// Measured on this class of machine: two ~20GB residents drop decode from ~80
// tok/s to ~2.4 tok/s. The number is a heuristic, not a hardware query.
export const HEAVY_BYTES = 6 * 1024 * 1024 * 1024;

export const DEFAULT_HOSTS = {
  ollama: {
    base_url: 'http://127.0.0.1:11434',
    // Ollama's own API; the OpenAI-compatible surface hangs off /v1.
    list_path: '/api/tags',
    loaded_path: '/api/ps',
    start_command: 'ollama serve'
  },
  'llama-server': {
    base_url: 'http://127.0.0.1:8080',
    list_path: '/v1/models',
    loaded_path: null, // llama-server holds exactly one model: up == loaded
    start_command: '~/tools_I_want_to_build_and_opensource/llama-qwen36/agentic/start.sh'
  }
};

export const HOST_NAMES = Object.keys(DEFAULT_HOSTS);

// --- ids ---------------------------------------------------------------------
// Namespaced so a model id is self-describing everywhere it travels: persona
// files, the spend ledger, offer cards, the room transcript.

export const localModelId = (host, model) => `${LOCAL_PREFIX}/${host}/${model}`;

export const isLocalModel = (id) => typeof id === 'string' && id.startsWith(`${LOCAL_PREFIX}/`);

// "local/ollama/qwen3.6:35b-a3b" -> { host: 'ollama', model: 'qwen3.6:35b-a3b' }.
// The model half may itself contain slashes (hf-style ids), so only the first
// two segments are consumed.
export function parseLocalModel(id) {
  if (!isLocalModel(id)) return null;
  const rest = id.slice(LOCAL_PREFIX.length + 1);
  const cut = rest.indexOf('/');
  if (cut <= 0) return null;
  const host = rest.slice(0, cut);
  const model = rest.slice(cut + 1);
  if (!host || !model) return null;
  return { host, model };
}

// --- configuration -----------------------------------------------------------

const ENV_KEYS = { ollama: 'ROOM_OLLAMA_URL', 'llama-server': 'ROOM_LLAMA_SERVER_URL' };
const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

export function readLocalConfig(stateDir = process.env.ROOM_STATE_DIR || path.join(os.homedir(), '.room')) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
    return j && typeof j.local_hosts === 'object' && j.local_hosts ? j.local_hosts : {};
  } catch { return {}; }
}

// The resolved host table: defaults, overlaid by config.json, overlaid by env.
export function localHosts({ stateDir, env = process.env, config } = {}) {
  const cfg = config || readLocalConfig(stateDir);
  const out = {};
  for (const [name, base] of Object.entries(DEFAULT_HOSTS)) {
    const fromCfg = cfg[name] || {};
    const fromEnv = env[ENV_KEYS[name]];
    out[name] = {
      ...base,
      ...fromCfg,
      host: name,
      base_url: trimSlash(fromEnv || fromCfg.base_url || base.base_url)
    };
  }
  // A user may add hosts of their own in config.json; they are assumed to be
  // OpenAI-compatible, which is the only thing we actually require.
  for (const [name, c] of Object.entries(cfg)) {
    if (out[name] || !c || !c.base_url) continue;
    out[name] = {
      list_path: '/v1/models',
      loaded_path: null,
      start_command: c.start_command || `(start the server at ${c.base_url})`,
      ...c,
      host: name,
      base_url: trimSlash(c.base_url)
    };
  }
  return out;
}

// The chat endpoint for a host. Ollama's OpenAI shim lives at /v1 too, so this
// is the same rule for both.
export const chatUrlFor = (cfg) => `${trimSlash(cfg.base_url)}/v1/chat/completions`;

// --- response parsing --------------------------------------------------------
// Split out from the fetching so the shapes can be tested against fixtures with
// no server running.

// GET /api/tags — Ollama's installed-model list.
export function parseOllamaTags(body) {
  const list = Array.isArray(body?.models) ? body.models : [];
  return list.map((m) => {
    const id = m.model || m.name;
    if (!id) return null;
    const size = Number(m.size);
    return {
      host: 'ollama',
      model: id,
      id: localModelId('ollama', id),
      size_bytes: Number.isFinite(size) ? size : null,
      parameter_size: m.details?.parameter_size || null,
      quantization: m.details?.quantization_level || null,
      family: m.details?.family || null,
      context_length: Number(m.details?.context_length) || null,
      capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
      heavy: Number.isFinite(size) && size >= HEAVY_BYTES
    };
  }).filter(Boolean);
}

// GET /v1/models — the OpenAI catalog shape, used by llama-server and by any
// other OpenAI-compatible server somebody points us at.
export function parseOpenAIModels(body, host = 'llama-server') {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return list.map((m) => {
    const id = typeof m === 'string' ? m : (m.id || m.model || m.name);
    if (!id) return null;
    return {
      host,
      model: id,
      id: localModelId(host, id),
      size_bytes: null,
      parameter_size: null,
      quantization: null,
      family: null,
      context_length: Number(m.context_length || m.n_ctx) || null,
      capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
      // llama-server serves one model and it is resident by definition, so a
      // running llama-server is always a heavyweight occupant of the GPU.
      heavy: true
    };
  }).filter(Boolean);
}

// GET /api/ps — what Ollama currently holds in memory.
export function parseOllamaPs(body) {
  const list = Array.isArray(body?.models) ? body.models : [];
  return list.map((m) => {
    const id = m.model || m.name;
    if (!id) return null;
    const vram = Number(m.size_vram ?? m.size);
    return {
      host: 'ollama',
      model: id,
      id: localModelId('ollama', id),
      vram_bytes: Number.isFinite(vram) ? vram : null,
      expires_at: m.expires_at || null,
      heavy: Number.isFinite(vram) && vram >= HEAVY_BYTES
    };
  }).filter(Boolean);
}

// --- fetching ----------------------------------------------------------------

async function getJson(url, { fetchImpl = fetch, timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal });
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Why a host is unreachable matters less than the fact that it is; either way
// the answer the user needs is the command that would fix it.
const downReason = (e) => {
  const msg = String(e?.message || e);
  if (/abort/i.test(msg)) return 'timed out';
  if (/ECONNREFUSED|fetch failed|Failed to fetch|ENOTFOUND|network/i.test(msg)) return 'not running';
  return msg.slice(0, 120);
};

export async function probeHost(cfg, { fetchImpl = fetch, timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  const base = { host: cfg.host, base_url: cfg.base_url, start_command: cfg.start_command };
  try {
    const body = await getJson(`${cfg.base_url}${cfg.list_path}`, { fetchImpl, timeoutMs });
    const models = cfg.list_path === '/api/tags'
      ? parseOllamaTags(body)
      : parseOpenAIModels(body, cfg.host);
    return { ...base, running: true, models };
  } catch (e) {
    return { ...base, running: false, models: [], reason: downReason(e) };
  }
}

// What is resident on the GPU right now. Ollama can say precisely; llama-server
// has no such endpoint, so "the process answered" is the answer.
export async function loadedLocalModels({ hosts, fetchImpl = fetch, timeoutMs = DISCOVERY_TIMEOUT_MS, stateDir } = {}) {
  const table = hosts || localHosts({ stateDir });
  const loaded = [];
  for (const cfg of Object.values(table)) {
    if (cfg.loaded_path) {
      try {
        const body = await getJson(`${cfg.base_url}${cfg.loaded_path}`, { fetchImpl, timeoutMs });
        loaded.push(...parseOllamaPs(body));
      } catch { /* host down: nothing of its is loaded */ }
    } else {
      const probe = await probeHost(cfg, { fetchImpl, timeoutMs });
      if (probe.running) {
        for (const m of probe.models) {
          loaded.push({ host: cfg.host, model: m.model, id: m.id, vram_bytes: null, heavy: true });
        }
      }
    }
  }
  return loaded;
}

export async function discoverLocalModels({ hosts, fetchImpl = fetch, timeoutMs = DISCOVERY_TIMEOUT_MS, stateDir } = {}) {
  const table = hosts || localHosts({ stateDir });
  const probed = await Promise.all(
    Object.values(table).map((cfg) => probeHost(cfg, { fetchImpl, timeoutMs }))
  );
  const models = probed.flatMap((h) => h.models);
  return {
    ok: true,
    hosts: probed,
    models,
    running: probed.filter((h) => h.running).map((h) => h.host),
    down: probed.filter((h) => !h.running).map((h) => h.host),
    text: formatDiscovery({ hosts: probed, models })
  };
}

// --- candidates --------------------------------------------------------------

// Which discovered models are worth putting in front of a role. Embedding-only
// models are dropped because they cannot answer a probe at all, and the field is
// capped so discovery on a well-stocked machine does not silently turn a
// four-model audition into a twenty-model one.
export const MAX_LOCAL_CANDIDATES = 4;

export function localCandidates(models, { limit = MAX_LOCAL_CANDIDATES } = {}) {
  const chat = (models || []).filter((m) => {
    const caps = m.capabilities || [];
    if (caps.length && !caps.includes('completion')) return false;
    return !/embed/i.test(m.model);
  });
  // Largest first: on a machine that only runs one big model at a time, the big
  // one is the reason local is being considered at all.
  const sorted = [...chat].sort((a, b) => (b.size_bytes || 0) - (a.size_bytes || 0));
  return sorted.slice(0, limit).map((m) => ({ model: m.id, local: true, host: m.host }));
}

// --- GPU contention ----------------------------------------------------------
// Advisory only. Nothing here kills, evicts or unloads anything: it tells the
// user that the number they are about to see is not the number they measured
// alone, and leaves the decision with them.

export const fmtBytes = (n) =>
  (typeof n === 'number' && Number.isFinite(n) && n > 0 ? `${(n / 1e9).toFixed(1)}GB` : 'n/a');

// `model` is the namespaced id about to be probed or hired, if there is one.
// Returns null when nothing would contend.
export function contentionWarning({ loaded = [], model = null, heavy: modelIsHeavy = true } = {}) {
  const target = parseLocalModel(model || '');
  const others = loaded.filter((l) => !(target && l.host === target.host && l.model === target.model));
  const heavies = others.filter((l) => l.heavy);
  if (!heavies.length) return null;
  const already = heavies.map((l) => `${l.host}/${l.model}${l.vram_bytes ? ` (${fmtBytes(l.vram_bytes)})` : ''}`);
  const mine = target ? `${target.host}/${target.model}` : 'another local model';
  if (!modelIsHeavy) return null;
  return `GPU contention: ${already.join(', ')} already resident. Running ${mine} alongside ` +
    `will slow both — measured decode on this machine drops from ~80 tok/s to ~2.4 tok/s under contention. ` +
    `Nothing was unloaded; stop one yourself if the throughput matters.`;
}

export async function localContention({ model = null, hosts, fetchImpl = fetch, timeoutMs = DISCOVERY_TIMEOUT_MS, stateDir } = {}) {
  const loaded = await loadedLocalModels({ hosts, fetchImpl, timeoutMs, stateDir });
  return { loaded, warning: contentionWarning({ loaded, model }) };
}

// --- rendering ---------------------------------------------------------------

export function formatHostLine(h) {
  if (!h.running) {
    return `${h.host} — not running at ${h.base_url} (${h.reason || 'not running'}). Start it with: ${h.start_command}`;
  }
  return `${h.host} — up at ${h.base_url}, ${h.models.length} model(s)`;
}

export function formatModelLine(m) {
  const bits = [m.id];
  if (m.parameter_size) bits.push(m.parameter_size);
  if (m.size_bytes) bits.push(fmtBytes(m.size_bytes));
  if (m.quantization) bits.push(m.quantization);
  if (m.context_length) bits.push(`${Math.round(m.context_length / 1024)}k ctx`);
  bits.push('$0 (local)');
  return `  ${bits.join(' · ')}`;
}

export function formatDiscovery({ hosts, models }) {
  const lines = ['Local model hosts:', ...hosts.map((h) => `  ${formatHostLine(h)}`)];
  if (models.length) {
    lines.push('', `${models.length} local model(s) available:`, ...models.map(formatModelLine));
  } else {
    lines.push('', 'No local models available.');
  }
  return lines.join('\n');
}

export default {
  discoverLocalModels, localContention, localHosts, isLocalModel, parseLocalModel,
  localModelId, parseOllamaTags, parseOpenAIModels, parseOllamaPs, chatUrlFor
};
