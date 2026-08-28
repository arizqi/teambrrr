import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoom } from '../core/room.mjs';
import { createExecutionWorker } from '../adapters/execution/index.mjs';
import { check, done } from './_harness.mjs';

console.log('room extension integration tests\n');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-room-ext-'));
const stateDir = path.join(scratch, 'state');
const rolePackDir = path.join(scratch, 'role-packs');
fs.mkdirSync(rolePackDir, { recursive: true });

const pack = {
  schema_version: 1,
  id: 'test-worker',
  name: 'Test Worker',
  version: '1.0.0',
  mission: 'Return a bounded, verifiable answer.',
  default_volume: { per_day: 2, tokens_in: 100, tokens_out: 20 },
  candidate_requirements: {
    model_patterns: ['*/*'], min_context_tokens: 1,
    required_capabilities: ['instruction-following'], notes: 'fixture'
  },
  trial_count: 1,
  prompt_template: 'Follow the mission: {{mission}}',
  permissions: { tools: [], data: [], network: 'none', approval_required: [], notes: 'fixture' },
  cases: [{ id: 'basic', name: 'Basic', prompt: 'Return PASS.', context: 'fixture', evaluator_ids: ['pass'] }],
  evaluators: [{ id: 'pass', type: 'must_contain', weight: 1, required: true, fatal: true, values: ['PASS'] }]
};
fs.writeFileSync(path.join(rolePackDir, 'test-worker.json'), JSON.stringify(pack));

const provider = {
  name: 'mock',
  call: async ({ model }) => ({
    text: model === 'mock/bad' ? 'invented result' : 'PASS',
    cost: 0.001, latency_ms: 5, usage: { prompt_tokens: 10, completion_tokens: 1 }
  })
};
const room = createRoom({ stateDir, projectDir: scratch, rolePackDir, provider, autoMigrate: false, retryDelayMs: 0 });

const hired = await room.recruit({
  name: 'worker', model: 'mock/good', system_prompt: 'Do assigned work and report evidence.', briefing: 'Fixture room.'
});
check(hired.ok, 'recruit exists before work can be assigned');

const evaluation = await room.evaluateRole({
  role_pack: 'test-worker',
  candidates: [
    { model: 'mock/good', price: { prompt: 0.000001, completion: 0.000002 } },
    { model: 'mock/bad', price: { prompt: 0, completion: 0 } }
  ]
});
check(evaluation.ok && evaluation.rows[0].eligible, 'role-pack evaluation is exposed through room-core');
check(evaluation.offers?.length === 1, 'role evaluation returns a selectable cost offer');
check(evaluation.offers[0].model === 'mock/good' && !evaluation.offers.some((o) => o.model === 'mock/bad'),
  'ineligible candidates remain evidence but never become selectable offers');
check(evaluation.rows[0].evidence.length === 1, 'raw case and trial evidence survives integration');
check(room.roster().spend.byRecruit['evaluation:test-worker'].calls === 2, 'evaluation spend is attributed in the room ledger');

// Regression: an unpriced provider response must not let concurrent role-pack
// trials all pass the preflight check. With a $0.015 cap and $0.01 actual
// responses, only the first trial may spend; queued trials must settle as
// budget errors and make the candidate ineligible.
const budgetScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-room-budget-'));
let budgetCalls = 0;
const budgetProvider = {
  name: 'mock',
  call: async () => {
    budgetCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { text: 'PASS', cost: 0.01, latency_ms: 15, usage: { prompt_tokens: 10, completion_tokens: 1 } };
  }
};
const budgetRoom = createRoom({
  stateDir: path.join(budgetScratch, 'state'),
  projectDir: budgetScratch,
  rolePackDir,
  provider: budgetProvider,
  budget: 0.015,
  autoMigrate: false,
  retryDelayMs: 0
});
const budgetEvaluation = await budgetRoom.evaluateRole({
  role_pack: 'test-worker',
  candidates: [{ model: 'mock/unpriced' }],
  trials: 3,
  max_parallel: 3
});
const budgetEvidence = budgetEvaluation.rows?.[0]?.evidence || [];
const budgetErrors = budgetEvidence.filter((trial) => /budget|remaining|cap|unreserved/i.test(trial.error || ''));
check(budgetEvaluation.ok, 'budget regression evaluation completes without deadlock');
check(budgetCalls <= 1, 'unpriced concurrent trials reserve capacity before calling the provider');
check(Number(budgetRoom.roster().spend.total || 0) <= 0.015, 'budget reservation prevents overspend');
check(budgetErrors.length === 2 && budgetEvaluation.rows[0].eligible === false,
  'later trials become budget errors and the candidate is ineligible');
