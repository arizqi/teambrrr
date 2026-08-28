# Execution bridge

The execution bridge lets a recruited persona remain the same named agent while
an external runtime performs durable work. The room is the control plane;
Hermes, OpenClaw, or another host remains the execution and policy boundary.

## Lifecycle

```text
chair assigns → worker claims lease → progress/heartbeat
                                      ├─→ approval requested → chair approves → running
                                      ├─→ approval rejected  → failed
                                      └─→ completed | failed | canceled
```

Every task binds to a stable agent ID, `room-recruit:<handle>`. Assignment and
terminal writes support idempotency keys, updates use optimistic versions, and
workers must present the active lease token. Expired work can be reclaimed.
Every transition is appended to the execution event log and mirrored into the
room event stream so later conversation can see what happened.

State lives under `<stateDir>/execution/`. The reference file store uses private
directory/file modes, atomic JSON replacement, a write lock, append-only JSONL
events, and catch-up plus live subscriptions. It is suitable for one trusted
local user; it is not a multi-tenant or remote authorization service.

## Chair API

`createRoom()` exposes the operations used by desktop hosts and MCP:

```js
const task = await room.assignTask({
  name: 'reviewer',
  title: 'Review the migration',
  input: { instructions: 'Read-only review. Return findings with file references.' },
  idempotency_key: 'migration-17:review'
});

room.taskStatus({ task_id: task.task.id });       // omit task_id to list
// Only after the worker has requested approval:
room.decideTask({
  task_id: task.task.id,
  approval_id: 'approval_id_from_task_status',
  decision: 'approve',
  reason: 'Read only.'
});
room.cancelTask({
  task_id: task.task.id,
  reason: 'Superseded.',
  idempotency_key: 'migration-17:cancel'
});
```

The corresponding MCP tools are `assign_task`, `tasks`, `task_decide`, and
`task_cancel`. Assignment refuses unknown recruits. Approval records a human
decision in this control plane; it never grants a capability the runtime policy
does not already permit.

## Direct-import worker

An execution runtime imports the small adapter and supplies the actual tool
loop. The adapter intentionally knows nothing about shells, browsers, CRMs, or
email providers.

```js
import { createExecutionWorker } from './adapters/execution/index.mjs';

const worker = createExecutionWorker({
  stateDir: process.env.ROOM_STATE_DIR,
  workerId: 'hermes-local-1',
  agent: { name: 'reviewer', model: 'provider/model' }
});

const claimed = await worker.claim();
if (claimed.task) {
  const { task, leaseToken } = claimed;
  await worker.progress(task.id, leaseToken, { progress: { message: 'Reading the diff', percent: 25 } });

  // The host applies its own allowlist/sandbox before any tool call.
  // For consequential work it may pause:
  await worker.requestApproval(task.id, leaseToken, {
    request: {
      summary: 'Apply the reviewed migration patch',
      action: { kind: 'filesystem.write', target: 'migration files' }
    }
  });

  // After an approval transition, reclaim the task and use the new lease.
  const resumed = await worker.claim({ taskId: task.id });
  await worker.complete(resumed.task.id, resumed.leaseToken, {
    result: { summary: 'Review complete', artifacts: [] },
    idempotencyKey: `${resumed.task.id}:complete`
  });
}
```

Workers can also `heartbeat`, `fail`, `get`, `list`, read `events`, or
`subscribe`. Integrations should persist their last event sequence and reconnect
from it. A handler must tolerate duplicate delivery; mutations themselves are
idempotent where duplication would be dangerous.

## Security boundary

- Task instructions and model output are untrusted data, never executable policy.
- The runtime authenticates workers and enforces tool, filesystem, network,
  secret, data, and approval rules.
- A room approval cannot override a runtime deny rule.
- Completion receipts should describe tools, artifacts, costs, and policy
  decisions; the local schema currently accepts generic JSON and does not attest
  those claims.
- Do not expose the filesystem store to mutually untrusted users or hosts.

## Current limits

The lifecycle and direct-import contract are tested without network access, but
no real Hermes or OpenClaw process has completed an end-to-end tool task through
this repository. The next production step is the authenticated Agent Room
Protocol and SQLite daemon described in the
[enterprise roadmap](ENTERPRISE_ROADMAP.md), followed by adapter conformance and
reconnect tests against live runtimes.
