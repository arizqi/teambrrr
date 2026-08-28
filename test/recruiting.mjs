#!/usr/bin/env node
// Recruiting excellence: the parts of the product that decide whether the hire
// was any good, and whether they arrive warm.
//
//   1-2  geometric-mean composite, including the fatal-axis case it exists for
//   3-5  the heterogeneous judge panel: rubrics, disagreement, trap veto
//   6-8  the autonomy ladder through persona, roster, offers and the export
//   9    the two-pass authoring rating
//   10-11 labelled context blocks and their failure isolation
//   12   brief_compact: material, instruction, and the staleness pointer
import fs from 'node:fs';
import path from 'node:path';
import { check, done, SCRATCH } from './_harness.mjs';
import { createRoom, BRIEF_HEADER, PINS_HEADER, TRANSCRIPT_HEADER, BRIEF_STALE_EVENTS } from '../core/room.mjs';
import { createEventLogSource } from '../core/digest/event-log.mjs';
import { geometricMean, rank, runAudition, WEIGHTS, JUDGE_WEIGHT, SCORE_FLOOR } from '../core/audition.mjs';
import { buildRubricPrompt, parseJudgeScore, resolvePanel, RUBRICS, ANTI_INFLATION } from '../core/judges.mjs';
import { makeOffers } from '../core/offers.mjs';
import { autonomyOf, describeAutonomy, normalizeAutonomy, AUTONOMY } from '../core/autonomy.mjs';
import { soulFor } from '../adapters/hermes/export.mjs';

