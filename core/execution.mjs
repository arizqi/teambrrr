// Host-neutral live-execution control plane.
//
// This module records what an executor should do; it never runs tools. Hermes,
// OpenClaw, or another worker claims tasks through adapters/execution and reports
// progress/results back under the same durable recruit identity.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TASK_STATUSES = Object.freeze([
  'queued', 'assigned', 'running', 'awaiting_approval',
  'completed', 'failed', 'canceled'
]);
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);
export const DEFAULT_LEASE_MS = 60_000;
export const EXECUTION_STORE_VERSION = 1;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const clone = (v) => v == null ? v : JSON.parse(JSON.stringify(v));
const iso = (ms) => new Date(ms).toISOString();
const asError = (code, message, details) => Object.assign(new Error(message), { code, details });
const assert = (condition, code, message, details) => {
  if (!condition) throw asError(code, message, details);
};
const finitePositive = (n, fallback) => Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : fallback;
const cleanId = (id, label = 'id') => {
  const value = String(id || '');
  assert(TASK_ID_RE.test(value), 'INVALID_ID', `${label} must match ${TASK_ID_RE}`);
  return value;
};
const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
};
const canonical = (value) => JSON.stringify(canonicalValue(value));
const same = (a, b) => canonical(a) === canonical(b);

function normalizeAgent(agent) {
  assert(agent && typeof agent === 'object', 'INVALID_AGENT', 'agent is required');
  const name = String(agent.name || '').replace(/^@/, '');
  assert(name, 'INVALID_AGENT', 'agent.name is required');
  const id = String(agent.id || agent.agent_id || `room-recruit:${name}`);
  assert(id, 'INVALID_AGENT', 'agent.id is required');
  return { id, name, model: agent.model == null ? null : String(agent.model) };
}

function ensureVersion(task, expectedVersion) {
  if (expectedVersion == null) return;
  assert(Number(expectedVersion) === task.version, 'VERSION_CONFLICT',
    `task ${task.id} is version ${task.version}, expected ${expectedVersion}`,
    { actual: task.version, expected: Number(expectedVersion) });
}

function ensureOpen(task) {
  assert(!TERMINAL_STATUSES.has(task.status), 'TASK_TERMINAL',
    `task ${task.id} is already ${task.status}`);
}

function ensureLease(task, { workerId, leaseToken, nowMs }) {
  assert(task.status === 'running', 'NOT_RUNNING', `task ${task.id} is ${task.status}, not running`);
  assert(task.worker_id === workerId, 'LEASE_OWNER_MISMATCH', `task ${task.id} is claimed by another worker`);
  assert(task.lease?.token === leaseToken, 'LEASE_TOKEN_MISMATCH', `invalid lease token for task ${task.id}`);
  assert(Date.parse(task.lease.expires_at) > nowMs, 'LEASE_EXPIRED', `lease expired for task ${task.id}`);
}

const eventText = (type, task, data = {}) => {
  const who = `@${task.agent.name}`;
  const map = {
    'task.created': `task ${task.id} created for ${who}`,
    'task.assigned': `task ${task.id} assigned to ${who}`,
    'task.claimed': `task ${task.id} claimed by ${data.worker_id}`,
    'task.heartbeat': `task ${task.id} heartbeat from ${data.worker_id}`,
    'task.progress': `task ${task.id} progress: ${data.message || (data.percent ?? '')}`.trim(),
    'task.approval_requested': `task ${task.id} requests approval`,
    'task.approved': `task ${task.id} approved by ${data.by}`,
    'task.rejected': `task ${task.id} rejected by ${data.by}`,
    'task.completed': `task ${task.id} completed by ${who}`,
    'task.failed': `task ${task.id} failed: ${data.error || 'unknown error'}`,
    'task.canceled': `task ${task.id} canceled${data.reason ? `: ${data.reason}` : ''}`
  };
  return map[type] || `${type}: task ${task.id}`;
};

export function roomEventForTaskEvent(event) {
  return {
    ts: event.ts,
    host: 'execution',
    author: event.agent?.name || 'execution',
    role: 'assistant',
    type: 'task_event',
    text: event.text,
    task_id: event.task_id,
    agent_id: event.agent?.id || null,
    model: event.agent?.model || null,
    task_event: clone(event)
  };
}

function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { fs.chmodSync(dir, DIR_MODE); } catch {}
}

