// Single-writer session room. This joins host sessions, not provider personas.
// The server owns serialization; each accepted change is atomically persisted.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export function createSessionRoom({ dir, participants, allowEnrollment = false }) {
  for (const actor of allowEnrollment ? ['human'] : ['human', 'codex', 'claude']) {
    if (!participants?.[actor]?.label || (actor !== 'human' && !participants[actor].sessionId)) throw new Error('Explicit participant labels and session IDs required');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'room.json');
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
    version: 1, id: randomUUID(), paused: false, participants, events: []
  };
  if (state.version !== 1 || !Array.isArray(state.events)) throw new Error('Unsupported room state');
  for (const actor of allowEnrollment ? [] : ['codex', 'claude']) {
    if (state.participants[actor]?.sessionId !== participants[actor].sessionId) throw new Error('Session binding changed; create a separate room for a different session');
  }
  function save(next) {
    const temp = file + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    state = next;
  }
  if (!fs.existsSync(file)) save(state);
  const requireActor = (actor) => {
    if (!Object.hasOwn(state.participants, actor)) throw new Error('Unknown participant');
  };
  function mutate(actor, input) {
    requireActor(actor);
    const { kind, key } = input;
    if (typeof key !== 'string' || !key.length || key.length > 160) throw new Error('An idempotency key is required');
    const old = state.events.find(e => e.actor === actor && e.key === key);
    const intent = JSON.stringify(input);
    if (old) {
      if (old.intent !== intent) throw new Error('Idempotency key reused for a different request');
      return structuredClone(old);
    }
    let data;
    if (kind === 'message') {
      if (state.paused && actor !== 'human') throw new Error('Room paused by human');
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000) throw new Error('Message must contain 1–16000 characters');
      if (input.to !== 'all') requireActor(input.to);
      if (input.replyTo && !state.events.some(e => e.id === input.replyTo && e.kind === 'message')) throw new Error('Unknown reply target');
      data = { to: input.to, text: input.text, replyTo: input.replyTo || null };
    } else if (kind === 'ack') {
      const message = state.events.find(e => e.id === input.messageId && e.kind === 'message');
      if (!message || message.actor === actor || ![actor, 'all'].includes(message.to)) throw new Error('Cannot acknowledge this message');
      data = { messageId: message.id };
    } else if (kind === 'pause') {
      if (actor !== 'human' || typeof input.paused !== 'boolean') throw new Error('Only human may pause/resume');
      data = { paused: input.paused };
    } else throw new Error('Unknown event kind');
    const event = { id: randomUUID(), seq: state.events.length + 1, ts: new Date().toISOString(), actor, kind, key, intent, ...data };
    const next = { ...state, events: [...state.events, event], ...(kind === 'pause' ? { paused: data.paused } : {}) };
    save(next);
    return structuredClone(event);
  }
  function snapshot(actor, after = 0) {
    requireActor(actor);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid cursor');
    // Every bridge exchange is visible to all room participants, especially the human.
    // Addressing controls whose inbox it reaches, not transcript privacy.
    return structuredClone({ ...state, events: state.events.filter(e => e.seq > after).map(({ intent, ...e }) => e), cursor: state.events.length });
  }
  function enroll({ host, sessionId, role = 'Collaborator' }) {
    if (!allowEnrollment) throw new Error('Enrollment is not enabled for this room');
    if (!['codex', 'claude'].includes(host) || typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Valid host and actual session ID required');
    if (typeof role !== 'string' || role.length > 200) throw new Error('Role must be at most 200 characters');
    const existing = Object.entries(state.participants).find(([, p]) => p.host === host && p.sessionId === sessionId);
    if (existing) return { actor: existing[0], participant: structuredClone(existing[1]) };
    const actor = !state.participants[host] ? host : `${host}-${createHash('sha256').update(sessionId).digest('hex').slice(0,16)}`;
    if (state.participants[actor]) throw new Error('Participant handle collision');
    const participant = { host, sessionId, label: host === 'codex' ? 'Codex' : 'Claude Code', role };
    const event = { id: randomUUID(), seq: state.events.length + 1, ts: new Date().toISOString(), actor, kind: 'join', participant };
    save({ ...state, participants: { ...state.participants, [actor]: participant }, events: [...state.events, event] });
    return { actor, participant };
  }
  return { mutate, snapshot, enroll };
}
