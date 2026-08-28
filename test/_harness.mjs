// Minimal check harness. Each test file prints its own lines and ends with a
// machine-readable tally that test/run.mjs aggregates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let total = 0;
let failures = 0;

export function check(cond, label, extra = '') {
  total++;
  if (cond) { console.log(`  ok   ${label}`); return true; }
  failures++;
  console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`);
  return false;
}

export function done() {
  console.log(`\nTALLY checks=${total} failures=${failures}`);
  process.exit(failures ? 1 : 0);
}

export const SCRATCH = process.env.PR_SCRATCH ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'teambrrr-tests-'));
