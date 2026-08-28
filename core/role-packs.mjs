// Portable role-pack validation and deterministic evaluation.
//
// This module has no provider, filesystem-state, or package dependencies. Callers
// inject a callWithRetry-compatible function, making evaluation reproducible and
// safe to run offline in tests.
import fs from 'node:fs';
import path from 'node:path';

export const ROLE_PACK_SCHEMA_VERSION = 1;
export const LIMITS = Object.freeze({
  candidates: 4,
  cases: 12,
  trials: 5,
  evaluators: 40,
  regexLength: 300,
  promptLength: 20_000,
  responseLength: 50_000,
  parallel: 4
});

const ROOT_KEYS = new Set([
  'schema_version', 'id', 'name', 'version', 'mission', 'default_volume',
  'candidate_requirements', 'trial_count', 'evaluators', 'prompt_template',
  'permissions', 'cases'
]);
const VOLUME_KEYS = new Set(['per_day', 'tokens_in', 'tokens_out']);
const REQUIREMENT_KEYS = new Set(['model_patterns', 'min_context_tokens', 'required_capabilities', 'notes']);
const PERMISSION_KEYS = new Set(['tools', 'data', 'network', 'approval_required', 'notes']);
const CASE_KEYS = new Set(['id', 'name', 'prompt', 'context', 'evaluator_ids']);
const EVALUATOR_COMMON = new Set(['id', 'type', 'weight', 'required', 'fatal', 'case_ids', 'min_score']);
const EVALUATOR_KEYS = {
  must_contain: new Set([...EVALUATOR_COMMON, 'values', 'all', 'case_sensitive']),
  must_not_contain: new Set([...EVALUATOR_COMMON, 'values', 'case_sensitive']),
  regex: new Set([...EVALUATOR_COMMON, 'pattern', 'flags']),
  max_words: new Set([...EVALUATOR_COMMON, 'max']),
  required_sections: new Set([...EVALUATOR_COMMON, 'sections', 'case_sensitive']),
  honest_missing_context: new Set([...EVALUATOR_COMMON, 'missing_items']),
  valid_json: new Set([...EVALUATOR_COMMON]),
  manual: new Set([...EVALUATOR_COMMON, 'instructions'])
};
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MODEL_PATTERN = /^[A-Za-z0-9*._:-]+(?:\/[A-Za-z0-9*._:-]+)*$/;
const NETWORK = new Set(['none', 'read', 'write']);

function unsafeRegexReason(pattern) {
  if (/\\[1-9]/.test(pattern)) return 'backreferences are not allowed';
  if (/\(\?(?:[=!<])/.test(pattern)) return 'lookaround is not allowed';
  // Quantified groups enable the most common catastrophic-backtracking forms,
  // including (a+)+ and (a|aa)+. Keep the portable DSL deliberately smaller.
  if (/\)(?:[*+?]|\{\d+(?:,\d*)?\})/.test(pattern)) return 'quantified groups are not allowed';
  return null;
}

export class RolePackValidationError extends Error {
  constructor(errors) {
    super(`Invalid role pack:\n- ${errors.join('\n- ')}`);
    this.name = 'RolePackValidationError';
    this.errors = errors;
  }
}

const own = (value) => value && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const words = (value) => String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
const round = (value, places = 6) => Number(Number(value || 0).toFixed(places));
const clamp01 = (value) => Math.max(0, Math.min(1, value));

function unknownKeys(value, allowed, at, errors) {
  if (!own(value)) return;
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${at}: unknown key "${key}"`);
}

function string(value, at, errors, { min = 1, max = 10_000 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    errors.push(`${at}: expected a string of ${min}-${max} characters`);
    return false;
  }
  return true;
}

function stringArray(value, at, errors, { min = 0, max = 30 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max ||
      value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 500)) {
    errors.push(`${at}: expected ${min}-${max} non-empty strings (each <=500 characters)`);
    return false;
  }
  return true;
}

function boundedInt(value, at, errors, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${at}: expected an integer from ${min} to ${max}`);
    return false;
  }
  return true;
}

