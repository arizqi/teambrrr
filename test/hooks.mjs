#!/usr/bin/env node
// Claude Code harness hooks: SessionStart, UserPromptSubmit, Stop.
//
// Every hook is exercised the way the harness runs it — a fresh `node` process
// fed fixture JSON on stdin — because the failure modes that matter (a throw, a
// non-zero exit, stray stdout) only exist at the process boundary.
//
// No network: the provider is forced to mock and PERSONA_RECRUITER_MOCK_TEXT
// pins the watcher's reply so both branches of the Stop flow are reachable.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, done, SCRATCH } from './_harness.mjs';
import { createRoom } from '../core/room.mjs';
import { createEventLogSource } from '../core/digest/event-log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.join(HERE, '..', 'hooks');
const SESSION_START = path.join(HOOKS, 'session-start.mjs');
const UPS = path.join(HOOKS, 'user-prompt-submit.mjs');
const STOP = path.join(HOOKS, 'stop.mjs');

const ROOT = path.join(SCRATCH, 'hooks-test');
fs.rmSync(ROOT, { recursive: true, force: true });
const mk = (...p) => { const d = path.join(ROOT, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

console.log('harness hook tests\n');

function run(file, input, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PERSONA_RECRUITER_PROVIDER: 'mock', OPENROUTER_API_KEY: '', ...env }
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ out, err, code }));
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

const ctx = (r) => {
  try { return JSON.parse(r.out)?.hookSpecificOutput?.additionalContext || ''; }
  catch { return ''; }
};
const evt = (r) => {
  try { return JSON.parse(r.out)?.hookSpecificOutput?.hookEventName || null; }
  catch { return null; }
};

// A room bound to a scratch state dir, used to set the fixture up.
const roomAt = (stateDir, projectDir) => createRoom({
  stateDir, projectDir, host: 'test', autoMigrate: false,
  provider: { name: 'mock', call: async () => ({ text: 'ok', cost: 0 }) },
  digestSource: createEventLogSource(stateDir)
});

// ------------------------------------------------------- 1. SessionStart -----
{
  const stateDir = mk('ss-state');
  const projectDir = mk('ss-proj');
  const env = { ROOM_STATE_DIR: stateDir };
  const input = { session_id: 's1', transcript_path: '/nope.jsonl', cwd: projectDir, hook_event_name: 'SessionStart' };

  const empty = await run(SESSION_START, input, env);
  check(empty.code === 0, 'SessionStart exits 0 with an empty room');
  check(empty.out === '', 'and stays silent — an empty room costs nothing', JSON.stringify(empty.out));

  const room = roomAt(stateDir, projectDir);
  await room.recruit({ name: 'reviewer', model: 'anthropic/claude-3.5-haiku', system_prompt: 'r', tags: ['review', 'security'] });
  await room.recruit({ name: 'drafter', model: 'openai/gpt-4o-mini', system_prompt: 'd', watch: true });

  const bare = await run(SESSION_START, input, env);
  check(bare.code === 0 && evt(bare) === 'SessionStart', 'SessionStart emits hookSpecificOutput with its own event name', bare.out.slice(0, 120));
  const c = ctx(bare);
  check(/Room active/.test(c), 'the context says the room is active', c.split('\n')[0]);
  check(/@name/.test(c) && /roster/.test(c), 'and how to reach it (@name, roster)');
  check(c.includes('- reviewer · anthropic/claude-3.5-haiku · review, security'), 'one roster line per recruit: name · model · tags', c);
  check(c.includes('- drafter · openai/gpt-4o-mini · watching'), 'a watching recruit is marked as such', c);
  check(!c.includes('PINNED ROOM CONTEXT'), 'no pin block while the board is empty');

  room.pin({ text: 'Ship Postgres, not Dynamo.', by: 'ashar' });
  const withPins = ctx(await run(SESSION_START, input, env));
  check(withPins.includes('PINNED ROOM CONTEXT:\n- Ship Postgres, not Dynamo. — ashar'), 'the pin board is injected under its header', withPins);

  const sess = JSON.parse(fs.readFileSync(path.join(projectDir, '.room', 'session.json'), 'utf8'));
  check(typeof sess.pins_hash === 'string' && sess.pins_hash.length > 0, 'SessionStart records the pin hash it showed');
  check(sess.transcript_path === '/nope.jsonl', 'and keeps the transcript pointer');

  const garbage = await run(SESSION_START, 'not json at all', env);
  check(garbage.code === 0 && garbage.err === '', 'SessionStart survives garbage stdin', garbage.err);
  const noStdin = await run(SESSION_START, '', env);
  check(noStdin.code === 0, 'and empty stdin');
}

