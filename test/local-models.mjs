// Local models: discovery, the local provider path, graceful degradation when a
// host is down, and the $0 ledger entries a local hire produces.
//
// Everything here runs with no server on the machine. Discovery and the chat
// call both take an injectable fetch, so the fixtures below ARE the servers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseOllamaTags, parseOpenAIModels, parseOllamaPs, localHosts, localModelId,
  parseLocalModel, isLocalModel, discoverLocalModels, loadedLocalModels,
  contentionWarning, localCandidates, chatUrlFor, DEFAULT_HOSTS
} from '../core/local-models.mjs';
import { callLocal, callWithRetry, tokensPerSec } from '../core/provider.mjs';
import { rank, WEIGHTS } from '../core/audition.mjs';
import { makeOffers, offerLine } from '../core/offers.mjs';
import { createRoom } from '../core/room.mjs';
import { check, done } from './_harness.mjs';

console.log('local model tests\n');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-local-'));
const stateDir = path.join(scratch, 'state');

// --- fixtures ----------------------------------------------------------------
// Trimmed from real responses on this machine.

const TAGS_FIXTURE = {
  models: [
    {
      name: 'qwen3.6:35b-a3b', model: 'qwen3.6:35b-a3b', size: 23938333577,
      details: { family: 'qwen35moe', parameter_size: '36.0B', quantization_level: 'Q4_K_M', context_length: 262144 },
      capabilities: ['vision', 'completion', 'tools', 'thinking']
    },
    {
      name: 'gemma4:e4b', model: 'gemma4:e4b', size: 9608350718,
      details: { family: 'gemma4', parameter_size: '8.0B', quantization_level: 'Q4_K_M' },
      capabilities: ['completion', 'tools', 'thinking']
    },
    {
      name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', size: 274302450,
      details: { family: 'nomic-bert', parameter_size: '137M', quantization_level: 'F16' },
      capabilities: ['embedding']
    }
  ]
};

const V1_MODELS_FIXTURE = {
  object: 'list',
  data: [{ id: 'qwen3.6-35b-a3b', aliases: ['qwen3.6-35b-a3b'], tags: [] }]
};

const PS_FIXTURE = {
  models: [
    { name: 'gpt-oss:20b', model: 'gpt-oss:20b', size: 13607622409, size_vram: 13607622409, expires_at: '2026-08-28T09:00:56-07:00' },
    { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', size: 370031984, size_vram: 370031984 }
  ]
};

const json = (body) => ({ ok: true, status: 200, json: async () => body });
const refused = () => { throw new TypeError('fetch failed'); };

// A fetch that answers only the URLs it is given, and refuses everything else
// the way a closed port does.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of Object.entries(routes)) {
      if (String(url).includes(match)) return handler(url, init);
    }
    return refused();
  };
  impl.calls = calls;
  return impl;
}

// --- ids ---------------------------------------------------------------------

check(localModelId('ollama', 'qwen3.6:35b-a3b') === 'local/ollama/qwen3.6:35b-a3b',
  'a local id is namespaced host-then-model');
check(isLocalModel('local/ollama/x') && !isLocalModel('openai/gpt-4o-mini'),
  'only the local/ prefix reads as local');
const parsed = parseLocalModel('local/ollama/qwen3.6:35b-a3b');
check(parsed.host === 'ollama' && parsed.model === 'qwen3.6:35b-a3b',
  'parsing splits on the first slash only, so colons and dots survive', JSON.stringify(parsed));
check(parseLocalModel('local/llama-server/org/model-v2')?.model === 'org/model-v2',
  'a model id containing a slash is not truncated');
check(parseLocalModel('local/ollama') === null && parseLocalModel('openrouter/x') === null,
  'a malformed or remote id parses to null');

// --- discovery parsing -------------------------------------------------------

