#!/usr/bin/env node
// CallBudget: two ceilings, reserved before the call rather than checked after,
// attributed per recruit and per reason.
//
// The property that matters most here is the one the old preflight did not have:
// a parallel fan-out cannot collectively overshoot, because each call reserves
// its estimated cost before it is dispatched.
import fs from 'node:fs';
import path from 'node:path';
import { check, done, SCRATCH } from './_harness.mjs';
import {
  createCallBudget, estimateCallCost, BudgetExhausted, isBudgetExhausted,
  maxCallsFromEnv, DEFAULT_MAX_CALLS
} from '../core/budget.mjs';
import { createRoom } from '../core/room.mjs';
import { createEventLogSource } from '../core/digest/event-log.mjs';

const ROOT = path.join(SCRATCH, 'budget-test');
fs.rmSync(ROOT, { recursive: true, force: true });
const mk = (...p) => { const d = path.join(ROOT, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

console.log('CallBudget tests\n');

const roomAt = (stateDir, projectDir, provider, extra = {}) => createRoom({
  stateDir, projectDir, provider, host: 'test', autoMigrate: false,
  digestSource: createEventLogSource(stateDir), ...extra
});

// ------------------------------------------------------------ 1. ceilings ----
{
  const b = createCallBudget({ maxCalls: 3, maxUsd: 1, spent: () => 0 });
  check(b.maxCalls === 3 && b.maxUsd === 1, 'a budget carries both ceilings');
  check(b.exhausted() === null, 'a fresh budget is not exhausted');

  for (let i = 0; i < 3; i++) (await b.consume('a', 'ask')).settle(0);
  check(b.calls() === 3, 'every consume counts one call', String(b.calls()));
  check(b.remainingCalls() === 0, 'and the remaining count reaches zero');

  let thrown = null;
  try { await b.consume('a', 'ask'); } catch (e) { thrown = e; }
  check(thrown instanceof BudgetExhausted, 'the fourth call throws BudgetExhausted');
  check(isBudgetExhausted(thrown) && thrown.code === 'budget_exhausted', 'the error is typed', thrown?.code);
  check(thrown.kind === 'calls', 'and says which ceiling it was', thrown?.kind);
  check(/call ceiling reached: 3 of 3/.test(thrown.message), 'quoting the arithmetic', thrown.message);
  check(b.exhausted()?.kind === 'calls', 'exhausted() reports the same thing without spending a call');
}

// ----------------------------------------------------------- 2. dollars ------
{
  let spent = 0;
  const b = createCallBudget({ maxCalls: 100, maxUsd: 0.10, spent: () => spent, hint: 'HINT-TEXT' });
  const t = await b.consume('a', 'ask', { estimate: 0.04 });
  check(b.reserved() === 0.04, 'an estimate is reserved before the call', String(b.reserved()));
  spent = 0.04; t.settle(0.04);
  check(b.reserved() === 0, 'and released on settle');

  spent = 0.10;
  let e = null;
  try { await b.consume('a', 'ask', { estimate: 0.01 }); } catch (err) { e = err; }
  check(e?.kind === 'usd' && /spend cap reached/.test(e.message), 'the dollar ceiling refuses', e?.message);
  check(/HINT-TEXT/.test(e.message), 'and carries the caller-supplied way out', e?.message);

  spent = 0.05;
  let big = null;
  try { await b.consume('a', 'ask', { estimate: 0.09 }); } catch (err) { big = err; }
  check(/exceeds the remaining/.test(big?.message || ''), 'a call larger than the remainder is refused', big?.message);
}

// -------------------------------------------------- 3. the mid-batch fix -----
// The gap this closes: five parallel calls, each estimated at $0.03, against a
// $0.10 cap. Without reservation all five pass one preflight and $0.15 is spent.
{
  let spent = 0;
  const b = createCallBudget({ maxCalls: 100, maxUsd: 0.10, spent: () => spent });
  const outcomes = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    b.consume(`r${i}`, 'ask', { estimate: 0.03 })
      .then((t) => { spent += 0.03; t.settle(0.03); return 'ran'; })
      .catch((e) => (isBudgetExhausted(e) ? 'refused' : `boom:${e.message}`))));
  const ran = outcomes.filter((o) => o === 'ran').length;
  check(ran === 3, 'only as many parallel calls run as the cap can pay for', outcomes.join(','));
  check(spent <= 0.10, 'the batch lands inside the cap rather than one batch past it', String(spent));
}

