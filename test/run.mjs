#!/usr/bin/env node
// Runs every test file and aggregates the tallies.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  'smoke.mjs', 'core.mjs', 'digest.mjs', 'discuss.mjs',
  'audition.mjs', 'offers.mjs', 'persona.mjs', 'context.mjs',
  'hooks.mjs', 'hermes.mjs', 'slack.mjs',
  'execution.mjs', 'role-packs.mjs', 'room-extensions.mjs'
];

let checks = 0;
let failures = 0;

for (const f of FILES) {
  console.log(`\n=== ${f} ===`);
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, f)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; process.stdout.write(d); });
    p.on('close', (code) => resolve({ buf, code }));
  });
  const m = /TALLY checks=(\d+) failures=(\d+)/.exec(out.buf);
  if (m) { checks += Number(m[1]); failures += Number(m[2]); }
  else { failures++; console.log(`  FAIL ${f} produced no tally (exit ${out.code})`); }
}

console.log(`\n${'='.repeat(40)}`);
console.log(failures ? `${checks} checks, ${failures} FAILURE(S)` : `${checks} checks, all passed`);
process.exit(failures ? 1 : 0);
