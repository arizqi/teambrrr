#!/usr/bin/env node
// discuss(): recruit-to-recruit rounds. Proves round 2 actually carries round 1,
// that one recruit erroring does not kill the round for the others, and that the
// budget / retry / fallback machinery is the same code path as ask().
import fs from 'node:fs';
import path from 'node:path';
import { check, done, SCRATCH } from './_harness.mjs';
import { createRoom } from '../core/room.mjs';
import { createEventLogSource } from '../core/digest/event-log.mjs';

const ROOT = path.join(SCRATCH, 'discuss-test');
fs.rmSync(ROOT, { recursive: true, force: true });
const mk = (...p) => { const d = path.join(ROOT, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

console.log('discuss() tests\n');

// Records every prompt it was handed so we can inspect what round 2 saw.
function recorder(replyFor) {
  const seen = [];
  return {
    seen,
    provider: {
      name: 'mock',
      call: async ({ name, model, messages }) => {
        const message = messages[messages.length - 1].content;
        const digest = String(messages.find((m) => m.__digest)?.content || '');
        seen.push({ name, model, message, digest });
        return { text: replyFor(name, message, seen), cost: 0, usage: { prompt_tokens: 0, completion_tokens: 0 } };
      }
    }
  };
}

const twoRecruits = async (room) => {
  await room.recruit({ name: 'alice', model: 'x/a', system_prompt: 'alice' });
  await room.recruit({ name: 'bob', model: 'x/b', system_prompt: 'bob' });
};

// ------------------------------------------------------- 1. two-round shape ---
{
  const stateDir = mk('state1');
  const projectDir = mk('proj1');
  const roundOf = (seen) => `R${seen.filter((s) => s.name === 'alice').length}`;
  const rec = recorder((name, msg, seen) => `${name.toUpperCase()}-SAYS-${roundOf(seen)}-${name === 'alice' ? 'SHARD-BY-TENANT' : 'SHARD-BY-REGION'}`);
  const room = createRoom({ stateDir, projectDir, provider: rec.provider, host: 'test', autoMigrate: false, digestSource: createEventLogSource(stateDir) });
  await twoRecruits(room);
  room.events.append({ author: 'user', role: 'user', text: 'CHANNEL-KICKOFF-LINE' });

  const r = await room.discuss({ names: ['alice', 'bob'], topic: 'how should we shard the orders table?' });

  check(r.ok && r.rounds === 2, 'discuss defaults to two rounds', JSON.stringify({ ok: r.ok, rounds: r.rounds }));
  check(r.blocks.length === 4, 'two recruits x two rounds = four blocks', `got ${r.blocks.length}`);
  check(r.blocks.every((b) => typeof b.round === 'number'), 'every block is tagged with its round');
  check(r.blocks.filter((b) => b.round === 1).length === 2 && r.blocks.filter((b) => b.round === 2).length === 2,
    'blocks split evenly across rounds');
  check(JSON.stringify(r.names) === JSON.stringify(['alice', 'bob']), 'the participant list comes back');

  // transcript shape: the existing ask blocks, grouped by round separators
  check(r.text.includes('— round 1 —') && r.text.includes('— round 2 —'), 'round separators are present', r.text.slice(0, 80));
  check(r.text.indexOf('— round 1 —') < r.text.indexOf('— round 2 —'), 'rounds appear in order');
  check(r.text.includes('[alice · x/a · $0.0000]') && r.text.includes('[bob · x/b · $0.0000]'),
    'blocks keep the existing [name · model · $cost] header', r.text.split('\n')[2]);
  const firstRound = r.text.slice(0, r.text.indexOf('— round 2 —'));
  check(firstRound.includes('ALICE-SAYS-R1') && firstRound.includes('BOB-SAYS-R1'), 'round 1 section holds round 1 replies');

  // THE point of the feature: round 2 inputs carry round 1 replies, by name
  const r2 = rec.seen.filter((s) => /ROUND 1 REPLIES/.test(s.message));
  check(r2.length === 2, 'both recruits got a round-2 prompt', `got ${r2.length}`);
  const bobsRound2 = r2.find((s) => s.name === 'bob').message;
  const alicesRound2 = r2.find((s) => s.name === 'alice').message;
  check(bobsRound2.includes('ALICE-SAYS-R1-SHARD-BY-TENANT'), "bob's round 2 contains alice's round-1 reply", bobsRound2.slice(0, 300));
  check(bobsRound2.includes('@alice:'), "alice's reply is attributed by name", bobsRound2.slice(0, 300));
  check(alicesRound2.includes('BOB-SAYS-R1-SHARD-BY-REGION') && alicesRound2.includes('@bob:'),
    "alice's round 2 contains bob's round-1 reply, attributed");
  check(/round 2 of 2/.test(bobsRound2), 'the round-2 prompt says which round it is');
  check(/agree|disagree|refine/i.test(bobsRound2), 'the round-2 prompt asks them to engage, not restate');

  // round 1 has no previous replies to leak
  const r1 = rec.seen.filter((s) => !/ROUND 1 REPLIES/.test(s.message));
  check(r1.every((s) => /round 1 of 2/.test(s.message)), 'round-1 prompts announce round 1');
  check(r1.every((s) => s.message.includes('how should we shard the orders table?')), 'the topic reaches every recruit');
  check(r1.every((s) => !s.message.includes('SAYS-R1')), 'round 1 carries no replies');

  // digest: built once, present in round 1
  check(rec.seen[0].digest.includes('CHANNEL-KICKOFF-LINE'), 'the channel digest reaches round 1', rec.seen[0].digest.slice(0, 120));

  // events: one per reply, plus a chair line per round
  const ev = room.events.tail(50);
  const replies = ev.filter((e) => e.role === 'assistant');
  check(replies.length === 4, 'one event appended per reply', `got ${replies.length}`);
  check(replies.every((e) => e.round === 1 || e.round === 2), 'reply events carry their round');
  check(ev.filter((e) => e.author === 'chair' && /— round/.test(e.text)).length === 2, 'one chair event per round');
}

// -------------------------------------------------- 2. an error in round 1 ---
{
  const stateDir = mk('state2');
  const projectDir = mk('proj2');
  const seen = [];
  const halfDead = {
    name: 'mock',
    call: async ({ name, model, messages }) => {
      const message = messages[messages.length - 1].content;
      seen.push({ name, message });
      // bob is broken for round 1 only; alice always answers
      if (name === 'bob' && !/ROUND 1 REPLIES/.test(message)) {
        const e = new Error('OpenRouter 401: bad key for bob');
        e.status = 401;
        throw e;
      }
      return { text: `${name.toUpperCase()}-OK`, cost: 0 };
    }
  };
  const room = createRoom({ stateDir, projectDir, provider: halfDead, host: 'test', autoMigrate: false, retryDelayMs: 5, digestSource: createEventLogSource(stateDir) });
  await twoRecruits(room);

  const r = await room.discuss({ names: ['alice', 'bob'], topic: 'ship on friday?' });
  check(r.ok, 'discuss still succeeds when one recruit fails a round');
  check(r.blocks.length === 4, 'the failed turn still produces a block', `got ${r.blocks.length}`);

  const bobR1 = r.blocks.find((b) => b.name === 'bob' && b.round === 1);
  check(bobR1.error && bobR1.model === 'error', "bob's round-1 failure is an error block", JSON.stringify(bobR1));
  check(r.text.includes('[bob · error · $n/a]'), 'the error block renders in the transcript', r.text.slice(0, 200));

  // round 2 ran anyway, for both of them
  const round2 = r.blocks.filter((b) => b.round === 2);
  check(round2.length === 2, "round 2 ran for everyone despite bob's round-1 error", `got ${round2.length}`);
  check(round2.every((b) => !b.error), 'round 2 succeeded for both');
  const bobsRound2 = seen.find((s) => s.name === 'bob' && /ROUND 1 REPLIES/.test(s.message)).message;
  check(bobsRound2.includes('ALICE-OK'), "bob's round 2 still carries alice's round-1 reply", bobsRound2.slice(0, 200));
  check(!bobsRound2.includes('bad key for bob'), 'the error text is not fed back as if it were a reply');

  // everyone failing stops the discussion instead of looping
  const allDead = { name: 'mock', call: async () => { const e = new Error('OpenRouter 401: nope'); e.status = 401; throw e; } };
  const room2 = createRoom({ stateDir, projectDir, provider: allDead, host: 'test', autoMigrate: false, retryDelayMs: 5, digestSource: createEventLogSource(stateDir) });
  const dead = await room2.discuss({ names: ['alice', 'bob'], topic: 'anything' });
  check(dead.blocks.length === 2 && dead.blocks.every((b) => b.error), 'a fully dead round 1 stops the discussion', `got ${dead.blocks.length}`);
  check(/every recruit errored/.test(dead.text), 'the transcript says why it stopped', dead.text.slice(-120));
}

// ----------------------------------------------------- 3. rounds + options ---
{
  const stateDir = mk('state3');
  const projectDir = mk('proj3');
  const rec = recorder((name) => `${name}-reply`);
  const room = createRoom({ stateDir, projectDir, provider: rec.provider, host: 'test', autoMigrate: false, digestSource: createEventLogSource(stateDir) });
  await twoRecruits(room);
  await room.recruit({ name: 'carol', model: 'x/c', system_prompt: 'carol' });
  room.events.append({ author: 'user', role: 'user', text: 'CHANNEL-KICKOFF-LINE' });

  const three = await room.discuss({ names: ['alice', 'bob', 'carol'], topic: 't', rounds: 3 });
  check(three.blocks.length === 9, 'three recruits x three rounds = nine blocks', `got ${three.blocks.length}`);
  check(three.text.includes('— round 3 —'), 'the third round separator is present');

  const one = await room.discuss({ names: ['alice', 'bob'], topic: 't', rounds: 1 });
  check(one.blocks.length === 2 && !one.text.includes('— round 2 —'), 'rounds:1 runs a single round');

  const clamped = await room.discuss({ names: ['alice', 'bob'], topic: 't', rounds: 99 });
  check(clamped.rounds === 5, 'rounds is clamped to 5', `got ${clamped.rounds}`);

  rec.seen.length = 0;
  await room.discuss({ names: ['alice', 'bob'], topic: 't', rounds: 1, digest: false });
  check(rec.seen.every((s) => !s.digest.includes('CHANNEL-KICKOFF-LINE')), 'digest:false suppresses the channel transcript');
  check(rec.seen.every((s) => s.digest.includes('no channel transcript')), 'digest:false sends the no-digest marker', rec.seen[0].digest);

  // duplicate names collapse
  const dup = await room.discuss({ names: ['alice', '@alice', 'bob'], topic: 't', rounds: 1 });
  check(dup.blocks.length === 2, 'duplicate and @-prefixed names collapse to one participant each', `got ${dup.blocks.length}`);
}

// -------------------------------------------------------- 4. input guards ----
{
  const stateDir = mk('state4');
  const projectDir = mk('proj4');
  const rec = recorder(() => 'ok');
  const room = createRoom({ stateDir, projectDir, provider: rec.provider, host: 'test', autoMigrate: false, digestSource: createEventLogSource(stateDir) });
  await twoRecruits(room);

  const solo = await room.discuss({ names: ['alice'], topic: 't' });
  check(solo.ok === false && /at least two/.test(solo.text), 'a one-person discussion is refused', solo.text);
  const noTopic = await room.discuss({ names: ['alice', 'bob'] });
  check(noTopic.ok === false && /needs a topic/.test(noTopic.text), 'a topicless discussion is refused', noTopic.text);
  const ghost = await room.discuss({ names: ['alice', 'ghost'], topic: 't' });
  check(ghost.ok === false && /no recruit named "ghost"/.test(ghost.text), 'an unknown participant is refused up front', ghost.text);
  check(rec.seen.length === 0, 'a refused discussion spends nothing');
}

// --------------------------------------------------- 5. budget + fallback ----
{
  const stateDir = mk('state5');
  const projectDir = mk('proj5');
  const paid = { name: 'mock', call: async () => ({ text: 'pricey', cost: 0.3 }) };
  const room = createRoom({ stateDir, projectDir, provider: paid, host: 'test', autoMigrate: false, budget: 1.0, digestSource: createEventLogSource(stateDir) });
  await twoRecruits(room);

  const first = await room.discuss({ names: ['alice', 'bob'], topic: 't', rounds: 2 });
  check(first.ok && first.blocks.length === 4, 'the first discussion runs inside the cap');
  check(room.roster().text.includes('of $1.00 cap'), 'spend is tracked as usual');

  const blocked = await room.discuss({ names: ['alice', 'bob'], topic: 't' });
  check(blocked.ok === false && /spend cap reached/.test(blocked.text), 'discuss refuses once the cap is spent', blocked.text);

  // a discussion already under way stops between rounds rather than overrunning
  const stateDir2 = mk('state5b');
  const room2 = createRoom({ stateDir: stateDir2, projectDir, provider: paid, host: 'test', autoMigrate: false, budget: 0.7, digestSource: createEventLogSource(stateDir2) });
  await room2.recruit({ name: 'alice', model: 'x/a', system_prompt: 'a' });
  await room2.recruit({ name: 'bob', model: 'x/b', system_prompt: 'b' });
  const cut = await room2.discuss({ names: ['alice', 'bob'], topic: 't', rounds: 4 });
  check(cut.blocks.length < 8, 'a long discussion is cut short by the cap', `got ${cut.blocks.length}`);
  check(/spend cap reached/.test(cut.text), 'the transcript says the cap stopped it', cut.text.slice(-140));

  // retry/fallback is shared with ask
  const calls = [];
  const flaky = {
    name: 'mock',
    call: async ({ model }) => {
      calls.push(model);
      if (model === 'free/primary') { const e = new Error('OpenRouter 429: slow down'); e.status = 429; throw e; }
      return { text: 'from backup', cost: 0 };
    }
  };
  const stateDir3 = mk('state5c');
  const room3 = createRoom({ stateDir: stateDir3, projectDir, provider: flaky, host: 'test', autoMigrate: false, retryDelayMs: 5, digestSource: createEventLogSource(stateDir3) });
  await room3.recruit({ name: 'flake', model: 'free/primary', system_prompt: 'p', fallback_model: 'paid/backup' });
  await room3.recruit({ name: 'steady', model: 'paid/backup', system_prompt: 's' });
  const fb = await room3.discuss({ names: ['flake', 'steady'], topic: 't', rounds: 1 });
  const flakeBlock = fb.blocks.find((b) => b.name === 'flake');
  check(flakeBlock.model === 'paid/backup' && flakeBlock.reply === 'from backup',
    'discuss reuses the 429 retry + fallback path', JSON.stringify(flakeBlock));
  check(calls.filter((m) => m === 'free/primary').length === 2, 'the primary was retried once before falling back', JSON.stringify(calls));
}

done();
