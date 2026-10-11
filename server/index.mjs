// Online match server: pairs two players by a room code and relays their turn messages.
// It also serves the built web game from ../dist so one deploy hosts both.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { handleAccounts } from './accounts.mjs';

const PORT = Number(process.env.PORT) || 8787;
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const THEMES = ['warzone', 'grass', 'desert', 'snow'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' };

const http = createServer(async (req, res) => {
  if (req.url === '/health') return res.end('ok');
  if (req.url?.startsWith('/api/')) {
    try {
      if (await handleAccounts(req, res, req.url.split('?')[0])) return;
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500).end();
      return;
    }
  }
  const path = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^([/\\])+/, '');
  try {
    const file = join(DIST, path === '' ? 'index.html' : path);
    if (!file.startsWith(DIST)) throw new Error('outside');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

/** code -> { players: [{ ws, info }], started } */
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

/** Players waiting for a quick match, oldest first. */
const queue = [];

function startMatch(room) {
  room.started = true;
  room.rematch = 0;
  const seed = Math.floor(Math.random() * 2 ** 31);
  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  const first = Math.random() < 0.5 ? 0 : 1;
  const players = room.players.map((p, i) => ({ ...p.info, team: i }));
  room.players.forEach((p, i) => send(p.ws, { t: 'start', seed, theme, first, players, you: i }));
}

const broadcastQueue = () => {
  for (const q of queue) send(q.ws, { t: 'queued', online: wss.clients.size });
};

function cleanInfo(info) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  return {
    name: s(info?.name, 16).trim() || 'Commander',
    model: s(info?.model, 20),
    look: { paint: s(info?.look?.paint, 9), decal: s(info?.look?.decal, 20), trail: s(info?.look?.trail, 20) },
    weapons: Array.isArray(info?.weapons) ? info.weapons.slice(0, 12).map((w) => s(w, 20)) : ['shell'],
  };
}

const wss = new WebSocketServer({ server: http, maxPayload: 512 * 1024 });

wss.on('connection', (ws) => {
  let room = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'quick' && !room) {
      if (queue.some((q) => q.ws === ws)) return;
      const other = queue.shift();
      if (other && other.ws.readyState === 1) {
        room = { code: newCode(), players: [other, { ws, info: cleanInfo(msg.info) }], started: false };
        rooms.set(room.code, room);
        other.setRoom(room);
        startMatch(room);
      } else {
        queue.push({ ws, info: cleanInfo(msg.info), setRoom: (r) => (room = r) });
      }
      broadcastQueue();
    } else if (msg.t === 'create' && !room) {
      const code = newCode();
      room = { code, players: [{ ws, info: cleanInfo(msg.info) }], started: false };
      rooms.set(code, room);
      send(ws, { t: 'created', code });
    } else if (msg.t === 'join' && !room) {
      const r = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!r || r.players.length >= 2) return send(ws, { t: 'error', message: r ? 'That room is already full.' : 'No room with that code. Check it and try again.' });
      room = r;
      r.players.push({ ws, info: cleanInfo(msg.info) });
      startMatch(r);
    } else if (msg.t === 'relay' && room) {
      for (const p of room.players) if (p.ws !== ws) send(p.ws, { t: 'relay', data: msg.data });
    } else if (msg.t === 'rematch' && room && room.players.length === 2) {
      room.rematch = (room.rematch || 0) + 1;
      if (room.rematch === 2) startMatch(room);
      else {
        for (const p of room.players) if (p.ws !== ws) send(p.ws, { t: 'rematch-offer' });
      }
    }
  });

  ws.on('close', () => {
    const qi = queue.findIndex((q) => q.ws === ws);
    if (qi >= 0) {
      queue.splice(qi, 1);
      broadcastQueue();
    }
    if (!room) return;
    for (const p of room.players) if (p.ws !== ws) send(p.ws, { t: 'left' });
    rooms.delete(room.code);
  });
});

// Drop dead connections so rooms do not linger.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30_000);

http.listen(PORT, process.env.HOST || undefined, () => console.log(`WARCORE server on http://localhost:${PORT}`));
