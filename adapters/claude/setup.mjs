#!/usr/bin/env node
// Register TeamBrrr with a Claude Code project.
// Idempotent: only the teambrrr MCP entry and its three hook entries are owned.
//   node adapters/claude/setup.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..', '..');
const MCP_ID = 'teambrrr';
const HOOKS = [
  ['SessionStart', 'session-start.mjs', true],
  ['UserPromptSubmit', 'user-prompt-submit.mjs', true],
  ['Stop', 'stop.mjs', false]
];
const LEGACY_MCP_ID = 'persona-recruiter';
const OWNED_CHECKOUT_NAMES = new Set(['teambrrr', 'persona-recruiter']);

const quoteShell = (value) => process.platform === 'win32'
  ? `"${String(value).replaceAll('"', '\\"')}"`
  : `'${String(value).replaceAll("'", "'\\''")}'`;

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw new Error(`cannot parse ${file}: ${error.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function desiredMcp(serverPath) {
  return { command: 'node', args: [serverPath] };
}

function desiredHook(file, matcher) {
  const entry = { type: 'command', command: `node ${quoteShell(file)}` };
  return matcher
    ? { matcher: '*', hooks: [entry] }
    : { hooks: [entry] };
}

function commandPath(command) {
  if (typeof command !== 'string') return null;
  const match = /^\s*node\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(command);
  return match?.[1] || match?.[2] || match?.[3] || null;
}

// The old installer had no marker in settings.json. The narrowest reliable
// migration signature is therefore: node, a checkout named teambrrr or
// persona-recruiter, /hooks/, and the event's exact hook filename.
function isOwnedLegacyCommand(command, filename) {
  const file = commandPath(command);
  if (!file) return false;
  const parts = file.replaceAll('\\', '/').split('/');
  return parts.at(-1) === filename &&
    parts.at(-2) === 'hooks' &&
    parts.slice(0, -2).some((part) => OWNED_CHECKOUT_NAMES.has(part));
}

function installHooks(settings, root) {
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  for (const [event, filename, matcher] of HOOKS) {
    const hookPath = path.join(root, 'hooks', filename);
    const command = `node ${quoteShell(hookPath)}`;
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const entries = [];
    let ownedSeen = false;

    for (const entry of existing) {
      if (!Array.isArray(entry?.hooks)) {
        entries.push(entry);
        continue;
      }
      const hooks = [];
      for (const hook of entry.hooks) {
        const exact = hook?.type === 'command' && hook.command === command;
        const legacy = hook?.type === 'command' && isOwnedLegacyCommand(hook.command, filename);
        if (exact || legacy) {
          if (ownedSeen) continue; // remove only duplicate owned hooks
          ownedSeen = true;
          hooks.push(legacy && !exact ? { ...hook, command } : hook);
        } else {
          hooks.push(hook);
        }
      }
      // Keep the group and its unrelated metadata even when it contained only
      // a duplicate owned hook; JSON structure outside our hook remains intact.
      entries.push({ ...entry, hooks });
    }
    if (!ownedSeen) entries.push(desiredHook(hookPath, matcher));
    settings.hooks[event] = entries;
  }
}

export function install({ projectDir = process.cwd(), packageRoot = PACKAGE_ROOT, dryRun = false } = {}) {
  const root = path.resolve(packageRoot);
  const project = path.resolve(projectDir);
  const mcpFile = path.join(project, '.mcp.json');
  const settingsFile = path.join(project, '.claude', 'settings.json');
  const serverPath = path.join(root, 'server', 'index.mjs');

  const mcp = loadJson(mcpFile, {});
  const settings = loadJson(settingsFile, {});
  if (!mcp.mcpServers || typeof mcp.mcpServers !== 'object' || Array.isArray(mcp.mcpServers)) {
    mcp.mcpServers = {};
  }
  // Migrate the one legacy key we own. Removing it is intentional; keeping it
  // would make Claude start the same server twice after a checkout rename.
  const migratedLegacyMcp = Object.prototype.hasOwnProperty.call(mcp.mcpServers, LEGACY_MCP_ID);
  if (migratedLegacyMcp) delete mcp.mcpServers[LEGACY_MCP_ID];
  mcp.mcpServers[MCP_ID] = desiredMcp(serverPath);

  installHooks(settings, root);

  if (!dryRun) {
    writeJson(mcpFile, mcp);
    writeJson(settingsFile, settings);
  }
  return {
    projectDir: project,
    mcpFile,
    settingsFile,
    serverPath,
    dryRun,
    migratedLegacyMcp,
    mcp,
    settings
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = install({ dryRun: process.argv.includes('--dry-run') });
    console.log(`${result.dryRun ? 'would update' : 'updated'} ${result.mcpFile}`);
    console.log(`${result.dryRun ? 'would update' : 'updated'} ${result.settingsFile}`);
    console.log('Registered teambrrr MCP plus SessionStart, UserPromptSubmit, and Stop hooks.');
  } catch (error) {
    console.error(`Claude setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
