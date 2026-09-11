#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSessionRoom } from '../../core/session-room.mjs';

export async function startSessionServer({ dir, participants, port = 0, allowEnrollment = false }) {
  dir = path.resolve(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'server.lock');
  // Never run two writers over the same room, including on different ports.
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, String(process.pid));
  fs.closeSync(fd);
  let server;
  try {
    const room = createSessionRoom({ dir, participants, allowEnrollment });
    const tokenPath = path.join(dir, 'tokens.json');
    const tokens = fs.existsSync(tokenPath) ? JSON.parse(fs.readFileSync(tokenPath, 'utf8')) :
      Object.fromEntries(Object.keys(participants).map(actor => [actor, randomBytes(32).toString('hex')]));
    fs.writeFileSync(tokenPath, JSON.stringify(tokens), { mode: 0o600 });
    const html = fs.readFileSync(new URL('./room.html', import.meta.url));
    let origin;
    const connection = actor => ({ origin, actor, token: tokens[actor] });
    const atomicJson = (file, value) => { fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
    server = http.createServer(async (req, res) => {
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" };
      const json = (code, data) => { res.writeHead(code, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      try {
        if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return json(403, { error: 'Origin refused' });
        const url = new URL(req.url, origin);
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
        }
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        const actor = Object.keys(tokens).find(a => tokens[a] === token);
        if (!actor) return json(401, { error: 'Participant credential required' });
        if (req.method === 'GET' && url.pathname === '/events') return json(200, room.snapshot(actor, Number(url.searchParams.get('after') || 0)));
        if (req.method === 'POST' && ['/events', '/participants'].includes(url.pathname)) {
          if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON required' });
          let body = '';
          for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) return json(413, { error: 'Request too large' }); }
          if (url.pathname === '/participants') {
            if (actor !== 'human' || !allowEnrollment) return json(403, { error: 'Enrollment requires the local room owner' });
            const joined = room.enroll(JSON.parse(body));
            if (!tokens[joined.actor]) {
              tokens[joined.actor] = randomBytes(32).toString('hex');
              atomicJson(tokenPath, tokens);
            }
            atomicJson(path.join(dir, `${joined.actor}.json`), connection(joined.actor));
            return json(200, joined);
          }
          const result = room.mutate(actor, JSON.parse(body));
          return json(200, result);
        }
        json(404, { error: 'Unknown route' });
      } catch (error) { json(400, { error: error.message }); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    for (const [actor, token] of Object.entries(tokens)) {
      atomicJson(path.join(dir, `${actor}.json`), connection(actor));
    }
    fs.writeFileSync(path.join(dir, 'dashboard.json'), JSON.stringify({ url: `${origin}/#${tokens.human}` }), { mode: 0o600 });
    return { origin, room, close: async () => { await new Promise(resolve => server.close(resolve)); fs.unlinkSync(lock); } };
  } catch (error) { server?.close(); fs.unlinkSync(lock); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, participantsPath] = process.argv.slice(2);
  if (!dir || !participantsPath) throw new Error('Usage: node server.mjs ROOM_DIR PARTICIPANTS_JSON');
  const managed = participantsPath === '--managed';
  const running = await startSessionServer({ dir, participants: managed ? { human: { label: 'You', role: 'Director' } } : JSON.parse(fs.readFileSync(participantsPath, 'utf8')), allowEnrollment: managed });
  console.log(`TeamBrrr session room listening at ${running.origin}; credentials saved in room directory.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await running.close(); process.exit(0); });
}
