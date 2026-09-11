import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StdioClientTransport } from './mcp-sdk.mjs';
import { startSessionServer } from '../adapters/session/server.mjs';
import { check, done, SCRATCH } from './_harness.mjs';
const dir = path.join(SCRATCH, 'session-mcp');
const participants = { human: { label: 'You' }, codex: { label: 'Codex', sessionId: 'codex-fixture' }, claude: { label: 'Claude', sessionId: 'claude-fixture' } };
const daemon = await startSessionServer({ dir, participants });
const clients = [];
async function connect(actor) {
  const c = new Client({ name: 'test', version: '1' }); clients.push(c);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k,v]) => typeof v === 'string' && k !== 'CODEX_THREAD_ID'));
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../server/session.mjs', import.meta.url)), path.join(dir, actor+'.json')], env }));
  return c;
}
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });
const value = r => JSON.parse(r.content[0].text);
try {
  const codex = await connect('codex'), claude = await connect('claude');
  check((await codex.listTools()).tools.length === 5, 'MCP advertises all five session tools');
  check((await call(codex, 'room_read')).isError, 'Read requires explicit join');
  check((await call(codex, 'room_join', { session_id: 'wrong' })).isError, 'Wrong host session cannot join');
  check(value(await call(codex, 'room_join', { session_id: 'codex-fixture' })).joined, 'Codex joins exact session');
  check(value(await call(claude, 'room_join', { session_id: 'claude-fixture' })).joined, 'Claude joins exact session');
  const args = { to: 'claude', message: 'MCP hello', idempotency_key: 'mcp-hello' };
  const sent = value(await call(codex, 'room_send', args));
  check(sent.actor === 'codex', 'MCP send retains caller identity');
  check(value(await call(codex, 'room_send', args)).id === sent.id, 'MCP retries are idempotent');
  check(value(await call(claude, 'room_read')).inbox[0].text === 'MCP hello', 'Other MCP process receives actual message');
  check(value(await call(claude, 'room_ack', { message_id: sent.id })).kind === 'ack', 'Receipt recorded through MCP');
  const waiting = call(codex, 'room_wait', { after: 2, seconds: 2 });
  const reply = value(await call(claude, 'room_send', { to: 'codex', message: 'MCP reply', idempotency_key: 'mcp-reply', reply_to: sent.id }));
  check(value(await waiting).inbox[0].id === reply.id, 'MCP wait returns peer reply');
  daemon.room.mutate('human', { kind: 'pause', paused: true, key: 'pause-mcp' });
  check((await call(codex, 'room_send', { ...args, idempotency_key: 'paused-send' })).isError, 'MCP honors human pause');
  check((await call(codex, 'room_wait', { after: 4, seconds: 60 })).isError, 'MCP schema refuses unbounded wait');
  check(!JSON.stringify(await call(codex, 'room_read')).includes('token'), 'MCP results do not expose credentials');
} finally { for (const c of clients) await c.close(); await daemon.close(); }
done();
