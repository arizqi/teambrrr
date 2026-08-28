#!/usr/bin/env node
// Export a room recruit as a hermes-agent teammate profile.
//
//   node adapters/hermes/export.mjs sdr --dry-run
//   import { exportToHermes } from '.../adapters/hermes/export.mjs'
//
// Path B: the room hires the brain, hermes runs the body. The room is where you
// audition models, pick one, argue with them and keep the correspondence. It has
// no scheduler, no tools, no approvals and no spend enforcement — hermes has all
// four, and has had them for months. So rather than grow a second execution
// runtime, a recruit who needs to *do* things is exported into hermes and runs
// there under hermes' guardrails.
//
// What this writes, and why each file exists (all learned from the live install
// at $HERMES_HOME, not from guesswork):
//
//   profiles/<name>/SOUL.md      the system prompt. Not a first user turn —
//                                prompt_builder.load_soul_md() injects it as a
//                                real system prompt.
//   profiles/<name>/profile.yaml the roster entry. `ui_meta.company` is the
//                                single flag that makes a profile a *teammate*
//                                rather than just a profile; without it the
//                                export is invisible to the roster and to
//                                @mentions.
//   profiles/<name>/config.yaml  cloned from an existing sibling profile with
//                                only the `model:` block patched. The file
//                                carries `_config_version`, the approvals
//                                policy and the command allowlist; inventing
//                                any of those is how you get a config the
//                                runtime refuses or, worse, a teammate with no
//                                approval policy.
//   profiles/<name>/.env         where hermes looks for OPENROUTER_API_KEY.
//                                Written WITHOUT the key — see KEY_NOTE.
//
// Two things this deliberately does not do: it never touches the room's own
// state beyond appending one event, and it never overwrites an existing
// profile.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStore, DEFAULT_STATE_DIR, NAME_RE } from '../../core/state.mjs';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const KEY_ENV = 'OPENROUTER_API_KEY';
export const KEY_FILE = '~/.claude/.openrouter_key';
export const DEFAULT_HERMES_HOME = path.join(os.homedir(), '.company-os', 'hermes-home');

// hermes_cli/profiles.py: validate_profile_name.
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const RESERVED_PROFILE_NAMES = new Set(['hermes', 'default', 'test', 'tmp', 'root', 'sudo']);

const MODE_FILE = 0o600; // every secret-bearing file in a live profile is -rw-------
const MODE_DIR = 0o700;

// hermes_cli/profiles.py: _PROFILE_DIRS. Created empty; the runtime fills them.
export const PROFILE_DIRS = [
  'memories', 'sessions', 'skills', 'skins', 'logs', 'plans', 'workspace', 'cron', 'home'
];

// --- the key ----------------------------------------------------------------
// The one thing this exporter refuses to do.
//
// hermes resolves the key for an openrouter.ai endpoint from the *profile's own*
// .env — every profile is its own HERMES_HOME, and under the desktop's
// multiplexed backend an absent key fails closed rather than falling through to
// the parent environment. So the file has to exist and the variable has to be
// named OPENROUTER_API_KEY. (`model.api_key` in config.yaml is silently ignored
// on this path: runtime_provider excludes it whenever the base_url host is
// openrouter.ai.)
//
// But copying the key out of ~/.claude/.openrouter_key and into a second file on
// disk doubles the blast radius of a leak, and does it silently, as a side
// effect of a command the user thought was about a persona. So the .env is
// written with the instruction and without the secret, and the export prints the
// one manual step. A tool that spreads your credentials around as a convenience
// is not being convenient.
export const KEY_NOTE = (envPath) => `# TeamBrrr export — hermes reads ${KEY_ENV} from THIS file.
#
# The key is deliberately NOT written here. TeamBrrr reads it from
# ${KEY_FILE} (or $${KEY_ENV}) and never copies key material into an
# exported profile: that would put a second copy of your credential on disk as a
# silent side effect of exporting a persona.
#
# One manual step, once:
#
#     printf '${KEY_ENV}=%s\\n' "$(cat ${KEY_FILE})" >> ${envPath}
#
# Why this file and not $HERMES_HOME/.env: every hermes profile is its own
# HERMES_HOME. The root .env is copied in at creation time, never merged at
# runtime, and under a multiplexed backend the profile scope is authoritative —
# a missing key here does not fall back to the parent environment, it 401s.
#
# If you would rather not have the key on disk twice at all, hermes can call out
# for it instead: add a root \`providers:\` block to config.yaml with
# \`key_cmd: cat ${KEY_FILE}\` and point \`model.provider\` at it. That path is
# real but it needs a non-canonical provider slug, which the Company OS roster
# does not yet know how to render — hence the plain .env by default.
`;

