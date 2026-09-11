import fs from 'node:fs';
import path from 'node:path';
import { createSessionRoom } from '../core/session-room.mjs';
import { startSessionServer } from '../adapters/session/server.mjs';
import { check, done, SCRATCH } from './_harness.mjs';

const participants = { human: { label: 'Ashar' }, codex: { label: 'Codex', sessionId: 'cx-test' }, claude: { label: 'Claude', sessionId: 'cl-test' } };
const dir = path.join(SCRATCH, 'session-room');
let room = createSessionRoom({ dir, participants });
const rejects = (fn) => { try { fn(); return false; } catch { return true; } };
const input = { kind: 'message', to: 'claude', text: 'Handshake', key: 'hello' };
const msg = room.mutate('codex', input);
check(msg.seq === 1 && msg.actor === 'codex', 'Message has stable attribution and sequence');
check(room.mutate('codex', input).id === msg.id, 'Retry does not duplicate a message');
check(rejects(() => room.mutate('codex', { ...input, text: 'Different' })), 'Conflicting retry is refused');
check(rejects(() => room.mutate('other', input)), 'Unknown session is refused');
check(rejects(() => room.mutate('codex', { ...input, key: 'bad-to', to: 'unknown' })), 'Unknown recipient refused');
check(rejects(() => room.mutate('codex', { ...input, key: 'bad-reply', replyTo: 'missing' })), 'Reply cannot reference a nonexistent message');
check(rejects(() => room.mutate('codex', { kind: 'ack', messageId: msg.id, key: 'ack-own' })), 'Sender cannot acknowledge its own message');
room.mutate('claude', { kind: 'ack', messageId: msg.id, key: 'ack' });
room.mutate('claude', { kind: 'message', to: 'codex', text: 'ACK', replyTo: msg.id, key: 'reply' });
check(room.snapshot('human').events.length === 3, 'Human sees both directions and receipt');
check(room.snapshot('codex', 2).events[0].text === 'ACK', 'Cursor returns only new events');
check(rejects(() => room.mutate('claude', { kind: 'pause', paused: false, key: 'escalate' })), 'Agent cannot impersonate human control');
room.mutate('human', { kind: 'pause', paused: true, key: 'pause' });
check(rejects(() => room.mutate('codex', { ...input, key: 'paused' })), 'Pause prevents new agent messages');
room.mutate('human', { ...input, key: 'direction' });
room = createSessionRoom({ dir, participants });
check(room.snapshot('human').paused && room.snapshot('human').cursor === 5, 'Restart preserves transcript and pause');
room.mutate('human', { kind: 'pause', paused: false, key: 'resume' });
check(room.mutate('codex', { ...input, key: 'after-resume' }).seq === 7, 'Resume permits subsequent messages');
check((fs.statSync(path.join(dir, 'room.json')).mode & 0o777) === 0o600, 'Transcript has private filesystem permissions');
check(rejects(() => createSessionRoom({ dir, participants: { ...participants, codex: { label: 'Codex', sessionId: 'other-session' } } })), 'Restart cannot silently rebind a room to another session');

const networkDir = path.join(SCRATCH, 'session-http');
const server = await startSessionServer({ dir: networkDir, participants });
try {
  const config = JSON.parse(fs.readFileSync(path.join(networkDir, 'codex.json')));
  const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
  check((await fetch(server.origin + '/events')).status === 401, 'Unauthenticated reads refused');
  check((await fetch(server.origin + '/events', { headers: { ...headers, Origin: 'https://evil.example' } })).status === 403, 'Cross-origin requests refused');
  const posted = await fetch(server.origin + '/events', { method: 'POST', headers, body: JSON.stringify({ ...input, actor: 'human' }) });
  check((await posted.json()).actor === 'codex', 'Credential determines author, not request body');
  const pause = await fetch(server.origin + '/events', { method: 'POST', headers, body: JSON.stringify({ kind: 'pause', paused: true, key: 'not-human' }) });
  check(pause.status === 400, 'Agent credential cannot pause via HTTP');
  let locked = false;
  try { await startSessionServer({ dir: networkDir, participants }); } catch { locked = true; }
  check(locked, 'Second writer cannot start over same room');
  check((await (await fetch(server.origin + '/')).text()).includes('textContent'), 'Dashboard renders messages as text');
} finally { await server.close(); }
const restarted = await startSessionServer({ dir: networkDir, participants });
check(restarted.room.snapshot('human').events.length === 1, 'Daemon restart preserves messages');
await restarted.close();
done();