// ------------------------------------------- 4. unpriced calls serialise -----
{
  let spent = 0;
  let inFlight = 0;
  let peak = 0;
  const b = createCallBudget({ maxCalls: 100, maxUsd: 0.05, spent: () => spent });
  const run = async () => {
    const t = await b.consume('x', 'probe', { estimate: null, wait: true });
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    spent += 0.025;
    t.settle(0.025);
  };
  const results = await Promise.all([run(), run(), run()].map((p) => p.then(() => 'ok', (e) => e.message)));
  check(peak === 1, 'a call with no validated price never runs beside another', `peak=${peak}`);
  check(results.filter((r) => r === 'ok').length === 2, 'two of three fit inside the cap', results.join(' | '));
  check(/spend cap reached/.test(results.find((r) => r !== 'ok') || ''),
    'and the third is refused rather than queued forever', results.join(' | '));
  check(spent <= 0.05, 'an unpriced fan-out still lands inside the cap', String(spent));

  // The floor: below a cent, an unpriced call is refused outright rather than
  // reserving a remainder too small to mean anything.
  const tight = createCallBudget({ maxCalls: 10, maxUsd: 0.10, spent: () => 0.096 });
  let floor = null;
  try { await tight.consume('x', 'probe', { estimate: null }); } catch (e) { floor = e; }
  check(/less than \$0\.01 remains/.test(floor?.message || ''),
    'under a cent, an unpriced call is refused for having no price and no room', floor?.message);
}

// ------------------------------------------------------- 5. the estimate -----
{
  const messages = [{ role: 'user', content: 'x'.repeat(2000) }];
  const price = { prompt: 0.000001, completion: 0.000002 };
  const est = estimateCallCost({ messages, params: { max_tokens: 500 }, price });
  check(est === 1000 * 0.000001 + 500 * 0.000002, 'the estimate is chars/2 in and max_tokens out', String(est));
  check(estimateCallCost({ messages, price: null }) === null, 'no price means no estimate, not a zero one');
  check(estimateCallCost({ messages, price: { prompt: 0, completion: 0 } }) === 0, 'a free model estimates at exactly zero');
  check(maxCallsFromEnv({}) === DEFAULT_MAX_CALLS, 'the call ceiling defaults to 200', String(DEFAULT_MAX_CALLS));
  check(maxCallsFromEnv({ PERSONA_RECRUITER_BUDGET_CALLS: '7' }) === 7, 'and is settable from the environment');
}

// ------------------------------------------ 6. through the room: ceilings ----
{
  const stateDir = mk('state1');
  const projectDir = mk('proj1');
  let calls = 0;
  const provider = { name: 'mock', call: async () => { calls++; return { text: 'hi', cost: 0 }; } };
  const room = roomAt(stateDir, projectDir, provider, { maxCalls: 2 });
  await room.recruit({ name: 'ann', model: 'x/a', system_prompt: 'a' });
  await room.recruit({ name: 'bob', model: 'x/b', system_prompt: 'b' });

  const first = await room.ask({ names: ['ann', 'bob'], message: 'q' });
  check(first.ok && first.blocks.every((b) => !b.error), 'two recruits answer inside a two-call ceiling');
  check(calls === 2, 'and exactly two provider calls were made', String(calls));

  const blocked = await room.ask({ name: 'ann', message: 'q' });
  check(blocked.ok === false && /call ceiling reached/.test(blocked.text),
    'the next ask is refused by the call ceiling even though nothing was spent', blocked.text);
  check(calls === 2, 'a refused ask reaches no provider', String(calls));
}

// ------------------------------- 7. a ceiling reached MID-batch, per block ----
// The room refuses up front when the budget is already gone. This is the other
// case: room for some of the batch but not all of it. Nobody's turn should take
// down anybody else's.
{
  const stateDir = mk('state2');
  const projectDir = mk('proj2');
  const provider = { name: 'mock', call: async () => ({ text: 'hi', cost: 0 }) };
  const room = roomAt(stateDir, projectDir, provider, { maxCalls: 2 });
  for (const n of ['ann', 'bob', 'cal']) await room.recruit({ name: n, model: `x/${n}`, system_prompt: n });

  const r = await room.ask({ names: ['ann', 'bob', 'cal'], message: 'q' });
  const errored = r.blocks.filter((b) => b.error);
  check(r.ok, 'the fan-out still returns');
  check(errored.length === 1, 'exactly one recruit is cut off by the ceiling', `errored=${errored.length}`);
  check(errored[0].budget_exhausted === true, 'their block is flagged as a budget refusal');
  check(/budget: session call ceiling reached/.test(errored[0].reply),
    'and reads as a budget error in the standard block', errored[0].reply);
  check(r.text.includes('[cal · error'), 'the refusal is rendered as that recruit\'s own error block',
    r.text.split('\n').filter((l) => l.startsWith('[')).join(' | '));
  check(r.blocks.filter((b) => !b.error).length === 2, 'the other two still answered');
}

