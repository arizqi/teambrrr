import { parseArgs } from 'node:util';
import { defaultRoomsRoot, ensureRoom, joinRoom, listRooms } from '../../core/session-manager.mjs';

export async function runRoomCommand(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    host: { type: 'string' }, session: { type: 'string' }, role: { type: 'string' }, root: { type: 'string' }
  } });
  const [command, name] = positionals, root = values.root || defaultRoomsRoot();
  if (command === 'rooms') return { rooms: listRooms(root) };
  if (!['start', 'join'].includes(command)) throw new Error('Use teambrrr start NAME, join NAME --host codex|claude --session ID, or rooms');
  const host = values.host || (process.env.CODEX_THREAD_ID ? 'codex' : undefined);
  const sessionId = values.session || (host === 'codex' ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_CODE_SESSION_ID);
  if (host === 'codex' && process.env.CODEX_THREAD_ID && sessionId !== process.env.CODEX_THREAD_ID) throw new Error('Session ID differs from current Codex session');
  if (command === 'start' && !host && !sessionId) {
    const { state, started } = await ensureRoom({ root, name, create: true });
    return { name, room_id: state.id, started, next: `In each agent conversation, ask it to join TeamBrrr room ${name}.` };
  }
  if (!host || !sessionId) throw new Error('Joining requires --host codex|claude and --session ACTUAL_SESSION_ID (Codex supplies its ID automatically)');
  const { actor, state, started } = await joinRoom({ root, name, host, sessionId, role: values.role, create: command === 'start' });
  return { name, room_id: state.id, actor, participants: state.participants, cursor: state.cursor, started, next: `Ask the other agent to join TeamBrrr room ${name}.` };
}
