#!/usr/bin/env node
// Smoke test: drives the MCP adapter over stdio with the mock provider against a
// scratch project containing a fake transcript in the real Claude Code format.
// State goes to a scratch stateDir — the real ~/.room is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, StdioClientTransport } from './mcp-sdk.mjs';
import { check, done, SCRATCH } from './_harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server', 'index.mjs');
const HOOK = path.join(HERE, '..', 'hooks', 'user-prompt-submit.mjs');
const PROJ = path.join(SCRATCH, 'smoke-project');
const STATE = path.join(SCRATCH, 'smoke-state');       // stands in for ~/.room
const CODEX_HOME = path.join(SCRATCH, 'smoke-codex');  // empty: keeps auto hermetic
const HERMES = path.join(SCRATCH, 'smoke-hermes');     // fixture: never the real install
const PACKAGE = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

// --- scratch project with a fake transcript in the observed JSONL shape ------
fs.rmSync(PROJ, { recursive: true, force: true });
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(CODEX_HOME, { recursive: true });
fs.rmSync(HERMES, { recursive: true, force: true });
fs.mkdirSync(path.join(HERMES, 'profiles', 'qa'), { recursive: true });
fs.writeFileSync(path.join(HERMES, 'profiles', 'qa', 'config.yaml'),
  'model:\n  default: gpt-oss:20b\n  provider: custom\n  base_url: http://127.0.0.1:11434/v1\n_config_version: 37\n');
const legacyDir = path.join(PROJ, '.claude', 'recruits');
fs.mkdirSync(legacyDir, { recursive: true });
const transcript = path.join(PROJ, 'fake-session.jsonl');

const MARKER = 'zeppelin-cardamom';
const entry = (type, content, uuid) => JSON.stringify({
  parentUuid: null, isSidechain: false, type,
  message: type === 'user' ? { role: 'user', content } : { model: 'claude-opus-5', type: 'message', role: 'assistant', content },
  uuid, timestamp: new Date().toISOString(),
  cwd: PROJ, sessionId: 'smoke-session', version: '2.1.229', userType: 'external'
});
fs.writeFileSync(transcript, [
  entry('user', `we need to pick a datastore for the ${MARKER} service`, 'u1'),
  entry('assistant', [{ type: 'thinking', thinking: 'hidden reasoning' }, { type: 'text', text: 'Postgres is the safe default here.' }], 'a1'),
  entry('user', 'what about write amplification?', 'u2'),
  entry('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], 'a2'),
  entry('assistant', [{ type: 'text', text: 'Measured it; the write path is fine under 5k rps.' }], 'a3')
].join('\n') + '\n');
fs.writeFileSync(path.join(legacyDir, '.session'),
  JSON.stringify({ session_id: 'smoke-session', transcript_path: transcript }));

const statePersona = (n) => path.join(STATE, 'recruits', n, 'persona.json');
const stateHistory = (n) => path.join(STATE, 'recruits', n, 'history.jsonl');

// --- connect -----------------------------------------------------------------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  cwd: PROJ,
  env: {
    ...process.env,
    PERSONA_RECRUITER_PROVIDER: 'mock',
    PERSONA_RECRUITER_CWD: PROJ,
    ROOM_STATE_DIR: STATE,
    CODEX_HOME,
    HERMES_HOME: HERMES,
    OPENROUTER_API_KEY: ''
  }
});
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: (r.content || []).map((c) => c.text).join('\n'), isError: !!r.isError };
};

console.log('TeamBrrr smoke test (MCP adapter)\n');