const tags = parseOllamaTags(TAGS_FIXTURE);
check(tags.length === 3, 'every installed ollama model is listed', String(tags.length));
check(tags[0].id === 'local/ollama/qwen3.6:35b-a3b', 'tags are namespaced on the way out', tags[0].id);
check(tags[0].size_bytes === 23938333577 && tags[0].parameter_size === '36.0B' && tags[0].context_length === 262144,
  'size, parameter count and context window survive parsing');
check(tags[0].heavy === true && tags[2].heavy === false,
  'a 24GB model is heavy and a 274MB embedder is not');
check(parseOllamaTags({}).length === 0 && parseOllamaTags(null).length === 0,
  'a junk /api/tags body parses to an empty list rather than throwing');

const served = parseOpenAIModels(V1_MODELS_FIXTURE);
check(served.length === 1 && served[0].id === 'local/llama-server/qwen3.6-35b-a3b',
  'the OpenAI catalog shape is namespaced under llama-server', JSON.stringify(served));
check(served[0].heavy === true, 'a served llama-server model is resident by definition');
check(parseOpenAIModels({ data: 'nonsense' }).length === 0, 'a junk /v1/models body parses to an empty list');

const loadedRows = parseOllamaPs(PS_FIXTURE);
check(loadedRows.length === 2 && loadedRows[0].vram_bytes === 13607622409,
  'ollama ps reports what is resident, with its VRAM footprint');
check(loadedRows[0].heavy === true && loadedRows[1].heavy === false,
  'only the big resident counts as a heavy occupant');

// --- configuration -----------------------------------------------------------

const defaults = localHosts({ stateDir, env: {} });
check(defaults.ollama.base_url === 'http://127.0.0.1:11434' && defaults['llama-server'].base_url === 'http://127.0.0.1:8080',
  'the two built-in hosts default to their documented ports');
check(chatUrlFor(defaults.ollama) === 'http://127.0.0.1:11434/v1/chat/completions',
  'both hosts are called through the OpenAI-compatible path', chatUrlFor(defaults.ollama));

fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
  local_hosts: {
    ollama: { base_url: 'http://10.0.0.5:11434/' },
    'gpu-box': { base_url: 'http://10.0.0.9:9000', start_command: 'ssh gpu-box start' }
  }
}));
const configured = localHosts({ stateDir, env: {} });
check(configured.ollama.base_url === 'http://10.0.0.5:11434', 'config.json overrides the default endpoint');
check(configured['gpu-box'].base_url === 'http://10.0.0.9:9000' && configured['gpu-box'].list_path === '/v1/models',
  'a user-defined host is assumed OpenAI-compatible');
const overridden = localHosts({ stateDir, env: { ROOM_OLLAMA_URL: 'http://192.168.1.2:11434' } });
check(overridden.ollama.base_url === 'http://192.168.1.2:11434', 'env beats config.json');

// --- discovery, both hosts up ------------------------------------------------

const bothUp = fakeFetch({
  '/api/tags': () => json(TAGS_FIXTURE),
  '/v1/models': () => json(V1_MODELS_FIXTURE)
});
const up = await discoverLocalModels({ hosts: localHosts({ stateDir: scratch, env: {} }), fetchImpl: bothUp });
check(up.models.length === 4, 'discovery merges both surfaces into one field', String(up.models.length));
check(up.running.length === 2 && up.down.length === 0, 'both hosts report running');
check(up.text.includes('$0 (local)'), 'every discovered model is priced at zero in the rendering');

// --- discovery, hosts down (the graceful path) -------------------------------

const allDown = fakeFetch({});
const down = await discoverLocalModels({ hosts: localHosts({ stateDir: scratch, env: {} }), fetchImpl: allDown });
check(down.ok === true && down.models.length === 0,
  'a machine with nothing running is an empty field, not an error');
check(down.hosts.every((h) => h.running === false && h.reason === 'not running'),
  'each host says plainly that it is not running');
check(down.text.includes('ollama serve'), 'the ollama start command is in the report', down.text);
check(down.text.includes('start.sh'), 'the llama-server start command is in the report');