// --- yaml (write-only, no dependency) ---------------------------------------
// core/ has no dependencies and this adapter keeps that property. Only two
// shapes are ever emitted — profile.yaml and a model block — so a full YAML
// serialiser would be a liability rather than an asset.

// Single-quoted style: valid for every scalar we emit, and the only escape is
// doubling an internal quote.
export const yq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Patch the `model:` block in place rather than appending one. An appended
// second `model:` is a duplicate key, and YAML's last-wins/first-wins behaviour
// is not something to bet a teammate's endpoint on.
export function patchModelBlock(configText, modelLines) {
  const lines = String(configText).split('\n');
  const start = lines.findIndex((l) => /^model:\s*(#.*)?$/.test(l));
  const block = ['model:', ...modelLines.map((l) => `  ${l}`)];

  if (start === -1) return [...block, ...lines].join('\n');

  let end = start + 1;
  // The block runs to the next line that starts in column zero and is not blank.
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || /^\s*$/.test(lines[end]))) {
    if (/^\s*$/.test(lines[end])) {
      const nextReal = lines.slice(end).findIndex((l) => /\S/.test(l));
      if (nextReal === -1) break;
      if (!/^\s/.test(lines[end + nextReal])) break;
    }
    end++;
  }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
}

// --- pieces ------------------------------------------------------------------

