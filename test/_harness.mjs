// Minimal check harness. Each test file prints its own lines and ends with a
// machine-readable tally that test/run.mjs aggregates.
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
  '/private/tmp/claude-501/-Users-ashar-tools-I-want-to-build-and-opensource/7e8af819-c523-417c-946a-b3406b7a8eb8/scratchpad';