check(PACKAGE.name === 'teambrrr', 'npm package uses the TeamBrrr name');
check(PACKAGE.bin.teambrrr === './server/index.mjs', 'teambrrr is the primary CLI');
check(PACKAGE.bin['persona-recruiter'] === './server/index.mjs', 'persona-recruiter CLI remains a compatibility alias');
check(fs.readFileSync(SERVER, 'utf8').includes("new McpServer({ name: 'teambrrr'"), 'MCP server uses teambrrr as its primary identifier');

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check(JSON.stringify(tools) === JSON.stringify([
  'ask', 'assign_task', 'audition', 'brief_update', 'discuss', 'dismiss',
  'evaluate_role', 'export_hermes', 'local_models', 'pin', 'pins', 'recruit',
  'rollback_persona', 'roster', 'show_persona', 'task_cancel', 'task_decide',
  'tasks', 'unpin', 'update_persona'
]), 'twenty tools registered', tools.join(','));

// recruit x2
const r1 = await call('recruit', { name: 'alpha', model: 'openai/gpt-4o-mini', system_prompt: 'You are a blunt systems engineer.', tags: ['systems'] });
check(!r1.isError && r1.text.includes('@alpha'), 'recruit alpha', r1.text);
const r2 = await call('recruit', { name: 'beta', model: 'anthropic/claude-3.5-haiku', system_prompt: 'You are a cautious DBA.', tags: ['db'] });
check(!r2.isError && r2.text.includes('@beta'), 'recruit beta', r2.text);
const bad = await call('recruit', { name: 'A', model: 'x/y', system_prompt: 'z' });
check(bad.isError, 'invalid name rejected', bad.text);
check(fs.existsSync(statePersona('alpha')), 'persona.json written to global state dir');

// roster
const ros1 = await call('roster');
check(ros1.text.includes('@alpha') && ros1.text.includes('@beta') && ros1.text.includes('calls:0'), 'roster lists both', ros1.text);

// ask single -> digest plumbing + header format
const a1 = await call('ask', { name: 'alpha', message: 'which datastore?' });
const lines = a1.text.split('\n');
check(lines[0] === '[alpha · openai/gpt-4o-mini · $0.0000]', 'header format exact', JSON.stringify(lines[0]));
check(a1.text.includes(MARKER), 'digest reached the recruit (marker present)', a1.text.slice(0, 200));
check(a1.text.includes('USER:'), 'digest carries USER: prefix');
check(!a1.text.includes('hidden reasoning'), 'thinking blocks excluded from digest');
check(a1.text.includes('which datastore?'), 'message reached the recruit');

// history
const hist = fs.readFileSync(stateHistory('alpha'), 'utf8').trim().split('\n');
check(hist.length === 1 && JSON.parse(hist[0]).q === 'which datastore?', 'history.jsonl written');

// ask names[] -> two blocks separated by a blank line
const a2 = await call('ask', { names: ['alpha', 'beta'], message: 'second opinion?' });
const blocks = a2.text.split('\n\n');
check(blocks.length === 2, 'two blocks concatenated with a blank line', JSON.stringify(a2.text.slice(0, 120)));
check(blocks[0].startsWith('[alpha · openai/gpt-4o-mini · $') && blocks[1].startsWith('[beta · anthropic/claude-3.5-haiku · $'),
  'both headers well formed', blocks.map((b) => b.split('\n')[0]).join(' | '));
const hist2 = fs.readFileSync(stateHistory('alpha'), 'utf8').trim().split('\n');
check(hist2.length === 2, 'history appended on second ask');

const missing = await call('ask', { name: 'ghost', message: 'hi' });
check(missing.text.includes('[ghost · error'), 'unknown recruit yields an error block', missing.text);

// per-recruit messages over the wire
const a3 = await call('ask', { names: ['alpha', 'beta'], per: { alpha: 'question-for-alpha', beta: 'question-for-beta' } });
const pb = a3.text.split('\n\n');
check(pb[0].includes('question-for-alpha') && !pb[0].includes('question-for-beta'), 'per: alpha got only its own message', pb[0]?.slice(0, 160));
check(pb[1].includes('question-for-beta') && !pb[1].includes('question-for-alpha'), 'per: beta got only its own message', pb[1]?.slice(0, 160));

// discuss over the wire
const disc = await call('discuss', { names: ['alpha', 'beta'], topic: 'which datastore wins?', rounds: 2 });
check(!disc.isError && disc.text.includes('— round 1 —') && disc.text.includes('— round 2 —'),
  'discuss returns a two-round transcript', disc.text.slice(0, 120));
