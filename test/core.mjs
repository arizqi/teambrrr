#!/usr/bin/env node
// room-core tests: state resolution, overlay shadowing, migration, event log,
// digest sources (codex + event-log + auto), per-recruit fan-out, retry/fallback.
// Everything runs against scratch dirs — the real ~/.room is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { check, done, SCRATCH } from './_harness.mjs';
import { createRoom } from '../core/room.mjs';
import { createStore, migrateLegacy } from '../core/state.mjs';
import { createEventLogSource, buildFromFile as eventDigest } from '../core/digest/event-log.mjs';
import codex from '../core/digest/codex.mjs';
import { createAutoSource } from '../core/digest/auto.mjs';

const ROOT = path.join(SCRATCH, 'core-test');
fs.rmSync(ROOT, { recursive: true, force: true });
const mk = (...p) => { const d = path.join(ROOT, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const wrJSON = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2)); };

console.log('room-core tests\n');

// A provider that never touches the network and echoes what it was asked.
const echoProvider = {
  name: 'mock',
  call: async ({ name, model, messages }) => ({
    text: `echo(${name}) asked:"${messages[messages.length - 1].content}" digest:"${String(messages.find((m) => m.__digest)?.content || '').slice(0, 300)}"`,
    cost: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0 }
  })
};

// ---------------------------------------------------------------- 1. state ---
{
  const stateDir = mk('state1');
  const projectDir = mk('proj1');
  wrJSON(path.join(stateDir, 'recruits', 'sage', 'persona.json'), { name: 'sage', model: 'g/global', system_prompt: 'global sage', tags: [] });
  wrJSON(path.join(stateDir, 'recruits', 'onlyglobal', 'persona.json'), { name: 'onlyglobal', model: 'g/only', system_prompt: 'x', tags: [] });

  let store = createStore({ stateDir, projectDir });
  check(store.readPersona('sage')?.model === 'g/global', 'global recruit resolves');
  check(!store.hasOverlay(), 'no overlay when project has no .room');
  check(store.listPersonas().length === 2, 'roster lists global recruits');

  // add the project overlay
  wrJSON(path.join(projectDir, '.room', 'recruits', 'sage', 'persona.json'), { name: 'sage', model: 'p/project', system_prompt: 'project sage', tags: [] });
  store = createStore({ stateDir, projectDir });
  check(store.hasOverlay(), 'overlay detected once <project>/.room exists');
  check(store.readPersona('sage')?.model === 'p/project', 'project overlay shadows the global recruit by name');
  check(store.readPersona('sage')?.__scope === 'project', 'shadowed recruit is tagged scope=project');
  check(store.readPersona('onlyglobal')?.model === 'g/only', 'non-shadowed global recruit still resolves');
  const names = store.listPersonas().map((p) => p.name).sort();
  check(JSON.stringify(names) === JSON.stringify(['onlyglobal', 'sage']), 'roster de-duplicates shadowed names', names.join(','));
  check(store.listPersonas().find((p) => p.name === 'sage').model === 'p/project', 'roster shows the overlay version');

  // writes follow the owning root
  store.appendHistory('sage', { q: 'a', a: 'b' });
  check(fs.existsSync(path.join(projectDir, '.room', 'recruits', 'sage', 'history.jsonl')), 'history for a shadowed recruit writes into the overlay');
  check(!fs.existsSync(path.join(stateDir, 'recruits', 'sage', 'history.jsonl')), 'global copy of a shadowed recruit is left alone');
}