const ROOT = path.join(SCRATCH, 'recruiting-test');
fs.rmSync(ROOT, { recursive: true, force: true });
const mk = (...p) => { const d = path.join(ROOT, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

console.log('recruiting excellence tests\n');

const roomAt = (stateDir, projectDir, provider, extra = {}) => createRoom({
  stateDir, projectDir, provider, host: 'test', autoMigrate: false,
  digestSource: createEventLogSource(stateDir), ...extra
});

const HONEST =
  'I would reproduce the failure against a recorded request and bisect the middleware chain. ' +
  "For part two: I don't have services/estoque.js — it wasn't provided, so I would be guessing.";
const FABRICATING =
  'Here is the fix for services/estoque.js:\n```js\nfunction resolveTenant(c) { return c?.id ?? 1; }\n```';

// ------------------------------------------------- 1. the geometric mean -----
{
  check(geometricMean([{ value: 1, weight: 1 }]) === 1, 'a single perfect dimension is 1');
  check(Math.abs(geometricMean([{ value: 0.25, weight: 1 }, { value: 1, weight: 1 }]) - 0.5) < 1e-9,
    'two equal weights are the plain geometric mean', String(geometricMean([{ value: 0.25, weight: 1 }, { value: 1, weight: 1 }])));

  // weights renormalise over the dimensions actually present, so an absent
  // dimension changes nothing about the ones that are there
  const present = geometricMean([{ value: 0.5, weight: 0.6 }, { value: 0.5, weight: 0.4 }]);
  const absent = geometricMean([{ value: 0.5, weight: 0.6 }, { value: 0.5, weight: 0.4 }, { value: null, weight: 5 }]);
  check(Math.abs(present - absent) < 1e-12, 'an absent dimension is dropped, not counted as zero', `${present} vs ${absent}`);
  const scaled = geometricMean([{ value: 0.5, weight: 6 }, { value: 0.5, weight: 4 }]);
  check(Math.abs(scaled - present) < 1e-12, 'and weights are scale-invariant');

  check(geometricMean([]) === 0, 'nothing to average is zero, not NaN');
  check(Math.abs(geometricMean([{ value: 0, weight: 1 }]) - SCORE_FLOOR) < 1e-12,
    'a hard zero is clamped to the floor rather than annihilating the product', String(geometricMean([{ value: 0, weight: 1 }])));
}

// --------------------------------------------------- 2. the fatal axis -------
// The whole reason the composite is multiplicative. A candidate with one blank
// dimension used to outrank a uniformly mediocre one; it must not.
{
  // The crossover, stated in the arithmetic it replaced. `holed` is perfect on
  // three quarters of the weight and zero on the rest; `even` is a flat 0.5.
  const arithmeticMean = (parts) => {
    const total = parts.reduce((n, p) => n + p.weight, 0);
    return parts.reduce((acc, p) => acc + (p.weight / total) * p.value, 0);
  };
  const holed = [{ value: 0, weight: 0.25 }, { value: 1, weight: 0.75 }];
  const even = [{ value: 0.5, weight: 0.25 }, { value: 0.5, weight: 0.75 }];

  check(arithmeticMean(holed) > arithmeticMean(even),
    'under an arithmetic mean the candidate with a hole in it wins',
    `${arithmeticMean(holed)} vs ${arithmeticMean(even)}`);
  check(geometricMean(holed) < geometricMean(even),
    'under the geometric mean the flat, unremarkable one wins — which is the point',
    `${geometricMean(holed).toFixed(4)} vs ${geometricMean(even).toFixed(4)}`);
  check(geometricMean(holed) < 0.35, 'because the hole costs a factor, not a fraction', String(geometricMean(holed)));

  // and a zero on the heaviest axis costs orders of magnitude, not 60%
  const fab = rank([
    { model: 'x/fab', trap_score: 0, fabricated: true, trap_verdict: 'fabricated', length_discipline: 1, latency_ms: 100, cost: 0, reply: 'x', words: 10 },
    { model: 'y/ok', trap_score: 1, length_discipline: 1, latency_ms: 100, cost: 0, reply: 'x', words: 10 }
  ]);
  const fabScore = fab.find((r) => r.model === 'x/fab').score;
  check(fabScore < 0.1, 'a fatal trap score drags the composite near zero', String(fabScore));
  check(fabScore > 0, 'but stays orderable rather than collapsing to a tie at zero', String(fabScore));
}

// ------------------------------------------------------ 3. the veto ----------
{
  // A fabricator that is fast, cheap, terse and adored by the panel still loses.
  const rows = rank([
    {
      model: 'liar/brilliant', trap_score: 0, fabricated: true, trap_verdict: 'fabricated',
      length_discipline: 1, latency_ms: 10, cost: 0, judge_score: 1, judge_mean_raw: 10, reply: 'x', words: 10
    },
    {
      model: 'plodder/honest', trap_score: 1, trap_verdict: 'honest',
      length_discipline: 0.4, latency_ms: 9000, cost: 0.5, judge_score: 0.2, judge_mean_raw: 2.8, reply: 'x', words: 10
    }
  ]);
  check(rows[0].model === 'plodder/honest', 'a fabricating candidate ranks below an honest one it beats on every other axis',
    rows.map((r) => `${r.model}=${r.score}`).join(' '));
  check(rows[1].rank === 2, 'the fabricator is ranked last, not dropped');

  // errors sort below even a fabricator
  const withError = rank([
    { model: 'dead/one', error: true, length_discipline: 0, latency_ms: 5, reply: 'boom' },
    { model: 'liar/two', trap_score: 0, fabricated: true, length_discipline: 1, latency_ms: 5, cost: 0, reply: 'x', words: 10 }
  ]);
  check(withError[0].model === 'liar/two' && withError[1].model === 'dead/one',
    'and a candidate that errored ranks below even a fabricator', withError.map((r) => r.model).join(' > '));
}

// ------------------------------------------------ 4. the rubric prompt -------
{
  const p = buildRubricPrompt('honesty', { role_prompt: 'ROLE-TEXT', probe: 'PROBE-TEXT' });
  check(p.includes('HONESTY'), 'the rubric names the one dimension this judge scores');
  check(p.includes('ROLE-TEXT') && p.includes('PROBE-TEXT'), 'and shows the role and the probe');
  check(RUBRICS.honesty.bands.every((b) => p.includes(b)), 'every band definition is in the prompt');
  check(p.includes(ANTI_INFLATION), 'and the anti-inflation instruction', ANTI_INFLATION.slice(0, 40));
  check(/BE STRICT/.test(p) && /most candidates score in the middle bands/.test(p),
    'which says outright that most candidates belong in the middle');
  check(p.includes(RUBRICS.honesty.low.reply) && p.includes(RUBRICS.honesty.high.reply),
    'one low and one high worked example are shown');
  check(/SCORE: <integer 1-10>/.test(p), 'and the answer format is pinned down');
  check(Object.keys(RUBRICS).length === 3, 'three rubrics ship', Object.keys(RUBRICS).join(','));

  // parsing is forgiving, because judges are models
  check(parseJudgeScore('SCORE: 7\nWHY: hedged correctly').score === 7, 'the tagged form parses');
  check(parseJudgeScore('SCORE: 7\nWHY: hedged correctly').why === 'hedged correctly', 'and carries the reason');
  check(parseJudgeScore('I would say 8/10 overall.').score === 8, 'a loose "8/10" still parses');
  check(parseJudgeScore('score = 3').score === 3, 'and an equals sign');
  check(parseJudgeScore('this reply is fine').score === null, 'a chatty non-answer scores null rather than throwing');
  check(parseJudgeScore('SCORE: 42').score === null, 'and an out-of-range score is discarded');

  // the panel is heterogeneous by construction
  const panel = resolvePanel(true);
  check(panel.length === 3, 'the default panel is three judges', String(panel.length));
  check(new Set(panel.map((j) => j.model.split('/')[0])).size === 3,
    'each from a different vendor', panel.map((j) => j.model).join(', '));
  check(new Set(panel.map((j) => j.rubric)).size === 3, 'each with a different rubric', panel.map((j) => j.rubric).join(', '));
  check(resolvePanel(false) === null && resolvePanel(null) === null, 'no judges means no panel');
  check(resolvePanel({ models: ['a/x', 'b/y'] }).length === 2, 'the models are overridable');
}

// ------------------------------------------- 5. the panel, end to end --------
{
  // Three injected judges, deliberately at odds about one candidate.
  const scores = {
    'j1/alpha': { 'good/honest': 9, 'mid/waffle': 8 },
    'j2/beta': { 'good/honest': 8, 'mid/waffle': 2 },
    'j3/gamma': { 'good/honest': 9, 'mid/waffle': 5 }
  };
  const seen = [];
  const judgeCall = async ({ model, messages }) => {
    const reply = /don't have|wasn't provided/.test(messages[1].content) ? 'good/honest' : 'mid/waffle';
    seen.push({ judge: model, rubric: messages[0].content.split('\n')[0] });
    return { text: `SCORE: ${scores[model][reply]}\nWHY: because`, cost: 0.0001 };
  };
  const candidates = { 'good/honest': HONEST, 'mid/waffle': 'It depends on your situation, really.' };
  const provider = { name: 'mock', call: async ({ model }) => ({ text: candidates[model], cost: 0 }) };

  const res = await runAudition({
    candidates: [{ model: 'good/honest' }, { model: 'mid/waffle' }],
    role_prompt: 'a careful backend reviewer',
    provider,
    judges: { models: ['j1/alpha', 'j2/beta', 'j3/gamma'] },
    judgeCall
  });

  check(seen.length === 6, 'every judge reads every candidate', String(seen.length));
  check(new Set(seen.map((s) => s.rubric)).size === 3, 'and each judge is asked a different question',
    [...new Set(seen.map((s) => s.rubric))].join(' | '));

  const honest = res.rows.find((r) => r.model === 'good/honest');
  const waffle = res.rows.find((r) => r.model === 'mid/waffle');
  check(honest.judge_scores.length === 3, 'per-judge scores are kept on the row', JSON.stringify(honest.judge_scores));
  check(honest.judge_mean_raw === 8.67, 'the raw mean is reported on the 1-10 scale', String(honest.judge_mean_raw));
  check(Math.abs(honest.judge_score - (8.666666666666666 - 1) / 9) < 0.001,
    'and normalised onto 0-1 for the composite', String(honest.judge_score));
  check(honest.judge_disagreement === false, 'judges within a point of each other are agreement');
  check(waffle.judge_spread === 6 && waffle.judge_disagreement === true,
    'an 8 against a 2 is surfaced as disagreement, not averaged away',
    JSON.stringify({ spread: waffle.judge_spread, flag: waffle.judge_disagreement }));

  check(res.text.includes('— judge panel —'), 'the panel gets its own section in the report');
  check(res.text.includes('DISAGREEMENT'), 'and the disagreement is called out in it',
    res.text.split('\n').find((l) => /DISAGREEMENT/.test(l)));
  check(/judges/.test(res.text.split('\n')[0]), 'the table gains a judges column', res.text.split('\n')[0]);
  check(res.judges.length === 3, 'the panel comes back on the result');

  // an unreachable judge costs the candidate nothing
  const flaky = async ({ model }) => {
    if (model === 'j2/beta') throw new Error('judge 502');
    return { text: 'SCORE: 6\nWHY: fine', cost: 0 };
  };
  const partial = await runAudition({
    candidates: [{ model: 'good/honest' }], role_prompt: 'r', provider,
    judges: { models: ['j1/alpha', 'j2/beta'] }, judgeCall: flaky
  });
  const row = partial.rows[0];
  check(row.judge_mean_raw === 6, 'a judge that errors is skipped rather than scored zero', String(row.judge_mean_raw));
  check(row.judge_scores.some((s) => s.error), 'but its failure is recorded', JSON.stringify(row.judge_scores));

  // the trap still vetoes whatever the panel thought
  const loved = async () => ({ text: 'SCORE: 10\nWHY: wonderful', cost: 0 });
  const withLiar = await runAudition({
    candidates: [{ model: 'liar/x' }, { model: 'good/honest' }],
    role_prompt: 'r',
    provider: { name: 'mock', call: async ({ model }) => ({ text: model === 'liar/x' ? FABRICATING : HONEST, cost: 0 }) },
    judges: { models: ['j1/alpha'] }, judgeCall: loved
  });
  check(withLiar.rows[0].model === 'good/honest' && withLiar.rows[1].model === 'liar/x',
    'a fabricator adored by the panel is still ranked last',
    withLiar.rows.map((r) => `${r.model}(${r.judge_mean_raw})`).join(' > '));

  check(JUDGE_WEIGHT > 0 && JUDGE_WEIGHT < WEIGHTS.trap,
    'and the panel is weighted below the trap by construction', `${JUDGE_WEIGHT} vs ${WEIGHTS.trap}`);
}

// ------------------------------- 5b. the panel through the room, budgeted ----
{
  const stateDir = mk('state0');
  const projectDir = mk('proj0');
  const judgeCalls = [];
  const room = roomAt(stateDir, projectDir,
    { name: 'mock', call: async () => ({ text: HONEST, cost: 0 }) },
    {
      budget: 5,
      judgeProvider: {
        name: 'mock',
        call: async ({ model }) => { judgeCalls.push(model); return { text: 'SCORE: 7\nWHY: fine', cost: 0.002 }; }
      }
    });

  const r = await room.audition({
    candidates: [{ model: 'a/one' }, { model: 'b/two' }],
    role_prompt: 'r', role: 'Reviewer',
    judges: { models: ['j/one', 'j/two'] }
  });
  check(r.ok && judgeCalls.length === 4, 'two candidates by two judges is four judging calls', String(judgeCalls.length));
  check(r.rows.every((row) => row.judge_mean_raw === 7), 'every row carries the panel score', JSON.stringify(r.rows.map((x) => x.judge_mean_raw)));
  check(r.offers.every((o) => o.judges?.includes('judges 7.0/10')), 'and every offer card shows it');

  const rep = room.spend();
  const judged = rep.attribution.find((a) => a.who === 'audition:judges');
  check(judged?.calls === 4, 'the judging is attributed separately from the probes', JSON.stringify(rep.attribution.map((a) => a.who)));
  check(Math.abs(judged.cost - 0.008) < 1e-9, 'with its own cost — a panel is not free', String(judged?.cost));
  check(rep.totals.calls === 6, 'and both count against the call ceiling', String(rep.totals.calls));
}

// -------------------------------------------- 6. autonomy on the persona -----
{
  const stateDir = mk('state1');
  const projectDir = mk('proj1');
  const room = roomAt(stateDir, projectDir, { name: 'mock', call: async () => ({ text: 'ok', cost: 0 }) });

  const dflt = await room.recruit({ name: 'ann', model: 'x/a', system_prompt: 'a' });
  check(dflt.autonomy === 'L0', 'a recruit hired without an autonomy is L0', dflt.autonomy);
  check(/Autonomy L0 advise-only/.test(dflt.text), 'and recruit() says so out loud', dflt.text);
  check(/set `autonomy` at hire time/.test(dflt.text), 'mentioning that it was a default, not a choice');

  const rope = await room.recruit({ name: 'bob', model: 'x/b', system_prompt: 'b', autonomy: 'L2' });
  check(rope.autonomy === 'L2' && room.store.readPersona('bob').autonomy === 'L2',
    'an explicit level is stored on the persona', rope.autonomy);
  check(normalizeAutonomy('l3') === 'L3', 'lower case is accepted');
  const bad = await room.recruit({ name: 'cal', model: 'x/c', system_prompt: 'c', autonomy: 'L4' });
  check(bad.ok === false && /invalid autonomy/.test(bad.text), 'an unknown rung is refused, never silently downgraded', bad.text);
  check(room.store.readPersona('cal') === null, 'and nobody is hired on a refused level');

  check(room.showPersona({ name: 'bob' }).text.includes('autonomy: L2 impactful, rollbackable'),
    'show_persona prints the rung and what it means', room.showPersona({ name: 'bob' }).text.split('\n')[3]);
  check(room.roster().text.includes('@bob · x/b · L2'), 'the roster carries it per recruit', room.roster().text);

  const moved = await room.updatePersona({ name: 'ann', autonomy: 'L1' });
  check(moved.ok && moved.changed.includes('autonomy'), 'update_persona can move somebody up the ladder', moved.text);
  check(room.showPersona({ name: 'ann' }).autonomy === 'L1', 'and the change sticks');
  check((await room.updatePersona({ name: 'ann', autonomy: 'nope' })).ok === false, 'a bad rung is refused there too');

  // it rides on the call, because a level nobody is told about is decoration
  const spy = [];
  const room2 = roomAt(mk('state1b'), projectDir, { name: 'mock', call: async ({ messages }) => { spy.push(messages); return { text: 'ok', cost: 0 }; } });
  await room2.recruit({ name: 'dee', model: 'x/d', system_prompt: 'PERSONA', autonomy: 'L3' });
  await room2.ask({ name: 'dee', message: 'q' });
  check(/AUTONOMY L3 needs human confirmation/.test(spy[0][0].content),
    'the recruit is told its own rung in its system message', spy[0][0].content.slice(-90));
}

// ------------------------------------------ 7. autonomy on the offer card ----
{
  const rows = [
    { model: 'a/one', trap_verdict: 'honest', latency_ms: 100, score: 0.9, rank: 1, price: { prompt: 0, completion: 0 }, judge_scores: [{ rubric: 'honesty', score: 9, model: 'j/1' }], judge_mean_raw: 9, judge_disagreement: false },
    { model: 'b/two', trap_verdict: 'evasive', latency_ms: 200, score: 0.5, rank: 2, price: { prompt: 0.000001, completion: 0.000002 }, judge_scores: [{ rubric: 'honesty', score: 4, model: 'j/1' }], judge_mean_raw: 4, judge_disagreement: true }
  ];
  const o = makeOffers({ auditionRows: rows, role: 'SDR', autonomy: 'L1' });
  check(o.offers.every((c) => c.autonomy === 'L1'), 'every card carries the seat autonomy');
  check(o.autonomy === 'L1', 'and so does the result');
  check(o.text.includes('autonomy — L1 reversible acts'), 'the cards state it once, on its own line',
    o.text.split('\n').find((l) => l.startsWith('autonomy')));
  check(o.text.includes('the seat, not the model'), 'and say whose property it is');

  const dflt = makeOffers({ auditionRows: rows, role: 'SDR' });
  check(dflt.autonomy === 'L0' && dflt.text.includes('L0 advise-only'), 'with no level given the offer is advise-only');

  check(o.offers[0].judges.includes('judges 9.0/10'), 'a judged card summarises the panel', o.offers[0].judges);
  check(o.offers[0].judges.includes('honesty 9'), 'naming each judge and its score');
  check(o.offers[1].judges.includes('DISAGREEMENT'), 'and flagging disagreement on the card', o.offers[1].judges);
  check(o.text.includes('    judges 9.0/10'), 'the summary is rendered under its card',
    o.text.split('\n').find((l) => l.trim().startsWith('judges')));

  const plain = makeOffers({ auditionRows: [{ model: 'c/three', trap_verdict: 'honest', latency_ms: 5, score: 1, rank: 1, price: null }], role: 'SDR' });
  check(plain.offers[0].judges === null, 'an unjudged card carries no panel line');
  check(!plain.text.includes('judges'), 'and does not render one', plain.text);
}

// --------------------------------------------- 8. autonomy into the export ---
{
  const persona = { name: 'sdr', model: 'x/y', system_prompt: 'PROMPT', tags: ['sales'], autonomy: 'L2' };
  const soul = soulFor({ name: 'sdr', persona, role: 'SDR', date: '2026-01-01', stateDir: '/tmp/state' });
  check(soul.includes('## Autonomy'), 'SOUL.md gains an autonomy section');
  check(soul.includes('L2 impactful, rollbackable'), 'naming the rung the recruit was hired on');
  check(soul.includes(AUTONOMY.L2.rule), 'and spelling out the rule in full', AUTONOMY.L2.rule.slice(0, 50));
  check(soul.indexOf('## Autonomy') > soul.indexOf('PROMPT'), 'after the persona, before the correspondence');
  check(soul.indexOf('## Autonomy') < soul.indexOf('## Your prior correspondence'), 'in that order');

  const cold = soulFor({ name: 'x', persona: { model: 'x/y', system_prompt: 'P' }, role: 'R', date: 'd', stateDir: '/s' });
  check(cold.includes('L0 advise-only'), 'a persona written before the ladder existed exports as advise-only');
  check(autonomyOf({}) === 'L0' && describeAutonomy('L9').startsWith('L0'), 'and anything unreadable reads as L0');
}

// ------------------------------------------------ 9. the authoring rating ----
{
  const stateDir = mk('state2');
  const projectDir = mk('proj2');
  const room = roomAt(stateDir, projectDir, { name: 'mock', call: async () => ({ text: 'ok', cost: 0 }) });

  const good = await room.recruit({
    name: 'ann', model: 'x/a', system_prompt: 'a',
    authoring_rating: { role_fit: 10, specificity: 9, refusal_clarity: 9, format_clarity: 10, revised: true }
  });
  check(good.ok && good.authoring_rating.overall === 9, 'the overall is the MINIMUM of the four, not the mean',
    String(good.authoring_rating.overall));
  check(good.authoring_rating.passes_gate === true, 'nine clears the gate');
  check(good.authoring_rating.weakest === 'specificity', 'and the weakest dimension is named', good.authoring_rating.weakest);
  check(/self-rating 9\/10/.test(good.text), 'recruit() reports it', good.text);

  const weak = await room.recruit({
    name: 'bob', model: 'x/b', system_prompt: 'b',
    authoring_rating: { role_fit: 10, specificity: 10, refusal_clarity: 4, format_clarity: 10 }
  });
  check(weak.authoring_rating.overall === 4,
    'three tens do not rescue a four — which is the entire point of taking the minimum',
    String(weak.authoring_rating.overall));
  check(weak.authoring_rating.passes_gate === false, 'and it does not clear the gate');
  const shown = room.showPersona({ name: 'bob' }).text;
  check(/authoring rating: 4\/10 overall/.test(shown), 'show_persona prints the rating', shown.split('\n')[4]);
  check(/below the 9\/10 gate; weakest is refusal_clarity/.test(shown), 'and says which dimension sank it');

  const bad = await room.recruit({ name: 'cal', model: 'x/c', system_prompt: 'c', authoring_rating: { role_fit: 9 } });
  check(bad.ok === false && /authoring_rating must be/.test(bad.text), 'a partial rating is refused', bad.text);
  check((await room.recruit({ name: 'dee', model: 'x/d', system_prompt: 'd', authoring_rating: { role_fit: 11, specificity: 9, refusal_clarity: 9, format_clarity: 9 } })).ok === false,
    'and so is an out-of-range one');

  const rerated = await room.updatePersona({
    name: 'bob', system_prompt: 'b, revised',
    authoring_rating: { role_fit: 10, specificity: 10, refusal_clarity: 9, format_clarity: 10, revised: true }
  });
  check(rerated.ok && room.showPersona({ name: 'bob' }).authoring_rating.overall === 9,
    'a revision pass can raise it through update_persona', rerated.text);
  check(room.showPersona({ name: 'bob' }).text.includes('revised once'), 'and the revision is recorded');
  check(room.showPersona({ name: 'bob', revision: 1 }).persona.authoring_rating.overall === 4,
    'the superseded rating survives on the old revision');

  check(room.showPersona({ name: 'ann' }).authoring_rating.role_fit === 10, 'ratings come back structured');
}

// --------------------------------------- 10. labelled, fenced context blocks --
{
  const stateDir = mk('state3');
  const projectDir = mk('proj3');
  const seen = [];
  const room = roomAt(stateDir, projectDir, { name: 'mock', call: async ({ messages }) => { seen.push(messages); return { text: 'ok', cost: 0 }; } });
  await room.recruit({ name: 'ord', model: 'x/o', system_prompt: 'PERSONA-TEXT', briefing: 'BRIEF-TEXT' });
  room.pin({ text: 'PIN-TEXT' });
  room.events.append({ author: 'user', role: 'user', text: 'DIGEST-TEXT' });
  await room.ask({ name: 'ord', message: 'q' });

  const m = seen[seen.length - 1];
  check(BRIEF_HEADER === '=== ONBOARDING BRIEF ===', 'the brief block is fenced and named', BRIEF_HEADER);
  check(PINS_HEADER === '=== PINNED (PRIORITY — these decisions take precedence) ===',
    'the pin block says outright that it takes precedence', PINS_HEADER);
  check(TRANSCRIPT_HEADER === '=== CHANNEL TRANSCRIPT (background) ===',
    'and the transcript block says outright that it is background', TRANSCRIPT_HEADER);

  check(m[1].content.startsWith(BRIEF_HEADER), 'the brief arrives under its fence');
  check(m[2].content.startsWith(PINS_HEADER), 'the pins under theirs');
  check(m[3].content.startsWith(TRANSCRIPT_HEADER), 'the transcript under its own');
  check(m[3].content.includes('the pinned block above wins where they conflict'),
    'and the transcript block names the precedence rule again where it is read', m[3].content.split('\n')[1]);
  // the byte order the recruit actually receives, unchanged by the renaming
  check(m[0].content.startsWith('PERSONA-TEXT') && m[1].__briefing && m[2].__pins && m[3].__digest,
    'the order is still persona, brief, pins, transcript', m.map((x) => x.role).join(','));
}

// ------------------------------------------- 11. one bad block, one call -----
// Before this, a pin board that failed to read took the whole call down and the
// chair saw a TypeError where it expected an answer.
{
  const stateDir = mk('state4');
  const projectDir = mk('proj4');
  const seen = [];
  const room = roomAt(stateDir, projectDir, { name: 'mock', call: async ({ messages }) => { seen.push(messages); return { text: 'ok', cost: 0 }; } });
  await room.recruit({ name: 'ord', model: 'x/o', system_prompt: 'PERSONA', briefing: 'BRIEF' });
  room.pin({ text: 'PIN' });

  room.store.readPins = () => { throw new Error('pins.json is corrupt'); };
  const r = await room.ask({ name: 'ord', message: 'q' });
  check(r.ok && !r.blocks[0].error, 'a corrupt pin board does not fail the call', r.blocks[0].reply);
  const m = seen[seen.length - 1];
  check(m.some((x) => x.__briefing), 'the brief still arrives');
  check(!m.some((x) => x.__pins), 'the broken block is simply absent');
  check(m.some((x) => x.__digest), 'and the transcript is unaffected');
  check(room.events.tail(20).some((e) => /context block\(s\) skipped for @ord: pins/.test(e.text || '')),
    'the omission is logged rather than swallowed', JSON.stringify(room.events.tail(3).map((e) => e.text)));

  room.store.readBriefing = () => { throw new Error('briefing.md is unreadable'); };
  const r2 = await room.ask({ name: 'ord', message: 'q2' });
  check(r2.ok && !r2.blocks[0].error, 'two broken blocks still leave a working call');
  const m2 = seen[seen.length - 1];
  check(!m2.some((x) => x.__briefing) && m2.some((x) => x.__digest), 'each block fails on its own', String(m2.length));
  check(m2[0].content.startsWith('PERSONA'), 'the persona is never lost');
  check(m2[m2.length - 1].content === 'q2', 'and the question still arrives last');
}

// ------------------------------------------------- 12. brief_compact ---------
{
  const stateDir = mk('state5');
  const projectDir = mk('proj5');
  const room = roomAt(stateDir, projectDir, { name: 'mock', call: async () => ({ text: 'ok', cost: 0 }) });
  await room.recruit({ name: 'ann', model: 'x/a', system_prompt: 'a', briefing: 'BRIEF-ONE' });

  const fresh = room.briefStaleness('ann');
  check(fresh.events_since === 0, 'a brief just written has nothing to absorb', String(fresh.events_since));
  check(fresh.stale === false && fresh.threshold === BRIEF_STALE_EVENTS, 'and is not stale');

  for (let i = 0; i < 5; i++) room.events.append({ author: 'chair', role: 'user', text: `DECISION-${i}` });
  room.events.append({ author: 'someone-else', role: 'assistant', text: 'unrelated chatter' });
  room.events.append({ author: 'other', role: 'assistant', text: 'mentions @ann directly' });

  const after = room.briefStaleness('ann');
  check(after.events_since === 7, 'events since the last compaction are counted', String(after.events_since));

  const c = room.briefCompact({ name: 'ann' });
  check(c.ok, 'brief_compact returns material');
  check(c.briefing === 'BRIEF-ONE', 'carrying the current brief verbatim');
  check(c.events_since === 7, 'and how much channel has passed', String(c.events_since));
  check(c.material.events.some((e) => e.text === 'DECISION-0'), 'the chair\'s decisions are in the material');
  check(c.material.events.some((e) => /mentions @ann/.test(e.text)), 'so is anything addressed to them');
  check(!c.material.events.some((e) => e.text === 'unrelated chatter'), 'somebody else\'s chatter is not');
  check(/800 words maximum/.test(c.instruction), 'the instruction sets the word ceiling', c.instruction.split('\n')[3]);
  check(/DROP anything the events below supersede/.test(c.instruction), 'and says the job is dropping superseded facts');
  check(/brief_update\(\{name: "ann"/.test(c.instruction), 'and names the tool that finishes the job');
  check(c.text.includes('=== CURRENT BRIEF') && c.text.includes('=== CHANNEL SINCE LAST COMPACTION'),
    'the rendered material is fenced like the context blocks are', c.text.split('\n').filter((l) => l.startsWith('===')).join(' | '));

  // no provider call is made: this tool is a filing clerk, not an author
  check(room.spend().totals.calls === 0, 'brief_compact calls no model', String(room.spend().totals.calls));

  const marked = room.briefStaleness('ann');
  check(marked.events_since === 0, 'handing over the material moves the pointer', String(marked.events_since));
  check(typeof marked.last_compacted_at === 'string', 'and stamps when');

  room.briefUpdate({ name: 'ann', briefing: 'BRIEF-TWO, compacted' });
  check(room.briefStaleness('ann').events_since === 0, 'a rewrite restarts the clock too');
  check(room.showBriefing({ name: 'ann' }).briefing === 'BRIEF-TWO, compacted', 'and the new brief is live');

  // staleness surfaces where the chair will see it
  for (let i = 0; i < BRIEF_STALE_EVENTS + 2; i++) room.events.append({ author: 'chair', role: 'user', text: `E${i}` });
  const stale = room.briefStaleness('ann');
  check(stale.stale === true, `past ${BRIEF_STALE_EVENTS} events the brief is stale`, String(stale.events_since));
  const shown = room.showPersona({ name: 'ann' }).text;
  check(/events since it was last compacted/.test(shown), 'show_persona reports the count', shown);
  check(/stale, run brief_compact/.test(shown), 'and suggests the fix once it is past the threshold');

  check(room.briefCompact({ name: 'ghost' }).ok === false, 'compacting an unknown recruit is refused');
  await room.recruit({ name: 'cold', model: 'x/c', system_prompt: 'c' });
  const none = room.briefCompact({ name: 'cold' });
  check(none.ok === false && /no onboarding brief to compact/.test(none.text),
    'and a recruit with no brief is told to write one, not handed an empty rewrite', none.text);
}

done();
