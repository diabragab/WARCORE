// Online match server: pairs two players by a room code and relays their turn messages.
// It also serves the built web game from ../dist so one deploy hosts both.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const THEMES = ['grass', 'desert', 'snow'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' };

const http = createServer(async (req, res) => {
  if (req.url === '/health') return res.end('ok');
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
    if (msg.t === 'create' && !room) {
      const code = newCode();
      room = { code, players: [{ ws, info: cleanInfo(msg.info) }], started: false };
      rooms.set(code, room);
      send(ws, { t: 'created', code });
    } else if (msg.t === 'join' && !room) {
      const r = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!r || r.players.length >= 2) return send(ws, { t: 'error', message: r ? 'That room is already full.' : 'No room with that code. Check it and try again.' });
      room = r;
      r.players.push({ ws, info: cleanInfo(msg.info) });
      r.started = true;
      const seed = Math.floor(Math.random() * 2 ** 31);
      const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
      const first = Math.random() < 0.5 ? 0 : 1;
      const players = r.players.map((p, i) => ({ ...p.info, team: i }));
      r.players.forEach((p, i) => send(p.ws, { t: 'start', seed, theme, first, players, you: i }));
    } else if (msg.t === 'relay' && room) {
      for (const p of room.players) if (p.ws !== ws) send(p.ws, { t: 'relay', data: msg.data });
    } else if (msg.t === 'rematch' && room && room.players.length === 2) {
      room.rematch = (room.rematch || 0) + 1;
      if (room.rematch === 2) {
        room.rematch = 0;
        const seed = Math.floor(Math.random() * 2 ** 31);
        const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
        const first = Math.random() < 0.5 ? 0 : 1;
        const players = room.players.map((p, i) => ({ ...p.info, team: i }));
        room.players.forEach((p, i) => send(p.ws, { t: 'start', seed, theme, first, players, you: i }));
      } else {
        for (const p of room.players) if (p.ws !== ws) send(p.ws, { t: 'rematch-offer' });
      }
    }
  });

  ws.on('close', () => {
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

http.listen(PORT, () => console.log(`WARCORE server on http://localhost:${PORT}`));