// ------------------------------------------------------------ 2. migration ---
{
  const stateDir = path.join(ROOT, 'state2');   // deliberately does not exist yet
  const projectDir = mk('proj2');
  const legacy = path.join(projectDir, '.claude', 'recruits');
  wrJSON(path.join(legacy, 'reviewer', 'persona.json'), { name: 'reviewer', model: 'nv/ultra', system_prompt: 'reviewer', tags: ['review'] });
  fs.writeFileSync(path.join(legacy, 'reviewer', 'history.jsonl'), JSON.stringify({ q: 'old question', a: 'old answer' }) + '\n');
  wrJSON(path.join(legacy, '.spend.json'), { total: 0.25, byRecruit: { reviewer: { calls: 2, spend: 0.25 } } });
  wrJSON(path.join(legacy, '.models-cache.json'), { fetched_at: Date.now(), models: { 'nv/ultra': { pricing: { prompt: '0', completion: '0' } } } });
  fs.mkdirSync(path.join(legacy, '.dismissed', 'ghost-2026'), { recursive: true });
  wrJSON(path.join(legacy, '.dismissed', 'ghost-2026', 'persona.json'), { name: 'ghost' });

  const rep = migrateLegacy({ projectDir, stateDir });
  check(rep.ran && rep.recruits.includes('reviewer'), 'migration moved reviewer', JSON.stringify(rep.recruits));
  check(fs.existsSync(path.join(stateDir, 'recruits', 'reviewer', 'persona.json')), 'persona landed in the state dir');
  const h = fs.readFileSync(path.join(stateDir, 'recruits', 'reviewer', 'history.jsonl'), 'utf8');
  check(h.includes('old question'), 'history preserved through migration');
  check(fs.existsSync(path.join(stateDir, 'spend.json')) && fs.existsSync(path.join(stateDir, 'models-cache.json')), 'spend.json + models-cache.json migrated');
  check(fs.existsSync(path.join(stateDir, '.dismissed', 'ghost-2026')), 'dismissed archive migrated');
  check(fs.existsSync(path.join(legacy, 'reviewer', 'persona.json')), 'legacy files preserved, not moved');
  check(fs.existsSync(path.join(legacy, '.migrated')), '.migrated marker left in the old dir');

  const again = migrateLegacy({ projectDir, stateDir });
  check(!again.ran && again.skipped.length > 0, 'migration is idempotent (marker honoured)');
  check(createStore({ stateDir, projectDir }).readSpend().total === 0.25, 'migrated spend is readable');
}

// ---------------------------------------------- 3+4. event log + digest src ---
{
  const stateDir = mk('state3');
  const projectDir = mk('proj3');
  const room = createRoom({ stateDir, projectDir, provider: echoProvider, host: 'hermes', autoMigrate: false, digestSource: createEventLogSource(stateDir) });
  await room.recruit({ name: 'ada', model: 'x/ada', system_prompt: 'you are ada' });

  room.events.append({ author: 'user', role: 'user', text: 'kickoff: pick a queue' });
  const r = await room.ask({ name: 'ada', message: 'which queue?' });
  check(r.ok && r.text.startsWith('[ada · x/ada · $0.0000]'), 'event-log room ask returns a well formed block', r.text.split('\n')[0]);
  check(r.text.includes('USER: kickoff: pick a queue'), 'event-log digest reached the recruit as AUTHOR: text', r.text.slice(0, 200));

  const ev = room.events.tail(20);
  check(ev.length === 3, 'ask appended both sides to events.jsonl', `got ${ev.length}`);
  check(ev[1].author === 'chair' && ev[1].role === 'user' && ev[1].text.includes('which queue?'), 'question logged with author=chair');
  check(ev[2].author === 'ada' && ev[2].role === 'assistant' && ev[2].text.includes('echo(ada)'), 'reply logged under the recruit name');
  check(ev.every((e) => e.host === 'hermes' && e.ts), 'events carry host tag and timestamp');

  const dig = eventDigest(path.join(stateDir, 'events.jsonl'));
  check(dig.includes('CHAIR: @ada which queue?') && dig.includes('ADA: echo(ada)'), 'event-log digest formats AUTHOR: text', dig.slice(0, 200));

  // cross-host memory: a second room on another host sees the same channel
  const room2 = createRoom({ stateDir, projectDir: mk('proj3b'), provider: echoProvider, host: 'codex', autoMigrate: false, digestSource: createEventLogSource(stateDir) });
  const r2 = await room2.ask({ name: 'ada', message: 'still?' });
  check(r2.text.includes('kickoff: pick a queue'), 'a different host reads the same event log (shared roster + channel)');
}

