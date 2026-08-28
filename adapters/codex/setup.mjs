#!/usr/bin/env node
// Register the persona-recruiter MCP server with Codex CLI.
// Idempotent, and it never rewrites entries it does not own.
//   node adapters/codex/setup.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', '..', 'server', 'index.mjs');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CONFIG = path.join(CODEX_HOME, 'config.toml');
const DRY = process.argv.includes('--dry-run');

const BLOCK = [
  '[mcp_servers.persona-recruiter]',
  'command = "node"',
  `args = ["${SERVER}"]`
].join('\n');

export function apply({ codexHome = CODEX_HOME } = {}) {
  const config = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(codexHome)) {
    return { action: 'skipped', reason: 'codex not installed', config };
  }
  let raw = '';
  let existed = false;
  try { raw = fs.readFileSync(config, 'utf8'); existed = true; } catch {}

  // Replace only our own table; every other entry is left byte-for-byte alone.
  const header = /^\[mcp_servers\.persona-recruiter\]\s*$/m;
  let next;
  let action;
  if (header.test(raw)) {
    const lines = raw.split('\n');
    const start = lines.findIndex((l) => header.test(l));
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    const current = lines.slice(start, end).join('\n').trimEnd();
    if (current === BLOCK) return { action: 'unchanged', config, server: SERVER };
    lines.splice(start, end - start, ...BLOCK.split('\n'), '');
    next = lines.join('\n');
    action = 'updated';
  } else {
    next = (raw.trimEnd() + (raw.trim() ? '\n\n' : '') + BLOCK + '\n').replace(/^\n+/, '');
    action = existed ? 'appended' : 'created';
  }

  if (!DRY) {
    fs.mkdirSync(codexHome, { recursive: true });
    if (existed) fs.copyFileSync(config, config + '.bak');
    fs.writeFileSync(config, next);
  }
  return { action: DRY ? `${action} (dry-run)` : action, config, server: SERVER };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = apply();
  if (r.action === 'skipped') {
    console.log(`codex not installed (${CODEX_HOME} missing), setup script ready — run it after installing Codex.`);
  } else {
    console.log(`${r.action}: ${r.config}\n  [mcp_servers.persona-recruiter] -> node ${r.server}`);
    console.log('Also paste adapters/codex/agents-snippet.md into your project AGENTS.md.');
  }
}