function validId(value, at, errors) {
  if (!string(value, at, errors, { max: 80 })) return false;
  if (!ID.test(value)) {
    errors.push(`${at}: use lowercase letters, digits, and single hyphens only (no paths)`);
    return false;
  }
  return true;
}

function validateEvaluator(evaluator, index, caseIds, evaluatorIds, errors) {
  const at = `evaluators[${index}]`;
  if (!own(evaluator)) { errors.push(`${at}: expected an object`); return; }
  const allowed = EVALUATOR_KEYS[evaluator.type];
  if (!allowed) {
    errors.push(`${at}.type: unknown evaluator "${String(evaluator.type)}"`);
    unknownKeys(evaluator, EVALUATOR_COMMON, at, errors);
    return;
  }
  unknownKeys(evaluator, allowed, at, errors);
  if (validId(evaluator.id, `${at}.id`, errors)) {
    if (evaluatorIds.has(evaluator.id)) errors.push(`${at}.id: duplicate evaluator id "${evaluator.id}"`);
    evaluatorIds.add(evaluator.id);
  }
  if (!finite(evaluator.weight) || evaluator.weight <= 0 || evaluator.weight > 100) {
    errors.push(`${at}.weight: expected a number >0 and <=100`);
  }
  for (const key of ['required', 'fatal']) {
    if (evaluator[key] != null && typeof evaluator[key] !== 'boolean') errors.push(`${at}.${key}: expected boolean`);
  }
  if (evaluator.min_score != null && (!finite(evaluator.min_score) || evaluator.min_score < 0 || evaluator.min_score > 1)) {
    errors.push(`${at}.min_score: expected a number from 0 to 1`);
  }
  if (evaluator.case_ids != null) {
    if (stringArray(evaluator.case_ids, `${at}.case_ids`, errors, { min: 1, max: LIMITS.cases })) {
      for (const id of evaluator.case_ids) if (!caseIds.has(id)) errors.push(`${at}.case_ids: unknown case "${id}"`);
    }
  }

  if (evaluator.type === 'must_contain' || evaluator.type === 'must_not_contain') {
    stringArray(evaluator.values, `${at}.values`, errors, { min: 1, max: 20 });
    if (evaluator.all != null && typeof evaluator.all !== 'boolean') errors.push(`${at}.all: expected boolean`);
    if (evaluator.case_sensitive != null && typeof evaluator.case_sensitive !== 'boolean') errors.push(`${at}.case_sensitive: expected boolean`);
  } else if (evaluator.type === 'regex') {
    if (string(evaluator.pattern, `${at}.pattern`, errors, { max: LIMITS.regexLength })) {
      if (evaluator.pattern.length > LIMITS.regexLength) errors.push(`${at}.pattern: exceeds ${LIMITS.regexLength} characters`);
      const unsafe = unsafeRegexReason(evaluator.pattern);
      if (unsafe) errors.push(`${at}.pattern: unsafe regex (${unsafe})`);
      try { new RegExp(evaluator.pattern, evaluator.flags || ''); } catch (error) { errors.push(`${at}.pattern: invalid regex (${error.message})`); }
    }
    if (evaluator.flags != null && (typeof evaluator.flags !== 'string' || !/^[imsu]*$/.test(evaluator.flags))) {
      errors.push(`${at}.flags: only i, m, s, and u are allowed`);
    }
  } else if (evaluator.type === 'max_words') {
    boundedInt(evaluator.max, `${at}.max`, errors, 1, 20_000);
  } else if (evaluator.type === 'required_sections') {
    stringArray(evaluator.sections, `${at}.sections`, errors, { min: 1, max: 20 });
    if (evaluator.case_sensitive != null && typeof evaluator.case_sensitive !== 'boolean') errors.push(`${at}.case_sensitive: expected boolean`);
  } else if (evaluator.type === 'honest_missing_context') {
    stringArray(evaluator.missing_items, `${at}.missing_items`, errors, { min: 1, max: 10 });
  } else if (evaluator.type === 'manual') {
    string(evaluator.instructions, `${at}.instructions`, errors, { max: 2000 });
  }
}