// ------------------------------------------------------------- 5. codex src ---
{
  const codexHome = mk('codexhome');
  const projectDir = mk('proj4');
  const other = mk('proj4-other');
  const day = path.join(codexHome, 'sessions', '2026', '08', '20');
  fs.mkdirSync(day, { recursive: true });

  const meta = (cwd, id) => JSON.stringify({ timestamp: '2026-08-20T00:00:00.000Z', type: 'session_meta', payload: { session_id: id, id, cwd, originator: 'Codex CLI', cli_version: '0.145.0', git: {} } });
  const item = (payload) => JSON.stringify({ timestamp: '2026-08-20T00:00:01.000Z', type: 'response_item', payload });
  const evt = (payload) => JSON.stringify({ timestamp: '2026-08-20T00:00:01.000Z', type: 'event_msg', payload });

  const mine = path.join(day, 'rollout-2026-08-20T01-00-00-aaaa.jsonl');
  fs.writeFileSync(mine, [
    meta(projectDir, 'aaaa'),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\ncwd is here\n</environment_context>' }] }),
    item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>\nsandbox\n</permissions instructions>' }] }),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'should we shard the ostrich-vanilla table?' }] }),
    item({ type: 'reasoning', summary: [], encrypted_content: 'SECRETREASONING' }),
    item({ type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' }),
    item({ type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'NOISEOUTPUT' }] }),
    item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Shard on tenant id.' }] }),
    evt({ type: 'agent_message', message: 'Shard on tenant id.' })
  ].join('\n') + '\n');

  const theirs = path.join(day, 'rollout-2026-08-20T02-00-00-bbbb.jsonl');
  fs.writeFileSync(theirs, [
    meta(other, 'bbbb'),
    item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'unrelated project chatter' }] })
  ].join('\n') + '\n');
  // make the unrelated one newest so cwd matching has to beat mtime
  const now = Date.now() / 1000;
  fs.utimesSync(mine, now - 100, now - 100);
  fs.utimesSync(theirs, now, now);

  process.env.CODEX_HOME = codexHome;
  const hit = codex.locate({ projectDir });
  check(hit?.file === mine && hit.exact, 'codex locate prefers the rollout whose session cwd matches the project', hit?.file);

  const d = await codex.build({ projectDir });
  check(d.includes('USER: should we shard the ostrich-vanilla table?'), 'codex digest renders user turns', d.slice(0, 200));
  check(d.includes('CODEX: Shard on tenant id.'), 'codex digest renders assistant turns');
  check(d.includes('CODEX: [tool: shell]'), 'codex digest renders tool calls as [tool: name]');
  check(!d.includes('SECRETREASONING'), 'codex digest drops reasoning');
  check(d.includes('⤷ result: NOISEOUTPUT'), 'codex digest now excerpts tool output', d.slice(0, 300));
  check(!d.includes('environment_context') && !d.includes('sandbox'), 'codex digest drops plumbing turns (env context, developer role)');
  check((d.match(/Shard on tenant id\./g) || []).length === 1, 'event_msg mirrors are not double counted');

  const orphan = mk('proj4-orphan');
  const warned = await codex.build({ projectDir: orphan });
  check(warned.startsWith('(warning: no Codex session for'), 'codex falls back to the newest session with a warning line', warned.slice(0, 80));
  check(warned.includes('unrelated project chatter'), 'fallback digest still carries content');

  // auto picks codex when only codex has a transcript for this project
  const auto = createAutoSource({ stateDir: mk('state4'), projectDir, host: undefined });
  check(auto.resolved() === 'codex', 'auto resolves to codex for a codex-only project', auto.resolved());
  const forced = createAutoSource({ stateDir: mk('state4b'), projectDir, host: 'event-log' });
  check(forced.resolved() === 'event-log', 'ROOM_HOST-style override wins outright');
  const noneAuto = createAutoSource({ stateDir: mk('state4c'), projectDir: mk('proj4-none') });
  check(noneAuto.resolved() === 'event-log', 'auto falls back to the event log with no transcripts');
  delete process.env.CODEX_HOME;
}

