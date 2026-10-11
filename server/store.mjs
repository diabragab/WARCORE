// Shared storage and HTTP helpers: the accounts file, the purchase log and small request utilities.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const FILE = join(DATA_DIR, 'accounts.json');
const LOG = join(DATA_DIR, 'purchases.log');
mkdirSync(DATA_DIR, { recursive: true });

/** users: lowercased name -> account; tokens: token -> lowercased name; whop: Whop membership/user id -> lowercased name */
export let db = { users: {}, tokens: {}, whop: {} };
try {
  db = JSON.parse(readFileSync(FILE, 'utf8'));
} catch {
  /* first run */
}
db.whop ||= {};

let saveTimer = null;
export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeFileSync(FILE + '.tmp', JSON.stringify(db));
    renameSync(FILE + '.tmp', FILE);
  }, 200);
}

/** One JSON line per payment, refund and VIP change, so there's a full record outside the accounts file. */
export function logPurchase(entry) {
  try {
    appendFileSync(LOG, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error('purchase log:', e.message);
  }
}

export function readPurchases(limit = 500) {
  try {
    return readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}

/** Raw request body as text (the payment webhook signs the exact bytes). */
export function readRaw(req) {
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readBody(req) {
  const raw = await readRaw(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error('bad json');
  }
}

export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The Windows app runs on its own origin, so allow cross-origin calls (tokens travel in a header, not cookies). */
export function cors(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204).end();
  return true;
}

export const userByToken = (token) => {
  const key = typeof token === 'string' && db.tokens[token];
  return key && db.users[key] ? { key, token, user: db.users[key] } : null;
};

export function userFor(req) {
  const m = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || '');
  return m ? userByToken(m[1]) : null;
}

export const userByKey = (key) => db.users[String(key).toLowerCase()] || null;
