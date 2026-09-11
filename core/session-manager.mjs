// Local named-room lifecycle. Reuses the session daemon and its single-writer store.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const defaultRoomsRoot = () => process.env.TEAMBRRR_ROOMS_DIR || path.join(os.homedir(), '.room', 'sessions');
export function roomDirectory(root, name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) throw new Error('Room name must use 1–48 lowercase letters, digits or hyphens');
  return path.join(path.resolve(root), name);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const live = pid => {
  if (!Number.isInteger(pid) || pid < 2) throw new Error('Invalid daemon PID; inspect server.lock');
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; if (e.code === 'EPERM') return true; throw e; }
};
export async function localRequest(configPath, endpoint = '/events', body, signal) {
  const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const u = new URL(c.origin);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') throw new Error('Only loopback rooms are supported');
  const r = await fetch(`${c.origin}${endpoint}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000)
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error);
  delete value.intent;
  return value;
}

export async function ensureRoom({ root = defaultRoomsRoot(), name, create = false }) {
  const dir = roomDirectory(root, name);
  if (!create && !fs.existsSync(path.join(dir, 'room.json'))) throw new Error(`No room named ${name}; start it first`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const human = path.join(dir, 'human.json');
  const healthy = async () => {
    try {
      const result = await localRequest(human);
      const expected = JSON.parse(fs.readFileSync(path.join(dir, 'room.json'), 'utf8')).id;
      return result.id === expected ? result : null;
    } catch { return null; }
  };
  let state = await healthy();
  if (state) return { dir, state, started: false };
  const starter = path.join(dir, 'startup.lock');
  let fd;
  for (let i = 0; i < 50; i++) {
    try { fd = fs.openSync(starter, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; await sleep(200); }
  }
  if (fd === undefined) throw new Error(`Room startup is busy. If its launcher crashed, inspect ${starter} before removing that lock.`);
  try {
    state = await healthy();
    if (state) return { dir, state, started: false };
    const lock = path.join(dir, 'server.lock');
    if (fs.existsSync(lock)) {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (live(pid)) throw new Error('Room process is alive but not responding; refusing to start a second writer');
      fs.unlinkSync(lock); // Serialized under startup.lock, and old owner proven dead.
    }
    const log = fs.openSync(path.join(dir, 'daemon.log'), 'a', 0o600);
    let child;
    try { child = spawn(process.execPath, [fileURLToPath(new URL('../adapters/session/server.mjs', import.meta.url)), dir, '--managed'], { detached: true, stdio: ['ignore', log, log] }); }
    finally { fs.closeSync(log); }
    let spawnError;
    child.on('error', e => { spawnError = e; }); child.unref();
    for (let i = 0; i < 50; i++) {
      if (spawnError) throw spawnError;
      state = await healthy();
      if (state) return { dir, state, started: true };
      await sleep(100);
    }
    throw new Error(`Room did not start; inspect ${path.join(dir, 'daemon.log')}`);
  } finally { fs.closeSync(fd); fs.unlinkSync(starter); }
}

export async function joinRoom({ root = defaultRoomsRoot(), name, host, sessionId, role, create = false }) {
  const { dir, started } = await ensureRoom({ root, name, create });
  const joined = await localRequest(path.join(dir, 'human.json'), '/participants', { host, sessionId, ...(role ? { role } : {}) });
  const configPath = path.join(dir, `${joined.actor}.json`);
  const state = await localRequest(configPath);
  return { ...joined, configPath, state, started };
}
export function listRooms(root = defaultRoomsRoot()) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && /^[a-z0-9][a-z0-9-]{0,47}$/.test(e.name)).flatMap(e => {
    try { const s = JSON.parse(fs.readFileSync(path.join(root, e.name, 'room.json'), 'utf8')); return [{ name: e.name, room_id: s.id, participants: s.participants, paused: s.paused }]; } catch { return []; }
  });
}