check((disc.text.match(/^\[alpha · /gm) || []).length === 2, 'alpha spoke in both rounds', disc.text.slice(0, 200));
check(disc.text.includes('ROUND 1 REPLIES'), 'round 2 fed the round-1 replies back in (mock echoes its prompt)');
const discBad = await call('discuss', { names: ['alpha'], topic: 'solo' });
check(discBad.isError && /at least two/.test(discBad.text), 'discuss rejects a one-person discussion', discBad.text);

// audition over the wire
const aud = await call('audition', {
  candidates: [{ model: 'openai/gpt-4o-mini' }, { model: 'anthropic/claude-3.5-haiku' }],
  role_prompt: 'a cautious DBA who reads query plans'
});
check(!aud.isError && aud.text.includes('— raw replies —'), 'audition returns a report', aud.text.slice(0, 160));
check(aud.text.includes('services/estoque.js'), 'the audition probe carries the missing-context trap');
check(/\bscore\b/.test(aud.text) && /Nobody is recruited/.test(aud.text), 'the report is a ranked table that recruits nobody');
const audBad = await call('audition', { candidates: [], role_prompt: 'x' });
check(audBad.isError, 'audition rejects an empty candidate list', audBad.text);

const roleEval = await call('evaluate_role', {
  role_pack: 'code-reviewer',
  candidates: [{ model: 'openai/gpt-4o-mini' }],
  trials: 1,
  offers: false
});
check(!roleEval.isError && roleEval.text.includes('Role evaluation:'), 'role-pack evaluation runs over MCP', roleEval.text);

const taskCreated = await call('assign_task', {
  name: 'alpha', title: 'Inspect the fixture', input: { path: 'fixture.js' },
  idempotency_key: 'smoke-task-1'
});
const smokeTaskId = /task (task_[A-Za-z0-9-]+)/.exec(taskCreated.text)?.[1];
check(!taskCreated.isError && smokeTaskId, 'execution task is assigned over MCP', taskCreated.text);
const taskListed = await call('tasks', { name: 'alpha' });
check(!taskListed.isError && taskListed.text.includes(smokeTaskId), 'execution task is visible over MCP', taskListed.text);
const taskCanceled = await call('task_cancel', {
  task_id: smokeTaskId, reason: 'smoke complete', idempotency_key: 'smoke-cancel-1'
});
check(!taskCanceled.isError && taskCanceled.text.includes('Canceled'), 'execution task is canceled over MCP', taskCanceled.text);

// dismiss
const d = await call('dismiss', { name: 'beta' });
check(!d.isError && !fs.existsSync(path.join(STATE, 'recruits', 'beta')), 'beta dir removed', d.text);
const dismissed = fs.readdirSync(path.join(STATE, '.dismissed'));
check(dismissed.some((n) => n.startsWith('beta-')), 'archived under .dismissed/', dismissed.join(','));

const ros2 = await call('roster');
check(ros2.text.includes('@alpha') && !ros2.text.includes('@beta'), 'roster after dismiss', ros2.text);
check(ros2.text.includes('calls:5'), 'roster counts calls (3 asks + 2 discuss rounds)', ros2.text);

// --- the newer tools, over the wire ------------------------------------------
// Registration already proved the schemas convert; these prove the round trip.
{
  const shown = await call('show_persona', { name: 'alpha' });
  check(!shown.isError && shown.text.includes('You are a blunt systems engineer.'),
    'show_persona returns the prompt in full over MCP', shown.text.slice(0, 120));
  check(shown.text.includes('rev 1 (current)'), 'and its revision');

  const up = await call('update_persona', { name: 'alpha', system_prompt: 'You are a blunt systems engineer who insists on measurements.' });
  check(!up.isError && /rev 2/.test(up.text), 'update_persona bumps the revision over MCP', up.text);
  check(fs.existsSync(path.join(STATE, 'recruits', 'alpha', 'revisions', '1.json')), 'and snapshots rev 1 to the scratch state dir');
  check(fs.readFileSync(stateHistory('alpha'), 'utf8').length > 0, 'while memory survives the edit');

  const back = await call('rollback_persona', { name: 'alpha', revision: 1 });
  check(!back.isError && /rev 3/.test(back.text), 'rollback_persona writes a new revision over MCP', back.text);

  const badRev = await call('show_persona', { name: 'alpha', revision: 99 });
  check(badRev.isError, 'a bad revision is an MCP error, not a silent empty', badRev.text);

  // briefings + pins, over the wire
  const briefed = await call('recruit', {
    name: 'gamma', model: 'x/g', system_prompt: 'You are a release manager.',
    briefing: 'Project: the smoke fixture.\nGlossary: MARKER means the datastore thread.'
  });
  check(!briefed.isError && /Onboarding brief stored/.test(briefed.text), 'recruit accepts a briefing over MCP', briefed.text);
  check(fs.existsSync(path.join(STATE, 'recruits', 'gamma', 'briefing.md')), 'and the brief lands on disk');

  const askedBriefed = await call('ask', { name: 'gamma', message: 'ready?' });
  check(!askedBriefed.isError, 'a briefed recruit answers over MCP', askedBriefed.text.split('\n')[0]);

  const rebrief = await call('brief_update', { name: 'gamma', briefing: 'Project: the smoke fixture, take two.' });
  check(!rebrief.isError && /brief rev 2/.test(rebrief.text), 'brief_update re-onboards over MCP', rebrief.text);
  check(fs.existsSync(path.join(STATE, 'recruits', 'gamma', 'briefings', '1.md')), 'snapshotting the old brief');
  const shownBrief = await call('show_persona', { name: 'gamma' });
  check(shownBrief.text.includes('briefing: rev 2') && shownBrief.text.includes('take two'),
    'show_persona reports the current brief and its revision count', shownBrief.text.slice(0, 200));

  const pinned = await call('pin', { text: 'MCP-PINNED-DECISION', by: 'smoke' });
  check(!pinned.isError && /Pinned p/.test(pinned.text), 'pin over MCP', pinned.text);
  const pinList = await call('pins');
  check(pinList.text.includes('MCP-PINNED-DECISION') && /1 pin\(s\)/.test(pinList.text), 'pins lists it', pinList.text);
  const pinId = /^(p\d+)/m.exec(pinList.text)?.[1];
  check(!!pinId, 'the listing exposes a usable id', pinList.text);
  const seenPin = await call('ask', { name: 'gamma', message: 'anything standing?' });
  check(!seenPin.isError, 'a pinned board does not disturb the ask path', seenPin.text.split('\n')[0]);
  const overBudget = await call('pin', { text: 'z'.repeat(2100) });
  check(overBudget.isError && /pin refused/.test(overBudget.text), 'the pin budget is enforced over MCP', overBudget.text.slice(0, 120));
  const unpinned = await call('unpin', { id: pinId });
  check(!unpinned.isError && (await call('pins')).text.includes('No pins'), 'unpin over MCP', unpinned.text);

  const watched = await call('update_persona', { name: 'gamma', watch: true });
  check(!watched.isError && JSON.parse(fs.readFileSync(statePersona('gamma'), 'utf8')).watch === true,
    'update_persona sets the watch flag over MCP', watched.text);

  // audition with role -> offers, exercising the volume union schema
  const off = await call('audition', {
    candidates: [{ model: 'a/one' }, { model: 'b/two' }],
    role_prompt: 'an SDR who books meetings',
    role: 'SDR',
    volume: 'worker'
  });
  check(!off.isError && off.text.startsWith('Offers for "SDR"'), 'audition with a role returns offers over MCP', off.text.split('\n')[0]);
  check(off.text.includes('volume worker'), 'and honours a named volume profile');
  const offObj = await call('audition', {
    candidates: [{ model: 'a/one' }],
    role_prompt: 'r', role: 'SDR', volume: { per_day: 10, tokens_in: 1000, tokens_out: 100 }
  });
  check(!offObj.isError && offObj.text.includes('volume custom'), 'and an explicit volume object', offObj.text.split('\n')[0]);

  // export_hermes, dry run, against the fixture home
  const dry = await call('export_hermes', { name: 'alpha', dry_run: true });
  check(!dry.isError && dry.text.startsWith('DRY RUN'), 'export_hermes dry-runs over MCP', dry.text.split('\n')[0]);
  check(!fs.existsSync(path.join(HERMES, 'profiles', 'alpha')), 'and writes nothing');

  const wrote = await call('export_hermes', { name: 'alpha' });
  check(!wrote.isError && fs.existsSync(path.join(HERMES, 'profiles', 'alpha', 'SOUL.md')),
    'export_hermes writes the profile over MCP', wrote.text.split('\n')[0]);
  check(fs.readFileSync(path.join(HERMES, 'profiles', 'alpha', 'config.yaml'), 'utf8').includes('openrouter.ai'),
    'with the OpenRouter endpoint patched in');
  const again = await call('export_hermes', { name: 'alpha' });
  check(again.isError && /refusing to overwrite/.test(again.text), 'and refuses a second time', again.text);
  check(!fs.existsSync(path.join(process.env.HOME, '.company-os', 'hermes-home', 'profiles', 'alpha')),
    'the real hermes install was never touched');
}

await client.close();

// --- hook (resolves the global roster, dual-writes the session pointer) -----
const HOOK_ENV = { ...process.env, ROOM_STATE_DIR: STATE };
const hookOut = await new Promise((resolve) => {
  const p = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'], env: HOOK_ENV });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ out, code }));
  p.stdin.end(JSON.stringify({
    session_id: 'smoke-session', transcript_path: transcript, cwd: PROJ,
    hook_event_name: 'UserPromptSubmit', prompt: '@alpha hello there'
  }));
});
check(hookOut.code === 0, 'hook exits 0');
let parsed = null;
try { parsed = JSON.parse(hookOut.out); } catch {}
check(parsed?.hookSpecificOutput?.hookEventName === 'UserPromptSubmit', 'hook emits hookSpecificOutput', hookOut.out.slice(0, 200));
check(/recruit\(s\) alpha/.test(parsed?.hookSpecificOutput?.additionalContext || ''), 'additionalContext names alpha');
check(/\["alpha"\]/.test(parsed?.hookSpecificOutput?.additionalContext || ''), 'additionalContext carries names array');
check(JSON.parse(fs.readFileSync(path.join(legacyDir, '.session'), 'utf8')).transcript_path === transcript, 'hook wrote .session');
check(JSON.parse(fs.readFileSync(path.join(PROJ, '.room', 'session.json'), 'utf8')).transcript_path === transcript, 'hook wrote .room/session.json');

// Without an @mention the hook no longer routes — but the room is still there,
// so it says so in one line. (Full coverage of that behaviour is in hooks.mjs.)
const noMention = await new Promise((resolve) => {
  const p = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'], env: HOOK_ENV });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ out, code }));
  p.stdin.end(JSON.stringify({ session_id: 's', transcript_path: transcript, cwd: PROJ, prompt: 'no mentions here' }));
});
const noMentionCtx = JSON.parse(noMention.out || '{}')?.hookSpecificOutput?.additionalContext || '';
check(noMention.code === 0, 'hook exits 0 without an @mention');
check(!/addressed recruit/.test(noMentionCtx), 'hook does not route without an @mention', noMentionCtx.slice(0, 120));
check(/^\[room\] recruits: /m.test(noMentionCtx), 'but the room-state line is still injected', noMentionCtx.slice(0, 120));

const garbage = await new Promise((resolve) => {
  const p = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] });
  p.on('close', (code) => resolve(code));
  p.stdin.end('not json at all');
});
check(garbage === 0, 'hook survives garbage stdin');

done();