// ------------------------------------------------------- 8. attribution -----
{
  const stateDir = mk('state3');
  const projectDir = mk('proj3');
  const provider = { name: 'mock', call: async () => ({ text: 'hi', cost: 0.01 }) };
  const room = roomAt(stateDir, projectDir, provider, { budget: 5 });
  await room.recruit({ name: 'ann', model: 'x/a', system_prompt: 'a' });
  await room.recruit({ name: 'bob', model: 'x/b', system_prompt: 'b' });
  await room.ask({ name: 'ann', message: 'q1' });
  await room.ask({ name: 'ann', message: 'q2' });
  await room.discuss({ names: ['ann', 'bob'], topic: 't', rounds: 1 });

  const logPath = path.join(stateDir, 'spend-log.jsonl');
  check(fs.existsSync(logPath), 'the attribution log is written to the state dir');
  const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check(log.length === 4, 'one line per provider call', String(log.length));
  check(log.every((e) => e.ts && e.who && e.why && typeof e.cost === 'number'),
    'each line carries who, why, cost and a timestamp', JSON.stringify(log[0]));
  check(log.filter((e) => e.who === 'ann').length === 3, 'attributed to the recruit that spent it');
  check(new Set(log.map((e) => e.why)).size === 1 || log.some((e) => e.why === 'ask'), 'and to what it was for');

  const rep = room.spend();
  check(rep.ok, 'spend() reports');
  const ann = rep.attribution.find((a) => a.who === 'ann');
  check(ann.calls === 3 && Math.abs(ann.cost - 0.03) < 1e-9, 'per-recruit calls and dollars', JSON.stringify(ann));
  check(rep.totals.calls === 4 && Math.abs(rep.totals.spent - 0.04) < 1e-9, 'session totals', JSON.stringify(rep.totals));
  check(rep.totals.cap === 5 && rep.totals.max_calls === room.maxCalls, 'against both ceilings', JSON.stringify(rep.totals));
  check(rep.text.includes('ann · 3 calls · $0.0300'), 'rendered per recruit', rep.text.split('\n')[2]);
  check(/of \$5\.00 cap/.test(rep.text) && /of 200 calls/.test(rep.text), 'and the totals line names both caps', rep.text.split('\n')[0]);
  check(rep.text.includes('spend-log.jsonl'), 'and points at the raw ledger');
}

// -------------------------------------- 9. auditions and judges attributed ---
{
  const stateDir = mk('state4');
  const projectDir = mk('proj4');
  const provider = { name: 'mock', call: async () => ({ text: 'I do not have that file.', cost: 0 }) };
  const room = roomAt(stateDir, projectDir, provider, { budget: 5 });
  await room.audition({ candidates: [{ model: 'a/one' }, { model: 'b/two' }], role_prompt: 'r' });

  const rep = room.spend();
  const whos = rep.attribution.map((a) => a.who);
  check(whos.join(',') === 'audition', 'audition spend is attributed under one label', whos.join(','));
  check(rep.attribution[0].calls === 2 && rep.attribution[0].why.audition === 2,
    'one logged call per probe, all for the audition', JSON.stringify(rep.attribution[0]));
  // The ledger label and the log label agree, so nothing shows up twice or as
  // "before this session".
  check(!rep.text.includes('before this session'),
    'the ledger and the log describe the same rows', rep.text);
  const log = fs.readFileSync(path.join(stateDir, 'spend-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check(log.map((e) => e.model).sort().join(',') === 'a/one,b/two',
    'and each line still names the model it probed', log.map((e) => e.model).join(','));
}

// ------------------------------------------------- 10. env compatibility -----
{
  const stateDir = mk('state5');
  const projectDir = mk('proj5');
  const room = roomAt(stateDir, projectDir, { name: 'mock', call: async () => ({ text: 'x', cost: 0 }) });
  await room.recruit({ name: 'ann', model: 'x/a', system_prompt: 'a' });
  check(room.budget === Number(process.env.PERSONA_RECRUITER_BUDGET_USD || '1.00'),
    'PERSONA_RECRUITER_BUDGET_USD still sets the dollar cap', String(room.budget));
  check(room.maxCalls === DEFAULT_MAX_CALLS, 'and the call ceiling defaults to 200', String(room.maxCalls));
  check(typeof room.overBudget() === 'boolean', 'overBudget() keeps its old shape for the Stop hook');
  check(room.roster().text.includes('of 200 calls'), 'the roster shows the call ceiling too', room.roster().text);
}

done();