function atomicJson(file, value) {
  mkdirPrivate(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: FILE_MODE });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, FILE_MODE); } catch {}
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return clone(fallback); }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Durable file-store contract used by createExecutionBridge():
//   transaction(fn), get(id), list(), events({afterSeq,limit}), subscribe(...).
// A different durable store can implement that same surface and be injected.
export function createFileExecutionStore({
  stateDir,
  lockTimeoutMs = 5_000,
  staleLockMs = 30_000,
  retryMs = 8
} = {}) {
  assert(stateDir, 'STATE_DIR_REQUIRED', 'stateDir is required when no store is provided');
  const root = path.join(path.resolve(stateDir), 'execution');
  const tasksDir = path.join(root, 'tasks');
  const eventsFile = path.join(root, 'events.jsonl');
  const indexFile = path.join(root, 'index.json');
  const lockFile = path.join(root, '.write.lock');
  const listeners = new Set();

  mkdirPrivate(tasksDir);
  if (!fs.existsSync(indexFile)) atomicJson(indexFile, { version: EXECUTION_STORE_VERSION, next_seq: 1, idempotency: {} });

  const taskPath = (id) => path.join(tasksDir, `${cleanId(id, 'task id')}.json`);

  async function acquireLock() {
    const started = Date.now();
    while (true) {
      try {
        const fd = fs.openSync(lockFile, 'wx', FILE_MODE);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        fs.closeSync(fd);
        return () => { try { fs.unlinkSync(lockFile); } catch {} };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const lock = readJson(lockFile, {});
          const age = Date.now() - Number(lock.at || fs.statSync(lockFile).mtimeMs);
          if (age > staleLockMs) { fs.unlinkSync(lockFile); continue; }
        } catch (inner) {
          if (inner?.code === 'ENOENT') continue;
        }
        if (Date.now() - started >= lockTimeoutMs) {
          throw asError('STORE_LOCK_TIMEOUT', `timed out acquiring execution store lock at ${lockFile}`);
        }
        await delay(retryMs);
      }
    }
  }

  const get = (id) => {
    const task = readJson(taskPath(id), null);
    return task ? clone(task) : null;
  };
  const list = () => {
    let names = [];
    try { names = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json')).sort(); } catch {}
    return names.map((f) => readJson(path.join(tasksDir, f), null)).filter(Boolean).map(clone);
  };
  const events = ({ afterSeq = 0, limit = 100 } = {}) => {
    let lines = [];
    try { lines = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean); } catch {}
    return lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((e) => e && e.seq > Number(afterSeq || 0)).slice(0, Math.max(0, Number(limit) || 0));
  };

  async function transaction(fn) {
    const release = await acquireLock();
    let emitted = [];
    try {
      const index = readJson(indexFile, { version: EXECUTION_STORE_VERSION, next_seq: 1, idempotency: {} });
      const writes = new Map();
      const pendingEvents = [];
      const tx = {
        get: (id) => writes.has(id) ? clone(writes.get(id)) : get(id),
        list: () => {
          const merged = new Map(list().map((t) => [t.id, t]));
          for (const [id, task] of writes) merged.set(id, clone(task));
          return [...merged.values()];
        },
        put: (task) => writes.set(cleanId(task.id, 'task id'), clone(task)),
        idempotencyGet: (key) => key ? clone(index.idempotency?.[key] || null) : null,
        remember: (key, value) => { if (key) index.idempotency[key] = clone(value); },
        emit: (event) => pendingEvents.push(clone(event))
      };
      const result = await fn(tx);
      for (const [id, task] of writes) atomicJson(taskPath(id), task);
      emitted = pendingEvents.map((event) => ({ ...event, seq: index.next_seq++ }));
      if (emitted.length) {
        mkdirPrivate(root);
        fs.appendFileSync(eventsFile, emitted.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: FILE_MODE });
        try { fs.chmodSync(eventsFile, FILE_MODE); } catch {}
      }
      atomicJson(indexFile, index);
      return { result: clone(result), emitted: clone(emitted) };
    } finally {
      release();
      if (emitted.length) queueMicrotask(() => {
        for (const event of emitted) for (const listener of listeners) listener(clone(event));
      });
    }
  }

  function subscribe({ afterSeq = 0, onEvent }) {
    assert(typeof onEvent === 'function', 'INVALID_SUBSCRIBER', 'onEvent must be a function');
    let cursor = Number(afterSeq || 0);
    let closed = false;
    const deliver = (event) => {
      if (closed || event.seq <= cursor) return;
      cursor = event.seq;
      onEvent(clone(event));
    };
    listeners.add(deliver);
    let watcher = null;
    try {
      watcher = fs.watch(root, { persistent: false }, (_kind, filename) => {
        if (filename && filename !== path.basename(eventsFile)) return;
        for (const event of events({ afterSeq: cursor, limit: Number.MAX_SAFE_INTEGER })) deliver(event);
      });
      // Some constrained hosts surface watch exhaustion asynchronously rather
      // than throwing from fs.watch. Same-process subscriptions still use the
      // listener set; callers can reconnect to recover cross-process watching.
      watcher.on('error', () => { try { watcher?.close(); } catch {} watcher = null; });
    } catch {}
    // Register live delivery before catch-up. cursor de-duplicates an event if
    // it arrives through both paths, avoiding the read-then-subscribe gap.
    for (const event of events({ afterSeq: cursor, limit: Number.MAX_SAFE_INTEGER })) deliver(event);
    return () => { closed = true; listeners.delete(deliver); watcher?.close(); };
  }

  return { kind: 'file', root, transaction, get, list, events, subscribe };
}