// -------------------------------------------------- 2. UserPromptSubmit ------
{
  const stateDir = mk('ups-state');
  const projectDir = mk('ups-proj');
  const env = { ROOM_STATE_DIR: stateDir };
  const transcript = path.join(projectDir, 'fake.jsonl');
  fs.writeFileSync(transcript, '');
  const input = (prompt) => ({
    session_id: 'ups-1', transcript_path: transcript, cwd: projectDir,
    hook_event_name: 'UserPromptSubmit', prompt
  });

  // no recruits: the pointer is still written, but nothing is injected
  const none = await run(UPS, input('@alpha hello'), env);
  check(none.code === 0 && none.out === '', 'UPS is silent with no recruits at all', JSON.stringify(none.out));
  check(JSON.parse(fs.readFileSync(path.join(projectDir, '.room', 'session.json'), 'utf8')).transcript_path === transcript,
    'but the session pointer is written regardless — the digest depends on it');
  check(JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'recruits', '.session'), 'utf8')).transcript_path === transcript,
    'and the legacy pointer too');

  const room = roomAt(stateDir, projectDir);
  await room.recruit({ name: 'alpha', model: 'x/a', system_prompt: 'a' });
  await room.recruit({ name: 'beta', model: 'x/b', system_prompt: 'b' });

  // --- the @-routing contract, unchanged ---
  const routed = await run(UPS, input('@alpha hello there'), env);
  check(routed.code === 0, 'UPS exits 0');
  check(evt(routed) === 'UserPromptSubmit', 'UPS emits hookSpecificOutput');
  const rc = ctx(routed);
  check(/The user addressed recruit\(s\) alpha\./.test(rc), 'additionalContext names alpha', rc.slice(0, 80));
  check(/\["alpha"\]/.test(rc), 'additionalContext carries the names array');
  check(/re-post each recruit's reply VERBATIM/i.test(rc), 'and the verbatim re-post rule');
  check(rc.startsWith('The user addressed recruit(s)'), 'the routing instruction still comes first');

  const both = ctx(await run(UPS, input('@alpha and @beta, thoughts?'), env));
  check(/\["alpha", "beta"\]/.test(both), 'several mentions route together', both.slice(0, 90));
  const unknown = ctx(await run(UPS, input('@nobody hi'), env));
  check(!/addressed recruit/.test(unknown), 'an unknown @handle does not route');

  // --- the new room-state line ---
  check(/\[room\] recruits: alpha, beta · pins: 0/.test(rc), 'a compact room-state line rides along', rc);
  const quiet = ctx(await run(UPS, input('no mentions here'), env));
  check(/\[room\] recruits: alpha, beta · pins: 0/.test(quiet), 'and appears without any @mention too', quiet);
  check(!/addressed recruit/.test(quiet), 'while no routing instruction is invented');

  // --- pins are re-injected only when they change ---
  const p1 = room.pin({ text: 'PIN-ONE' });
  const afterPin = ctx(await run(UPS, input('anything'), env));
  check(afterPin.includes('PINNED ROOM CONTEXT:\n- PIN-ONE'), 'a new pin brings the full board back', afterPin);
  check(/pins: 1/.test(afterPin), 'and the count moves');
  const unchanged = ctx(await run(UPS, input('anything'), env));
  check(!unchanged.includes('PINNED ROOM CONTEXT'), 'an unchanged board is not repeated');
  check(/pins: 1/.test(unchanged), 'though the count line still reports it');
  room.pin({ text: 'PIN-TWO' });
  const changed = ctx(await run(UPS, input('anything'), env));
  check(changed.includes('- PIN-ONE') && changed.includes('- PIN-TWO'), 'another pin brings it back again', changed);
  room.unpin({ id: p1.id });
  const afterUnpin = ctx(await run(UPS, input('anything'), env));
  check(afterUnpin.includes('PINNED ROOM CONTEXT') && !afterUnpin.includes('PIN-ONE'), 'an unpin counts as a change too', afterUnpin);

  // --- the watch inbox is injected and cleared ---
  const inbox = path.join(projectDir, '.room', 'watch-inbox.md');
  fs.writeFileSync(inbox, '## watchers · now\n[eye · x/e · $0.0000]\nThe migration has no rollback.\n');
  const delivered = ctx(await run(UPS, input('carry on'), env));
  check(/WATCHERS — recruits reviewing your last turn:/.test(delivered), 'a parked watcher comment is injected', delivered);
  check(delivered.includes('The migration has no rollback.'), 'with the comment body');
  check(!fs.existsSync(inbox), 'and the inbox is cleared, so it is delivered exactly once');
  const after = ctx(await run(UPS, input('carry on'), env));
  check(!/WATCHERS/.test(after), 'the next prompt does not see it again');

  const garbage = await run(UPS, 'not json at all', env);
  check(garbage.code === 0, 'UPS survives garbage stdin');
}