const halfUp = fakeFetch({ '/api/tags': () => json(TAGS_FIXTURE) });
const half = await discoverLocalModels({ hosts: localHosts({ stateDir: scratch, env: {} }), fetchImpl: halfUp });
check(half.running.join() === 'ollama' && half.down.join() === 'llama-server',
  'one host being down does not lose the other host\'s models');
check(half.models.length === 3, 'the surviving host still contributes its full catalogue');

// --- candidate selection -----------------------------------------------------

const cands = localCandidates(up.models);
check(cands.length === 3, 'embedding-only models are not put in front of a role', JSON.stringify(cands));
check(!cands.some((c) => /embed/.test(c.model)), 'the embedder is specifically the one dropped');
check(cands[0].model === 'local/ollama/qwen3.6:35b-a3b', 'the largest candidate leads the field');
check(localCandidates(up.models, { limit: 1 }).length === 1, 'the field is capped');

// --- provider request shape --------------------------------------------------

const chat = fakeFetch({
  '/v1/chat/completions': () => json({
    choices: [{ message: { content: 'I have not been shown services/estoque.js.' } }],
    usage: { prompt_tokens: 40, completion_tokens: 160 }
  })
});
const reply = await callLocal({
  model: 'local/ollama/gemma4:e4b',
  messages: [{ role: 'user', content: 'hello', __digest: true }],
  params: { temperature: 0.2 },
  hosts: localHosts({ stateDir: scratch, env: {} }),
  fetchImpl: chat
});
const sent = chat.calls[0];
const body = JSON.parse(sent.init.body);
check(sent.url === 'http://127.0.0.1:11434/v1/chat/completions', 'the call goes to the host chat endpoint', sent.url);
check(sent.init.method === 'POST', 'the call is a POST');
check(!('Authorization' in sent.init.headers), 'no API key is sent to a local server', JSON.stringify(sent.init.headers));
check(body.model === 'gemma4:e4b', 'the namespace is stripped before the id reaches the server', body.model);
check(body.temperature === 0.2, 'completion params are passed through');
check(body.messages.length === 1 && Object.keys(body.messages[0]).join() === 'role,content',
  'internal message markers are stripped, exactly as on the remote path', JSON.stringify(body.messages[0]));
check(reply.cost === 0, 'a local reply costs exactly zero, as a number rather than null', String(reply.cost));
check(reply.local === true && reply.host === 'ollama', 'the reply says where it came from');
check(Number.isFinite(reply.tokens_per_sec) && reply.tokens_per_sec > 0,
  'throughput is measured from usage and the wall clock', String(reply.tokens_per_sec));
check(tokensPerSec({ completion_tokens: 160 }, 2000) === 80, 'tok/s is completion tokens over seconds');
check(tokensPerSec(null, 2000) === null && tokensPerSec({ completion_tokens: 0 }, 2000) === null,
  'an unreported or empty completion has no rate rather than a rate of zero');

// --- server-down call path ---------------------------------------------------

let downError = null;
try {
  await callLocal({
    model: 'local/llama-server/qwen3.6-35b-a3b',
    messages: [{ role: 'user', content: 'hi' }],
    hosts: localHosts({ stateDir: scratch, env: {} }),
    fetchImpl: allDown
  });
} catch (e) { downError = e; }
check(downError !== null, 'a call to a dead host fails rather than hanging');
check(downError.status === 503 && downError.local_down === true,
  'the failure is marked transient so a configured fallback can take over');
check(/not running/.test(downError.message) && /start\.sh/.test(downError.message),
  'the message names the host and the command that would start it', downError.message);

// A recruit with no fallback gets the server-down message, not a remote model.
const localOnlyProvider = {
  name: 'local',
  call: ({ model }) => callLocal({
    model, messages: [{ role: 'user', content: 'hi' }],
    hosts: localHosts({ stateDir: scratch, env: {} }), fetchImpl: allDown
  })
};
let noFallback = null;
try {
  await callWithRetry({ provider: localOnlyProvider, model: 'local/llama-server/x', messages: [], retryDelayMs: 0 });
} catch (e) { noFallback = e; }
check(noFallback && /not running/.test(noFallback.message),
  'with no fallback_model configured, the server-down message is what surfaces');

