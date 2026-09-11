#!/usr/bin/env node
// Protocol-level fallback for hosts whose tool inventory cannot reload mid-turn.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
let [config, sessionId, name, argumentsPath] = process.argv.slice(2);
let host, room, root;
if (config === '--host') {
  const { values } = parseArgs({ args: process.argv.slice(2), options: Object.fromEntries(['host','room','session','tool','args','root'].map(k=>[k,{type:'string'}])) });
  ({ host, room, root } = values); sessionId = values.session || process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID; name = values.tool; argumentsPath = values.args;
  if (!['codex','claude'].includes(host) || !sessionId || !name || (!room && name !== 'room_list')) throw new Error('Named mode: --host codex|claude --room NAME --session ACTUAL_ID --tool TOOL [--args JSON_FILE] [--root DIR]');
} else if (!config || !sessionId || !name) throw new Error('Usage: node mcp-client.mjs CONFIG ACTUAL_SESSION_ID TOOL [ARGUMENTS_JSON_FILE]');
const client = new Client({ name: 'teambrrr-existing-session', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../server/session.mjs', import.meta.url)), ...(host ? ['--host',host,...(root?['--root',root]:[])] : [config])], env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')) }));
  const supplied = argumentsPath ? JSON.parse(fs.readFileSync(argumentsPath, 'utf8')) : {};
  let result;
  if (host && ['room_start','room_list'].includes(name)) {
    result = await client.callTool({ name, arguments: name === 'room_list' ? {} : { ...supplied, name: room, session_id: sessionId } });
  } else {
    const join = await client.callTool({ name: 'room_join', arguments: { session_id: sessionId, ...(host ? { name: room } : {}) } });
    if (join.isError) throw new Error(join.content.map(c => c.text || '').join('\n'));
    result = name === 'room_join' ? join : await client.callTool({ name, arguments: supplied });
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }
