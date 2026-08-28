#!/usr/bin/env node
// show_persona / update_persona / rollback_persona: the recruiting manager.
//
// The prompt you wrote before you saw a recruit work is rarely the prompt you
// want afterwards, so the persona is editable — and therefore versioned. Two
// invariants are load-bearing and are what most of this file checks: the
// revision chain is append-only (a rollback moves *forward*, carrying old
// content), and memory is never collateral damage of an edit.
import fs from 'node:fs';
import path from 'node:path';
import { check, done, SCRATCH } from './_harness.mjs';
import { createRoom } from '../core/room.mjs';
import { createEventLogSource } from '../core/digest/event-log.mjs';

const ROOT = path.join(SCRATCH, 'persona-test');
fs.rmSync(ROOT, { recursive: true, force: true });
const mk = (...p) => { const d = path.join(ROOT, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

console.log('persona lifecycle tests\n');

const P1 = 'You are an SDR. You book qualified meetings.';
const P2 = 'You are an SDR. You book qualified meetings, and you never invent a company detail.';
const P3 = 'You are an SDR. Lead with the trigger event. Three sentences, one ask.';

async function freshRoom(tag, opts = {}) {
  const stateDir = mk(tag, 'state');
  const projectDir = mk(tag, 'proj');
  const provider = { name: 'mock', call: async () => ({ text: 'ok', cost: 0 }) };
  const room = createRoom({
    stateDir, projectDir, provider, host: 'test', autoMigrate: false,
    digestSource: createEventLogSource(stateDir), ...opts
  });
  return { room, stateDir, projectDir };
}

const revPath = (stateDir, name, n) => path.join(stateDir, 'recruits', name, 'revisions', `${n}.json`);
const historyPath = (stateDir, name) => path.join(stateDir, 'recruits', name, 'history.jsonl');

// ------------------------------------------------------ 1. a hire is rev 1 ---
{
  const { room, stateDir } = await freshRoom('one');
  await room.recruit({ name: 'sdr', model: 'a/one', system_prompt: P1, tags: ['sales'] });

  const shown = room.showPersona({ name: 'sdr' });
  check(shown.ok && shown.revision === 1, 'a fresh hire is revision 1', String(shown.revision));
  check(shown.revisions.join(',') === '1', 'with a chain of exactly one', shown.revisions.join(','));
  check(shown.persona.system_prompt === P1, 'showing returns the prompt it was hired with');
  check(typeof shown.persona.updated_at === 'string', 'and an updated_at');
  check(!fs.existsSync(path.join(stateDir, 'recruits', 'sdr', 'revisions')),
    'no revisions directory exists until something is superseded');

  check(shown.text.includes(P1), 'the rendered text carries the whole prompt');
  check(shown.text.includes('@sdr · rev 1 (current)'), 'the header names the revision', shown.text.split('\n')[0]);
  check(shown.text.includes('revisions: rev 1 (current)'), 'the revision list is one line', shown.text.split('\n').find((l) => l.startsWith('revisions:')));
  check(shown.text.includes('model: a/one'), 'the binding is shown');
  check(shown.text.includes('tags: [sales]'), 'the tags are shown');

  // an @ prefix is tolerated, as everywhere else in the room
  check(room.showPersona({ name: '@sdr' }).ok, 'an @-prefixed handle works');
  check(room.showPersona({ name: 'nobody' }).ok === false, 'an unknown recruit is refused');
}

// ------------------------------------------ 2. a long prompt is not truncated ---
{
  const { room } = await freshRoom('long');
  const LONG = Array.from({ length: 200 }, (_, i) => `Line ${i}: a specific instruction that must survive display.`).join('\n');
  await room.recruit({ name: 'sdr', model: 'a/one', system_prompt: LONG });

  const t = room.showPersona({ name: 'sdr' }).text;
  check(t.includes('Line 0:') && t.includes('Line 199:'), 'the first and last lines both survive', String(t.length));
  check(!/…|\.\.\.\s*\(truncated/.test(t), 'nothing is elided — the point of showing a prompt is reading it');
  check(t.includes(LONG), 'the prompt appears verbatim, in one piece');
}

// ------------------------------------------------------------- 3. updating ---
{
  const { room, stateDir } = await freshRoom('update');
  await room.recruit({ name: 'sdr', model: 'a/one', fallback_model: 'a/backup', system_prompt: P1, tags: ['sales'], params: { temperature: 0.4 } });

  // give them some memory to protect
  await room.ask({ name: 'sdr', message: 'first exchange' });
  await room.ask({ name: 'sdr', message: 'second exchange' });
  const memBefore = fs.readFileSync(historyPath(stateDir, 'sdr'), 'utf8');
  check(memBefore.split('\n').filter(Boolean).length === 2, 'two exchanges are on record before the edit');

  const up = await room.updatePersona({ name: 'sdr', system_prompt: P2 });
  check(up.ok && up.revision === 2 && up.from === 1, 'an update bumps the revision', JSON.stringify({ r: up.revision, f: up.from }));
  check(up.changed.join(',') === 'system_prompt', 'and reports what changed', up.changed.join(','));

  // the superseded copy is on disk, under its own number
  check(fs.existsSync(revPath(stateDir, 'sdr', 1)), 'the superseded revision is snapshotted');
  const snap = JSON.parse(fs.readFileSync(revPath(stateDir, 'sdr', 1), 'utf8'));
  check(snap.system_prompt === P1, 'the snapshot holds the OLD prompt', snap.system_prompt);
  check(snap.revision === 1, 'and is numbered as the revision it was', String(snap.revision));
  check(!('__root' in snap) && !('__scope' in snap), 'internal bookkeeping never reaches disk', Object.keys(snap).join(','));
  check(!fs.existsSync(revPath(stateDir, 'sdr', 2)), 'the current revision is not also duplicated into the chain');

  // current is the new one
  const now = room.showPersona({ name: 'sdr' });
  check(now.persona.system_prompt === P2 && now.revision === 2, 'the current persona is the new one');
  check(now.revisions.join(',') === '1,2', 'the chain now has two links', now.revisions.join(','));
  check(now.text.includes('revisions: rev 2 (current) · rev 1'),
    'the revision list reads newest first with the current one marked', now.text.split('\n').find((l) => l.startsWith('revisions:')));

  // partial update: everything not named is left alone
  check(now.persona.model === 'a/one', 'the model is untouched by a prompt-only update');
  check(now.persona.fallback_model === 'a/backup', 'the fallback is untouched');
  check(now.persona.tags.join(',') === 'sales', 'the tags are untouched');
  check(now.persona.params.temperature === 0.4, 'the params are untouched');
  check(now.persona.created_at === snap.created_at, 'created_at still records the hire, not the edit');
  check(now.persona.updated_at !== snap.updated_at, 'updated_at moves with the edit');

  // memory is not collateral damage
  check(fs.readFileSync(historyPath(stateDir, 'sdr'), 'utf8') === memBefore,
    'history.jsonl is byte-for-byte unchanged by the edit');
  check(room.store.readHistory('sdr', 10).length === 2, 'the recruit still remembers both exchanges');
  check(/Memory is untouched/.test(up.text), 'and the operator is told so', up.text);

  // the event log records it
  const ev = room.events.tail(50).filter((e) => /persona updated rev/.test(e.text || ''));
  check(ev.length === 1, 'one event per update', String(ev.length));
  check(ev[0].text === 'persona updated rev 2: @sdr (system_prompt)', 'the event names the revision and the fields', ev[0].text);
  check(ev[0].host === 'test', 'tagged with the host that made the change', ev[0].host);
}

// --------------------------------------------------- 4. updating each field ---
{
  const { room } = await freshRoom('fields');
  await room.recruit({ name: 'sdr', model: 'a/one', fallback_model: 'a/backup', system_prompt: P1, tags: ['sales'] });

  const t = await room.updatePersona({ name: 'sdr', tags: ['sales', 'outbound'] });
  check(t.ok && room.showPersona({ name: 'sdr' }).persona.tags.join(',') === 'sales,outbound', 'tags can be replaced');
  check(room.showPersona({ name: 'sdr' }).persona.system_prompt === P1, 'without disturbing the prompt');

  const m = await room.updatePersona({ name: 'sdr', model: 'b/two', fallback_model: 'b/backup' });
  check(m.ok && m.changed.join(',') === 'model,fallback_model', 'the binding can be changed', m.changed.join(','));
  check(room.showPersona({ name: 'sdr' }).persona.model === 'b/two', 'and the new model sticks');

  const p = await room.updatePersona({ name: 'sdr', params: { temperature: 0.9, max_tokens: 500 } });
  check(p.ok && room.showPersona({ name: 'sdr' }).persona.params.max_tokens === 500, 'params can be set');

  const clear = await room.updatePersona({ name: 'sdr', fallback_model: '' });
  check(clear.ok && !('fallback_model' in room.showPersona({ name: 'sdr' }).persona),
    'an empty fallback_model clears it rather than setting an empty one',
    JSON.stringify(room.showPersona({ name: 'sdr' }).persona.fallback_model));

  const shown = room.showPersona({ name: 'sdr' });
  check(shown.revision === 5, 'four edits took it to revision 5', String(shown.revision));
  check(shown.revisions.join(',') === '1,2,3,4,5', 'every step is in the chain', shown.revisions.join(','));

  // guards
  const none = await room.updatePersona({ name: 'sdr' });
  check(none.ok === false && /at least one of/.test(none.text), 'an update with no fields is refused', none.text);
  check(room.showPersona({ name: 'sdr' }).revision === 5, 'and does not burn a revision');

  const ghost = await room.updatePersona({ name: 'nobody', system_prompt: 'x' });
  check(ghost.ok === false && /never creates/.test(ghost.text), 'updating a non-existent recruit never creates one', ghost.text);
  check(room.roster().recruits.length === 1, 'the roster is unchanged by the refusal');

  const blank = await room.updatePersona({ name: 'sdr', system_prompt: '   ' });
  check(blank.ok === false, 'a whitespace-only prompt is not an update', blank.text);
}

// --------------------------------------------- 5. model validation on update ---
{
  // A provider that is not 'mock' makes the room consult the catalog, exactly as
  // recruit() does — a typo'd model must fail at the edit, not at the next ask.
  const { room, stateDir } = await freshRoom('validate', { provider: { name: 'openrouter', call: async () => ({ text: 'ok', cost: 0 }) } });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'models-cache.json'), JSON.stringify({
    fetched_at: Date.now(),
    models: {
      'a/one': { pricing: { prompt: '0.0000001', completion: '0.0000002' } },
      'b/two': { pricing: { prompt: '0.000001', completion: '0.000002' } }
    }
  }));

  await room.recruit({ name: 'sdr', model: 'a/one', system_prompt: P1 });
  check(room.showPersona({ name: 'sdr' }).revision === 1, 'hired against the catalog');

  const bad = await room.updatePersona({ name: 'sdr', model: 'typo/nope' });
  check(bad.ok === false && /unknown OpenRouter model/.test(bad.text), 'an unknown model is refused on update', bad.text);
  check(room.showPersona({ name: 'sdr' }).model === undefined || room.showPersona({ name: 'sdr' }).persona.model === 'a/one',
    'the binding is unchanged after a refused update');
  check(room.showPersona({ name: 'sdr' }).revision === 1, 'a refused update burns no revision', String(room.showPersona({ name: 'sdr' }).revision));
  check(!fs.existsSync(revPath(stateDir, 'sdr', 1)), 'and snapshots nothing');

  const badFb = await room.updatePersona({ name: 'sdr', fallback_model: 'typo/nope' });
  check(badFb.ok === false && /unknown fallback_model/.test(badFb.text), 'an unknown fallback is refused too', badFb.text);

  const good = await room.updatePersona({ name: 'sdr', model: 'b/two' });
  check(good.ok && room.showPersona({ name: 'sdr' }).persona.model === 'b/two', 'a known model is accepted', good.text);

  // a prompt-only edit needs no catalog at all
  const promptOnly = await room.updatePersona({ name: 'sdr', system_prompt: P3 });
  check(promptOnly.ok, 'a prompt-only edit does not consult the catalog', promptOnly.text);
}

// -------------------------------------------------- 6. historical revisions ---
{
  const { room } = await freshRoom('history');
  await room.recruit({ name: 'sdr', model: 'a/one', system_prompt: P1 });
  await room.updatePersona({ name: 'sdr', system_prompt: P2 });
  await room.updatePersona({ name: 'sdr', system_prompt: P3 });

  const cur = room.showPersona({ name: 'sdr' });
  check(cur.revision === 3 && cur.persona.system_prompt === P3, 'current is rev 3');

  const old = room.showPersona({ name: 'sdr', revision: 1 });
  check(old.ok && old.revision === 1, 'a past revision can be read back', String(old.revision));
  check(old.persona.system_prompt === P1, 'and holds what it held at the time', old.persona.system_prompt);
  check(old.current === 3, 'while still reporting what current is', String(old.current));
  check(old.text.includes('rev 1 (historical; current is rev 3)'),
    'the header says plainly that this is not the live prompt', old.text.split('\n')[0]);
  check(old.text.includes(P1) && !old.text.includes(P3), 'the historical prompt is shown, not the current one');
  check(old.text.includes('— system prompt (rev 1) —'), 'and the section is labelled with its revision');

  const mid = room.showPersona({ name: 'sdr', revision: 2 });
  check(mid.persona.system_prompt === P2, 'the middle revision is readable too');

  const nope = room.showPersona({ name: 'sdr', revision: 9 });
  check(nope.ok === false && /no revision 9/.test(nope.text), 'an out-of-range revision is refused', nope.text);
  check(/have 1, 2, 3/.test(nope.text), 'and the refusal lists what exists', nope.text);
  check(room.showPersona({ name: 'sdr', revision: 3 }).revision === 3, 'asking for the current number by hand works');
}

// -------------------------------------------------------------- 7. rollback ---
{
  const { room, stateDir } = await freshRoom('rollback');
  await room.recruit({ name: 'sdr', model: 'a/one', system_prompt: P1, tags: ['sales'] });
  await room.ask({ name: 'sdr', message: 'an exchange to protect' });
  await room.updatePersona({ name: 'sdr', system_prompt: P2 });
  await room.updatePersona({ name: 'sdr', system_prompt: P3, tags: ['sales', 'outbound'] });
  const memBefore = fs.readFileSync(historyPath(stateDir, 'sdr'), 'utf8');

  const back = room.rollbackPersona({ name: 'sdr', revision: 1 });
  check(back.ok, 'a rollback succeeds', back.text);
  check(back.revision === 4, 'and lands as a NEW revision, not by rewinding', String(back.revision));
  check(back.restored === 1 && back.from === 3, 'reporting what it restored and what it left', JSON.stringify({ r: back.restored, f: back.from }));

  const now = room.showPersona({ name: 'sdr' });
  check(now.persona.system_prompt === P1, 'the old prompt is live again', now.persona.system_prompt);
  check(now.persona.tags.join(',') === 'sales', 'and so are the other fields of that revision', now.persona.tags.join(','));
  check(now.revision === 4, 'at revision 4');
  check(now.revisions.join(',') === '1,2,3,4', 'the chain grew rather than shrank — nothing was erased', now.revisions.join(','));
  check(now.persona.rolled_back_from === 1, 'the persona records where it came from', String(now.persona.rolled_back_from));
  check(now.text.includes('rolled back from rev 1'), 'and the rendering says so', now.text);

  // the revision we left is preserved, so you can roll forward again
  check(fs.existsSync(revPath(stateDir, 'sdr', 3)), 'the abandoned revision is kept on disk');
  check(JSON.parse(fs.readFileSync(revPath(stateDir, 'sdr', 3), 'utf8')).system_prompt === P3,
    'with its contents intact');
  const forward = room.rollbackPersona({ name: 'sdr', revision: 3 });
  check(forward.ok && room.showPersona({ name: 'sdr' }).persona.system_prompt === P3,
    'so you can roll forward again after changing your mind twice', forward.text);
  check(room.showPersona({ name: 'sdr' }).revision === 5, 'as revision 5');
  check(room.showPersona({ name: 'sdr' }).persona.rolled_back_from === 3, 'the marker updates rather than accumulating');

  // a plain update after a rollback clears the marker
  await room.updatePersona({ name: 'sdr', system_prompt: P2 });
  check(!('rolled_back_from' in room.showPersona({ name: 'sdr' }).persona),
    'an ordinary edit is not a rollback and does not claim to be');

  // memory survives all of it
  check(fs.readFileSync(historyPath(stateDir, 'sdr'), 'utf8') === memBefore, 'history.jsonl survives rollbacks untouched');

  // guards
  const same = room.rollbackPersona({ name: 'sdr', revision: room.showPersona({ name: 'sdr' }).revision });
  check(same.ok === false && /already at rev/.test(same.text), 'rolling back to the current revision is refused', same.text);
  const oob = room.rollbackPersona({ name: 'sdr', revision: 99 });
  check(oob.ok === false && /no revision 99/.test(oob.text), 'an out-of-range rollback is refused', oob.text);
  const ghost = room.rollbackPersona({ name: 'nobody', revision: 1 });
  check(ghost.ok === false, 'rolling back an unknown recruit is refused');

  const ev = room.events.tail(80).filter((e) => /rolled back to rev/.test(e.text || ''));
  check(ev.length === 2, 'each rollback is an event', String(ev.length));
  check(/^persona updated rev \d+: @sdr rolled back to rev \d+$/.test(ev[0].text), 'shaped like the other persona events', ev[0].text);
}

// ------------------------------------------- 8. the edit reaches the recruit ---
{
  // An edited persona has to actually change what gets sent, or the whole
  // feature is theatre.
  const seen = [];
  const stateDir = mk('effect', 'state');
  const projectDir = mk('effect', 'proj');
  const provider = { name: 'mock', call: async ({ messages }) => { seen.push(messages[0].content); return { text: 'ok', cost: 0 }; } };
  const room = createRoom({ stateDir, projectDir, provider, host: 'test', autoMigrate: false, digestSource: createEventLogSource(stateDir) });

  await room.recruit({ name: 'sdr', model: 'a/one', system_prompt: P1 });
  await room.ask({ name: 'sdr', message: 'q1' });
  check(seen[0].includes(P1), 'the first ask uses the hired prompt');

  await room.updatePersona({ name: 'sdr', system_prompt: P3 });
  await room.ask({ name: 'sdr', message: 'q2' });
  check(seen[1].includes(P3), 'the next ask uses the edited prompt', seen[1].slice(0, 80));
  check(!seen[1].includes(P1), 'and not the old one');

  room.rollbackPersona({ name: 'sdr', revision: 1 });
  await room.ask({ name: 'sdr', message: 'q3' });
  check(seen[2].includes(P1), 'and a rollback puts the old prompt back on the wire', seen[2].slice(0, 80));
  check(room.store.readHistory('sdr', 10).length === 3, 'all three exchanges are remembered across both edits');
}

// ------------------------------------------ 9. legacy personas have no field ---
{
  // Personas written before revisions existed carry neither `revision` nor
  // `updated_at`. They are revision 1 by definition rather than a crash.
  const { room, stateDir } = await freshRoom('legacy');
  const dir = path.join(stateDir, 'recruits', 'old');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({
    name: 'old', model: 'a/one', system_prompt: P1, tags: [], params: {}, created_at: '2026-01-01T00:00:00.000Z'
  }, null, 2));

  const shown = room.showPersona({ name: 'old' });
  check(shown.ok && shown.revision === 1, 'a persona with no revision field reads as revision 1', String(shown.revision));
  check(shown.text.includes('updated 2026-01-01'), 'and falls back to created_at for the timestamp', shown.text.split('\n')[0]);

  const up = await room.updatePersona({ name: 'old', system_prompt: P2 });
  check(up.ok && up.revision === 2, 'and can be edited into revision 2', String(up.revision));
  check(JSON.parse(fs.readFileSync(revPath(stateDir, 'old', 1), 'utf8')).system_prompt === P1,
    'snapshotting it preserves the original');
}

done();
