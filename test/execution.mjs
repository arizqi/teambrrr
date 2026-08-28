#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {
  createExecutionBridge, createFileExecutionStore, roomEventForTaskEvent,
  TASK_STATUSES, TERMINAL_STATUSES
} from '../core/execution.mjs';
import { createExecutionWorker } from '../adapters/execution/index.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-execution-'));
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const rejects = async (promise, code, message) => {
  await assert.rejects(promise, (error) => error?.code === code, message); checks++;
};
const agent = { id: 'agent_01HSTABLE', name: 'sdr', model: 'openai/gpt-4.1-mini' };

console.log('execution bridge tests\n');

// Deterministic clock and ids make every lifecycle assertion stable.
let clock = Date.parse('2030-01-01T00:00:00.000Z');
let serial = 0;
const roomEvents = [];
const stateDir = path.join(ROOT, 'state');
const bridge = createExecutionBridge({
  stateDir,
  now: () => clock,
  randomUUID: () => `id-${++serial}`,
  appendRoomEvent: async (event) => roomEvents.push(event),
  defaultLeaseMs: 1_000
});

equal(TASK_STATUSES.length, 7, 'all lifecycle states are exported');
check(TERMINAL_STATUSES.has('completed') && !TERMINAL_STATUSES.has('running'), 'terminal states are explicit');

// create is durable, identity-preserving, and idempotent.
const created = await bridge.createTask({
  id: 'task-sdr-1', idempotencyKey: 'lead-42', agent, room_id: 'sales-room',
  title: 'Research Acme', input: { account: 'Acme' }, metadata: { source: 'slack' }
});
equal(created.task.status, 'assigned', 'new task is assigned and ready to claim');
equal(created.task.agent, agent, 'stable recruit id/name/model are preserved');
equal(created.task.version, 1, 'new task begins at version one');
equal(created.task.input, { account: 'Acme' }, 'structured input is preserved');
check(created.events[0].type === 'task.created' && created.events[0].seq === 1, 'create emits first append-only event');
check(created.mirrored && roomEvents.length === 1, 'create event is mirrored into room stream');
equal(roomEvents[0].task_id, 'task-sdr-1', 'room mirror references the same task');
equal(roomEvents[0].agent_id, agent.id, 'room mirror references the same agent');
equal(roomEvents[0].model, agent.model, 'room mirror preserves model provenance');

const replay = await bridge.createTask({
  id: 'task-sdr-1', idempotencyKey: 'lead-42', agent, room_id: 'sales-room',
  title: 'Research Acme', input: { account: 'Acme' }, metadata: { source: 'slack' }
});
check(replay.idempotent && replay.task.id === created.task.id, 'same create key returns same task');
equal(replay.events.length, 0, 'idempotent create emits no duplicate event');
await rejects(bridge.createTask({
  id: 'task-other', idempotencyKey: 'lead-42', agent, title: 'Different'
}), 'IDEMPOTENCY_CONFLICT', 'same create key cannot change intent');

const generated = await bridge.createTask({ idempotencyKey: 'generated-id', agent, title: 'Generated identity' });
const generatedReplay = await bridge.createTask({ idempotencyKey: 'generated-id', agent, title: 'Generated identity' });
check(generated.task.id.startsWith('task_'), 'bridge can generate a stable task id');
equal(generatedReplay.task.id, generated.task.id, 'generated id survives an idempotent create retry');
check(generatedReplay.idempotent, 'generated-id retry is marked idempotent');

const diskTask = JSON.parse(fs.readFileSync(path.join(stateDir, 'execution', 'tasks', 'task-sdr-1.json'), 'utf8'));
equal(diskTask.id, created.task.id, 'task survives as durable JSON');
if (process.platform !== 'win32') {
  equal(fs.statSync(path.join(stateDir, 'execution')).mode & 0o777, 0o700, 'execution directory is private');
  equal(fs.statSync(path.join(stateDir, 'execution', 'tasks', 'task-sdr-1.json')).mode & 0o777, 0o600, 'task file is private');
}

// Worker direct-import API: claim, lease, heartbeat, progress.
const worker = createExecutionWorker({ bridge, workerId: 'hermes-01', agent, leaseMs: 1_000 });
equal(worker.agent.id, agent.id, 'worker adapter binds stable agent id');
const claim = await worker.claim({ taskId: 'task-sdr-1', expectedVersion: 1 });
equal(claim.task.status, 'running', 'worker claims task');
equal(claim.task.worker_id, 'hermes-01', 'claim records worker identity');
equal(claim.task.attempt, 1, 'first claim records first attempt');
check(claim.leaseToken.startsWith('lease_'), 'claim returns opaque lease token');
await rejects(worker.progress('task-sdr-1', 'wrong-token', { progress: { percent: 5 } }),
  'LEASE_TOKEN_MISMATCH', 'wrong lease cannot report progress');

