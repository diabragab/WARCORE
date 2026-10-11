// Online match server: pairs two signed-in players (by rating for quick matches, or by a room code)
// and relays their turn messages. Quick matches are ranked: the server settles the result and ratings.
// It also serves the built web game from ../dist so one deploy hosts both.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { handleAccounts } from './accounts.mjs';
import { CATALOG, handleEconomy, isVip, rankFor, settleOnline } from './economy.mjs';
import { handlePayments } from './payments.mjs';
import { DATA_DIR, json, userByToken } from './store.mjs';

const PORT = Number(process.env.PORT) || 8787;
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const THEMES = CATALOG.maps;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml' };
/** Website pages served at clean addresses. */
const PAGES = { '/': 'landing.html', '/privacy': 'privacy.html', '/terms': 'terms.html' };
/** The Windows installer offered on the website: the newest .exe in this folder (C:\warcore\downloads on Windows). */
const DOWNLOADS = process.env.DOWNLOADS_DIR || join(DATA_DIR, '..', 'downloads');

async function latestInstaller() {
  try {
    const files = (await readdir(DOWNLOADS)).filter((f) => f.toLowerCase().endsWith('.exe'));
    const stats = await Promise.all(files.map(async (f) => ({ file: f, ...(await stat(join(DOWNLOADS, f))) })));
    return stats.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
  } catch {
    return null;
  }
}

const http = createServer(async (req, res) => {
  if (req.url === '/health') return res.end('ok');
  if (req.url === '/api/download') {
    const f = await latestInstaller();
    return json(res, 200, { windows: f && { file: f.file, size: f.size } });
  }
  if (req.url === '/download/windows') {
    const f = await latestInstaller();
    if (!f) return res.writeHead(302, { location: '/#download' }).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': f.size, 'content-disposition': 'attachment; filename="WARCORE-Setup.exe"' });
    return createReadStream(join(DOWNLOADS, f.file)).pipe(res);
  }
  if (req.url?.startsWith('/api/')) {
    try {
      const p = req.url.split('?')[0];
      if ((await handlePayments(req, res, p)) || (await handleEconomy(req, res, p)) || (await handleAccounts(req, res, p))) return;
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500).end();
      return;
    }
  }
  const url = (req.url || '/').split('?')[0];
  // The website: "/" is the landing page and the game lives at "/play/".
  if (url === '/play') return res.writeHead(301, { location: '/play/' }).end();
  const page = PAGES[url] ?? (url.startsWith('/play/') ? url.slice(5) : url);
  const path = normalize(decodeURIComponent(page)).replace(/^([/\\])+/, '');
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
  if (room.started && !room.settled) settle(room);
  room.started = true;
  room.rematch = 0;
  room.reports = [null, null];
  room.settled = false;
  clearTimeout(room.reportTimer);
  room.reportTimer = null;
  const seed = Math.floor(Math.random() * 2 ** 31);
  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  const first = Math.random() < 0.5 ? 0 : 1;
  const players = room.players.map((p, i) => ({ ...p.info, team: i }));
  room.players.forEach((p, i) => send(p.ws, { t: 'start', seed, theme, first, players, you: i, ranked: room.ranked }));
}

const broadcastQueue = () => {
  for (const q of queue) send(q.ws, { t: 'queued', online: wss.clients.size, searching: queue.length });
};

function cleanInfo(info, user) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  return {
    name: user.name,
    model: s(info?.model, 20),
    look: { paint: s(info?.look?.paint, 9), decal: s(info?.look?.decal, 20), trail: s(info?.look?.trail, 20) },
    weapons: Array.isArray(info?.weapons) ? info.weapons.slice(0, 12).map((w) => s(w, 20)) : ['shell'],
    rating: user.profile.rating ?? 1000,
    rank: rankFor(user.profile.rating ?? 1000),
    vip: isVip(user),
  };
}

/** How far apart two ratings may be to pair up; it widens the longer either player has waited. */
const reach = (a, b) => 150 + 25 * ((Date.now() - Math.min(a.since, b.since)) / 1000);

