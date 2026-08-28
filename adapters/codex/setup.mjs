#!/usr/bin/env node
// Register the TeamBrrr MCP server with Codex CLI.
// Idempotent, and it never rewrites entries it does not own.
//   node adapters/codex/setup.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.resolve(HERE, '..', '..', 'server', 'index.mjs');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CONFIG = path.join(CODEX_HOME, 'config.toml');
const DRY = process.argv.includes('--dry-run');

const PRIMARY_ID = 'teambrrr';
const LEGACY_ID = 'persona-recruiter';

const ownedValues = {
  command: 'command = "node"',
  args: `args = [${JSON.stringify(SERVER)}]`
};

function patchOwnedTable(raw, id) {
  const lines = raw.split('\n');
  const header = new RegExp(`^\\[mcp_servers\\.${id}\\]\\s*$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return { raw, found: false, changed: false };

  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;

  let commandSeen = false;
  let argsSeen = false;
  for (let i = start + 1; i < end; i++) {
    if (/^\s*command\s*=/.test(lines[i])) {
      lines[i] = ownedValues.command;
      commandSeen = true;
    } else if (/^\s*args\s*=/.test(lines[i])) {
      lines[i] = ownedValues.args;
      argsSeen = true;
    }
  }

  // A malformed/incomplete owned entry is repaired in place. Nested tables and
  // every line outside this table remain byte-for-byte untouched.
  const missing = [];
  if (!commandSeen) missing.push(ownedValues.command);
  if (!argsSeen) missing.push(ownedValues.args);
  if (missing.length) {
    const insertAt = end > start + 1 && lines[end - 1] === '' ? end - 1 : end;
    lines.splice(insertAt, 0, ...missing);
  }
  const next = lines.join('\n');
  return { raw: next, found: true, changed: next !== raw };
}

export function apply({ codexHome = CODEX_HOME } = {}) {
  const config = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(codexHome)) {
    return { action: 'skipped', reason: 'codex not installed', config };
  }
  let raw = '';
  let existed = false;
  try { raw = fs.readFileSync(config, 'utf8'); existed = true; } catch {}

  // Patch only our owned command/args lines. This repairs stale absolute paths
  // after a checkout moves while preserving legacy IDs and unrelated bytes.
  const primary = patchOwnedTable(raw, PRIMARY_ID);
  const legacy = patchOwnedTable(primary.raw, LEGACY_ID);
  let next = legacy.raw;
  let action;
  if (primary.found || legacy.found) {
    if (primary.changed || legacy.changed) action = 'updated';
    else if (legacy.found && !primary.found) action = 'legacy-compatible';
    else action = 'unchanged';
  } else {
    const block = [
      `[mcp_servers.${PRIMARY_ID}]`,
      ownedValues.command,
      ownedValues.args
    ].join('\n');
    next = (raw.trimEnd() + (raw.trim() ? '\n\n' : '') + block + '\n').replace(/^\n+/, '');
    action = existed ? 'appended' : 'created';
  }

  if (!DRY && next !== raw) {
    fs.mkdirSync(codexHome, { recursive: true });
    if (existed) fs.copyFileSync(config, config + '.bak');
    fs.writeFileSync(config, next);
  }
  return {
    action: DRY ? `${action} (dry-run)` : action,
    config,
    server: SERVER,
    id: legacy.found && !primary.found ? LEGACY_ID : PRIMARY_ID
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = apply();
  if (r.action === 'skipped') {
    console.log(`codex not installed (${CODEX_HOME} missing), setup script ready — run it after installing Codex.`);
  } else if (r.id === LEGACY_ID) {
    console.log(`${r.action}: ${r.config}\n  [mcp_servers.${LEGACY_ID}] preserved and points to node ${r.server}`);
    console.log(`New installs use [mcp_servers.${PRIMARY_ID}]. No duplicate server was added.`);
  } else {
    console.log(`${r.action}: ${r.config}\n  [mcp_servers.${PRIMARY_ID}] -> node ${r.server}`);
    console.log('Also paste adapters/codex/agents-snippet.md into your project AGENTS.md.');
  }
}