// The same recruit, configured with a fallback, reaches the remote model.
const mixedProvider = {
  name: 'openrouter',
  call: async ({ model }) => {
    if (isLocalModel(model)) {
      return callLocal({
        model, messages: [{ role: 'user', content: 'hi' }],
        hosts: localHosts({ stateDir: scratch, env: {} }), fetchImpl: allDown
      });
    }
    return { text: 'remote answered', cost: 0.002, usage: { prompt_tokens: 5, completion_tokens: 5 } };
  }
};
const fellBack = await callWithRetry({
  provider: mixedProvider,
  model: 'local/llama-server/x',
  fallback_model: 'openai/gpt-4o-mini',
  messages: [], retryDelayMs: 0
});
check(fellBack.fellBack === true && fellBack.model === 'openai/gpt-4o-mini',
  'a local recruit falls back to OpenRouter only when it was hired with a fallback');

// --- GPU contention ----------------------------------------------------------

const loaded = await loadedLocalModels({
  hosts: localHosts({ stateDir: scratch, env: {} }),
  fetchImpl: fakeFetch({ '/api/ps': () => json(PS_FIXTURE), '/v1/models': () => json(V1_MODELS_FIXTURE) })
});
check(loaded.length === 3, 'resident models are collected from both hosts', JSON.stringify(loaded.map((l) => l.id)));
check(loaded.some((l) => l.id === 'local/llama-server/qwen3.6-35b-a3b'),
  'a running llama-server counts as resident even though it has no ps endpoint');

const warn = contentionWarning({ loaded, model: 'local/ollama/gemma4:e4b' });
check(warn !== null && /gpt-oss:20b/.test(warn) && /qwen3\.6-35b-a3b/.test(warn),
  'the warning names the heavy models already on the GPU', String(warn));
check(/Nothing was unloaded/.test(warn), 'the warning is explicit that nothing was killed');
check(contentionWarning({ loaded: [], model: 'local/ollama/gemma4:e4b' }) === null,
  'an idle GPU produces no warning');
check(contentionWarning({
  loaded: [{ host: 'ollama', model: 'gemma4:e4b', heavy: true }], model: 'local/ollama/gemma4:e4b'
}) === null, 'a model already loaded does not contend with itself');

// --- ranking: throughput ------------------------------------------------------

check(Math.abs(WEIGHTS.trap + WEIGHTS.length + WEIGHTS.latency + WEIGHTS.throughput + WEIGHTS.cost - 1) < 1e-9,
  'the weights still sum to one');
const noRates = rank([
  { model: 'a', latency_ms: 1000, cost: 0, trap_score: 1, length_discipline: 1 },
  { model: 'b', latency_ms: 2000, cost: 0, trap_score: 1, length_discipline: 1 }
]);
check(noRates[0].throughput_score === noRates[0].latency_score,
  'with no measured rate, throughput defers to latency and the old arithmetic is unchanged');
check(noRates[0].score === 1, 'the fastest all-honest candidate still scores a clean 1.0', String(noRates[0].score));

const withRates = rank([
  // Slower wall clock, but it wrote far more and decoded faster.
  { model: 'local/ollama/big', latency_ms: 4000, cost: 0, trap_score: 1, length_discipline: 1, tokens_per_sec: 80 },
  { model: 'remote/small', latency_ms: 2000, cost: 0, trap_score: 1, length_discipline: 1, tokens_per_sec: 20 }
]);
const big = withRates.find((r) => r.model === 'local/ollama/big');
const small = withRates.find((r) => r.model === 'remote/small');
check(big.throughput_score === 1 && small.throughput_score === 0.25,
  'throughput is normalised against the fastest decoder in the batch',
  JSON.stringify([big.throughput_score, small.throughput_score]));
