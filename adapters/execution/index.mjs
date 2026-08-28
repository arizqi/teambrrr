// Direct-import worker adapter for Hermes, OpenClaw, and similar executors.
// It binds one stable worker/agent identity to the host-neutral control plane;
// callers still decide which tools to run and when to request human approval.
import { createExecutionBridge } from '../../core/execution.mjs';

export function createExecutionWorker({
  bridge,
  stateDir,
  store,
  appendRoomEvent,
  workerId,
  agent,
  leaseMs
} = {}) {
  if (!workerId) throw new Error('workerId is required');
  if (!agent?.name) throw new Error('agent.name is required');
  const control = bridge || createExecutionBridge({ stateDir, store, appendRoomEvent });
  const agentId = agent.id || agent.agent_id || `room-recruit:${String(agent.name).replace(/^@/, '')}`;

  const claim = (options = {}) => control.claimTask({
    ...options, workerId, agentId, leaseMs: options.leaseMs || leaseMs
  });
  const bound = (fn) => (taskId, leaseToken, options = {}) => fn({
    ...options, taskId, leaseToken, workerId
  });

  return {
    workerId,
    agent: { id: agentId, name: String(agent.name).replace(/^@/, ''), model: agent.model ?? null },
    claim,
    heartbeat: bound(control.heartbeat),
    progress: bound(control.reportProgress),
    requestApproval: bound(control.requestApproval),
    complete: bound(control.completeTask),
    fail: bound(control.failTask),
    get: control.getTask,
    list: (options = {}) => control.listTasks({ ...options, agentId }),
    events: control.tailEvents,
    subscribe: control.subscribe,
    control
  };
}

export { createExecutionBridge, createFileExecutionStore } from '../../core/execution.mjs';