// -------------------------------------------------------- 6. per + fan-out ---
{
  const stateDir = mk('state5');
  const projectDir = mk('proj5');
  const room = createRoom({ stateDir, projectDir, provider: echoProvider, host: 'test', autoMigrate: false, digestSource: createEventLogSource(stateDir) });
  await room.recruit({ name: 'alice', model: 'x/a', system_prompt: 'alice' });
  await room.recruit({ name: 'bob', model: 'x/b', system_prompt: 'bob' });

  const r = await room.ask({ names: ['alice', 'bob'], per: { alice: 'ALICE-ONLY-Q', bob: 'BOB-ONLY-Q' } });
  const [ba, bb] = r.blocks;
  check(ba.reply.includes('ALICE-ONLY-Q') && !ba.reply.includes('BOB-ONLY-Q'), 'per: alice received only her own message');
  check(bb.reply.includes('BOB-ONLY-Q') && !bb.reply.includes('ALICE-ONLY-Q'), 'per: bob received only his own message');

  const shared = await room.ask({ names: ['alice', 'bob'], message: 'SHARED-Q' });
  check(shared.blocks.every((b) => b.reply.includes('SHARED-Q')), 'shared message still fans out to everyone');
  const mixed = await room.ask({ names: ['alice', 'bob'], message: 'SHARED-Q', per: { bob: 'BOB-OVERRIDE' } });
  check(mixed.blocks[0].reply.includes('SHARED-Q') && mixed.blocks[1].reply.includes('BOB-OVERRIDE'), 'per overrides only the names it lists');
  const bad = await room.ask({ names: ['alice', 'bob'], per: { alice: 'only alice' } });
  check(bad.ok === false && /needs a message/.test(bad.text), 'partial per with no shared message is rejected', bad.text);

  // the solo rule is on every system prompt
  let captured;
  const spy = { name: 'mock', call: async ({ messages }) => { captured = messages; return { text: 'ok', cost: 0 }; } };
  const room2 = createRoom({ stateDir, projectDir, provider: spy, host: 'test', autoMigrate: false, digestSource: createEventLogSource(stateDir) });
  await room2.ask({ name: 'alice', message: 'hi' });
  check(/respond only to the part addressed to you/.test(captured[0].content), 'system prompt carries the answer-only-as-yourself rule');
}

// ------------------------------------------------------ 7. retry + fallback ---
{
  const stateDir = mk('state6');
  const projectDir = mk('proj6');
  const http = (status) => { const e = new Error(`OpenRouter ${status}: rate limited by upstream`); e.status = status; return e; };

  let calls = [];
  const flaky = {
    name: 'mock',
    call: async ({ model }) => { calls.push(model); if (calls.length === 1) throw http(429); return { text: 'recovered', cost: 0 }; }
  };
  const room = createRoom({ stateDir, projectDir, provider: flaky, host: 'test', autoMigrate: false, retryDelayMs: 5, digestSource: createEventLogSource(stateDir) });
  await room.recruit({ name: 'flake', model: 'free/primary', system_prompt: 'p', fallback_model: 'paid/backup' });
  const r = await room.ask({ name: 'flake', message: 'q' });
  check(calls.length === 2 && r.blocks[0].reply === 'recovered', '429 retried once and succeeded', JSON.stringify(calls));
  check(r.blocks[0].model === 'free/primary', 'successful retry stays on the primary model');

  calls = [];
  const always429 = { name: 'mock', call: async ({ model }) => { calls.push(model); if (model === 'free/primary') throw http(429); return { text: 'from backup', cost: 0 }; } };
  const room2 = createRoom({ stateDir, projectDir, provider: always429, host: 'test', autoMigrate: false, retryDelayMs: 5, digestSource: createEventLogSource(stateDir) });
  const r2 = await room2.ask({ name: 'flake', message: 'q2' });
  check(JSON.stringify(calls) === JSON.stringify(['free/primary', 'free/primary', 'paid/backup']), 'exhausted primary falls through to fallback_model', JSON.stringify(calls));
  check(r2.blocks[0].reply === 'from backup' && r2.blocks[0].model === 'paid/backup', 'fallback reply is attributed to the fallback model');

  calls = [];
  const dead = { name: 'mock', call: async ({ model }) => { calls.push(model); throw http(503); } };
  const room3 = createRoom({ stateDir, projectDir, provider: dead, host: 'test', autoMigrate: false, retryDelayMs: 5, digestSource: createEventLogSource(stateDir) });
  const r3 = await room3.ask({ name: 'flake', message: 'q3' });
  check(calls.length === 3, '5xx is retried then falls back too', JSON.stringify(calls));
  check(r3.text.startsWith('[flake · error · $n/a]'), 'total failure renders the error block', r3.text.split('\n')[0]);
  check(r3.text.split('\n')[1].length <= 300, 'error text truncated to 300 chars');

  calls = [];
  const fatal = { name: 'mock', call: async ({ model }) => { calls.push(model); const e = new Error('OpenRouter 401: bad key'); e.status = 401; throw e; } };
  const room4 = createRoom({ stateDir, projectDir, provider: fatal, host: 'test', autoMigrate: false, retryDelayMs: 5, digestSource: createEventLogSource(stateDir) });
  await room4.ask({ name: 'flake', message: 'q4' });
  check(calls.length === 1, 'non-retryable status (401) is not retried', JSON.stringify(calls));
}