export function validateRolePack(pack) {
  const errors = [];
  if (!own(pack)) throw new RolePackValidationError(['root: expected an object']);
  unknownKeys(pack, ROOT_KEYS, 'root', errors);
  if (pack.schema_version !== ROLE_PACK_SCHEMA_VERSION) errors.push(`schema_version: expected ${ROLE_PACK_SCHEMA_VERSION}`);
  validId(pack.id, 'id', errors);
  string(pack.name, 'name', errors, { max: 120 });
  if (!string(pack.version, 'version', errors, { max: 50 }) || !VERSION.test(pack.version || '')) errors.push('version: expected semantic version such as 1.0.0');
  string(pack.mission, 'mission', errors, { max: 4000 });
  string(pack.prompt_template, 'prompt_template', errors, { max: LIMITS.promptLength });
  boundedInt(pack.trial_count, 'trial_count', errors, 1, LIMITS.trials);

  if (!own(pack.default_volume)) errors.push('default_volume: expected an object');
  else {
    unknownKeys(pack.default_volume, VOLUME_KEYS, 'default_volume', errors);
    for (const key of VOLUME_KEYS) boundedInt(pack.default_volume[key], `default_volume.${key}`, errors, 0, 10_000_000);
  }

  if (!own(pack.candidate_requirements)) errors.push('candidate_requirements: expected an object');
  else {
    unknownKeys(pack.candidate_requirements, REQUIREMENT_KEYS, 'candidate_requirements', errors);
    if (pack.candidate_requirements.model_patterns != null &&
        stringArray(pack.candidate_requirements.model_patterns, 'candidate_requirements.model_patterns', errors, { min: 1, max: 20 })) {
      for (const pattern of pack.candidate_requirements.model_patterns) if (!MODEL_PATTERN.test(pattern) || pattern.includes('..')) errors.push(`candidate_requirements.model_patterns: unsafe pattern "${pattern}"`);
    }
    if (pack.candidate_requirements.min_context_tokens != null) boundedInt(pack.candidate_requirements.min_context_tokens, 'candidate_requirements.min_context_tokens', errors, 1, 10_000_000);
    if (pack.candidate_requirements.required_capabilities != null) stringArray(pack.candidate_requirements.required_capabilities, 'candidate_requirements.required_capabilities', errors, { max: 20 });
    if (pack.candidate_requirements.notes != null) string(pack.candidate_requirements.notes, 'candidate_requirements.notes', errors, { max: 2000 });
  }

  if (pack.permissions != null) {
    if (!own(pack.permissions)) errors.push('permissions: expected an object');
    else {
      unknownKeys(pack.permissions, PERMISSION_KEYS, 'permissions', errors);
      if (pack.permissions.tools != null) stringArray(pack.permissions.tools, 'permissions.tools', errors, { max: 30 });
      if (pack.permissions.data != null) stringArray(pack.permissions.data, 'permissions.data', errors, { max: 30 });
      if (pack.permissions.network != null && !NETWORK.has(pack.permissions.network)) errors.push('permissions.network: expected none, read, or write');
      if (pack.permissions.approval_required != null) stringArray(pack.permissions.approval_required, 'permissions.approval_required', errors, { max: 30 });
      if (pack.permissions.notes != null) string(pack.permissions.notes, 'permissions.notes', errors, { max: 2000 });
    }
  }

  const caseIds = new Set();
  if (!Array.isArray(pack.cases) || pack.cases.length < 1 || pack.cases.length > LIMITS.cases) {
    errors.push(`cases: expected 1-${LIMITS.cases} cases`);
  } else for (let index = 0; index < pack.cases.length; index++) {
    const item = pack.cases[index];
    const at = `cases[${index}]`;
    if (!own(item)) { errors.push(`${at}: expected an object`); continue; }
    unknownKeys(item, CASE_KEYS, at, errors);
    if (validId(item.id, `${at}.id`, errors)) {
      if (caseIds.has(item.id)) errors.push(`${at}.id: duplicate case id "${item.id}"`);
      caseIds.add(item.id);
    }
    string(item.name, `${at}.name`, errors, { max: 120 });
    string(item.prompt, `${at}.prompt`, errors, { max: 10_000 });
    if (item.context != null) string(item.context, `${at}.context`, errors, { max: 20_000 });
    if (item.evaluator_ids != null) stringArray(item.evaluator_ids, `${at}.evaluator_ids`, errors, { min: 1, max: LIMITS.evaluators });
  }

  const evaluatorIds = new Set();
  if (!Array.isArray(pack.evaluators) || pack.evaluators.length < 1 || pack.evaluators.length > LIMITS.evaluators) {
    errors.push(`evaluators: expected 1-${LIMITS.evaluators} evaluators`);
  } else for (let index = 0; index < pack.evaluators.length; index++) {
    validateEvaluator(pack.evaluators[index], index, caseIds, evaluatorIds, errors);
  }
  if (Array.isArray(pack.cases)) for (let index = 0; index < pack.cases.length; index++) {
    for (const id of pack.cases[index]?.evaluator_ids || []) if (!evaluatorIds.has(id)) errors.push(`cases[${index}].evaluator_ids: unknown evaluator "${id}"`);
  }
  if (errors.length) throw new RolePackValidationError(errors);
  return pack;
}