check(budgetEvaluation.offers?.length === 0, 'budget-ineligible candidate is not offered for hire');
fs.rmSync(budgetScratch, { recursive: true, force: true });

const assigned = await room.assignTask({
  name: 'worker', title: 'Prepare fixture result', input: { value: 7 },
  idempotency_key: 'fixture-assignment-1'
});
check(assigned.ok && assigned.task.status === 'assigned', 'chair assigns a durable task to the same recruit identity');
check(assigned.task.agent.id === 'room-recruit:worker', 'task uses the stable room recruit id');

const duplicate = await room.assignTask({
  name: 'worker', title: 'Prepare fixture result', input: { value: 7 },
  idempotency_key: 'fixture-assignment-1'
});
check(duplicate.ok && duplicate.idempotent && duplicate.task.id === assigned.task.id, 'chair retries are idempotent');

const executor = createExecutionWorker({
  bridge: room.execution,
  workerId: 'hermes-fixture',
  agent: { name: 'worker', model: 'mock/good' }
});
const claimed = await executor.claim({ taskId: assigned.task.id });
check(claimed.task.status === 'running' && claimed.leaseToken, 'direct-import runtime claims the task with a lease');
await executor.progress(assigned.task.id, claimed.leaseToken, { progress: { percent: 50, message: 'halfway' } });
check(room.taskStatus({ task_id: assigned.task.id }).task.progress.percent === 50, 'runtime progress is visible in the room');

const approval = await executor.requestApproval(assigned.task.id, claimed.leaseToken, {
  request: { action: 'send_email', summary: 'send the approved fixture' }
});
check(approval.task.status === 'awaiting_approval', 'runtime can request an explicit human approval');
const approved = await room.decideTask({
  task_id: assigned.task.id, approval_id: approval.approvalId,
  decision: 'approve', by: 'test-user', expected_version: approval.task.version
});
check(approved.ok && approved.task.status === 'assigned', 'chair approval returns work to the executor queue');

const reclaimed = await executor.claim({ taskId: assigned.task.id, expectedVersion: approved.task.version });
const completed = await executor.complete(assigned.task.id, reclaimed.leaseToken, {
  result: { sent: false, artifact: 'draft-1' }, idempotencyKey: 'fixture-complete-1'
});
check(completed.task.status === 'completed', 'runtime completes under the same durable identity');
check(room.taskStatus({ task_id: assigned.task.id }).task.result.artifact === 'draft-1', 'result is visible from the chair-facing room API');
check(room.events.tail(20).some((event) => event.task_id === assigned.task.id && /completed/.test(event.text)),
  'execution events mirror into shared room history');

const second = await room.assignTask({
  name: 'worker', title: 'Cancelable fixture', idempotency_key: 'fixture-assignment-2'
});
const canceled = await room.cancelTask({
  task_id: second.task.id, reason: 'no longer needed', idempotency_key: 'fixture-cancel-1'
});
check(canceled.ok && canceled.task.status === 'canceled', 'chair can cancel work idempotently');
check(room.taskStatus({ name: 'worker' }).tasks.length === 2, 'task list follows the recruit across execution states');

fs.rmSync(scratch, { recursive: true, force: true });
done();