// recruit.mjs: initialsFor — one word takes its first two characters.
export function initialsFor(name, role) {
  const words = String(role || '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const src = (words[0] || name || '').replace(/[^a-zA-Z0-9]/g, '');
  return (src.slice(0, 2) || 'XX').toUpperCase();
}

export const displayName = (name) => String(name).replace(/[-_]+/g, ' ')
  .split(' ').filter(Boolean).map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
  .join(' ');

const roleFor = (persona, role) =>
  role || (persona.tags?.length ? persona.tags.join(', ') : `Recruited in the room on ${persona.model}`);

// The Company OS identity tail, stored in the file rather than appended by the
// runtime. Reproduced verbatim from the live profiles.
export const SOUL_FOOTER = `You are a named, durable teammate in a Company OS company. Your identity is
not your model: the model underneath you can be rebound, and you are still
you afterwards. Answer as yourself, and say plainly when you do not know.`;

// Line 1 must be `# Name` and the role must be recoverable from the top of the
// file — the Company OS plugin reads the first lines rather than making a second
// RPC. So the provenance sits just below the role line instead of above the
// heading, which would break that contract for the sake of a comment.
export function soulFor({ name, persona, role, date, stateDir }) {
  const title = displayName(name);
  const historyPath = path.join(stateDir, 'recruits', name, 'history.jsonl');
  return [
    `# ${title}`,
    '',
    `**Role:** ${role}`,
    '',
    `*Exported from TeamBrrr recruit ${name} on ${date}; memory continues in ${stateDir}.*`,
    '',
    `You are ${title}, the ${role} on this team. When someone asks who you are, say so.`,
    '',
    persona.system_prompt || '',
    '',
    '## Your prior correspondence',
    '',
    'You were hired and worked in the TeamBrrr room before you were',
    'exported here. Every exchange you had there is on disk at:',
    '',
    `    ${historyPath}`,
    '',
    'Treat it as your own prior correspondence and read it when you need context on',
    'what has already been discussed or decided. It is a **read-only reference**: it',
    'stopped growing at the export, and nothing you say here is appended to it. When',
    'it contradicts what you are told now, what you are told now wins — and say that',
    'you noticed the contradiction rather than quietly picking one.',
    '',
    '---',
    '',
    SOUL_FOOTER,
    ''
  ].join('\n');
}

export function profileYamlFor({ name, role, model, at }) {
  return [
    `description: ${yq(role)}`,
    'description_auto: false',
    'ui_meta:',
    '  company:',
    `    teammateId: ${yq(name)}`,
    `    initials: ${yq(initialsFor(name, role))}`,
    `    role: ${yq(role)}`,
    '    bindingVersion: 1',
    // Not a cosmetic field. Company OS's spend cap keys off the provider slug,
    // and `custom` is not in PAID_SLUGS — so an OpenRouter teammate is metered
    // by OpenRouter while Company OS believes it is free. zeroSpend:false is
    // what stops the UI labelling it $0 and offering it as a free generator.
    // The cap still will not block it; see README.
    '    zeroSpend: false',
    '    history:',
    '      - version: 1',
    '        binding:',
    "          provider: 'custom'",
    `          model: ${yq(model)}`,
    `          baseUrl: ${yq(OPENROUTER_BASE_URL)}`,
    `        at: ${yq(at)}`,
    "        note: 'exported from TeamBrrr'",
    `    updatedAt: ${yq(at)}`,
    ''
  ].join('\n');
}

export const modelBlockFor = (model) => [
  'provider: custom',
  `default: ${model}`,
  `base_url: ${OPENROUTER_BASE_URL}`
];

// --- template ----------------------------------------------------------------
// config.yaml is cloned, never authored. It carries `_config_version` (which the
// runtime refuses if it is below the support floor), the approvals policy and
// the command allowlist. An exporter that writes its own gets to choose a
// teammate's sandbox rules by accident.
export function findTemplateConfig(hermesHome, explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`template config not found: ${explicit}`);
    return explicit;
  }
  const profiles = path.join(hermesHome, 'profiles');
  let entries = [];
  try {
    entries = fs.readdirSync(profiles, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {}
  for (const p of entries) {
    const c = path.join(profiles, p, 'config.yaml');
    if (fs.existsSync(c)) return c;
  }
  const root = path.join(hermesHome, 'config.yaml');
  if (fs.existsSync(root)) return root;
  throw new Error(
    `no config.yaml to clone under ${hermesHome} — expected an existing profile ` +
    'or a root config. Is HERMES_HOME right?'
  );
}

// --- export ------------------------------------------------------------------

export function exportToHermes({
  name,
  role,
  hermesHome = process.env.HERMES_HOME || DEFAULT_HERMES_HOME,
  stateDir = process.env.ROOM_STATE_DIR || DEFAULT_STATE_DIR,
  projectDir = process.cwd(),
  templateConfig,
  dryRun = false,
  now = () => new Date()
} = {}) {
  const n = String(name || '').replace(/^@/, '');
  if (!NAME_RE.test(n)) return fail(`invalid recruit name "${name}" — must match ${NAME_RE}`);
  if (!PROFILE_NAME_RE.test(n)) return fail(`"${n}" is not a valid hermes profile name (${PROFILE_NAME_RE})`);
  if (RESERVED_PROFILE_NAMES.has(n)) return fail(`"${n}" is a reserved hermes profile name — rename the recruit first`);

  const store = createStore({ stateDir, projectDir });
  const persona = store.readPersona(n);
  if (!persona) return fail(`no recruit named "${n}" in ${stateDir} — roster() to see who exists`);

  const dest = path.join(hermesHome, 'profiles', n);

  // Refuse to overwrite. Two distinct cases, and the second is the dangerous
  // one: a *retired* teammate is a regular FILE at profiles/<name>, placed there
  // deliberately so a still-running backend cannot mkdir the name back into
  // existence as a roster ghost. Clobbering it would resurrect a teammate the
  // user retired on purpose.
  if (fs.existsSync(dest)) {
    let kind = 'a profile';
    try { kind = fs.statSync(dest).isDirectory() ? 'a profile' : 'a retirement tombstone'; } catch {}
    if (kind === 'a retirement tombstone') {
      return fail(
        `${dest} is a retirement tombstone, not a directory — "${n}" was retired from this ` +
        'company on purpose, and the file is what stops it coming back as a ghost. ' +
        `Bring it back with the company's own unretire command, or export under another name.`
      );
    }
    return fail(
      `hermes already has ${kind} at ${dest} — refusing to overwrite it.\n` +
      `Compare before you decide:  diff -ru ${dest} <(this export --dry-run)\n` +
      `Then either export under a different name, or remove that profile yourself first.`
    );
  }

  let templatePath;
  try { templatePath = findTemplateConfig(hermesHome, templateConfig); }
  catch (e) { return fail(String(e.message || e)); }

  const at = now().toISOString();
  const date = at.slice(0, 10);
  const theRole = roleFor(persona, role);
  const envPath = path.join(dest, '.env');

  let configText;
  try { configText = fs.readFileSync(templatePath, 'utf8'); }
  catch (e) { return fail(`cannot read template config ${templatePath}: ${e.message}`); }

  const files = [
    { path: path.join(dest, 'SOUL.md'), content: soulFor({ name: n, persona, role: theRole, date, stateDir }) },
    { path: path.join(dest, 'profile.yaml'), content: profileYamlFor({ name: n, role: theRole, model: persona.model, at }) },
    { path: path.join(dest, 'config.yaml'), content: patchModelBlock(configText, modelBlockFor(persona.model)) },
    { path: envPath, content: KEY_NOTE(envPath) }
  ].map((f) => ({ ...f, mode: MODE_FILE, bytes: Buffer.byteLength(f.content) }));

  // Last line of defence, cheap and worth it: nothing leaves here carrying a
  // credential, whatever the persona happens to contain.
  const leak = files.find((f) => /\bsk-[A-Za-z0-9_-]{8,}/.test(f.content));
  if (leak) return fail(`refusing to write ${leak.path}: it contains something shaped like an API key`);

  const dirs = [dest, ...PROFILE_DIRS.map((d) => path.join(dest, d))];

  const result = {
    ok: true, name: n, role: theRole, model: persona.model, hermesHome, dest,
    stateDir, templateConfig: templatePath, dryRun: !!dryRun,
    dirs, files: files.map((f) => ({ path: f.path, mode: f.mode, bytes: f.bytes, content: f.content }))
  };

  if (dryRun) {
    result.text = renderDryRun(result);
    return result;
  }

  for (const d of dirs) fs.mkdirSync(d, { recursive: true, mode: MODE_DIR });
  for (const f of files) {
    fs.writeFileSync(f.path, f.content, { mode: MODE_FILE });
    try { fs.chmodSync(f.path, MODE_FILE); } catch {}
  }

  // The room keeps the receipt. host:'hermes' so the channel shows where the
  // recruit went, and the digest sources pick it up like any other event.
  store.appendEvent({
    host: 'hermes', author: 'chair', role: 'user',
    text: `exported as hermes profile: @${n} on ${persona.model} → ${dest}`
  });

  result.text = renderWrote(result);
  return result;
}

// --- rendering ---------------------------------------------------------------

const rel = (p, root) => (p.startsWith(root) ? p.slice(root.length).replace(/^\//, '') : p);

const nextSteps = (r) => [
  '',
  'Before it can answer:',
  `  1. Put the key in ${rel(path.join(r.dest, '.env'), r.hermesHome)} — the file explains how. `,
  `     It was written WITHOUT your key on purpose.`,
  `  2. hermes will pick the profile up on its own: the directory listing is the roster.`,
  '',
  `Memory: the room keeps every exchange at ${path.join(r.stateDir, 'recruits', r.name)}. `,
  'The export points the teammate at it read-only; it does not copy or move it,',
  'and @' + r.name + ' stays reachable in the room exactly as before.'
].join('\n');

// The spend warning is not a footnote. Company OS's cap keys off the provider
// slug, `custom` is not a paid slug, and this teammate bills OpenRouter.
const spendWarning = (r) => [
  '',
  'Spend, plainly: this profile is `provider: custom`, which is how hermes is told',
  '"an OpenAI-compatible endpoint I will name". Company OS reads that slug as free',
  `and will not meter it — but ${r.model} bills your OpenRouter account on every`,
  'turn. `zeroSpend: false` stops the UI calling it free; it does not enforce a cap.',
  'Set the limit on the OpenRouter side, not here.'
].join('\n');

export function renderDryRun(r) {
  const head = [
    `DRY RUN — nothing was written.`,
    '',
    `recruit    @${r.name}  (${r.model})`,
    `role       ${r.role}`,
    `hermes     ${r.hermesHome}`,
    `profile    ${r.dest}`,
    `config     cloned from ${r.templateConfig}, with only the model: block patched`,
    '',
    `would create ${r.dirs.length} directories: ${r.dirs.map((d) => rel(d, r.dest) || '.').join(' ')}`,
    `would write ${r.files.length} files (mode 0600):`,
    ...r.files.map((f) => `  ${rel(f.path, r.dest)}  ${f.bytes} bytes`)
  ].join('\n');

  const bodies = r.files.map((f) =>
    [`\n${'='.repeat(72)}`, `--- ${f.path}`, '='.repeat(72), f.content.replace(/\n$/, '')].join('\n')
  ).join('\n');

  return [head, bodies, spendWarning(r), nextSteps(r), '', 'Re-run without --dry-run to write it.'].join('\n');
}

export function renderWrote(r) {
  return [
    `Exported @${r.name} to hermes as a teammate profile.`,
    '',
    `  ${r.dest}`,
    ...r.files.map((f) => `    ${rel(f.path, r.dest)}`),
    `  + ${r.dirs.length - 1} empty runtime directories`,
    '',
    `model      ${r.model} via ${OPENROUTER_BASE_URL} (provider: custom)`,
    `config     cloned from ${r.templateConfig}`,
    spendWarning(r),
    nextSteps(r)
  ].join('\n');
}

const fail = (text) => ({ ok: false, error: text, text });

// --- cli ---------------------------------------------------------------------

function parseArgv(argv) {
  const out = { dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--hermes-home') out.hermesHome = argv[++i];
    else if (a === '--state-dir') out.stateDir = argv[++i];
    else if (a === '--role') out.role = argv[++i];
    else if (a === '--template') out.templateConfig = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else rest.push(a);
  }
  if (rest.length) out.name = rest[0];
  return out;
}

const USAGE = `export a room recruit as a hermes teammate profile

  node adapters/hermes/export.mjs <name> [--dry-run] [options]

  --dry-run, -n        print the files it would write, write nothing
  --role "..."         role line for SOUL.md and the roster (default: the recruit's tags)
  --hermes-home PATH   default: $HERMES_HOME or ~/.company-os/hermes-home
  --state-dir PATH     default: $ROOM_STATE_DIR or ~/.room
  --template PATH      config.yaml to clone (default: the first existing profile's)

The room hires the brain; hermes runs the body. Your OpenRouter key is never
copied into the exported profile — see the .env it writes.`;

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || !args.name) {
    console.log(USAGE);
    process.exit(args.name ? 0 : 1);
  }
  const r = exportToHermes(args);
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
}

export default { exportToHermes, patchModelBlock, findTemplateConfig };
