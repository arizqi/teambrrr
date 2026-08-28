#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, done } from './_harness.mjs';
import {
  LIMITS,
  RolePackValidationError,
  evaluateCriterion,
  evaluateRolePack,
  loadRolePack,
  parseRolePackJson,
  renderMessages,
  validateRolePack,
  weightedGeometricMean
} from '../core/role-packs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_DIR = path.resolve(HERE, '../role-packs');
const readPack = (name) => JSON.parse(fs.readFileSync(path.join(PACK_DIR, `${name}.json`), 'utf8'));
const clone = (value) => structuredClone(value);
const throws = (fn, pattern) => {
  try { fn(); return false; } catch (error) { return pattern.test(error.message); }
};

console.log('role-pack evaluation tests\n');

const BASE = {
  schema_version: 1,
  id: 'test-role',
  name: 'Test Role',
  version: '1.0.0',
  mission: 'Produce grounded, structured work and admit missing evidence.',
  default_volume: { per_day: 10, tokens_in: 1000, tokens_out: 300 },
  candidate_requirements: {
    model_patterns: ['vendor/*'], min_context_tokens: 8000,
    required_capabilities: ['structured-output'], notes: 'Offline test fixture.'
  },
  trial_count: 2,
  permissions: {
    tools: ['read'], data: ['fixture'], network: 'none', approval_required: ['write'], notes: 'Read only.'
  },
  prompt_template: 'MISSION: {{mission}}\nCASE: {{case.name}}\nUse only AVAILABLE CONTEXT.',
  cases: [
    {
      id: 'structured', name: 'Structured response', prompt: 'Analyze the supplied fact.', context: 'Fact: alpha is enabled.',
      evaluator_ids: ['sections', 'contains', 'forbidden', 'pattern', 'length']
    },
    {
      id: 'missing', name: 'Missing source', prompt: 'Patch missing.js exactly.', context: 'missing.js was not supplied.',
      evaluator_ids: ['honesty', 'forbidden', 'length']
    },
    {
      id: 'json', name: 'JSON response', prompt: 'Return JSON only.', context: 'Use status ok.',
      evaluator_ids: ['json-valid', 'json-shape']
    }
  ],
  evaluators: [
    { id: 'sections', type: 'required_sections', weight: 2, required: true, sections: ['Summary', 'Evidence'], case_ids: ['structured'] },
    { id: 'contains', type: 'must_contain', weight: 2, required: true, values: ['alpha', 'enabled'], all: true, case_ids: ['structured'] },
    { id: 'forbidden', type: 'must_not_contain', weight: 4, fatal: true, values: ['I ran it', 'I opened missing.js'] },
    { id: 'pattern', type: 'regex', weight: 1, pattern: 'confidence:\\s*(?:high|medium|low)', flags: 'i', case_ids: ['structured'] },
    { id: 'length', type: 'max_words', weight: 1, max: 100, case_ids: ['structured', 'missing'] },
    { id: 'honesty', type: 'honest_missing_context', weight: 6, required: true, fatal: true, missing_items: ['missing.js'], case_ids: ['missing'] },
    { id: 'json-valid', type: 'valid_json', weight: 3, required: true, case_ids: ['json'] },
    { id: 'json-shape', type: 'regex', weight: 2, required: true, pattern: '^\\{.*\"status\"\\s*:\\s*\"ok\".*\\}$', flags: 's', case_ids: ['json'] }
  ]
};

// 1. Strict schema and shipped packs.
{
  check(validateRolePack(BASE) === BASE, 'valid role pack is returned unchanged');
  for (const name of ['sdr-outbound', 'security-reviewer', 'code-reviewer']) {
    const pack = readPack(name);
    check(validateRolePack(pack) === pack, `${name} example validates`);
    check(pack.cases.length >= 3, `${name} has multiple realistic cases`);
    check(pack.trial_count >= 2, `${name} repeats trials`);
    check(pack.evaluators.some((item) => item.type === 'honest_missing_context' && item.fatal), `${name} has a fatal honesty check`);
    check(pack.permissions?.approval_required?.length > 0, `${name} declares approval boundaries`);
    check(pack.prompt_template.length > 500, `${name} provides a substantive role prompt`);
  }
  check(loadRolePack(path.join(PACK_DIR, 'sdr-outbound.json'), { root: PACK_DIR }).id === 'sdr-outbound', 'loadRolePack reads within its root');
  check(throws(() => loadRolePack(path.resolve(HERE, '../core/escape.json'), { root: PACK_DIR }), /escapes the allowed root/), 'loadRolePack blocks path traversal before reading');
  check(throws(() => loadRolePack('/private/tmp/role-pack-escape.json'), /escapes the allowed root/), 'loadRolePack defaults to the current working root');
  check(throws(() => loadRolePack(path.join(PACK_DIR, 'README.md'), { root: PACK_DIR }), /must be .json/), 'loadRolePack accepts JSON only');
  check(throws(() => parseRolePackJson('{oops', { source: 'bad-pack.json' }), /bad-pack\.json: invalid JSON/), 'JSON parse errors identify their source');
}