check(big.throughput_score > big.latency_score,
  'a model penalised by wall clock is credited for the tokens it actually produced');

// --- offer cards -------------------------------------------------------------

const offered = makeOffers({
  rows: [
    {
      model: 'local/ollama/qwen3.6:35b-a3b', rank: 1, score: 0.98, latency_ms: 4200,
      trap_verdict: 'honest', tokens_per_sec: 81.4, price: { prompt: 0, completion: 0 }, host: 'ollama'
    },
    {
      model: 'openai/gpt-4o-mini', rank: 2, score: 0.9, latency_ms: 1200,
      trap_verdict: 'honest', price: { prompt: 0.00000015, completion: 0.0000006 }
    }
  ],
  role: 'local coder',
  local_warning: 'GPU contention: llama-server/qwen3.6-35b-a3b already resident.'
});
const localCard = offered.offers[0];
check(localCard.local === true && localCard.host === 'ollama' && localCard.tier === 'local',
  'a local card is tiered as local rather than as a free remote tier', JSON.stringify({
    local: localCard.local, host: localCard.host, tier: localCard.tier
  }));
const line = offerLine(localCard);
check(line === '#1 local-coder · local/ollama/qwen3.6:35b-a3b · host ollama · honest · $0 (local) · 81.4 tok/s · 4.2s · recommended',
  'the local offer line shows name, model, host, tok/s and $0 (local)', line);
check(!/rate limits apply/.test(line),
  'a local model is never described with the free-tier rate-limit caveat');
check(offerLine(offered.offers[1]) === '#2 local-coder · openai/gpt-4o-mini · honest · $0.54/mo est · 1.2s · premium',
  'a remote card on the same table renders exactly as it always did', offerLine(offered.offers[1]));
check(offered.offers[1].premium === true && localCard.premium === false,
  'against a local card at zero, the paid remote one is the premium step up');
check(offered.text.includes('GPU contention'), 'the contention warning rides on the offer text');

// --- room integration: ledger, local_only, graceful degradation --------------

const roomState = path.join(scratch, 'room-state');
const downState = path.join(scratch, 'down-state');

// Seed the OpenRouter catalogue cache in both rooms. The room only consults it
// for remote ids, but seeding it keeps this file hermetic: loadModels returns
// from a fresh cache before it considers a network call, so these tests never
// reach a socket even on a machine that has a key.
const CATALOG = {
  fetched_at: Date.now(),
  models: {
    'openai/gpt-4o-mini': {
      name: 'GPT-4o mini', context_length: 128000,
      pricing: { prompt: '0.00000015', completion: '0.0000006' }
    }
  }
};
for (const dir of [roomState, downState]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'models-cache.json'), JSON.stringify(CATALOG));
}

const spent = [];
const roomProvider = {
  name: 'local',
  call: async ({ model }) => {
    spent.push(model);
    return {
      text: 'I have not been shown that file, so I cannot fix it.',
      cost: isLocalModel(model) ? 0 : 0.004,
      usage: { prompt_tokens: 50, completion_tokens: 100 }
    };
  }
};
const room = createRoom({
  stateDir: roomState, projectDir: scratch, provider: roomProvider,
  autoMigrate: false, retryDelayMs: 0,
  localDiscovery: () => discoverLocalModels({ hosts: localHosts({ stateDir: scratch, env: {} }), fetchImpl: bothUp }),
  localContentionFn: () => loadedLocalModels({
    hosts: localHosts({ stateDir: scratch, env: {} }),
    fetchImpl: fakeFetch({ '/api/ps': () => json(PS_FIXTURE), '/v1/models': () => json(V1_MODELS_FIXTURE) })
  }).then((l) => ({ loaded: l, warning: contentionWarning({ loaded: l }) }))
});

const discovered = await room.localModels();
check(discovered.models.length === 4, 'the room exposes discovery through one injectable seam');

