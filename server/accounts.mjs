// Player accounts: name + password, each holding that player's coins, purchases and stats.
// Stored in DATA_DIR/accounts.json (default: ../data next to the server folder).
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const FILE = join(DATA_DIR, 'accounts.json');
mkdirSync(DATA_DIR, { recursive: true });

/** users: lowercased name -> { name, salt, hash, profile, created }; tokens: token -> lowercased name */
let db = { users: {}, tokens: {} };
try {
  db = JSON.parse(readFileSync(FILE, 'utf8'));
} catch {
  /* first run */
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeFileSync(FILE + '.tmp', JSON.stringify(db));
    renameSync(FILE + '.tmp', FILE);
  }, 200);
}

const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
const ITEM_RE = /^(tank|weapon|paint|decal|trail):[a-z0-9-]{1,24}$/;
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
const id = (v, fallback) => (typeof v === 'string' && /^[a-z0-9-]{1,24}$/.test(v) ? v : fallback);

/** Keep only fields the game uses, with sane bounds. */
function cleanProfile(p) {
  p = p && typeof p === 'object' ? p : {};
  const owned = Array.isArray(p.owned) ? [...new Set(p.owned.filter((x) => typeof x === 'string' && ITEM_RE.test(x)))].slice(0, 200) : [];
  const e = p.equipped || {};
  const st = p.stats || {};
  return {
    coins: int(p.coins, 10_000_000),
    owned,
    equipped: { tank: id(e.tank, 'patton'), paint: id(e.paint, 'olive'), decal: id(e.decal, 'none'), trail: id(e.trail, 'smoke') },
    stats: { played: int(st.played, 1e9), wins: int(st.wins, 1e9), arcadeBest: int(st.arcadeBest, 1e6) },
  };
}

async function hashPassword(password, salt) {
  return (await scrypt(password, salt, 64)).toString('hex');
}

function issueToken(key) {
  const token = randomBytes(24).toString('hex');
  db.tokens[token] = key;
  persist();
  return token;
}

// Simple brute-force brake: at most 10 sign-in attempts per address per minute.
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 60_000);
  a.push(now);
  attempts.set(ip, a);
  return a.length > 10;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function userFor(req) {
  const m = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || '');
  const key = m && db.tokens[m[1]];
  return key ? { key, token: m[1], user: db.users[key] } : null;
}

/** Handles /api/account/*. Returns false for other paths. */
export async function handleAccounts(req, res, path) {
  if (!path.startsWith('/api/account/')) return false;
  // The Windows app runs on its own origin, so allow cross-origin calls (tokens travel in a header, not cookies).
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end(), true;

  const action = path.slice('/api/account/'.length);
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: 'Bad request.' }), true;
    }
  }

  if (req.method === 'POST' && (action === 'register' || action === 'login')) {
    if (tooMany(ip)) return json(res, 429, { error: 'Too many attempts. Wait a minute and try again.' }), true;
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    const key = name.toLowerCase();
    if (action === 'register') {
      if (!NAME_RE.test(name)) return json(res, 400, { error: 'Names are 3 to 16 letters, numbers, - or _.' }), true;
      if (password.length < 6 || password.length > 128) return json(res, 400, { error: 'Use a password of at least 6 characters.' }), true;
      if (db.users[key]) return json(res, 409, { error: 'That name is taken.' }), true;
      const salt = randomBytes(16).toString('hex');
      db.users[key] = { name, salt, hash: await hashPassword(password, salt), profile: cleanProfile(body.profile), created: Date.now() };
      return json(res, 200, { name, token: issueToken(key), profile: db.users[key].profile }), true;
    }
    const u = db.users[key];
    const ok = u && timingSafeEqual(Buffer.from(await hashPassword(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
    if (!ok) return json(res, 401, { error: 'Wrong name or password.' }), true;
    return json(res, 200, { name: u.name, token: issueToken(key), profile: u.profile }), true;
  }

  const who = userFor(req);
  if (!who || !who.user) return json(res, 401, { error: 'Please sign in again.' }), true;
  if (action === 'profile' && req.method === 'GET') return json(res, 200, { name: who.user.name, profile: who.user.profile }), true;
  if (action === 'profile' && req.method === 'PUT') {
    who.user.profile = cleanProfile(body.profile);
    persist();
    return json(res, 200, { ok: true }), true;
  }
  if (action === 'logout' && req.method === 'POST') {
    delete db.tokens[who.token];
    persist();
    return json(res, 200, { ok: true }), true;
  }
  return json(res, 404, { error: 'Not found.' }), true;
}
