#!/usr/bin/env node
// export_hermes(): a hired recruit becomes a hermes teammate profile.
//
// Everything here runs against a FIXTURE hermes-home in scratch. The real
// install at ~/.company-os/hermes-home is never read and never written by this
// file: an exporter that can create teammates is exactly the kind of thing that
// must not be tested against the live roster.
import fs from 'node:fs';
import path from 'node:path';
import { check, done, SCRATCH } from './_harness.mjs';
import { createRoom } from '../core/room.mjs';
import { createEventLogSource } from '../core/digest/event-log.mjs';
import {
  exportToHermes, patchModelBlock, findTemplateConfig, initialsFor, displayName,
  OPENROUTER_BASE_URL, PROFILE_DIRS, DEFAULT_HERMES_HOME
} from '../adapters/hermes/export.mjs';

const ROOT = path.join(SCRATCH, 'hermes-test');
fs.rmSync(ROOT, { recursive: true, force: true });
const mk = (...p) => { const d = path.join(ROOT, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

console.log('export_hermes() tests\n');

// A structurally faithful copy of a live profile's config.yaml: the model block
// we must patch, plus the approvals policy, allowlist and _config_version we
// must carry through untouched.
const FIXTURE_CONFIG = `model:
  default: gpt-oss:20b
  provider: custom
  base_url: http://127.0.0.1:11434/v1
approvals:
  smart_policy: 'This machine runs Company OS. Its teammates are AI agents.

    ESCALATE anything that publishes, pushes, or releases.'
  deny:
    - rm -rf /
    - '*git push*'
command_allowlist:
  - ls*
  - cat *
  - npm test*
_config_version: 37
company_os_spend_cap_usd: 5
company_os_hermes_home: /somewhere/hermes-home
`;

// Build a fixture $HERMES_HOME with one existing profile to clone from.
function fixtureHome(tag) {
  const home = mk(tag);
  const qa = path.join(home, 'profiles', 'qa');
  fs.mkdirSync(qa, { recursive: true });
  fs.writeFileSync(path.join(qa, 'config.yaml'), FIXTURE_CONFIG);
  fs.writeFileSync(path.join(qa, 'SOUL.md'), '# QA\n\n**Role:** Verification\n');
  fs.writeFileSync(path.join(qa, 'profile.yaml'), 'description: Verification\n');
  return home;
}

// A room with one hired recruit, on its own state dir.
async function roomWith(tag, persona = {}) {
  const stateDir = mk(tag, 'state');
  const projectDir = mk(tag, 'proj');
  const provider = { name: 'mock', call: async () => ({ text: 'ok', cost: 0 }) };
  const room = createRoom({
    stateDir, projectDir, provider, host: 'test', autoMigrate: false,
    digestSource: createEventLogSource(stateDir)
  });
  await room.recruit({
    name: 'sdr',
    model: 'deepseek/deepseek-chat',
    fallback_model: 'meta-llama/llama-3.3-70b-instruct:free',
    system_prompt: 'You are an SDR. You book qualified meetings and you never invent a company detail you have not read.',
    tags: ['sales', 'outbound'],
    ...persona
  });
  return { room, stateDir, projectDir };
}

// ------------------------------------------------------ 1. patchModelBlock ---
{
  const patched = patchModelBlock(FIXTURE_CONFIG, ['provider: custom', 'default: deepseek/deepseek-chat', `base_url: ${OPENROUTER_BASE_URL}`]);
  check(patched.includes('default: deepseek/deepseek-chat'), 'the new model id lands in the block');
  check(patched.includes(`base_url: ${OPENROUTER_BASE_URL}`), 'the endpoint is rewritten to OpenRouter');
  check(!patched.includes('gpt-oss:20b'), 'the template model id is gone', patched.slice(0, 200));
  check(!patched.includes('127.0.0.1:11434'), 'the template endpoint is gone — this is the bug that bit the live install', patched.slice(0, 200));
  check((patched.match(/^model:/gm) || []).length === 1, 'exactly one model: key — a second would be a duplicate', String((patched.match(/^model:/gm) || []).length));

  check(patched.includes('_config_version: 37'), 'the config version is carried through, never invented');
  check(patched.includes('command_allowlist:') && patched.includes('  - npm test*'), 'the command allowlist survives');
  check(patched.includes('smart_policy:') && patched.includes('ESCALATE anything that publishes'),
    'the approvals policy survives, including its wrapped continuation lines');
  check(patched.includes("    - '*git push*'"), 'the deny list survives');
  check(patched.includes('company_os_spend_cap_usd: 5'), 'the company keys survive');

  // ordering: the model block stays where it was, not appended at the end
  const lines = patched.split('\n');
  check(lines[0] === 'model:', 'the block is patched in place, at the top', lines[0]);
  check(lines.indexOf('approvals:') > 0 && lines.indexOf('approvals:') < 6,
    'and the next top-level key follows immediately', String(lines.indexOf('approvals:')));

  // no model: block at all -> prepended
  const none = patchModelBlock('approvals:\n  deny: []\n', ['provider: custom', 'default: a/b']);
  check(none.startsWith('model:\n  provider: custom'), 'a config with no model block gets one prepended', none.slice(0, 40));
  check(none.includes('approvals:'), 'and keeps everything it had');

  // a trailing comment on the key is still the key
  const commented = patchModelBlock('model: # the brain\n  default: old\napprovals: {}\n', ['default: new']);
  check(commented.includes('default: new') && !commented.includes('default: old'), 'a commented model: key is still matched', commented);
  check(commented.includes('approvals: {}'), 'and the following key survives');

  // blank line inside the block does not end it
  const spaced = patchModelBlock('model:\n  default: old\n\n  provider: custom\napprovals: {}\n', ['default: new']);
  check(!spaced.includes('provider: custom'), 'a blank line inside the block does not truncate the replacement', spaced);
  check(spaced.includes('approvals: {}'), 'and the next top-level key is untouched');
}

// ------------------------------------------------------------- 2. dry run ---
{
  const home = fixtureHome('dry');
  const { room, stateDir, projectDir } = await roomWith('dry-room');

  const before = fs.readdirSync(path.join(home, 'profiles')).sort();
  const r = exportToHermes({ name: 'sdr', hermesHome: home, stateDir, projectDir, dryRun: true });

  check(r.ok && r.dryRun === true, 'the dry run succeeds and says it is one', r.text?.slice(0, 60));
  check(fs.readdirSync(path.join(home, 'profiles')).sort().join(',') === before.join(','),
    'the dry run creates nothing on disk', fs.readdirSync(path.join(home, 'profiles')).join(','));
  check(!fs.existsSync(path.join(home, 'profiles', 'sdr')), 'no profile directory appears');

  check(r.files.length === 4, 'four files would be written', String(r.files.length));
  const names = r.files.map((f) => path.basename(f.path)).sort();
  check(names.join(',') === '.env,SOUL.md,config.yaml,profile.yaml', 'the four are SOUL, profile, config and .env', names.join(','));
  check(r.files.every((f) => f.mode === 0o600), 'each is planned as 0600', JSON.stringify(r.files.map((f) => f.mode.toString(8))));
  check(r.dirs.length === PROFILE_DIRS.length + 1, 'the runtime directories are planned too', String(r.dirs.length));

  check(r.text.startsWith('DRY RUN — nothing was written.'), 'the output leads with the fact that nothing happened', r.text.split('\n')[0]);
  for (const f of ['SOUL.md', 'profile.yaml', 'config.yaml', '.env']) {
    check(r.text.includes(`--- ${path.join(home, 'profiles', 'sdr', f)}`), `the dry run prints ${f} in full`);
  }
  check(r.text.includes('You are an SDR.'), 'the system prompt is visible in the dry run so it can be reviewed');
  check(/Re-run without --dry-run/.test(r.text), 'and it says how to proceed', r.text.slice(-80));

  // a dry run must not touch the room either
  const ev = room.events.tail(50);
  check(!ev.some((e) => /exported as hermes profile/.test(e.text || '')), 'a dry run appends no event', JSON.stringify(ev.map((e) => e.text)));
}

// -------------------------------------------------------- 3. a real export ---
{
  const home = fixtureHome('real');
  const { room, stateDir, projectDir } = await roomWith('real-room');
  const dest = path.join(home, 'profiles', 'sdr');

  const r = exportToHermes({ name: 'sdr', role: 'Outbound sales development', hermesHome: home, stateDir, projectDir });
  check(r.ok, 'the export succeeds', r.text?.slice(0, 120));
  check(fs.existsSync(dest) && fs.statSync(dest).isDirectory(), 'the profile directory is created');

  for (const f of ['SOUL.md', 'profile.yaml', 'config.yaml', '.env']) {
    check(fs.existsSync(path.join(dest, f)), `${f} is written`);
    const mode = fs.statSync(path.join(dest, f)).mode & 0o777;
    check(mode === 0o600, `${f} is 0600, like every secret-bearing file in a live profile`, mode.toString(8));
  }
  for (const d of PROFILE_DIRS) {
    check(fs.existsSync(path.join(dest, d)) && fs.statSync(path.join(dest, d)).isDirectory(), `runtime dir ${d}/ exists`);
  }

  // --- SOUL.md ---
  const soul = fs.readFileSync(path.join(dest, 'SOUL.md'), 'utf8');
  const soulLines = soul.split('\n');
  check(soulLines[0] === '# SDR', 'line 1 is the name heading the Company OS plugin reads', soulLines[0]);
  check(soulLines[2] === '**Role:** Outbound sales development', 'line 3 is the role line', soulLines[2]);
  check(/^\*Exported from TeamBrrr recruit sdr on \d{4}-\d{2}-\d{2}; memory continues in /.test(soulLines[4]),
    'the provenance header sits below the role, not above the heading', soulLines[4]);
  check(soul.includes('You are SDR, the Outbound sales development on this team.'),
    'the identity is stated in a sentence, not left to the heading');
  check(soul.includes('You are an SDR. You book qualified meetings'), 'the room persona is carried over verbatim');
  check(soul.includes(path.join(stateDir, 'recruits', 'sdr', 'history.jsonl')),
    'the teammate is pointed at its room history by absolute path', soul.slice(-600));
  check(/read-only reference/.test(soul), 'and told the history is read-only');
  check(soul.includes('Your identity is\nnot your model'), 'the Company OS identity footer is stored in the file');
  check(soul.trim().endsWith('say plainly when you do not know.'), 'the footer is last', soul.trim().slice(-40));

  // --- profile.yaml ---
  const py = fs.readFileSync(path.join(dest, 'profile.yaml'), 'utf8');
  check(py.includes('ui_meta:') && py.includes('  company:'),
    'ui_meta.company is written — without it the profile is not a teammate at all');
  check(py.includes("    teammateId: 'sdr'"), 'the teammate id is the handle', py);
  check(py.includes("    initials: 'OS'"), 'initials come from the role words', py.split('\n').find((l) => l.includes('initials')));
  check(py.includes("    role: 'Outbound sales development'"), 'the role is the roster subtitle');
  check(py.includes('    bindingVersion: 1'), 'the binding starts at version 1');
  check(py.includes('    zeroSpend: false'), 'zeroSpend is false — an OpenRouter teammate is not free', py.split('\n').find((l) => l.includes('zeroSpend')));
  check(py.includes('description_auto: false'), 'the description is marked human-authored so nothing overwrites it');
  check(py.includes("          model: 'deepseek/deepseek-chat'"), 'the binding history records the model');
  check(py.includes(`          baseUrl: '${OPENROUTER_BASE_URL}'`), 'and the endpoint');

  // --- config.yaml ---
  const cfg = fs.readFileSync(path.join(dest, 'config.yaml'), 'utf8');
  check(cfg.includes('  provider: custom'), 'the provider is custom — hermes\' name for a named OpenAI-compatible endpoint');
  check(cfg.includes('  default: deepseek/deepseek-chat'), 'the model id is the recruit\'s');
  check(cfg.includes(`  base_url: ${OPENROUTER_BASE_URL}`), 'the endpoint is OpenRouter');
  check(cfg.includes('_config_version: 37'), 'the cloned config version is preserved');
  check(cfg.includes('command_allowlist:'), 'the cloned approvals/allowlist are preserved');
  check(!cfg.includes('gpt-oss:20b') && !cfg.includes('11434'), 'nothing of the template binding leaks through');

  // --- .env ---
  const env = fs.readFileSync(path.join(dest, '.env'), 'utf8');
  check(env.includes('OPENROUTER_API_KEY'), 'the .env names the variable hermes actually reads');
  check(!/^OPENROUTER_API_KEY=\S/m.test(env), 'but assigns it no value', env.split('\n').filter((l) => l.includes('OPENROUTER_API_KEY')).join(' | '));
  check(env.includes('~/.claude/.openrouter_key'), 'it points at where the room keeps the key');
  check(/deliberately NOT written here/.test(env), 'and says the omission was deliberate');
  check(env.split('\n').every((l) => !l.trim() || l.trim().startsWith('#')), 'the file is comments only', env.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')));

  // --- no key material anywhere ---
  for (const f of ['SOUL.md', 'profile.yaml', 'config.yaml', '.env']) {
    const body = fs.readFileSync(path.join(dest, f), 'utf8');
    check(!/\bsk-[A-Za-z0-9_-]{8,}/.test(body), `no API key material in ${f}`);
    check(!/sk-or-v1/.test(body), `no OpenRouter key shape in ${f}`);
  }

  // --- the room's receipt ---
  const ev = room.events.tail(50);
  const exported = ev.filter((e) => /exported as hermes profile/.test(e.text || ''));
  check(exported.length === 1, 'exactly one export event is appended', String(exported.length));
  check(exported[0].host === 'hermes', "the event is tagged host:'hermes'", exported[0].host);
  check(exported[0].text.includes('@sdr') && exported[0].text.includes('deepseek/deepseek-chat'),
    'the event records who went where', exported[0].text);
  check(room.roster().recruits.length === 1, 'the recruit stays in the room — export is a copy, not a move');
  check(fs.existsSync(path.join(stateDir, 'recruits', 'sdr', 'persona.json')), 'the room persona is left in place');

  // --- what the operator is told ---
  check(r.text.includes('Spend, plainly:'), 'the output warns about spend rather than burying it', r.text);
  check(/Company OS reads that slug as free/.test(r.text), 'and says exactly why the cap will not catch it');
  check(r.text.includes('WITHOUT your key on purpose'), 'and flags the one manual step');
}

// ------------------------------------------------------ 4. refuses to clobber ---
{
  const home = fixtureHome('clobber');
  const { stateDir, projectDir } = await roomWith('clobber-room');

  const first = exportToHermes({ name: 'sdr', hermesHome: home, stateDir, projectDir });
  check(first.ok, 'the first export lands');

  const soulBefore = fs.readFileSync(path.join(home, 'profiles', 'sdr', 'SOUL.md'), 'utf8');
  const second = exportToHermes({ name: 'sdr', hermesHome: home, stateDir, projectDir });
  check(second.ok === false, 'a second export of the same name is refused', second.text);
  check(/refusing to overwrite/.test(second.text), 'and says so plainly', second.text);
  check(/diff -ru/.test(second.text), 'and hands over a diff command instead', second.text);
  check(fs.readFileSync(path.join(home, 'profiles', 'sdr', 'SOUL.md'), 'utf8') === soulBefore,
    'the existing profile is byte-for-byte untouched');

  // a retired teammate is a FILE at profiles/<name>, on purpose
  const tomb = path.join(home, 'profiles', 'ghost');
  fs.writeFileSync(tomb, 'ghost was retired from this company on 2026-08-19.\n');
  const { room: r2, stateDir: sd2, projectDir: pd2 } = await roomWith('tomb-room');
  await r2.recruit({ name: 'ghost', model: 'a/b', system_prompt: 'x' });
  const onTomb = exportToHermes({ name: 'ghost', hermesHome: home, stateDir: sd2, projectDir: pd2 });
  check(onTomb.ok === false, 'exporting onto a retirement tombstone is refused', onTomb.text);
  check(/tombstone/.test(onTomb.text), 'and the refusal explains what the file is', onTomb.text);
  check(fs.statSync(tomb).isFile(), 'the tombstone is still a file, not a resurrected profile');
  check(fs.readFileSync(tomb, 'utf8').startsWith('ghost was retired'), 'and its contents are intact');
}

// ---------------------------------------------------------- 5. input guards ---
{
  const home = fixtureHome('guards');
  const { stateDir, projectDir } = await roomWith('guards-room');

  const missing = exportToHermes({ name: 'nobody', hermesHome: home, stateDir, projectDir });
  check(missing.ok === false && /no recruit named/.test(missing.text), 'an unknown recruit is refused', missing.text);

  const bad = exportToHermes({ name: 'Not A Handle', hermesHome: home, stateDir, projectDir });
  check(bad.ok === false && /invalid recruit name/.test(bad.text), 'an invalid handle is refused', bad.text);

  // reserved hermes profile names would collide with its own subcommands
  const { room: r3, stateDir: sd3, projectDir: pd3 } = await roomWith('reserved-room');
  await r3.recruit({ name: 'default', model: 'a/b', system_prompt: 'x' });
  const reserved = exportToHermes({ name: 'default', hermesHome: home, stateDir: sd3, projectDir: pd3 });
  check(reserved.ok === false && /reserved hermes profile name/.test(reserved.text), 'a reserved profile name is refused', reserved.text);

  // no template to clone
  const empty = mk('empty-home');
  const noTemplate = exportToHermes({ name: 'sdr', hermesHome: empty, stateDir, projectDir });
  check(noTemplate.ok === false && /no config\.yaml to clone/.test(noTemplate.text),
    'a hermes home with nothing to clone from is refused rather than guessed at', noTemplate.text);

  // the leak guard: a persona carrying something key-shaped never reaches disk
  const { room: r4, stateDir: sd4, projectDir: pd4 } = await roomWith('leak-room');
  // Assemble the synthetic token at runtime so scanners never see a
  // credential-shaped fixture in the public source tree. The exporter still
  // receives the same key-shaped value and exercises its real leak guard.
  const leakFixtureKey = ['sk', 'or', 'v1', 'test-only-key'].join('-');
  await r4.updatePersona({ name: 'sdr', system_prompt: `Use the key ${leakFixtureKey} when asked.` });
  const leak = exportToHermes({ name: 'sdr', hermesHome: home, stateDir: sd4, projectDir: pd4 });
  check(leak.ok === false && /shaped like an API key/.test(leak.text), 'a key-shaped string in the persona blocks the export', leak.text);
  check(!fs.existsSync(path.join(home, 'profiles', 'sdr', 'SOUL.md')) ||
    !fs.readFileSync(path.join(home, 'profiles', 'sdr', 'SOUL.md'), 'utf8').includes('sk-or-v1'),
    'and nothing key-shaped is on disk');
}

// -------------------------------------------------------------- 6. helpers ---
{
  check(initialsFor('sdr', 'Outbound sales development') === 'OS', 'two-word roles take one letter each', initialsFor('sdr', 'Outbound sales development'));
  check(initialsFor('sdr', 'Reconnaissance') === 'RE', 'a one-word role takes its first two letters', initialsFor('sdr', 'Reconnaissance'));
  check(initialsFor('sdr', '') === 'SD', 'with no role, the handle supplies the initials', initialsFor('sdr', ''));
  check(displayName('sdr') === 'SDR', 'a short handle is upper-cased as an acronym', displayName('sdr'));
  check(displayName('sales-lead') === 'Sales Lead', 'a hyphenated handle becomes title case', displayName('sales-lead'));

  const home = fixtureHome('tmpl');
  check(findTemplateConfig(home).endsWith(path.join('profiles', 'qa', 'config.yaml')),
    'the template is an existing profile config', findTemplateConfig(home));
  fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  default: root\n');
  fs.rmSync(path.join(home, 'profiles', 'qa'), { recursive: true, force: true });
  check(findTemplateConfig(home) === path.join(home, 'config.yaml'), 'falling back to the root config', findTemplateConfig(home));
}

// ------------------------------------------- 7. the real install is not used ---
{
  // Belt and braces: every export above passed an explicit fixture home, and the
  // default is only ever reached when nobody says otherwise.
  check(DEFAULT_HERMES_HOME.endsWith(path.join('.company-os', 'hermes-home')),
    'the documented default points at the Company OS install', DEFAULT_HERMES_HOME);
  check(!fs.existsSync(path.join(DEFAULT_HERMES_HOME, 'profiles', 'sdr')),
    'no test in this file created an sdr profile in the real hermes home');
}

done();
