#!/usr/bin/env node
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const [configPath, command, ...args] = process.argv.slice(2);
if (!configPath || !command) throw new Error('Usage: node client.mjs PARTICIPANT_CONFIG read [cursor] | wait [cursor] [seconds] | send RECIPIENT MESSAGE [KEY] [REPLY_ID] | send-file RECIPIENT FILE [KEY] [REPLY_ID] | ack MESSAGE_ID | pause | resume');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const url = new URL(config.origin);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Only a loopback room is supported');
async function request(body, after = 0) {
  const response = await fetch(`${config.origin}/events?after=${after}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
let result;
if (command === 'read' || command === 'wait') {
  const after = Number(args[0] || 0);
  const seconds = Math.min(25, Math.max(0, Number(args[1] || 20)));
  const end = Date.now() + (command === 'wait' ? seconds * 1000 : 0);
  do {
    result = await request(null, after);
    if (result.events.length || Date.now() >= end) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (true);
} else if (command === 'send' || command === 'send-file') {
  result = await request({ kind: 'message', to: args[0], text: command === 'send-file' ? fs.readFileSync(args[1], 'utf8') : args[1], key: args[2] || randomUUID(), replyTo: args[3] || null });
} else if (command === 'ack') {
  result = await request({ kind: 'ack', messageId: args[0], key: `ack:${args[0]}` });
} else if (['pause', 'resume'].includes(command)) {
  result = await request({ kind: 'pause', paused: command === 'pause', key: randomUUID() });
} else throw new Error('Unknown command');
// Credentials are deliberately never printed.
if (result.intent) delete result.intent;
console.log(JSON.stringify(result, null, 2));