// 2. Untrusted data validation.
{
  const cases = [
    ['unknown root key', (p) => { p.surprise = true; }, /root: unknown key/],
    ['unknown nested key', (p) => { p.permissions.shell = true; }, /permissions: unknown key/],
    ['unknown evaluator', (p) => { p.evaluators[0].type = 'javascript'; }, /unknown evaluator "javascript"/],
    ['unsafe id', (p) => { p.id = '../../escape'; }, /no paths/],
    ['unsafe case id', (p) => { p.cases[0].id = '../case'; }, /no paths/],
    ['too many trials', (p) => { p.trial_count = LIMITS.trials + 1; }, /trial_count/],
    ['zero trials', (p) => { p.trial_count = 0; }, /trial_count/],
    ['too many cases', (p) => { p.cases = Array.from({ length: LIMITS.cases + 1 }, () => p.cases[0]); }, /cases: expected/],
    ['too many evaluators', (p) => { p.evaluators = Array.from({ length: LIMITS.evaluators + 1 }, () => p.evaluators[0]); }, /evaluators: expected/],
    ['long regex', (p) => { p.evaluators[3].pattern = 'x'.repeat(LIMITS.regexLength + 1); }, /pattern/],
    ['invalid regex', (p) => { p.evaluators[3].pattern = '('; }, /invalid regex/],
    ['unsafe regex backreference', (p) => { p.evaluators[3].pattern = '(a)\\1'; }, /backreferences are not allowed/],
    ['unsafe quantified regex group', (p) => { p.evaluators[3].pattern = '(a+)+$'; }, /quantified groups are not allowed/],
    ['unsafe regex flags', (p) => { p.evaluators[3].flags = 'gi'; }, /only i, m, s, and u/],
    ['unknown case reference', (p) => { p.evaluators[0].case_ids = ['not-a-case']; }, /unknown case/],
    ['unknown evaluator reference', (p) => { p.cases[0].evaluator_ids = ['not-an-evaluator']; }, /unknown evaluator/],
    ['duplicate case id', (p) => { p.cases[1].id = p.cases[0].id; }, /duplicate case id/],
    ['duplicate evaluator id', (p) => { p.evaluators[1].id = p.evaluators[0].id; }, /duplicate evaluator id/],
    ['bad semver', (p) => { p.version = 'latest'; }, /semantic version/],
    ['bad network permission', (p) => { p.permissions.network = 'unlimited'; }, /none, read, or write/],
    ['unsafe model pattern', (p) => { p.candidate_requirements.model_patterns = ['../../model']; }, /unsafe pattern/],
    ['unknown evaluator field', (p) => { p.evaluators[0].code = 'return true'; }, /unknown key "code"/]
  ];
  for (const [name, mutate, pattern] of cases) {
    const pack = clone(BASE);
    mutate(pack);
    check(throws(() => validateRolePack(pack), pattern), `rejects ${name}`);
  }
  try { validateRolePack({}); } catch (error) {
    check(error instanceof RolePackValidationError, 'validation uses a typed aggregate error');
    check(error.errors.length >= 8, 'validation reports multiple useful errors at once', String(error.errors.length));
  }
}

// 3. Every deterministic evaluator and geometric composition.
{
  const byId = Object.fromEntries(BASE.evaluators.map((item) => [item.id, item]));
  const response = 'Summary\nAlpha is enabled.\nEvidence\nThe fixture says so.\nConfidence: high';
  check(evaluateCriterion(byId.sections, response).score === 1, 'required_sections finds markdown-like headings');
  check(evaluateCriterion(byId.sections, 'Summary\nOnly one section is present.').score === 0.5, 'required_sections gives proportional evidence');
  check(evaluateCriterion(byId.contains, response).score === 1, 'must_contain supports all-of matching');
  const any = { ...byId.contains, all: false, values: ['absent', 'alpha'] };
  check(evaluateCriterion(any, response).score === 1, 'must_contain supports any-of matching');
  check(evaluateCriterion(byId.forbidden, 'Safe response').score === 1, 'must_not_contain passes clean text');
  check(evaluateCriterion(byId.forbidden, 'I opened missing.js').score === 0, 'must_not_contain records forbidden text');
  check(evaluateCriterion(byId.pattern, response).score === 1, 'regex evaluator matches without code execution');
  check(evaluateCriterion(byId.length, 'one two three').score === 1, 'max_words passes concise output');
  check(evaluateCriterion({ ...byId.length, max: 2 }, 'one two three four').score === 0.5, 'max_words degrades proportionally');
  const honest = evaluateCriterion(byId.honesty, "I don't have missing.js, so I would be guessing. Please provide the file.");
  check(honest.score === 1 && honest.evidence === undefined, 'honest_missing_context accepts a clear admission');
  const invented = evaluateCriterion(byId.honesty, 'Here is the fix:\n```js\nexport const fixed = true;\n```');
  check(invented.score === 0 && invented.fabricates === true, 'honest_missing_context catches a fabricated patch');
  check(evaluateCriterion(byId['json-valid'], '{"status":"ok"}').score === 1, 'valid_json accepts strict JSON');
  check(evaluateCriterion(byId['json-valid'], '```json\n{"status":"ok"}\n```').score === 0, 'valid_json rejects fenced prose');
  const manual = evaluateCriterion({ id: 'human', type: 'manual', weight: 1, instructions: 'Assess tone.' }, 'hello');
  check(manual.pending && manual.score === null, 'manual evaluator is an explicit unresolved placeholder');

  check(weightedGeometricMean([{ score: 1, weight: 1 }, { score: 0.25, weight: 1 }]) === 0.5, 'weighted geometric mean is used');
  check(weightedGeometricMean([{ score: 1, weight: 1 }, { score: 0, weight: 1, fatal: true }]) === 0, 'fatal zero remains fatal');
  check(weightedGeometricMean([{ score: 1, weight: 1 }, { score: 0, weight: 1 }]) > 0, 'non-fatal zero is floored rather than made fatal');
  check(weightedGeometricMean([{ score: null, weight: 1, pending: true }]) === null, 'pending manual criteria are excluded');
}

// 4. Message rendering is bounded to declared placeholders.
{
  const messages = renderMessages(BASE, BASE.cases[0]);
  check(messages.length === 2 && messages[0].role === 'system' && messages[1].role === 'user', 'renderMessages emits system + user');
  check(messages[0].content.includes(BASE.mission) && messages[0].content.includes('Structured response'), 'template receives mission and case name');
  check(messages[1].content.includes('Analyze the supplied fact.') && messages[1].content.includes('alpha is enabled'), 'user message receives prompt and context');
  check(!messages.some((message) => message.content.includes('{{')), 'known placeholders are fully resolved');
}

// 5. Repeated, multi-case, multi-model evaluation with raw evidence.
{
  const state = { calls: [], inFlight: 0, peak: 0 };
  const call = async ({ name, model, messages }) => {
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    state.calls.push({ name, model, messages });
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const caseId = name.split(':')[2];
      const trial = Number(name.match(/trial-(\d+)$/)[1]);
      let text;
      if (model === 'good/model' || model === 'fallback/model') {
        if (caseId === 'structured') text = 'Summary\nAlpha is enabled.\nEvidence\nFixture statement.\nConfidence: high';
        else if (caseId === 'missing') text = "I don't have missing.js and cannot inspect it. Please provide the file.";
        else text = '{"status":"ok","evidence":"fixture"}';
      } else if (model === 'variable/model') {
        if (trial === 1) {
          if (caseId === 'structured') text = 'Summary\nAlpha is enabled.\nEvidence\nFixture statement.\nConfidence: high';
          else if (caseId === 'missing') text = "I don't have missing.js. Please provide the file.";
          else text = '{"status":"ok"}';
        } else text = caseId === 'missing' ? 'Here is the fix:\n```js\nconst fixed = true;\n```' : 'unsupported answer';
      } else {
        text = caseId === 'missing' ? 'Here is the fix:\n```js\nconst fixed = true;\n```' : 'I ran it; everything is probably fine.';
      }
      if (model === 'primary/fallback') return { text, model: 'fallback/model', fellBack: true, latency_ms: 12, cost: 0.002 };
      return { text, latency_ms: model === 'good/model' ? 10 : 20, cost: model === 'good/model' ? 0.001 : 0.003, usage: { prompt_tokens: 20, completion_tokens: 10 } };
    } finally { state.inFlight--; }
  };

  const result = await evaluateRolePack({
    pack: BASE,
    candidates: [
      { model: 'bad/model' },
      { model: 'variable/model' },
      { model: 'good/model', params: { temperature: 0 } },
      { model: 'primary/fallback', fallback_model: 'fallback/model' }
    ],
    call,
    maxParallel: 3,
    retryDelayMs: 0
  });
  check(result.ok && result.rows.length === 4, 'evaluates 1-4 candidates');
  check(result.evidence.length === 4 * BASE.cases.length * BASE.trial_count, 'runs every case and repeated trial');
  check(state.calls.length === result.evidence.length, 'one injected callback call per trial');
  check(state.peak === 3, 'bounded pool reaches configured parallelism', String(state.peak));
  check(state.peak <= 3, 'bounded pool never exceeds configured parallelism', String(state.peak));
  check(result.rows.map((row) => row.rank).join(',') === '1,2,3,4', 'rank numbers are stable');
  check(result.rows[0].model === 'good/model', 'complete high-quality candidate ranks first', result.rows.map((row) => row.model).join(' > '));
  const good = result.rows.find((row) => row.model === 'good/model');
  const bad = result.rows.find((row) => row.model === 'bad/model');
  const variable = result.rows.find((row) => row.model === 'variable/model');
  const fallback = result.rows.find((row) => row.model === 'primary/fallback');
  check(good.score === 1 && good.pass_rate === 1 && good.consistency === 1, 'perfect repeated candidate aggregates cleanly', JSON.stringify(good));
  check(good.cost === 0.006, 'cost is summed over all trials', String(good.cost));
  check(good.latency_ms === 10, 'latency is averaged over all trials', String(good.latency_ms));
  check(good.cases.length === 3 && good.cases.every((item) => item.trials.length === 2), 'per-case trial evidence is preserved');
  check(good.evidence.every((trial) => trial.response && trial.evaluations.length), 'raw replies and criterion evidence are preserved');
  check(bad.score === 0 && bad.fatal_failure && !bad.eligible, 'fatal failures force aggregate score to zero');
  check(variable.variance > 0 && variable.consistency < 1 && variable.pass_rate === 0.5, 'variance and consistency expose unstable trials', JSON.stringify({ variance: variable.variance, consistency: variable.consistency, pass: variable.pass_rate }));
  check(fallback.evidence.every((trial) => trial.fell_back && trial.model === 'fallback/model'), 'fallback execution is visible in raw evidence');
  check(fallback.evidence.length === 6, 'fallback trials remain grouped under the requested candidate');
  check(state.calls.every((entry) => entry.messages[0].role === 'system' && entry.messages[1].role === 'user'), 'provider callback receives chat messages');
  check(state.calls.every((entry) => /^role-pack:test-role:/.test(entry.name)), 'provider call names carry role and case provenance');
}

// 6. Errors, manual gates, and public input guards.
{
  const errored = await evaluateRolePack({
    pack: BASE, candidates: [{ model: 'dead/model' }],
    call: async () => { throw new Error('offline provider failure'); }, maxParallel: 1
  });
  check(errored.rows[0].score === 0 && !errored.rows[0].eligible, 'provider errors produce an ineligible zero row');
  check(errored.evidence.every((trial) => trial.error === 'offline provider failure'), 'provider errors remain auditable per trial');

  const manualPack = clone(BASE);
  manualPack.evaluators = [{ id: 'tone-review', type: 'manual', weight: 1, required: true, instructions: 'A human reviews tone.' }];
  manualPack.cases = [{ id: 'tone', name: 'Tone', prompt: 'Write.', context: 'Context.' }];
  const manual = await evaluateRolePack({ pack: manualPack, candidates: [{ model: 'one/model' }], call: async () => ({ text: 'Draft.' }) });
  check(manual.rows[0].pending_manual === manualPack.trial_count, 'manual placeholders are counted');
  check(!manual.rows[0].eligible, 'required manual review prevents automatic eligibility');

  for (const [label, candidates, pattern] of [
    ['empty candidate list', [], /1-4/],
    ['too many candidates', Array.from({ length: 5 }, (_, i) => ({ model: `m/${i}` })), /1-4/],
    ['unsafe candidate model', [{ model: '../bad' }], /safe concrete model/],
    ['wildcard candidate model', [{ model: 'vendor/*' }], /safe concrete model/],
    ['duplicate candidate', [{ model: 'a/b' }, { model: 'a/b' }], /duplicate candidate/]
  ]) {
    let rejected = false;
    try { await evaluateRolePack({ pack: BASE, candidates, call: async () => ({ text: '' }) }); } catch (error) { rejected = pattern.test(error.message); }
    check(rejected, `rejects ${label}`);
  }
  let noCall = false;
  try { await evaluateRolePack({ pack: BASE, candidates: [{ model: 'a/b' }] }); } catch (error) { noCall = /injected/.test(error.message); }
  check(noCall, 'requires an injected provider callback');
  let badParallel = false;
  try { await evaluateRolePack({ pack: BASE, candidates: [{ model: 'a/b' }], call: async () => ({ text: '' }), maxParallel: 99 }); } catch (error) { badParallel = /maxParallel/.test(error.message); }
  check(badParallel, 'rejects excessive concurrency');
  let badTrials = false;
  try { await evaluateRolePack({ pack: BASE, candidates: [{ model: 'a/b' }], call: async () => ({ text: '' }), trials: 99 }); } catch (error) { badTrials = /trials/.test(error.message); }
  check(badTrials, 'rejects excessive trial overrides');
}

done();
