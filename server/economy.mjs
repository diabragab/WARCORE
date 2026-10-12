// The game economy, decided on the server: prices, buying, match rewards, the daily reward,
// daily missions, ranked ratings, VIP and the leaderboards. Clients only ever ask; the server
// works out the coins, so editing the game in a browser can't add any.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cors, db, json, persist, readBody, readPurchases, userByKey, userFor } from './store.mjs';

export const CATALOG = JSON.parse(readFileSync(new URL('../shared/catalog.json', import.meta.url), 'utf8'));
const DAY = 86_400_000;
const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const ADMINS = (process.env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SLOTS = ['tank', 'paint', 'decal', 'trail'];
const DEFAULT_EQUIP = { tank: 'patton', paint: 'olive', decal: 'none', trail: 'smoke' };
/** Coins a player can earn from matches per day (VIP doubles it). Missions and the daily reward don't count. */
const DAILY_CAP = 3000;
/** Two-player games on one keyboard pay for this many matches a day. */
const LOCAL_PER_DAY = 10;

/** The Game Pass: bought once, it unlocks every item (including ones added later) and VIP for life. */
export const hasPass = (u) => !!u.pass;
export const isVip = (u) => hasPass(u) || (u.vipUntil || 0) > Date.now();
const keyOf = (u) => u.name.toLowerCase();

export function priceOf(item) {
  const [kind, id] = String(item).split(':');
  const p = CATALOG.prices[kind]?.[id];
  return typeof p === 'number' ? p : null;
}

export const rankFor = (rating) => [...CATALOG.ranks].reverse().find((r) => rating >= r.min).name;

/** Every item in the catalog, as "kind:id". */
const ALL_ITEMS = Object.entries(CATALOG.prices).flatMap(([kind, list]) => Object.keys(list).map((id) => `${kind}:${id}`));

const canUse = (u, item) =>
  (hasPass(u) && priceOf(item) !== null) || u.profile.owned.includes(item) || (CATALOG.vipOnly.includes(item) && isVip(u));

/** Fills in fields added since an account was created, and drops anything that isn't for sale. */
export function ensure(u) {
  const p = (u.profile ||= {});
  p.coins = Math.max(0, Math.floor(Number(p.coins) || 0));
  p.owned = [...new Set([...CATALOG.starter, ...(Array.isArray(p.owned) ? p.owned : [])])].filter((x) => priceOf(x) !== null && !CATALOG.vipOnly.includes(x));
  p.equipped = { ...DEFAULT_EQUIP, ...(p.equipped || {}) };
  p.stats = { played: 0, wins: 0, arcadeBest: 0, onlinePlayed: 0, onlineWins: 0, kills: 0, ...(p.stats || {}) };
  if (typeof p.rating !== 'number') p.rating = 1000;
  delete p.paidSeen;
  u.daily ||= { last: '', streak: 0 };
  u.earned ||= { day: '', coins: 0, local: 0 };
  if (u.earned.day !== today()) Object.assign(u.earned, { day: today(), coins: 0, local: 0 });
  // VIP looks go back to the defaults when VIP runs out.
  for (const s of SLOTS) if (!canUse(u, `${s}:${p.equipped[s]}`)) p.equipped[s] = DEFAULT_EQUIP[s];
  return u;
}

/** Adds earned coins: doubled for VIP and, for match rewards, limited per day. */
function grant(u, base, capped = true) {
  const mult = isVip(u) ? CATALOG.vip.multiplier : 1;
  let coins = Math.max(0, Math.round(base)) * mult;
  if (capped) {
    coins = Math.max(0, Math.min(coins, DAILY_CAP * mult - u.earned.coins));
    u.earned.coins += coins;
  }
  u.profile.coins += coins;
  return coins;
}

// ------------------------------------------------------------------ daily reward

const dailyReward = (streak) => 50 + 10 * (Math.min(streak, 7) - 1);
function nextStreak(u) {
  if (u.daily.last === today()) return u.daily.streak;
  return u.daily.last === today(Date.now() - DAY) ? u.daily.streak + 1 : 1;
}

// ------------------------------------------------------------------ missions

/** Each match reports an event; count says how much it moves a mission along, best keeps the highest value. */
const MISSIONS = [
  { id: 'play3', text: 'Play 3 matches', goal: 3, reward: 100, count: () => 1 },
  { id: 'win2', text: 'Win 2 matches', goal: 2, reward: 150, count: (e) => (e.won ? 1 : 0) },
  { id: 'online1', text: 'Win an online match', goal: 1, reward: 250, count: (e) => (e.mode === 'online' && e.won ? 1 : 0) },
  { id: 'dmg500', text: 'Deal 500 damage', goal: 500, reward: 120, count: (e) => e.damage },
  { id: 'kill5', text: 'Destroy 5 tanks', goal: 5, reward: 150, count: (e) => e.kills },
  { id: 'general', text: 'Beat the General (hard computer)', goal: 1, reward: 200, count: (e) => (e.mode === 'ai' && e.diff === 'hard' && e.won ? 1 : 0) },
  { id: 'arcade5', text: 'Clear wave 5 in Arcade', goal: 5, reward: 200, best: (e) => (e.mode === 'arcade' ? e.wave : 0) },
  { id: 'cluster3', text: 'Destroy 3 tanks with the Cluster Bomb', goal: 3, reward: 250, needs: 'weapon:cluster', count: (e) => e.weaponKills.cluster || 0 },
  { id: 'airstrike2', text: 'Destroy 2 tanks with an Airstrike', goal: 2, reward: 250, needs: 'weapon:airstrike', count: (e) => e.weaponKills.airstrike || 0 },
  { id: 'homing2', text: 'Destroy 2 tanks with the Homing Missile', goal: 2, reward: 250, needs: 'weapon:homing', count: (e) => e.weaponKills.homing || 0 },
  { id: 'nuke1', text: 'Destroy a tank with the Mega Nuke', goal: 1, reward: 200, needs: 'weapon:nuke', count: (e) => e.weaponKills.nuke || 0 },
];

function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Three missions a day, picked per player from the ones they can do with what they own. */
function missionsFor(u) {
  const d = today();
  if (u.missions?.day !== d) {
    const pool = MISSIONS.filter((m) => !m.needs || canUse(u, m.needs));
    let h = hash(keyOf(u) + d);
    const list = [];
    while (list.length < 3 && pool.length) {
      h = (Math.imul(h, 1103515245) + 12345) >>> 0;
      list.push({ id: pool.splice(h % pool.length, 1)[0].id, progress: 0, done: false });
    }
    u.missions = { day: d, list };
  }
  return u.missions.list;
}

/** Moves today's missions along and pays out the ones this match finished. */
function progress(u, e) {
  const finished = [];
  for (const m of missionsFor(u)) {
    const def = MISSIONS.find((x) => x.id === m.id);
    if (!def || m.done) continue;
    m.progress = Math.min(def.goal, def.best ? Math.max(m.progress, def.best(e)) : m.progress + def.count(e));
    if (m.progress >= def.goal) {
      m.done = true;
      finished.push({ text: def.text, coins: grant(u, def.reward, false) });
    }
  }
  return finished;
}

/** Kills per weapon as reported by the game, limited to weapons the player owns and to the kills allowed. */
function cleanWeaponKills(u, wk, maxKills) {
  const out = {};
  let left = maxKills;
  for (const [id, n] of Object.entries(wk && typeof wk === 'object' ? wk : {})) {
    if (!canUse(u, `weapon:${id}`)) continue;
    const k = Math.max(0, Math.min(left, Math.floor(Number(n) || 0)));
    if (k) out[id] = k;
    left -= k;
  }
  return out;
}

// ------------------------------------------------------------------ what the game sees

export function view(u) {
  ensure(u);
  const vip = isVip(u);
  const p = u.profile;
  const streak = nextStreak(u);
  return {
    coins: p.coins,
    owned: hasPass(u) ? ALL_ITEMS : vip ? [...p.owned, ...CATALOG.vipOnly] : p.owned,
    equipped: p.equipped,
    stats: p.stats,
    rating: p.rating,
    rank: rankFor(p.rating),
    vip,
    vipUntil: vip ? u.vipUntil || 0 : 0,
    pass: hasPass(u),
    paidTotal: u.paidTotal || 0,
    daily: { available: u.daily.last !== today(), streak, coins: dailyReward(streak) * (vip ? CATALOG.vip.multiplier : 1) },
    missions: missionsFor(u).map((m) => {
      const def = MISSIONS.find((x) => x.id === m.id);
      return { text: def.text, goal: def.goal, reward: def.reward * (vip ? CATALOG.vip.multiplier : 1), progress: m.progress, done: m.done };
    }),
    admin: ADMINS.includes(keyOf(u)),
  };
}

export function newProfile() {
  return { coins: 300, owned: [...CATALOG.starter], equipped: { ...DEFAULT_EQUIP }, stats: {}, rating: 1000 };
}

// ------------------------------------------------------------------ purchases (called by the payment webhook)

/** Adds bought coins (or removes them, for a refund) once per payment transaction. */
export function creditCoins(key, amount, txId) {
  const u = userByKey(key);
  if (!u) return false;
  ensure(u);
  u.payments ||= {};
  if (u.payments[txId] !== undefined) return false;
  u.payments[txId] = amount;
  u.paidTotal = (u.paidTotal || 0) + amount;
  u.profile.coins = Math.max(0, u.profile.coins + amount);
  persist();
  return true;
}

/** Adds (or, for a refund, removes) VIP days once per payment transaction. */
export function addVip(key, days, txId) {
  const u = userByKey(key);
  if (!u) return false;
  u.vipPayments ||= {};
  if (u.vipPayments[txId] !== undefined) return false;
  u.vipPayments[txId] = days;
  u.vipUntil = days > 0 ? Math.max(Date.now(), u.vipUntil || 0) + days * DAY : Math.max(0, (u.vipUntil || 0) + days * DAY);
  ensure(u);
  persist();
  return true;
}

/** Gives (or, for a refund, takes back) the Game Pass once per payment transaction. */
export function setPass(key, on, txId) {
  const u = userByKey(key);
  if (!u) return false;
  u.passPayments ||= {};
  if (u.passPayments[txId] !== undefined) return false;
  u.passPayments[txId] = on ? 1 : -1;
  u.pass = on;
  ensure(u);
  leaderCache = null;
  persist();
  return true;
}

// ------------------------------------------------------------------ online results (called by the match server)

/**
 * Pays both online players and moves their ratings.
 * outcome: { winner: 0 | 1 | null, damage: [a, b], weaponKills: [{}, {}], ranked }
 */
export function settleOnline(keys, outcome) {
  const us = keys.map((k) => userByKey(k));
  if (us.some((u) => !u)) return null;
  us.forEach(ensure);
  const before = us.map((u) => u.profile.rating);
  const out = us.map((u, i) => {
    const won = outcome.winner === i;
    let change = 0;
    if (outcome.ranked) {
      const expected = 1 / (1 + 10 ** ((before[1 - i] - before[i]) / 400));
      const score = outcome.winner === null ? 0.5 : won ? 1 : 0;
      change = Math.round(32 * (score - expected));
      u.profile.rating = Math.max(0, before[i] + change);
    }
    const damage = Math.max(0, Math.min(200, Math.floor(Number(outcome.damage?.[i]) || 0)));
    const coins = grant(u, damage / 2 + (won ? 100 : 15));
    const st = u.profile.stats;
    st.played++;
    st.onlinePlayed++;
    const kills = won ? 1 : 0;
    st.kills += kills;
    if (won) {
      st.wins++;
      st.onlineWins++;
    }
    const missions = progress(u, { mode: 'online', won, damage, kills, weaponKills: cleanWeaponKills(u, outcome.weaponKills?.[i], kills) });
    return { coins, rating: u.profile.rating, change, rank: rankFor(u.profile.rating), ranked: !!outcome.ranked, missions, profile: view(u) };
  });
  leaderCache = null;
  persist();
  return out;
}

// ------------------------------------------------------------------ offline matches (vs computer, two players, arcade)

/** Matches in progress: id -> { key, mode, diff, started, wave } */
const tickets = new Map();
setInterval(() => {
  for (const [id, t] of tickets) if (Date.now() - t.started > 3 * 3600_000) tickets.delete(id);
}, 600_000).unref();

/** Enemy tanks per arcade wave (matches the wave table in the game). */
const arcadeFoes = (w) => [1, 1, 2, 2, 1, 2, 2, 3][w - 1] ?? 3;
const AI_BONUS = { easy: 0, normal: 40, hard: 90 };

function finishMatch(u, t, body) {
  const st = u.profile.stats;
  const won = body.won === true;
  const damageIn = Math.max(0, Math.floor(Number(body.damage) || 0));
  const elapsed = Date.now() - t.started;
  const res = { coins: 0, missions: [] };

  if (t.mode === 'local') {
    tickets.delete(t.id);
    st.played++;
    // Both players are on one keyboard, so only a few matches a day pay and missions don't move.
    if (elapsed >= 12_000 && u.earned.local < LOCAL_PER_DAY) {
      u.earned.local++;
      res.coins = grant(u, 25 + Math.min(damageIn, 300) / 4);
    }
    return res;
  }

  if (t.mode === 'ai') {
    tickets.delete(t.id);
    if (elapsed < 12_000) return { ...res, note: 'That match was too short to count.' };
    const damage = Math.min(damageIn, 200);
    const kills = won ? 1 : 0;
    st.played++;
    st.kills += kills;
    if (won) st.wins++;
    res.coins = grant(u, damage / 2 + (won ? 60 + AI_BONUS[t.diff] : 10));
    res.missions = progress(u, { mode: 'ai', diff: t.diff, won, damage, kills, weaponKills: cleanWeaponKills(u, body.weaponKills, kills) });
    return res;
  }

  // Arcade: one ticket covers a whole run, one wave at a time.
  const wave = t.wave;
  const foes = arcadeFoes(wave);
  if (elapsed < 8_000 * foes) {
    tickets.delete(t.id);
    return { ...res, over: true, note: 'That wave was too short to count.' };
  }
  const damage = Math.min(damageIn, 200 * foes);
  const kills = won ? foes : Math.min(foes - 1, Math.max(0, Math.floor(Number(body.kills) || 0)));
  st.kills += kills;
  res.coins = grant(u, damage / 3 + (won ? 30 + wave * 20 : 0));
  const cleared = won ? wave : wave - 1;
  st.arcadeBest = Math.max(st.arcadeBest, cleared);
  if (won) {
    t.wave++;
    t.started = Date.now();
  } else {
    tickets.delete(t.id);
    st.played++;
  }
  res.missions = progress(u, { mode: 'arcade', won, wave: cleared, damage, kills, weaponKills: cleanWeaponKills(u, body.weaponKills, kills) });
  res.wave = t.wave;
  return res;
}

// ------------------------------------------------------------------ leaderboards

let leaderCache = null;
function leaderboard() {
  if (leaderCache && Date.now() - leaderCache.at < 30_000) return leaderCache.data;
  const all = Object.values(db.users).map(ensure);
  const top = (filter, value) =>
    all.filter(filter).sort((a, b) => value(b) - value(a)).slice(0, 10)
      .map((u) => ({ name: u.name, value: value(u), rank: rankFor(u.profile.rating), vip: isVip(u) }));
  const data = {
    rating: top((u) => u.profile.stats.onlinePlayed > 0, (u) => u.profile.rating),
    wins: top((u) => u.profile.stats.onlineWins > 0, (u) => u.profile.stats.onlineWins),
    arcade: top((u) => u.profile.stats.arcadeBest > 0, (u) => u.profile.stats.arcadeBest),
  };
  leaderCache = { at: Date.now(), data };
  return data;
}

// ------------------------------------------------------------------ routes

const ROUTES = new Set(['/api/account/buy', '/api/account/equip', '/api/account/daily', '/api/account/match/start', '/api/account/match/finish', '/api/leaderboard', '/api/admin/purchases']);

/** Handles the economy routes. Returns false for other paths. */
export async function handleEconomy(req, res, path) {
  if (!ROUTES.has(path)) return false;
  if (cors(req, res)) return true;
  if (path === '/api/leaderboard') return json(res, 200, leaderboard()), true;

  const who = userFor(req);
  if (!who?.user) return json(res, 401, { error: 'Please sign in again.' }), true;
  const u = ensure(who.user);

  if (path === '/api/admin/purchases' && req.method === 'GET') {
    if (!ADMINS.includes(who.key)) return json(res, 403, { error: 'Only the game owner can see this.' }), true;
    return json(res, 200, { purchases: readPurchases() }), true;
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Not allowed.' }), true;
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: 'Bad request.' }), true;
  }
  const p = u.profile;

  if (path === '/api/account/buy') {
    const item = String(body.item || '');
    const price = priceOf(item);
    if (price === null) return json(res, 400, { error: "That item isn't for sale." }), true;
    if (CATALOG.vipOnly.includes(item)) return json(res, 400, { error: 'This one comes with VIP membership.' }), true;
    if (!canUse(u, item)) {
      if (p.coins < price) return json(res, 400, { error: `You need ${price - p.coins} more coins.` }), true;
      p.coins -= price;
      p.owned.push(item);
      const [slot, id] = item.split(':');
      if (SLOTS.includes(slot)) p.equipped[slot] = id;
      persist();
    }
    return json(res, 200, { profile: view(u) }), true;
  }

  if (path === '/api/account/equip') {
    const slot = String(body.slot || '');
    const item = `${slot}:${body.id}`;
    if (!SLOTS.includes(slot) || !canUse(u, item)) return json(res, 400, { error: "You don't own that yet." }), true;
    p.equipped[slot] = String(body.id);
    persist();
    return json(res, 200, { profile: view(u) }), true;
  }

  if (path === '/api/account/daily') {
    if (u.daily.last === today()) return json(res, 409, { error: 'You already collected today\'s reward. Come back tomorrow.', profile: view(u) }), true;
    const streak = nextStreak(u);
    u.daily = { last: today(), streak };
    const coins = grant(u, dailyReward(streak), false);
    persist();
    return json(res, 200, { coins, streak, profile: view(u) }), true;
  }

  if (path === '/api/account/match/start') {
    const mode = ['ai', 'local', 'arcade'].includes(body.mode) ? body.mode : null;
    if (!mode) return json(res, 400, { error: 'Unknown mode.' }), true;
    const id = randomBytes(12).toString('hex');
    tickets.set(id, { id, key: who.key, mode, diff: AI_BONUS[body.diff] !== undefined ? body.diff : 'easy', started: Date.now(), wave: 1 });
    return json(res, 200, { id }), true;
  }

  if (path === '/api/account/match/finish') {
    const t = tickets.get(String(body.id || ''));
    if (!t || t.key !== who.key) return json(res, 404, { error: 'That match has already been counted.', profile: view(u) }), true;
    const r = finishMatch(u, t, body);
    leaderCache = null;
    persist();
    return json(res, 200, { ...r, profile: view(u) }), true;
  }
  return json(res, 404, { error: 'Not found.' }), true;
}