clock += 200;
const beat = await worker.heartbeat('task-sdr-1', claim.leaseToken);
equal(beat.task.version, 3, 'heartbeat advances optimistic version');
equal(beat.task.lease.expires_at, '2030-01-01T00:00:01.200Z', 'heartbeat extends lease from current time');
clock += 100;
const progress = await worker.progress('task-sdr-1', claim.leaseToken, { progress: { percent: 40, message: 'two leads checked' } });
equal(progress.task.progress.percent, 40, 'structured progress is durable');
check(progress.events[0].text.includes('two leads checked'), 'progress event is human-readable');
await rejects(worker.heartbeat('task-sdr-1', claim.leaseToken, { expectedVersion: 2 }),
  'VERSION_CONFLICT', 'stale optimistic version is refused');

// Human approval pauses execution and forces a fresh claim after approval.
const asked = await worker.requestApproval('task-sdr-1', claim.leaseToken, {
  request: { action: 'send_email', recipient: 'buyer@example.com' }
});
equal(asked.task.status, 'awaiting_approval', 'approval request pauses task');
equal(asked.task.lease, null, 'approval request releases execution lease');
check(asked.approvalId.startsWith('approval_'), 'approval has stable id');
await rejects(worker.complete('task-sdr-1', claim.leaseToken, { idempotencyKey: 'premature', result: {} }),
  'NOT_RUNNING', 'paused worker cannot complete without approval and reclaim');
const approved = await bridge.approveTask({ taskId: 'task-sdr-1', approvalId: asked.approvalId, by: 'ashar' });
equal(approved.task.status, 'assigned', 'approval returns task to claimable state');
equal(approved.task.approval.status, 'approved', 'approval decision is durable');
const reclaimed = await worker.claim({ taskId: 'task-sdr-1' });
equal(reclaimed.task.attempt, 2, 'post-approval work receives a fresh lease and attempt');

clock += 100;
const completed = await worker.complete('task-sdr-1', reclaimed.leaseToken, {
  idempotencyKey: 'done-lead-42', result: { account: 'Acme', contacts: 3 }
});
equal(completed.task.status, 'completed', 'worker completes task');
equal(completed.task.result.contacts, 3, 'executor result returns on same task identity');
equal(completed.task.agent.id, agent.id, 'terminal result remains attached to recruit identity');
const completedReplay = await worker.complete('task-sdr-1', reclaimed.leaseToken, {
  idempotencyKey: 'done-lead-42', result: { account: 'Acme', contacts: 3 }
});
check(completedReplay.idempotent, 'terminal retry is idempotent after lease is gone');
equal(completedReplay.events.length, 0, 'terminal retry emits no duplicate event');
await rejects(worker.complete('task-sdr-1', reclaimed.leaseToken, {
  idempotencyKey: 'done-lead-42', result: { contacts: 99 }
}), 'IDEMPOTENCY_CONFLICT', 'terminal key cannot hide changed result');

// Lease expiry permits takeover but blocks the stale worker.
await bridge.createTask({ id: 'task-expiry', idempotencyKey: 'expiry', agent, title: 'Long job' });
const first = await worker.claim({ taskId: 'task-expiry' });
clock += 1_001;
await rejects(worker.heartbeat('task-expiry', first.leaseToken), 'LEASE_EXPIRED', 'expired lease cannot heartbeat');
const worker2 = createExecutionWorker({ bridge, workerId: 'openclaw-02', agent, leaseMs: 500 });
const takeover = await worker2.claim({ taskId: 'task-expiry' });
check(takeover.reclaimed && takeover.task.attempt === 2, 'expired work can be safely reclaimed');
await rejects(worker.complete('task-expiry', first.leaseToken, { idempotencyKey: 'old-worker', result: 'bad' }),
  'LEASE_OWNER_MISMATCH', 'old worker cannot finish after takeover');
await worker2.fail('task-expiry', takeover.leaseToken, { idempotencyKey: 'failed-expiry', error: 'upstream unavailable' });
equal(bridge.getTask('task-expiry').status, 'failed', 'worker failure is terminal and durable');

// Rejection and cancellation cover remaining terminal paths.
await bridge.createTask({ id: 'task-reject', idempotencyKey: 'reject', agent, title: 'Sensitive write' });
const rejectClaim = await worker.claim({ taskId: 'task-reject' });
const pending = await worker.requestApproval('task-reject', rejectClaim.leaseToken, { request: { action: 'delete_record' } });
const rejected = await bridge.rejectTask({
  taskId: 'task-reject', idempotencyKey: 'reject-decision', by: 'security',
  reason: 'outside policy', approvalId: pending.approvalId
});
equal(rejected.task.status, 'failed', 'approval rejection closes task as failed');
equal(rejected.task.approval.status, 'rejected', 'rejected approval is recorded');
await bridge.createTask({ id: 'task-cancel', idempotencyKey: 'cancel', agent, title: 'No longer needed' });
const canceled = await bridge.cancelTask({ taskId: 'task-cancel', idempotencyKey: 'cancel-once', reason: 'campaign stopped' });
equal(canceled.task.status, 'canceled', 'unclaimed task can be canceled');
equal(canceled.task.canceled_reason, 'campaign stopped', 'cancellation reason is durable');