// ------------------------------------------------------------ 8. budget cap ---
{
  const stateDir = mk('state7');
  const projectDir = mk('proj7');
  const paid = { name: 'mock', call: async () => ({ text: 'pricey', cost: 0.6 }) };
  const room = createRoom({ stateDir, projectDir, provider: paid, host: 'test', autoMigrate: false, budget: 1.0, digestSource: createEventLogSource(stateDir) });
  await room.recruit({ name: 'spender', model: 'x/s', system_prompt: 's' });
  await room.ask({ name: 'spender', message: 'one' });
  const second = await room.ask({ name: 'spender', message: 'two' });
  check(second.ok !== false, 'under the cap the ask goes through');
  const third = await room.ask({ name: 'spender', message: 'three' });
  check(third.ok === false && /spend cap reached/.test(third.text), 'budget cap blocks once total exceeds it', third.text);
  check(room.roster().text.includes('of $1.00 cap'), 'roster reports the cap');
  check(room.roster().text.includes(stateDir), 'roster reports where state lives');
}

// ------------------------------------------------------- 9. codex setup.mjs ---
{
  const { apply } = await import('../adapters/codex/setup.mjs');
  const absent = path.join(ROOT, 'no-codex');
  check(apply({ codexHome: absent }).action === 'skipped', 'codex setup is a no-op when codex is not installed');

  const home = mk('codexcfg');
  const cfg = path.join(home, 'config.toml');
  const OTHERS = '[mcp_servers.node_repl]\ncommand = "node"\nargs = ["repl.mjs"]\n\n[mcp_servers.node_repl.env]\nFOO = "bar"\n';
  fs.writeFileSync(cfg, OTHERS);

  const a = apply({ codexHome: home });
  const after = fs.readFileSync(cfg, 'utf8');
  check(a.action === 'appended', 'setup appends to an existing config.toml', a.action);
  check(after.includes('[mcp_servers.persona-recruiter]') && after.includes('server/index.mjs'), 'our table was written');
  check(after.includes('[mcp_servers.node_repl.env]') && after.includes('FOO = "bar"'), 'other mcp entries left intact');

  const b = apply({ codexHome: home });
  check(b.action === 'unchanged', 'setup is idempotent on a second run', b.action);
  check(fs.readFileSync(cfg, 'utf8') === after, 'second run leaves the file byte-identical');

  // point only OUR table at a stale path
  fs.writeFileSync(cfg, after.replace(
    /(\[mcp_servers\.persona-recruiter\]\ncommand = "node"\n)args = \[.*\]/,
    '$1args = ["/old/stale/path.mjs"]'
  ));
  const c = apply({ codexHome: home });
  const fixed = fs.readFileSync(cfg, 'utf8');
  check(c.action === 'updated', 'a stale path is rewritten', c.action);
  check(!fixed.includes('/old/stale/path.mjs') && fixed.includes('[mcp_servers.node_repl]'), 'rewrite replaces only our table');

  const fresh = path.join(ROOT, 'codexcfg-fresh');
  fs.mkdirSync(fresh, { recursive: true });
  check(apply({ codexHome: fresh }).action === 'created', 'setup creates config.toml when missing');
  check(fs.readFileSync(path.join(fresh, 'config.toml'), 'utf8').startsWith('[mcp_servers.persona-recruiter]'), 'created file has no leading blank lines');
}

done();