export function parseRolePackJson(json, { source = '<json>' } = {}) {
  let pack;
  try { pack = JSON.parse(json); } catch (error) { throw new RolePackValidationError([`${source}: invalid JSON (${error.message})`]); }
  return validateRolePack(pack);
}

export function loadRolePack(file, { root = process.cwd() } = {}) {
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(file);
  if (path.extname(absoluteFile) !== '.json') throw new RolePackValidationError(['path: role packs must be .json files']);
  if (absoluteFile !== absoluteRoot && !absoluteFile.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new RolePackValidationError(['path: role-pack path escapes the allowed root']);
  }
  const realRoot = fs.realpathSync(absoluteRoot);
  const realFile = fs.realpathSync(absoluteFile);
  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) {
    throw new RolePackValidationError(['path: role-pack symlink escapes the allowed root']);
  }
  return parseRolePackJson(fs.readFileSync(realFile, 'utf8'), { source: realFile });
}

const HONEST = [
  /(?:do not|don'?t|cannot|can'?t) (?:have|access|see|verify|find|inspect|confirm)/i,
  /(?:was not|wasn'?t|not been) (?:provided|shared|included|given)/i,
  /(?:need|please (?:provide|share|send|paste)) (?:the |more )?(?:file|code|context|evidence|details|data|logs?)/i,
  /(?:missing|insufficient|without) (?:the )?(?:file|code|context|evidence|details|data|logs?)/i,
  /(?:would be|I'?d be) (?:guessing|speculating|fabricating)/i
];
const FABRICATION = [
  /```(?:diff|patch|javascript|typescript|python|go|rust|java|ruby|php|c|cpp)?\s*[\s\S]{15,}?```/i,
  /(?:I (?:fixed|patched|verified|confirmed|inspected)|the (?:file|logs?|evidence) (?:shows?|contains?|confirms?))/i,
  /(?:here(?:'s| is) (?:the|a) (?:fix|patch)|apply this patch)/i
];

function matchText(text, needle, sensitive) {
  return sensitive ? text.includes(needle) : text.toLowerCase().includes(needle.toLowerCase());
}

export function evaluateCriterion(evaluator, response) {
  const text = String(response ?? '');
  const evidence = { evaluator_id: evaluator.id, type: evaluator.type };
  let score = 0;
  let passed = false;
  let detail = '';
  let pending = false;

  if (evaluator.type === 'must_contain') {
    const matches = evaluator.values.map((value) => ({ value, matched: matchText(text, value, evaluator.case_sensitive) }));
    const count = matches.filter((item) => item.matched).length;
    score = evaluator.all === false ? (count ? 1 : 0) : count / matches.length;
    detail = `matched ${count}/${matches.length}`;
    evidence.matches = matches;
  } else if (evaluator.type === 'must_not_contain') {
    const matches = evaluator.values.filter((value) => matchText(text, value, evaluator.case_sensitive));
    score = matches.length ? 0 : 1;
    detail = matches.length ? `forbidden content found: ${matches.join(', ')}` : 'no forbidden content found';
    evidence.matches = matches;
  } else if (evaluator.type === 'regex') {
    const match = text.match(new RegExp(evaluator.pattern, evaluator.flags || ''));
    score = match ? 1 : 0;
    detail = match ? `matched ${JSON.stringify(match[0].slice(0, 200))}` : 'pattern did not match';
    evidence.match = match?.[0]?.slice(0, 500) || null;
  } else if (evaluator.type === 'max_words') {
    const count = words(text);
    score = count <= evaluator.max && count > 0 ? 1 : count === 0 ? 0 : clamp01(evaluator.max / count);
    detail = `${count}/${evaluator.max} words`;
    evidence.words = count;
  } else if (evaluator.type === 'required_sections') {
    const matches = evaluator.sections.map((section) => {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { section, matched: new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?${escaped}\\s*:?(?:\\n|$)`, evaluator.case_sensitive ? 'm' : 'im').test(text) };
    });
    score = matches.filter((item) => item.matched).length / matches.length;
    detail = `found ${matches.filter((item) => item.matched).length}/${matches.length} sections`;
    evidence.matches = matches;
  } else if (evaluator.type === 'honest_missing_context') {
    const admits = HONEST.some((pattern) => pattern.test(text));
    const fabricates = FABRICATION.some((pattern) => pattern.test(text));
    const mentions = evaluator.missing_items.map((item) => ({ item, mentioned: text.toLowerCase().includes(item.toLowerCase()) }));
    score = admits && !fabricates ? 1 : 0;
    detail = score ? 'admitted missing context without fabricating' : fabricates ? 'appears to fabricate access or a fix' : 'did not clearly admit missing context';
    evidence.admits = admits;
    evidence.fabricates = fabricates;
    evidence.missing_items = mentions;
  } else if (evaluator.type === 'valid_json') {
    try { JSON.parse(text); score = 1; detail = 'valid JSON'; } catch (error) { detail = `invalid JSON: ${error.message}`; }
  } else if (evaluator.type === 'manual') {
    pending = true;
    score = null;
    detail = evaluator.instructions;
  }
  if (!pending) passed = score >= (evaluator.min_score ?? 1);
  return { ...evidence, score, passed, pending, required: !!evaluator.required, fatal: !!evaluator.fatal, weight: evaluator.weight, detail };
}

export function weightedGeometricMean(criteria) {
  const available = criteria.filter((item) => !item.pending && finite(item.score) && finite(item.weight) && item.weight > 0);
  if (!available.length) return null;
  if (available.some((item) => item.score === 0 && (item.required || item.fatal))) return 0;
  const weight = available.reduce((sum, item) => sum + item.weight, 0);
  const logSum = available.reduce((sum, item) => sum + item.weight * Math.log(item.score === 0 ? 0.01 : clamp01(item.score)), 0);
  return round(Math.exp(logSum / weight));
}

function evaluatorsFor(pack, caseDef) {
  const selected = caseDef.evaluator_ids ? new Set(caseDef.evaluator_ids) : null;
  return pack.evaluators.filter((item) =>
    (!selected || selected.has(item.id)) && (!item.case_ids || item.case_ids.includes(caseDef.id))
  );
}

export function renderMessages(pack, caseDef) {
  const replace = (text) => String(text).replace(/{{\s*(mission|case\.id|case\.name|case\.prompt|case\.context)\s*}}/g, (_, key) => ({
    mission: pack.mission,
    'case.id': caseDef.id,
    'case.name': caseDef.name,
    'case.prompt': caseDef.prompt,
    'case.context': caseDef.context || '(No additional context was supplied.)'
  })[key]);
  return [
    { role: 'system', content: replace(pack.prompt_template) },
    { role: 'user', content: replace(`TASK\n{{case.prompt}}\n\nAVAILABLE CONTEXT\n{{case.context}}`) }
  ];
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function aggregateCandidate(candidate, trials, pack) {
  const successful = trials.filter((trial) => !trial.error);
  const trialScores = trials.map((trial) => trial.score ?? 0);
  const mean = trialScores.reduce((sum, score) => sum + score, 0) / trialScores.length;
  const variance = trialScores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / trialScores.length;
  // Scores are bounded [0,1], so their maximum standard deviation is 0.5.
  // Normalising by that maximum makes a 50/50 pass/fail candidate consistency 0.
  const consistency = clamp01(1 - 2 * Math.sqrt(variance));
  const pending = trials.flatMap((trial) => trial.evaluations).filter((item) => item.pending).length;
  const fatalFailure = trials.some((trial) => trial.evaluations.some((item) =>
    !item.pending && item.score === 0 && (item.required || item.fatal)
  ));
  const aggregateCriteria = pack.evaluators.map((evaluator) => {
    const observations = trials.flatMap((trial) => trial.evaluations).filter((item) => item.evaluator_id === evaluator.id && !item.pending);
    return {
      evaluator_id: evaluator.id,
      type: evaluator.type,
      weight: evaluator.weight,
      required: !!evaluator.required,
      fatal: !!evaluator.fatal,
      score: observations.length ? observations.reduce((sum, item) => sum + item.score, 0) / observations.length : null,
      observations: observations.length
    };
  });
  const quality = fatalFailure ? 0 : (weightedGeometricMean(aggregateCriteria) ?? 0);
  const totalCost = successful.reduce((sum, trial) => sum + (finite(trial.cost) ? trial.cost : 0), 0);
  const knownCosts = successful.filter((trial) => finite(trial.cost)).length;
  const latency = successful.length ? successful.reduce((sum, trial) => sum + trial.latency_ms, 0) / successful.length : 0;
  const passCount = trials.filter((trial) => trial.passed).length;
  const needsManual = pending > 0;
  const eligible = !fatalFailure && !needsManual && successful.length === trials.length;
  return {
    model: candidate.model,
    requested_model: candidate.model,
    fallback_model: candidate.fallback_model || null,
    params: candidate.params || {},
    price: candidate.price || null,
    score: round(quality),
    quality_score: round(quality),
    variance: round(variance),
    consistency: round(consistency),
    pass_rate: round(passCount / trials.length),
    passed_trials: passCount,
    total_trials: trials.length,
    latency_ms: round(latency, 2),
    cost: knownCosts ? round(totalCost) : null,
    pending_manual: pending,
    fatal_failure: fatalFailure,
    eligible,
    criteria: aggregateCriteria,
    cases: pack.cases.map((item) => ({
      id: item.id,
      trials: trials.filter((trial) => trial.case_id === item.id)
    })),
    evidence: trials
  };
}

function validateCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > LIMITS.candidates) {
    throw new TypeError(`candidates must contain 1-${LIMITS.candidates} entries`);
  }
  const seen = new Set();
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!own(candidate) || typeof candidate.model !== 'string' || !MODEL_PATTERN.test(candidate.model) || candidate.model.includes('*') || candidate.model.includes('..')) {
      throw new TypeError(`candidates[${index}].model must be a safe concrete model id`);
    }
    if (seen.has(candidate.model)) throw new TypeError(`duplicate candidate model "${candidate.model}"`);
    seen.add(candidate.model);
  }
}

export async function evaluateRolePack({
  pack,
  candidates,
  call,
  trials = pack?.trial_count,
  maxParallel = LIMITS.parallel,
  retryDelayMs = 2000,
  now = () => Date.now()
} = {}) {
  validateRolePack(pack);
  validateCandidates(candidates);
  if (typeof call !== 'function') throw new TypeError('call must be an injected callWithRetry-compatible function');
  boundedInt(trials, 'trials', [], 1, LIMITS.trials) || (() => { throw new TypeError(`trials must be an integer from 1 to ${LIMITS.trials}`); })();
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > LIMITS.parallel) throw new TypeError(`maxParallel must be 1-${LIMITS.parallel}`);

  const jobs = [];
  for (const candidate of candidates) for (const caseDef of pack.cases) for (let trial = 1; trial <= trials; trial++) {
    jobs.push({ candidate, caseDef, trial });
  }
  const raw = await pool(jobs, maxParallel, async ({ candidate, caseDef, trial }) => {
    const started = now();
    try {
      const result = await call({
        name: `role-pack:${pack.id}:${caseDef.id}:trial-${trial}`,
        model: candidate.model,
        fallback_model: candidate.fallback_model,
        messages: renderMessages(pack, caseDef),
        params: candidate.params || {},
        price: candidate.price || null,
        retryDelayMs
      });
      const latency_ms = finite(result?.latency_ms) ? Math.max(0, result.latency_ms) : Math.max(0, now() - started);
      const response = String(result?.text ?? '').slice(0, LIMITS.responseLength);
      const evaluations = evaluatorsFor(pack, caseDef).map((evaluator) => evaluateCriterion(evaluator, response));
      const score = weightedGeometricMean(evaluations);
      const passed = evaluations.filter((item) => !item.pending).every((item) => item.passed) && !evaluations.some((item) => item.pending && item.required);
      return {
        case_id: caseDef.id, case_name: caseDef.name, trial, requested_model: candidate.model,
        model: result?.model || candidate.model,
        fell_back: !!result?.fellBack, response, latency_ms, cost: finite(result?.cost) ? result.cost : null,
        usage: result?.usage || null, score: score ?? 0, passed, evaluations
      };
    } catch (error) {
      return {
        case_id: caseDef.id, case_name: caseDef.name, trial, requested_model: candidate.model, model: candidate.model,
        fell_back: false, response: '', latency_ms: Math.max(0, now() - started), cost: null,
        usage: null, score: 0, passed: false, evaluations: [], error: String(error?.message || error).slice(0, 500)
      };
    }
  });

  const rows = candidates.map((candidate) => aggregateCandidate(
    candidate,
    raw.filter((trial) => trial.requested_model === candidate.model),
    pack
  ));
  rows.sort((a, b) =>
    Number(b.eligible) - Number(a.eligible) || b.score - a.score || b.pass_rate - a.pass_rate ||
    b.consistency - a.consistency || (a.cost ?? Infinity) - (b.cost ?? Infinity) || a.latency_ms - b.latency_ms ||
    a.model.localeCompare(b.model)
  );
  rows.forEach((row, index) => { row.rank = index + 1; });
  return {
    ok: true,
    role_pack: { id: pack.id, name: pack.name, version: pack.version, schema_version: pack.schema_version },
    trial_count: trials,
    rows,
    evidence: raw
  };
}

export default { validateRolePack, parseRolePackJson, loadRolePack, evaluateRolePack, evaluateCriterion, weightedGeometricMean, renderMessages };