// List/get filters, append-only event sequencing, subscription (not polling).
equal(bridge.listTasks({ agentId: agent.id }).length, 5, 'agent filter returns all of this recruit tasks');
equal(bridge.listTasks({ roomId: 'sales-room' }).length, 1, 'room filter isolates room task');
equal(bridge.listTasks({ status: ['failed', 'canceled'] }).length, 3, 'status filter supports arrays');
check(bridge.getTask('task-sdr-1').result.contacts === 3, 'get returns terminal result');
const history = bridge.tailEvents({ afterSeq: 0, limit: 500 });
check(history.length >= 15, 'full append-only lifecycle is retained');
equal(history.map((e) => e.seq), history.map((_e, i) => i + 1), 'event sequence is gapless and ordered');
check(history.every((e, i) => i === 0 || e.seq > history[i - 1].seq), 'events are never rewritten or reordered');
const converted = roomEventForTaskEvent(history[0]);
equal(converted.type, 'task_event', 'room event conversion is exported independently');

const pushed = [];
const stop = bridge.subscribe({ afterSeq: history.at(-1).seq, onEvent: (event) => pushed.push(event) });
await bridge.createTask({ id: 'task-live', idempotencyKey: 'live', agent, title: 'Live delivery' });
await new Promise((resolve) => setImmediate(resolve));
stop();
equal(pushed.length, 1, 'subscriber receives new event without polling');
equal(pushed[0].task_id, 'task-live', 'subscription carries task identity');

// A second bridge proves files are the authority, not process memory.
const reopened = createExecutionBridge({ stateDir });
equal(reopened.getTask('task-sdr-1').status, 'completed', 'fresh process-facing bridge reads durable state');
equal(reopened.tailEvents({ afterSeq: 0, limit: 500 }).length, bridge.tailEvents({ afterSeq: 0, limit: 500 }).length,
  'fresh bridge reads full durable event log');

// Provided-store seam is accepted (wrapped file store here to stay durable).
const providedDir = path.join(ROOT, 'provided');
const providedStore = createFileExecutionStore({ stateDir: providedDir });
const injected = createExecutionBridge({ store: providedStore, now: () => clock, randomUUID: () => `provided-${++serial}` });
await injected.createTask({ id: 'task-injected', idempotencyKey: 'injected', agent, title: 'Injected store' });
equal(providedStore.get('task-injected').title, 'Injected store', 'explicit store abstraction owns persistence');
check(!fs.existsSync(path.join(os.homedir(), '.room', 'execution', 'tasks', 'task-injected.json')),
  'tests never write a real ~/.room task');

// Control-plane guarantee: the task payload is data; no command/tool runs.
await injected.createTask({
  id: 'task-control-only', idempotencyKey: 'control-only', agent,
  input: { tool: 'shell', command: 'touch /definitely-not-run-by-bridge' }
});
check(!fs.existsSync('/definitely-not-run-by-bridge'), 'bridge never executes requested tools');

// Assignment and claim arbitration exercise the lock across two callers.
const reviewer = { id: 'agent_review', name: 'reviewer', model: 'anthropic/claude-sonnet' };
await injected.createTask({ id: 'task-race', idempotencyKey: 'race', agent, title: 'Review concurrently' });
const reassigned = await injected.assignTask({ taskId: 'task-race', agent: reviewer, expectedVersion: 1 });
equal(reassigned.task.agent, reviewer, 'task can be reassigned while still claimable');
equal(reassigned.task.version, 2, 'assignment participates in optimistic versioning');
const hermesReviewer = createExecutionWorker({ bridge: injected, workerId: 'hermes-reviewer', agent: reviewer });
const openclawReviewer = createExecutionWorker({ bridge: injected, workerId: 'openclaw-reviewer', agent: reviewer });
const raced = await Promise.all([hermesReviewer.claim({ taskId: 'task-race' }), openclawReviewer.claim({ taskId: 'task-race' })]);
equal(raced.filter((r) => r.task).length, 1, 'store lock permits exactly one concurrent-ish claimant');
equal(raced.filter((r) => !r.task).length, 1, 'losing claimant receives no task instead of stealing lease');
equal(injected.getTask('task-race').attempt, 1, 'claim race creates only one execution attempt');

console.log(`\nTALLY checks=${checks} failures=0`);