function matchQueue() {
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const a = queue[i], b = queue[j];
      if (a.key === b.key || Math.abs(a.info.rating - b.info.rating) > reach(a, b)) continue;
      queue.splice(j, 1);
      queue.splice(i, 1);
      const room = { code: newCode(), players: [a, b], started: false, ranked: true };
      rooms.set(room.code, room);
      a.setRoom(room);
      b.setRoom(room);
      startMatch(room);
      return matchQueue();
    }
  }
}
setInterval(() => {
  if (queue.length > 1) {
    matchQueue();
    broadcastQueue();
  }
}, 2000);

/**
 * Both players report how the match ended. Matching reports count as given; if they disagree nothing
 * is ranked. A player who doesn't report in time (or leaves) is settled from the other player's report.
 */
function settle(room, forfeitBy = -1) {
  if (room.settled || !room.started) return;
  room.settled = true;
  clearTimeout(room.reportTimer);
  room.reportTimer = null;
  const [a, b] = room.reports;
  let winner, agreed = true;
  if (forfeitBy >= 0) winner = 1 - forfeitBy;
  else if (a && b) {
    agreed = a.winner === b.winner;
    winner = agreed ? a.winner : null;
  } else winner = (a || b)?.winner ?? null;
  const reports = [a, b].filter(Boolean);
  // Where two reports differ, the smaller number counts.
  const damage = [0, 1].map((i) => (reports.length ? Math.min(...reports.map((r) => r.damage[i])) : 0));
  const weaponKills = [0, 1].map((i) => {
    if (!reports.length) return {};
    const [x, y] = reports.map((r) => r.weaponKills[i]);
    return y ? Object.fromEntries(Object.keys(x).map((k) => [k, Math.min(Number(x[k]) || 0, Number(y[k]) || 0)])) : x;
  });
  const outcome = { winner, ranked: room.ranked && agreed, damage, weaponKills };
  const results = settleOnline(room.players.map((p) => p.key), outcome);
  if (results) room.players.forEach((p, i) => send(p.ws, { t: 'reward', ...results[i] }));
}

const validWinner = (w) => (w === 0 || w === 1 || w === null ? w : undefined);

const wss = new WebSocketServer({ server: http, maxPayload: 512 * 1024 });

wss.on('connection', (ws) => {
  let room = null;
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (['quick', 'create', 'join'].includes(msg.t) && !room) {
      // Online play needs an account, so results and ratings land on the right player.
      const who = userByToken(msg.token);
      if (!who) return send(ws, { t: 'error', message: 'Please sign in again to play online.', auth: true });
      me = { ws, key: who.key, info: cleanInfo(msg.info, who.user), since: Date.now(), setRoom: (r) => (room = r) };
    }
    if (msg.t === 'quick' && !room) {
      if (queue.some((q) => q.ws === ws)) return;
      queue.push(me);
      matchQueue();
      broadcastQueue();
    } else if (msg.t === 'create' && !room) {
      const code = newCode();
      room = { code, players: [me], started: false, ranked: false };
      rooms.set(code, room);
      send(ws, { t: 'created', code });
    } else if (msg.t === 'join' && !room) {
      const r = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!r || r.players.length >= 2) return send(ws, { t: 'error', message: r ? 'That room is already full.' : 'No room with that code. Check it and try again.' });
      if (r.players[0].key === me.key) return send(ws, { t: 'error', message: "That's your own room. Send the code to a friend." });
      room = r;
      r.players.push(me);
      startMatch(r);
    } else if (msg.t === 'relay' && room) {
      for (const p of room.players) if (p.ws !== ws) send(p.ws, { t: 'relay', data: msg.data });
    } else if (msg.t === 'result' && room?.started && !room.settled) {
      const i = room.players.findIndex((p) => p.ws === ws);
      const winner = validWinner(msg.winner);
      if (i < 0 || winner === undefined || room.reports[i]) return;
      room.reports[i] = {
        winner,
        damage: [0, 1].map((k) => Math.max(0, Math.floor(Number(msg.damage?.[k]) || 0))),
        weaponKills: [0, 1].map((k) => (msg.weaponKills?.[k] && typeof msg.weaponKills[k] === 'object' ? msg.weaponKills[k] : {})),
      };
      if (room.reports.every(Boolean)) settle(room);
      else room.reportTimer ||= setTimeout(() => settle(room), 20_000);
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
    // Leaving a match before it's settled counts as a loss.
    if (room.players.length === 2) settle(room, room.reports?.some(Boolean) ? -1 : room.players.findIndex((p) => p.ws === ws));
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
