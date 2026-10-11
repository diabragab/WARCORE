// Player accounts: name + password. Each account holds that player's coins, purchases and stats,
// which only the server changes (see economy.mjs).
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cors, db, json, persist, readBody, userFor } from './store.mjs';
import { newProfile, view } from './economy.mjs';

const scrypt = promisify(scryptCb);
const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;

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

/** Handles /api/account/register, login, profile and logout. Returns false for other paths. */
export async function handleAccounts(req, res, path) {
  if (!path.startsWith('/api/account/')) return false;
  if (cors(req, res)) return true;

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
      // Every account starts with the same fresh profile: progress can't be carried in from a browser.
      db.users[key] = { name, salt, hash: await hashPassword(password, salt), profile: newProfile(), paidTotal: 0, created: Date.now() };
      return json(res, 200, { name, token: issueToken(key), profile: view(db.users[key]) }), true;
    }
    const u = db.users[key];
    const ok = u && timingSafeEqual(Buffer.from(await hashPassword(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
    if (!ok) return json(res, 401, { error: 'Wrong name or password.' }), true;
    return json(res, 200, { name: u.name, token: issueToken(key), profile: view(u) }), true;
  }

  const who = userFor(req);
  if (!who || !who.user) return json(res, 401, { error: 'Please sign in again.' }), true;
  if (action === 'profile' && req.method === 'GET') {
    const p = view(who.user);
    persist();
    return json(res, 200, { name: who.user.name, profile: p }), true;
  }
  if (action === 'logout' && req.method === 'POST') {
    delete db.tokens[who.token];
    persist();
    return json(res, 200, { ok: true }), true;
  }
  return json(res, 404, { error: 'Not found.' }), true;
}
