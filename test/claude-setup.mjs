#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { check, done, SCRATCH } from './_harness.mjs';
import { install } from '../adapters/claude/setup.mjs';

const ROOT = path.join(SCRATCH, 'claude-setup');
fs.rmSync(ROOT, { recursive: true, force: true });
const project = path.join(ROOT, 'project');
const packageRoot = path.join(ROOT, 'checkout-with-spaces');
fs.mkdirSync(path.join(project, '.claude'), { recursive: true });

const unrelatedMcp = { command: 'node', args: ['other-server.mjs'], env: { KEEP: 'yes' } };
const unrelatedHook = { matcher: '*', hooks: [{ type: 'command', command: 'node other-hook.mjs' }] };
fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({
  mcpServers: { unrelated: unrelatedMcp }
}, null, 2) + '\n');
fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({
  permissions: { allow: ['Read(*)'] }, hooks: { UserPromptSubmit: [unrelatedHook] }, theme: 'keep-me'
}, null, 2) + '\n');

console.log('Claude Code installer tests\n');
const first = install({ projectDir: project, packageRoot });
const mcp = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'));
const settings = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
check(mcp.mcpServers.unrelated.env.KEEP === 'yes', 'installer preserves unrelated MCP configuration');
check(mcp.mcpServers.teambrrr.command === 'node', 'installer writes a valid teambrrr MCP command');
check(mcp.mcpServers.teambrrr.args[0] === path.join(packageRoot, 'server', 'index.mjs'), 'MCP server path is checkout-derived');
check(settings.permissions.allow[0] === 'Read(*)' && settings.theme === 'keep-me', 'installer preserves unrelated settings');
check(settings.hooks.UserPromptSubmit.length === 2, 'existing UserPromptSubmit hooks are retained');
check(settings.hooks.SessionStart.length === 1 && settings.hooks.Stop.length === 1, 'all three TeamBrrr hook events are registered');
check(settings.hooks.SessionStart[0].matcher === '*', 'SessionStart has a wildcard matcher');
check(!settings.hooks.Stop[0].matcher, 'Stop keeps the documented no-matcher shape');
check(settings.hooks.SessionStart[0].hooks[0].command.includes('checkout-with-spaces'), 'hook command quotes a path with spaces');

const mcpBefore = fs.readFileSync(path.join(project, '.mcp.json'), 'utf8');
const settingsBefore = fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8');
const second = install({ projectDir: project, packageRoot });
check(second.mcp.mcpServers.teambrrr.args[0] === mcp.mcpServers.teambrrr.args[0], 'installer is idempotent');
check(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8') === mcpBefore, 'second MCP install is byte-identical');
check(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8') === settingsBefore, 'second settings install is byte-identical');

const dryProject = path.join(ROOT, 'dry-run');
const dry = install({ projectDir: dryProject, packageRoot, dryRun: true });
check(dry.dryRun && !fs.existsSync(path.join(dryProject, '.mcp.json')), 'dry-run writes nothing');

// Rename migration: an older checkout used the legacy MCP key and absolute
// hook paths. Only those owned entries may move or be deduplicated.
const migrationProject = path.join(ROOT, 'rename-migration');
fs.mkdirSync(path.join(migrationProject, '.claude'), { recursive: true });
const legacyHook = (filename) => `node '/old/work/persona-recruiter/hooks/${filename}'`;
const unrelatedHookEntry = (filename) => ({ type: 'command', command: `node unrelated-${filename}` });
const legacySettings = { permissions: { allow: ['Write(*)'] }, hooks: {} };
for (const [event, filename, matcher] of [
  ['SessionStart', 'session-start.mjs', true],
  ['UserPromptSubmit', 'user-prompt-submit.mjs', true],
  ['Stop', 'stop.mjs', false]
]) {
  legacySettings.hooks[event] = [
    { ...(matcher ? { matcher: '*' } : {}), label: `keep-${event}`, hooks: [
      { type: 'command', command: legacyHook(filename), timeout: 12 }, unrelatedHookEntry(filename)
    ] },
    { ...(matcher ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: legacyHook(filename) }] }
  ];
}
fs.writeFileSync(path.join(migrationProject, '.mcp.json'), JSON.stringify({
  mcpServers: { 'persona-recruiter': { command: 'node', args: ['/old/work/persona-recruiter/server/index.mjs'] }, unrelated: unrelatedMcp }
}, null, 2) + '\n');
fs.writeFileSync(path.join(migrationProject, '.claude', 'settings.json'), JSON.stringify(legacySettings, null, 2) + '\n');

const migrated = install({ projectDir: migrationProject, packageRoot });
const migratedMcp = JSON.parse(fs.readFileSync(path.join(migrationProject, '.mcp.json'), 'utf8'));
const migratedSettings = JSON.parse(fs.readFileSync(path.join(migrationProject, '.claude', 'settings.json'), 'utf8'));
check(migrated.migratedLegacyMcp, 'legacy MCP key is detected for migration');
check(Object.keys(migratedMcp.mcpServers).sort().join(',') === 'teambrrr,unrelated', 'legacy MCP key becomes one teambrrr entry');
check(migratedMcp.mcpServers.teambrrr.args[0] === path.join(packageRoot, 'server', 'index.mjs'), 'migrated MCP entry points to the current checkout');
check(migratedMcp.mcpServers.unrelated.env.KEEP === 'yes', 'unrelated MCP entry survives migration');
for (const [event, filename] of [['SessionStart', 'session-start.mjs'], ['UserPromptSubmit', 'user-prompt-submit.mjs'], ['Stop', 'stop.mjs']]) {
  const commands = migratedSettings.hooks[event].flatMap((entry) => entry.hooks || []).map((hook) => hook.command);
  const desired = commands.filter((command) => command.includes(path.join(packageRoot, 'hooks', filename)));
  check(desired.length === 1, `${event} has exactly one current owned hook`, JSON.stringify(commands));
  check(!commands.some((command) => String(command).includes('persona-recruiter/hooks')), `${event} removes only the old owned hook path`);
  check(commands.includes(`node unrelated-${filename}`), `${event} keeps its unrelated hook`);
}
check(migratedSettings.hooks.SessionStart[0].label === 'keep-SessionStart', 'unrelated hook-group metadata survives migration');

const migratedMcpBefore = fs.readFileSync(path.join(migrationProject, '.mcp.json'), 'utf8');
const migratedSettingsBefore = fs.readFileSync(path.join(migrationProject, '.claude', 'settings.json'), 'utf8');
install({ projectDir: migrationProject, packageRoot });
check(fs.readFileSync(path.join(migrationProject, '.mcp.json'), 'utf8') === migratedMcpBefore, 'migrated MCP config is idempotent');
check(fs.readFileSync(path.join(migrationProject, '.claude', 'settings.json'), 'utf8') === migratedSettingsBefore, 'migrated hook config is idempotent');

done();