// --------------------------------------------------------------- 3. Stop ----
{
  const stateDir = mk('stop-state');
  const projectDir = mk('stop-proj');
  const env = { ROOM_STATE_DIR: stateDir };
  const inbox = path.join(projectDir, '.room', 'watch-inbox.md');
  const base = {
    session_id: 'st-1', cwd: projectDir, hook_event_name: 'Stop',
    last_assistant_message: 'I dropped the index and reran the migration.'
  };

  // no recruits at all
  const none = await run(STOP, base, env);
  check(none.code === 0 && none.out === '', 'Stop exits 0 and silently with no recruits', none.out);

  const room = roomAt(stateDir, projectDir);
  await room.recruit({ name: 'quiet', model: 'x/q', system_prompt: 'q' });

  const noWatchers = await run(STOP, base, env);
  check(noWatchers.code === 0 && !fs.existsSync(inbox), 'no watchers => no calls, no inbox', noWatchers.out);

  await room.recruit({ name: 'eye', model: 'x/e', system_prompt: 'e', watch: true });

  // the loop guard comes before anything that could spend
  const guarded = await run(STOP, { ...base, stop_hook_active: true },
    { ...env, PERSONA_RECRUITER_MOCK_TEXT: 'I object to everything.' });
  check(guarded.code === 0 && !fs.existsSync(inbox), 'stop_hook_active:true short-circuits before any provider call', guarded.out);
  check(!fs.existsSync(path.join(stateDir, 'recruits', 'eye', 'history.jsonl')), 'the watcher was never called');

  // a watcher with nothing to say
  const passed = await run(STOP, base, { ...env, PERSONA_RECRUITER_MOCK_TEXT: 'PASS' });
  check(passed.code === 0 && !fs.existsSync(inbox), 'an exact PASS leaves no comment behind', passed.out);
  const passedPunct = await run(STOP, base, { ...env, PERSONA_RECRUITER_MOCK_TEXT: '  pass.  ' });
  check(!fs.existsSync(inbox), 'and so does a lower-case PASS with stray punctuation');

  // a watcher with something to say
  const said = await run(STOP, base, { ...env, PERSONA_RECRUITER_MOCK_TEXT: 'That migration has no rollback path.' });
  check(said.code === 0, 'Stop still exits 0 when a watcher objects');
  check(said.out === '', 'and never blocks: no decision field, no stdout', JSON.stringify(said.out));
  const body = fs.readFileSync(inbox, 'utf8');
  check(/^## watchers · /m.test(body), 'the comment is parked in .room/watch-inbox.md', body);
  check(body.includes('[eye · x/e · $0.0000]'), 'attributed with the usual header line', body);
  check(body.includes('That migration has no rollback path.'), 'carrying the comment');

  // Stop -> inbox -> UserPromptSubmit is the delivery path
  const delivered = ctx(await run(UPS, {
    session_id: 'st-1', transcript_path: '', cwd: projectDir,
    hook_event_name: 'UserPromptSubmit', prompt: 'ok, next'
  }, env));
  check(/WATCHERS/.test(delivered) && delivered.includes('That migration has no rollback path.'),
    'the next user prompt delivers it to Claude', delivered);
  check(!fs.existsSync(inbox), 'and clears the inbox');

  // the watcher was actually asked, and remembers being asked
  const hist = fs.readFileSync(path.join(stateDir, 'recruits', 'eye', 'history.jsonl'), 'utf8').trim().split('\n');
  check(hist.length === 3, 'the watcher was called once per non-guarded Stop', String(hist.length));
  const first = JSON.parse(hist[0]);
  check(/reply exactly PASS/.test(first.q), 'the watch prompt asks for PASS when there is nothing to say', first.q.slice(0, 120));
  check(first.q.includes('I dropped the index and reran the migration.'), "and carries the chair's last turn");
  check(!fs.existsSync(path.join(stateDir, 'recruits', 'quiet', 'history.jsonl')),
    'a non-watching recruit is never called');

  // budget
  fs.rmSync(inbox, { force: true });
  const broke = await run(STOP, base, {
    ...env, PERSONA_RECRUITER_MOCK_TEXT: 'I object.', PERSONA_RECRUITER_BUDGET_USD: '0'
  });
  check(broke.code === 0 && !fs.existsSync(inbox), 'over the spend cap, watchers are skipped entirely', broke.out);

  // transcript fallback when the harness gives no last_assistant_message
  const transcript = path.join(projectDir, 'fallback.jsonl');
  const line = (type, content) => JSON.stringify({
    type, isSidechain: false,
    message: type === 'user' ? { role: 'user', content } : { role: 'assistant', content }
  });
  fs.writeFileSync(transcript, [
    line('user', 'do the thing'),
    line('assistant', [{ type: 'thinking', thinking: 'SECRET' }, { type: 'text', text: 'TRANSCRIPT-TURN' }])
  ].join('\n') + '\n');
  const fallback = await run(STOP, {
    session_id: 'st-2', cwd: projectDir, hook_event_name: 'Stop', transcript_path: transcript
  }, { ...env, PERSONA_RECRUITER_MOCK_TEXT: 'I object to the transcript turn.' });
  check(fallback.code === 0 && fs.existsSync(inbox), 'with no last_assistant_message the transcript is read instead');
  const hist2 = fs.readFileSync(path.join(stateDir, 'recruits', 'eye', 'history.jsonl'), 'utf8').trim().split('\n');
  const lastQ = JSON.parse(hist2[hist2.length - 1]).q;
  check(lastQ.includes('TRANSCRIPT-TURN'), 'the last assistant turn came from the transcript', lastQ.slice(-80));
  check(!lastQ.includes('SECRET'), 'and thinking blocks are not handed to a watcher');

  const garbage = await run(STOP, 'not json at all', env);
  check(garbage.code === 0, 'Stop survives garbage stdin');
  const noTurn = await run(STOP, { cwd: projectDir, hook_event_name: 'Stop' },
    { ...env, PERSONA_RECRUITER_MOCK_TEXT: 'I object.' });
  check(noTurn.code === 0, 'Stop exits 0 with nothing to review');
}

done();