export function createExecutionBridge({
  stateDir,
  store,
  appendRoomEvent,
  now = () => Date.now(),
  randomUUID = () => crypto.randomUUID(),
  defaultLeaseMs = DEFAULT_LEASE_MS
} = {}) {
  const db = store || createFileExecutionStore({ stateDir });

  const nowMs = () => {
    const value = now();
    const ms = typeof value === 'number' ? value : Date.parse(value);
    assert(Number.isFinite(ms), 'INVALID_CLOCK', 'now() must return epoch milliseconds or an ISO timestamp');
    return ms;
  };

  async function commit(mutator) {
    const { result, emitted } = await db.transaction(mutator);
    const mirrorErrors = [];
    if (appendRoomEvent) {
      for (const event of emitted) {
        try { await appendRoomEvent(roomEventForTaskEvent(event)); }
        catch (error) { mirrorErrors.push({ seq: event.seq, error: String(error?.message || error) }); }
      }
    }
    return { ...result, events: emitted, mirrored: appendRoomEvent ? mirrorErrors.length === 0 : false, mirror_errors: mirrorErrors };
  }

  const makeEvent = (type, task, data = {}) => ({
    id: `evt_${randomUUID()}`,
    ts: iso(nowMs()),
    type,
    task_id: task.id,
    task_version: task.version,
    agent: clone(task.agent),
    data: clone(data),
    text: eventText(type, task, data)
  });

  function mutateTask(tx, taskId, expectedVersion, change, type, data) {
    const task = tx.get(cleanId(taskId, 'taskId'));
    assert(task, 'TASK_NOT_FOUND', `task ${taskId} not found`);
    ensureVersion(task, expectedVersion);
    const updated = change(clone(task));
    updated.version = task.version + 1;
    updated.updated_at = iso(nowMs());
    tx.put(updated);
    tx.emit(makeEvent(type, updated, typeof data === 'function' ? data(updated) : data));
    return updated;
  }

  async function createTask({ id, idempotencyKey, agent, title, input, metadata, room_id } = {}) {
    assert(idempotencyKey, 'IDEMPOTENCY_REQUIRED', 'idempotencyKey is required for createTask');
    const normalizedAgent = normalizeAgent(agent);
    const requestedId = id ? cleanId(id, 'task id') : null;
    const request = { requestedId, agent: normalizedAgent, title: String(title || ''), input: clone(input ?? null), metadata: clone(metadata ?? {}), room_id: room_id ?? null };
    return commit((tx) => {
      const idem = tx.idempotencyGet(`create:${idempotencyKey}`);
      if (idem) {
        assert(same(idem.request, request), 'IDEMPOTENCY_CONFLICT', `idempotency key ${idempotencyKey} was used with different create input`);
        return { task: tx.get(idem.task_id), idempotent: true };
      }
      const taskId = requestedId || `task_${randomUUID()}`;
      assert(!tx.get(taskId), 'TASK_EXISTS', `task ${taskId} already exists`);
      const at = iso(nowMs());
      const task = {
        schema_version: EXECUTION_STORE_VERSION,
        id: taskId,
        room_id: room_id ?? null,
        agent: normalizedAgent,
        title: String(title || ''),
        input: clone(input ?? null),
        metadata: clone(metadata ?? {}),
        status: 'assigned',
        version: 1,
        attempt: 0,
        created_at: at,
        updated_at: at,
        worker_id: null,
        lease: null,
        approval: null,
        progress: null,
        result: null,
        error: null
      };
      tx.put(task);
      tx.remember(`create:${idempotencyKey}`, { request, task_id: task.id });
      tx.emit(makeEvent('task.created', task, { room_id: task.room_id }));
      return { task, idempotent: false };
    });
  }

  async function assignTask({ taskId, agent, expectedVersion } = {}) {
    const normalizedAgent = normalizeAgent(agent);
    return commit((tx) => ({ task: mutateTask(tx, taskId, expectedVersion, (task) => {
      ensureOpen(task);
      assert(task.status === 'queued' || task.status === 'assigned', 'INVALID_TRANSITION', `cannot assign task ${task.id} while ${task.status}`);
      task.agent = normalizedAgent;
      task.status = 'assigned';
      return task;
    }, 'task.assigned', { agent: normalizedAgent }) }));
  }

  async function claimTask({ taskId, workerId, agentId, leaseMs = defaultLeaseMs, expectedVersion } = {}) {
    assert(workerId, 'WORKER_REQUIRED', 'workerId is required');
    return commit((tx) => {
      const at = nowMs();
      const candidates = taskId ? [tx.get(cleanId(taskId, 'taskId'))] : tx.list()
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const task = candidates.find((candidate) => candidate &&
        (!agentId || candidate.agent.id === agentId) &&
        (candidate.status === 'assigned' || candidate.status === 'queued' ||
          (candidate.status === 'running' && Date.parse(candidate.lease?.expires_at || 0) <= at)));
      if (!task) return { task: null, leaseToken: null };
      ensureVersion(task, expectedVersion);
      const token = `lease_${randomUUID()}`;
      const reclaimed = task.status === 'running';
      task.status = 'running';
      task.worker_id = String(workerId);
      task.lease = { token, claimed_at: iso(at), expires_at: iso(at + finitePositive(leaseMs, defaultLeaseMs)) };
      task.attempt = Number(task.attempt || 0) + 1;
      task.version += 1;
      task.updated_at = iso(at);
      tx.put(task);
      tx.emit(makeEvent('task.claimed', task, { worker_id: task.worker_id, reclaimed, attempt: task.attempt, expires_at: task.lease.expires_at }));
      return { task, leaseToken: token, reclaimed };
    });
  }

  async function heartbeat({ taskId, workerId, leaseToken, leaseMs = defaultLeaseMs, expectedVersion } = {}) {
    return commit((tx) => ({ task: mutateTask(tx, taskId, expectedVersion, (task) => {
      const at = nowMs();
      ensureLease(task, { workerId, leaseToken, nowMs: at });
      task.lease.expires_at = iso(at + finitePositive(leaseMs, defaultLeaseMs));
      return task;
    }, 'task.heartbeat', { worker_id: workerId }) }));
  }

  async function reportProgress({ taskId, workerId, leaseToken, progress, expectedVersion } = {}) {
    return commit((tx) => ({ task: mutateTask(tx, taskId, expectedVersion, (task) => {
      ensureLease(task, { workerId, leaseToken, nowMs: nowMs() });
      task.progress = { ...(clone(progress) || {}), at: iso(nowMs()) };
      return task;
    }, 'task.progress', () => ({ worker_id: workerId, ...(clone(progress) || {}) })) }));
  }

  async function requestApproval({ taskId, workerId, leaseToken, request, expectedVersion } = {}) {
    assert(request != null, 'APPROVAL_REQUEST_REQUIRED', 'request is required');
    return commit((tx) => {
      let approvalId;
      const task = mutateTask(tx, taskId, expectedVersion, (current) => {
        ensureLease(current, { workerId, leaseToken, nowMs: nowMs() });
        approvalId = `approval_${randomUUID()}`;
        current.status = 'awaiting_approval';
        current.approval = { id: approvalId, status: 'pending', request: clone(request), requested_at: iso(nowMs()), requested_by: workerId };
        current.lease = null;
        return current;
      }, 'task.approval_requested', () => ({ approval_id: approvalId, request: clone(request), worker_id: workerId }));
      return { task, approvalId };
    });
  }

  async function approveTask({ taskId, approvalId, by, expectedVersion } = {}) {
    assert(by, 'APPROVER_REQUIRED', 'by is required');
    return commit((tx) => ({ task: mutateTask(tx, taskId, expectedVersion, (task) => {
      assert(task.status === 'awaiting_approval' && task.approval?.status === 'pending', 'NO_PENDING_APPROVAL', `task ${task.id} has no pending approval`);
      assert(!approvalId || task.approval.id === approvalId, 'APPROVAL_MISMATCH', `approval id does not match task ${task.id}`);
      task.approval = { ...task.approval, status: 'approved', decided_at: iso(nowMs()), decided_by: String(by) };
      task.status = 'assigned';
      task.worker_id = null;
      return task;
    }, 'task.approved', { approval_id: approvalId, by: String(by) }) }));
  }

  async function terminal(kind, { taskId, idempotencyKey, expectedVersion, workerId, leaseToken, result, error, reason, by, approvalId } = {}) {
    assert(idempotencyKey, 'IDEMPOTENCY_REQUIRED', `idempotencyKey is required for ${kind}`);
    const key = `terminal:${taskId}:${idempotencyKey}`;
    const payload = { kind, taskId, result: clone(result), error: error == null ? null : String(error), reason: reason == null ? null : String(reason), by: by == null ? null : String(by), approvalId: approvalId || null };
    return commit((tx) => {
      const idem = tx.idempotencyGet(key);
      if (idem) {
        assert(same(idem.payload, payload), 'IDEMPOTENCY_CONFLICT', `idempotency key ${idempotencyKey} was used with a different terminal update`);
        return { task: tx.get(taskId), idempotent: true };
      }
      const type = kind === 'complete' ? 'task.completed' : kind === 'fail' ? 'task.failed' : kind === 'reject' ? 'task.rejected' : 'task.canceled';
      const status = kind === 'complete' ? 'completed' : kind === 'cancel' ? 'canceled' : 'failed';
      const task = mutateTask(tx, taskId, expectedVersion, (current) => {
        ensureOpen(current);
        if (kind === 'complete' || kind === 'fail') ensureLease(current, { workerId, leaseToken, nowMs: nowMs() });
        if (kind === 'reject') {
          assert(current.status === 'awaiting_approval' && current.approval?.status === 'pending', 'NO_PENDING_APPROVAL', `task ${current.id} has no pending approval`);
          assert(!approvalId || current.approval.id === approvalId, 'APPROVAL_MISMATCH', `approval id does not match task ${current.id}`);
          current.approval = { ...current.approval, status: 'rejected', decided_at: iso(nowMs()), decided_by: String(by || '') };
        }
        current.status = status;
        current.result = kind === 'complete' ? clone(result ?? null) : null;
        current.error = kind === 'fail' ? String(error || 'execution failed') : kind === 'reject' ? String(reason || 'approval rejected') : null;
        current.canceled_reason = kind === 'cancel' ? String(reason || '') : null;
        current.terminal_at = iso(nowMs());
        current.lease = null;
        return current;
      }, type, { worker_id: workerId || null, error: error == null ? null : String(error), reason: reason == null ? null : String(reason), by: by || null, result: clone(result ?? null) });
      tx.remember(key, { payload, task_id: task.id });
      return { task, idempotent: false };
    });
  }

  const completeTask = (args) => terminal('complete', args);
  const failTask = (args) => terminal('fail', args);
  const cancelTask = (args) => terminal('cancel', args);
  const rejectTask = (args) => terminal('reject', args);

  const getTask = (taskId) => clone(db.get(cleanId(taskId, 'taskId')));
  const listTasks = ({ status, agentId, roomId } = {}) => db.list()
    .filter((task) => !status || (Array.isArray(status) ? status : [status]).includes(task.status))
    .filter((task) => !agentId || task.agent.id === agentId)
    .filter((task) => !roomId || task.room_id === roomId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at)).map(clone);
  const tailEvents = (options) => db.events(options).map(clone);
  const subscribe = (options) => db.subscribe(options);

  return {
    store: db,
    createTask, assignTask, claimTask, heartbeat, reportProgress,
    requestApproval, approveTask, rejectTask,
    completeTask, failTask, cancelTask,
    getTask, listTasks, tailEvents, subscribe
  };
}