const localAudition = await room.audition({
  candidates: [], local_only: true,
  role_prompt: 'Write and review small Node patches.', role: 'local coder'
});
check(localAudition.ok, 'local_only auditions the discovered field with no candidates supplied');
check(localAudition.rows.length === 3 && localAudition.rows.every((r) => r.local),
  'local_only means exactly that: no remote candidate is probed', JSON.stringify(spent));
check(localAudition.rows.every((r) => r.cost === 0), 'every local row costs zero');
check(localAudition.offers.every((o) => o.local && o.host), 'the offers carry their host');
check(/\$0 \(local\)/.test(localAudition.offers_text), 'the offer text prices local at $0 (local)');
check(/GPU contention/.test(localAudition.text), 'the contention warning reaches the user');
check(/tok\/s/.test(localAudition.text), 'the measured decode rate is in the table');

const ledger = room.roster().spend;
check(ledger.byRecruit.audition.calls === 3,
  'local calls are counted in the ledger rather than bypassing it', JSON.stringify(ledger.byRecruit.audition));
check(ledger.byRecruit.audition.spend === 0 && ledger.total === 0,
  'and they are recorded at exactly $0', JSON.stringify(ledger));

const mixed = await room.audition({
  candidates: [{ model: 'openai/gpt-4o-mini' }], include_local: true,
  role_prompt: 'Write and review small Node patches.'
});
check(mixed.rows.length === 4 && mixed.rows.some((r) => !r.local),
  'include_local adds to the given field instead of replacing it', String(mixed.rows.length));
check(mixed.text.includes('Local model hosts:'), 'the host report is part of the transcript');

// A room whose hosts are all down still answers, and says what to start.
const downRoom = createRoom({
  stateDir: downState, projectDir: scratch, provider: roomProvider,
  autoMigrate: false, retryDelayMs: 0,
  localDiscovery: () => discoverLocalModels({ hosts: localHosts({ stateDir: scratch, env: {} }), fetchImpl: allDown })
});
const nothing = await downRoom.audition({ candidates: [], local_only: true, role_prompt: 'anything' });
check(nothing.ok === false, 'an audition with no reachable candidates fails cleanly');
check(/ollama serve/.test(nothing.text) && /start\.sh/.test(nothing.text),
  'and the failure tells the user exactly what to start', nothing.text);

// --- hiring a local recruit ---------------------------------------------------

const hire = await room.recruit({
  name: 'coder', model: 'local/ollama/qwen3.6:35b-a3b',
  system_prompt: 'You review small Node patches.', briefing: 'Fixture room.'
});
check(hire.ok && hire.local === true, 'a local recruit is hired like any other', hire.text);
check(/\$0 \(local\)/.test(hire.text), 'the hire text prices them at zero');
check(/No fallback_model/.test(hire.text),
  'without a fallback the user is told the server-down behaviour up front', hire.text);
check(room.roster().text.includes('local/ollama/qwen3.6:35b-a3b'), 'and they persist in the roster');

const badModel = await room.recruit({
  name: 'ghost', model: 'local/ollama/not-installed', system_prompt: 'x'
});
check(badModel.ok === false && /has no model/.test(badModel.text),
  'a typo is refused while the host is up to prove it', badModel.text);

const hopeful = await downRoom.recruit({
  name: 'later', model: 'local/llama-server/qwen3.6-35b-a3b',
  system_prompt: 'x', fallback_model: 'openai/gpt-4o-mini'
});
check(hopeful.ok === true, 'hiring against a host that is not running yet is allowed');
check(/not running/.test(hopeful.text) && /start\.sh/.test(hopeful.text),
  'the hire says the server is down and how to start it', hopeful.text);
check(/fall back to openai\/gpt-4o-mini/.test(hopeful.text),
  'a configured fallback is stated at hire time', hopeful.text);

fs.rmSync(scratch, { recursive: true, force: true });
done();
