#!/usr/bin/env node
// Deterministic, offline release gate. It audits source identity and the
// actual npm pack manifest without creating or publishing an archive.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

check(PACKAGE.name === 'teambrrr', 'package name is teambrrr');
check(PACKAGE.description.includes('TeamBrrr'), 'package description uses TeamBrrr branding');
check(PACKAGE.bin?.teambrrr === './server/index.mjs', 'teambrrr is the primary CLI');
check(PACKAGE.bin?.['persona-recruiter'] === './server/index.mjs', 'legacy CLI alias is bundled by teambrrr');
check(read('README.md').startsWith('# TeamBrrr'), 'README has the public TeamBrrr heading');
check(read('README.md').includes('When you install\n`teambrrr`'), 'README scopes compatibility to installing teambrrr');
check(!read('README.md').includes('npm install persona-recruiter'), 'README does not claim a legacy npm package');
check(!read('README.md').includes('…/hooks/'), 'README has no literal ellipsis hook paths');
check(/node\s+\S*adapters\/claude\/setup\.mjs/.test(read('README.md')), 'README has executable Claude setup instructions');
check(read('README.md').includes('migrates that owned MCP entry'), 'README documents Claude rename migration');
check(read('README.md').includes('"mcpServers"') && read('README.md').includes('"teambrrr"'), 'README includes a valid Claude MCP example');
check(read('server/index.mjs').includes("name: 'teambrrr'"), 'MCP server uses the TeamBrrr identifier');
check(read('test/smoke.mjs').includes("from './mcp-sdk.mjs'"), 'smoke test uses package-aware MCP SDK resolution');

const textFiles = [];
function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.room', '.claude', '.codex'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.isFile()) {
      try {
        const body = fs.readFileSync(full);
        if (!body.includes(0)) textFiles.push({ path: path.relative(ROOT, full), body: body.toString('utf8') });
      } catch { /* unreadable/binary files are outside this text audit */ }
    }
  }
}
collect(ROOT);

// Keep the known session path split so the audit itself does not contain it.
// The generic home-directory pattern catches other machine-specific paths too.
const privateTmpPath = ['/private', 'tmp', 'claude-501'].join('/');
const developerPathPattern = /\/(?:Users|home)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/|\s|$)/;
const forbiddenPathPatterns = [privateTmpPath, developerPathPattern];
for (const file of textFiles) {
  for (const pattern of forbiddenPathPatterns) {
    const found = typeof pattern === 'string' ? file.body.includes(pattern) : pattern.test(file.body);
    check(!found, `${file.path} has no developer-specific absolute path`);
  }
  check(!/sk-or-v1-[A-Za-z0-9_-]{8,}/.test(file.body), `${file.path} has no credential-shaped OpenRouter fixture`);
}

const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: {
    ...process.env,
    npm_config_loglevel: 'error',
    npm_config_cache: fs.mkdtempSync(path.join(os.tmpdir(), 'teambrrr-npm-cache-'))
  }
});
check(pack.status === 0, 'npm pack dry run succeeds');
if (pack.status === 0) {
  let manifest;
  try { manifest = JSON.parse(pack.stdout)[0]; }
  catch { manifest = null; }
  check(Array.isArray(manifest?.files) && manifest.files.length > 0, 'npm pack reports release contents');
  const files = new Set((manifest?.files || []).map((entry) => entry.path));
  for (const required of ['README.md', 'LICENSE', 'core/room.mjs', 'server/index.mjs', 'adapters/claude/setup.mjs', 'test/release-audit.mjs']) {
    check(files.has(required), `npm pack includes ${required}`);
  }
  for (const entry of files) {
    check(!entry.startsWith('node_modules/') && !entry.endsWith('.env'), `npm pack excludes runtime/dependency file ${entry}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} release-audit failure(s)`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}

console.log(`Release audit passed: branding, source hygiene, and npm pack contents checked`);
