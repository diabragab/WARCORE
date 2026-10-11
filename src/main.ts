import '@fontsource/chakra-petch/400.css';
import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import './style.css';

import { Game, type Difficulty, type MatchResult, type PlayerSetup } from './game';
import { Online, type OnlineReward } from './online';
import { DECALS, MODELS, PAINTS, TRAILS, WEAPONS, modelById, paintById, rankFor, type Cosmetic, type Look } from './data';
import { drawTank, tankFrame, trailColor, whenTankArtReady } from './draw';
import { THEMES } from './terrain';
import { loadProfile, normalize, owns, saveProfile, type Profile } from './profile';
import * as account from './account';
import { sfx } from './sfx';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

let profile = loadProfile();
const canvas = $<HTMLCanvasElement>('#game');
const ctx = canvas.getContext('2d')!;
let game: Game;
let inMatch = false;

// ------------------------------------------------------------------ canvas loop

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
}
window.addEventListener('resize', resize);
resize();

/** Vivid colours: a punchier grade on the canvas plus a soft bloom around fire, explosions and bright skies. */
const graphics = { vivid: true };
const bloom = document.createElement('canvas');
const bctx = bloom.getContext('2d')!;

function applyBloom() {
  const w = Math.max(1, Math.round(canvas.width / 4)), h = Math.max(1, Math.round(canvas.height / 4));
  if (bloom.width !== w || bloom.height !== h) Object.assign(bloom, { width: w, height: h });
  // Keep only the bright parts (high contrast pushes the rest to black), blur them, then add them back as glow.
  bctx.filter = 'brightness(0.55) contrast(2.6) saturate(1.4) blur(3px)';
  bctx.globalCompositeOperation = 'copy';
  bctx.drawImage(canvas, 0, 0, w, h);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.45;
  ctx.drawImage(bloom, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  game.update(dt);
  game.render(ctx, canvas.width, canvas.height);
  if (graphics.vivid) applyBloom();
  requestAnimationFrame(frame);
}

const rand = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const seed = () => Math.floor(Math.random() * 2 ** 31);

function startDemo() {
  inMatch = false;
  const looks = [0, 1].map(() => ({ paint: rand(PAINTS).value, decal: rand(DECALS).id, trail: rand(TRAILS).id }));
  const all = WEAPONS.filter((w) => w.kind !== 'dirt' && w.kind !== 'teleport').map((w) => w.id);
  game = new Game({
    players: [
      { name: 'Alpha', team: 0, color: '#ff8a3d', ai: 'hard', model: rand(MODELS).id, look: looks[0], weapons: all },
      { name: 'Bravo', team: 1, color: '#6fc3e8', ai: 'normal', model: rand(MODELS).id, look: looks[1], weapons: all },
    ],
    theme: 'warzone',
    seed: seed(),
    demo: true,
    onEnd: () => setTimeout(() => !inMatch && startDemo(), 400),
  });
}

// ------------------------------------------------------------------ screens

const screens = ['menu', 'setup', 'shop', 'online', 'settings', 'account', 'buy', 'leaders', 'purchases', 'pause', 'result'] as const;
type Screen = (typeof screens)[number] | 'none';
/** Players need an account to play (except in the offline preview page, which can't reach the server). */
const mustSignIn = () => account.accountsAvailable() && !account.session;

function show(name: Screen) {
  if (mustSignIn() && name !== 'account') {
    name = 'account';
    renderAccount();
  }
  for (const s of screens) $(`#${s}`).hidden = s !== name;
  $('#touch').hidden = !(inMatch && name === 'none' && matchMedia('(pointer: coarse)').matches);
  $('#vignette').hidden = inMatch || name === 'none' || name === 'result';
  if (name === 'menu') renderMenu();
}

function renderMenu() {
  const s = account.session;
  $('#menu-welcome').innerHTML = s ? 'Welcome back' : 'Welcome to <strong>WARCORE</strong>';
  if (s) {
    const strong = document.createElement('strong');
    strong.textContent = s.name;
    $('#menu-welcome').append(strong);
  }
  $('#btn-account').textContent = s ? 'Account' : 'Sign in to save your progress';
  $('#btn-account').hidden = !account.accountsAvailable();
  $('#menu-coins').textContent = `${profile.coins} coins`;
  $('#menu-rank').replaceChildren(...badges(profile.rating, profile.vip));
  renderMissions();
  $('#menu-stats').textContent = profile.stats.played ? `${profile.stats.wins} ${profile.stats.wins === 1 ? 'win' : 'wins'} from ${profile.stats.played} ${profile.stats.played === 1 ? 'match' : 'matches'}` : 'No matches played yet';
  if (profile.stats.arcadeBest) $('#menu-stats').textContent += ` · Arcade best: wave ${profile.stats.arcadeBest}`;
}

/** Rank and VIP badges for a player (nothing for a player without a rating, e.g. in the offline preview). */
function badges(rating?: number, vip?: boolean): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (rating !== undefined) {
    const rank = rankFor(rating);
    const b = document.createElement('span');
    b.className = `badge ${rank.toLowerCase()}`;
    b.textContent = `${rank} · ${rating}`;
    b.title = 'Ranked online rating';
    out.push(b);
  }
  if (vip) {
    const v = document.createElement('span');
    v.className = 'badge vip';
    v.textContent = 'VIP';
    out.push(v);
  }
  return out;
}

// ------------------------------------------------------------------ daily reward and missions

function renderMissions() {
  const side = $('#menu-side');
  side.hidden = !account.session || !profile.missions;
  if (side.hidden) return;
  const d = profile.daily;
  $('#daily').hidden = !d;
  if (d) {
    $('#daily-text').textContent = d.available
      ? `Day ${d.streak} streak: collect ${d.coins} coins`
      : `Collected. Come back tomorrow for day ${d.streak + 1}.`;
    $<HTMLButtonElement>('#btn-daily').hidden = !d.available;
  }
  $('#missions').replaceChildren(
    ...(profile.missions ?? []).map((m) => {
      const li = document.createElement('li');
      li.className = m.done ? 'done' : '';
      const text = document.createElement('span');
      text.textContent = `${m.done ? '✓ ' : ''}${m.text}${m.goal > 1 ? `  (${m.progress}/${m.goal})` : ''}`;
      const reward = document.createElement('span');
      reward.className = 'reward';
      reward.textContent = m.done ? 'Done' : `+${m.reward}`;
      const bar = document.createElement('span');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.round((100 * m.progress) / m.goal)}%`;
      bar.append(fill);
      li.append(text, reward, bar);
      return li;
    }),
  );
}

$('#btn-daily').onclick = async () => {
  const b = $<HTMLButtonElement>('#btn-daily');
  b.disabled = true;
  try {
    const r = await account.claimDaily();
    useProfile(r.profile);
    sfx.coin();
    $('#daily-text').textContent = `+${r.coins} coins! Come back tomorrow for day ${r.streak + 1}.`;
    $('#menu-coins').textContent = `${profile.coins} coins`;
    b.hidden = true;
  } catch (e) {
    $('#daily-text').textContent = (e as Error).message;
  } finally {
    b.disabled = false;
  }
};

// ------------------------------------------------------------------ leaderboard

type Board = 'rating' | 'wins' | 'arcade';
let board: Board = 'rating';
let boards: Awaited<ReturnType<typeof account.leaderboard>> | null = null;

function renderLeaders() {
  const tabs: { id: Board; label: string; head: string }[] = [
    { id: 'rating', label: 'Rank', head: 'Rating' },
    { id: 'wins', label: 'Online wins', head: 'Wins' },
    { id: 'arcade', label: 'Arcade', head: 'Best wave' },
  ];
  $('#leader-tabs').replaceChildren(
    ...tabs.map((t) => {
      const b = document.createElement('button');
      b.className = 'tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t.id === board));
      b.textContent = t.label;
      b.onclick = () => {
        board = t.id;
        sfx.click();
        renderLeaders();
      };
      return b;
    }),
  );
  const table = $('#leader-table');
  table.replaceChildren();
  if (!boards) return;
  const rows = boards[board];
  $('#leader-status').textContent = rows.length ? '' : 'Nobody is on this board yet. Play a match to be the first!';
  const head = document.createElement('tr');
  for (const h of ['#', 'Commander', tabs.find((t) => t.id === board)!.head]) {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    if (r.name === account.session?.name) tr.className = 'me';
    const pos = document.createElement('td');
    pos.textContent = String(i + 1);
    const name = document.createElement('td');
    name.append(r.name, ' ', ...badges(undefined, r.vip));
    const rank = document.createElement('span');
    rank.className = `badge ${r.rank.toLowerCase()}`;
    rank.textContent = r.rank;
    name.append(' ', rank);
    const val = document.createElement('td');
    val.textContent = String(r.value);
    tr.append(pos, name, val);
    tbody.append(tr);
  });
  table.append(thead, tbody);
}

async function openLeaders() {
  boards = null;
  $('#leader-status').textContent = 'Loading…';
  renderLeaders();
  show('leaders');
  try {
    boards = await account.leaderboard();
    renderLeaders();
  } catch (e) {
    $('#leader-status').textContent = (e as Error).message;
  }
}
$('#btn-leaders').onclick = openLeaders;
$('#btn-leaders').hidden = !account.accountsAvailable();

// ------------------------------------------------------------------ purchase log (game owner only)

async function openPurchases() {
  show('purchases');
  $('#purchase-summary').textContent = 'Loading…';
  $('#purchase-table').replaceChildren();
  try {
    const list = await account.purchases();
    const money = (n: number, c: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD' }).format(n);
    const paid = list.filter((p) => p.type === 'payment').reduce((a, p) => a + p.amount, 0);
    const refunded = list.filter((p) => p.type === 'refund').reduce((a, p) => a + p.amount, 0);
    $('#purchase-summary').textContent = list.length
      ? `${list.filter((p) => p.type === 'payment').length} payments (${money(paid, 'USD')}), ${list.filter((p) => p.type === 'refund').length} refunds (${money(refunded, 'USD')}). Newest first.`
      : 'No payments yet.';
    const head = document.createElement('tr');
    for (const h of ['When', 'Type', 'Player', 'Item', 'Amount', 'Coins', 'Whop payment']) {
      const th = document.createElement('th');
      th.textContent = h;
      head.append(th);
    }
    const thead = document.createElement('thead');
    thead.append(head);
    const tbody = document.createElement('tbody');
    for (const p of list) {
      const tr = document.createElement('tr');
      const item = p.item === 'vip' ? `VIP${p.reason === 'subscription_cycle' ? ' (renewal)' : ''}` : p.item;
      for (const v of [new Date(p.time).toLocaleString(), p.type === 'refund' ? 'Refund' : 'Payment', p.player, item, money(p.amount, p.currency), p.coins ? String(p.coins) : '', p.payment]) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.append(td);
      }
      tbody.append(tr);
    }
    $('#purchase-table').append(thead, tbody);
  } catch (e) {
    $('#purchase-summary').textContent = (e as Error).message;
  }
}
$('#acc-purchases').onclick = openPurchases;
$('#purchases-back').onclick = () => {
  renderAccount();
  show('account');
};

// ------------------------------------------------------------------ settings

const isDesktopApp = '__TAURI_INTERNALS__' in window;
const SETTINGS_KEY = 'tanks.settings';
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  sfx.muted = saved.muted === true;
  graphics.vivid = saved.vivid !== false;
} catch {
  /* defaults */
}
canvas.classList.toggle('vivid', graphics.vivid);

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ muted: sfx.muted, vivid: graphics.vivid }));
  } catch {
    /* ignore */
  }
}

async function setFullscreen(on: boolean) {
  try {
    if (isDesktopApp) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setFullscreen(on);
    } else if (on) await document.documentElement.requestFullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* fullscreen refused (e.g. inside an embedded page) */
  }
  setTimeout(renderSettings, 200);
}

async function isFullscreen(): Promise<boolean> {
  if (isDesktopApp) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      return await getCurrentWindow().isFullscreen();
    } catch {
      return false;
    }
  }
  return !!document.fullscreenElement;
}

async function renderSettings() {
  chips($('#pick-sound'), [{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }], sfx.muted ? 'off' : 'on', (v) => {
    sfx.muted = v === 'off';
    saveSettings();
  }, renderSettings);
  chips($('#pick-colors'), [{ id: 'vivid', label: 'Vivid HDR' }, { id: 'natural', label: 'Natural' }], graphics.vivid ? 'vivid' : 'natural', (v) => {
    graphics.vivid = v === 'vivid';
    canvas.classList.toggle('vivid', graphics.vivid);
    saveSettings();
  }, renderSettings);
  const fs = await isFullscreen();
  chips($('#pick-display'), [{ id: 'window', label: 'Window' }, { id: 'full', label: 'Fullscreen' }], fs ? 'full' : 'window', (v) => setFullscreen(v === 'full'), renderSettings);
}

$('#btn-settings').onclick = () => {
  renderSettings();
  show('settings');
};
$('#btn-exit').hidden = !isDesktopApp;
$('.split').classList.toggle('single', !isDesktopApp);
$('#btn-exit').onclick = async () => {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  getCurrentWindow().close();
};

document.addEventListener('pointerdown', () => sfx.unlock(), { capture: true });
document.addEventListener('keydown', () => sfx.unlock(), { capture: true });
document.querySelectorAll<HTMLElement>('[data-back]').forEach((b) => (b.onclick = () => show('menu')));

// ------------------------------------------------------------------ account

let accMode: 'login' | 'register' = 'login';

function renderAccount(status = '') {
  const s = account.session;
  $('#acc-form').hidden = !!s;
  $('#acc-signed').hidden = !s;
  $('#acc-title').textContent = s ? s.name : accMode === 'login' ? 'Sign in' : 'Create an account';
  $('#acc-eyebrow').textContent = s ? 'Player account' : 'Sign in to play WARCORE';
  $('#acc-back').hidden = mustSignIn();
  if (s) {
    $('#acc-signed-text').textContent = 'Your coins, tanks, weapons and paint jobs are saved to this account. Sign in with the same name on any computer or browser to get them back.';
    const st = profile.stats;
    const rows: [string, string][] = [
      ['Rank', profile.rating !== undefined ? `${rankFor(profile.rating)} (${profile.rating})` : '-'],
      ['Online wins', `${st.onlineWins ?? 0} of ${st.onlinePlayed ?? 0}`],
      ['All wins', `${st.wins} of ${st.played}`],
      ['Tanks destroyed', String(st.kills ?? 0)],
      ['Best arcade wave', String(st.arcadeBest)],
      ['VIP', profile.vip && profile.vipUntil ? `Active until ${new Date(profile.vipUntil).toLocaleDateString()}` : 'No'],
    ];
    const tb = document.createElement('tbody');
    for (const [a, b] of rows) {
      const tr = document.createElement('tr');
      for (const v of [a, b]) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.append(td);
      }
      tb.append(tr);
    }
    $('#acc-stats').replaceChildren(tb);
    $('#acc-purchases').hidden = !profile.admin;
  }
  $('#acc-tab-login').setAttribute('aria-selected', String(accMode === 'login'));
  $('#acc-tab-register').setAttribute('aria-selected', String(accMode === 'register'));
  $('#acc-submit').textContent = accMode === 'login' ? 'Sign in' : 'Create account';
  $<HTMLInputElement>('#acc-pass').autocomplete = accMode === 'login' ? 'current-password' : 'new-password';
  $('#acc-hint').textContent =
    accMode === 'login'
      ? 'Signing in loads the progress saved on your account.'
      : 'Pick a player name (3 to 16 letters or numbers) and a password of at least 6 characters. Your coins and everything you buy are saved to it.';
  $('#acc-legal').hidden = accMode !== 'register';
  $('#acc-status').textContent = status;
  $('#acc-status').classList.toggle('error', false);
}

// The Windows app opens these pages in the player's browser.
document.querySelectorAll<HTMLAnchorElement>('#acc-legal a').forEach((a) =>
  a.addEventListener('click', async (e) => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    e.preventDefault();
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    openUrl(a.href);
  }),
);

/** Takes the account's profile from the server, which decides coins and purchases. */
function useProfile(p: Profile) {
  profile = normalize(p);
  saveProfile(profile);
}

$('#btn-account').onclick = () => {
  renderAccount();
  show('account');
};
$('#acc-tab-login').onclick = () => ((accMode = 'login'), renderAccount());
$('#acc-tab-register').onclick = () => ((accMode = 'register'), renderAccount());
$('#acc-fields').onsubmit = async (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>('#acc-name').value.trim();
  const pass = $<HTMLInputElement>('#acc-pass').value;
  const btn = $<HTMLButtonElement>('#acc-submit');
  btn.disabled = true;
  $('#acc-status').textContent = accMode === 'login' ? 'Signing in…' : 'Creating your account…';
  try {
    useProfile(accMode === 'login' ? await account.login(name, pass) : await account.register(name, pass));
    $<HTMLInputElement>('#acc-pass').value = '';
    sfx.coin();
    show('menu');
  } catch (err) {
    $('#acc-status').textContent = (err as Error).message;
    $('#acc-status').classList.add('error');
  } finally {
    btn.disabled = false;
  }
};
$('#acc-logout').onclick = async () => {
  await account.logout();
  // The next person to sign in on this computer shouldn't inherit this player's items.
  useProfile(normalize({}));
  renderAccount();
  show('account');
};

// Refresh from the account on start, so purchases made on another computer show up here.
account.fetchProfile().then(
  (p) => {
    if (p) {
      useProfile(p);
      if (!$('#menu').hidden) renderMenu();
    }
  },
  () => {
    // An expired sign-in sends the player back to the sign-in screen.
    if (mustSignIn() && !inMatch) show('account');
  },
);

// ------------------------------------------------------------------ setup

type Mode = 'ai' | 'local' | 'online' | 'arcade';
const setup = { mode: 'ai' as Mode, map: 'random', diff: 'normal' as Difficulty, p2Tank: 'patton', p2Paint: 'sand' };

function chips<T extends string>(el: HTMLElement, items: { id: T; label: string; sub?: string; swatch?: string }[], current: T, pick: (v: T) => void, rerender: () => void = renderSetup) {
  el.replaceChildren(
    ...items.map((it) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.setAttribute('aria-pressed', String(it.id === current));
      if (it.swatch) {
        const s = document.createElement('span');
        s.className = 'swatch';
        s.style.background = it.swatch;
        b.append(s);
      }
      b.append(it.label);
      if (it.sub) {
        const s = document.createElement('small');
        s.textContent = it.sub;
        b.append(s);
      }
      b.onclick = () => {
        pick(it.id);
        sfx.click();
        rerender();
      };
      return b;
    }),
  );
}

function renderSetup() {
  const ai = setup.mode === 'ai';
  $('#setup-title').textContent = ai ? 'Play vs Computer' : 'Two Players';
  $('#field-diff').hidden = !ai;
  $('#field-p2').hidden = ai;
  chips($('#pick-map'), [{ id: 'random', label: 'Random' }, ...Object.entries(THEMES).map(([id, t]) => ({ id, label: t.name }))], setup.map, (v) => (setup.map = v));
  chips(
    $('#pick-diff'),
    [
      { id: 'easy' as Difficulty, label: 'Recruit', sub: 'misses a lot' },
      { id: 'normal' as Difficulty, label: 'Sergeant', sub: 'fair fight' },
      { id: 'hard' as Difficulty, label: 'General', sub: 'rarely misses' },
    ],
    setup.diff,
    (v) => (setup.diff = v),
  );
  const ownedTanks = MODELS.filter((m) => owns(profile, 'tank', m.id));
  const ownedPaints = PAINTS.filter((p) => owns(profile, 'paint', p.id));
  if (!ownedTanks.some((m) => m.id === setup.p2Tank)) setup.p2Tank = ownedTanks[0].id;
  if (!ownedPaints.some((p) => p.id === setup.p2Paint)) setup.p2Paint = ownedPaints[0].id;
  chips($('#pick-p2-tank'), ownedTanks.map((m) => ({ id: m.id, label: m.name })), setup.p2Tank, (v) => (setup.p2Tank = v));
  chips($('#pick-p2-paint'), ownedPaints.map((p) => ({ id: p.id, label: p.name, swatch: p.value })), setup.p2Paint, (v) => (setup.p2Paint = v));
  $('#setup-hint').textContent = ai
    ? `You drive your ${modelById(profile.equipped.tank).name} with the weapons you own. Wins pay more against tougher opponents.`
    : 'Both players share the keyboard and take turns: ← → drive, ↑ ↓ aim, hold Space to fire, Q / E to switch weapons.';
}

function openSetup(mode: Mode) {
  setup.mode = mode;
  renderSetup();
  show('setup');
}

const AI_NAMES: Record<Difficulty, string> = { easy: 'Cpl. Pinecone', normal: 'Sgt. Ramsay', hard: 'Gen. Ironside' };
const AI_WEAPONS: Record<Difficulty, string[]> = {
  easy: ['shell', 'heavy'],
  normal: ['shell', 'heavy', 'triple', 'cluster'],
  hard: ['shell', 'heavy', 'triple', 'cluster', 'nuke'],
};

function myLook(): Look {
  const e = profile.equipped;
  return { paint: paintById(e.paint).value, decal: e.decal, trail: e.trail };
}

/** The server's id for the match being played, which the reward is collected with (signed-in players only). */
let ticket: Promise<string | null> = Promise.resolve(null);
const openTicket = (mode: 'ai' | 'local' | 'arcade', diff?: string) => {
  ticket = account.session ? account.matchStart(mode, diff).catch(() => null) : Promise.resolve(null);
};

/** Result-screen lines for missions finished in a match. */
function noteMissions(list: { text: string; coins: number }[], extra: string[] = []) {
  $('#result-notes').replaceChildren(
    ...[...extra, ...list.map((m) => `Mission complete: ${m.text}  +${m.coins}`)].map((t) => {
      const li = document.createElement('li');
      li.textContent = t;
      return li;
    }),
  );
}

/** Kills per weapon id for one side of a match. */
const killsOf = (r: MatchResult, team: number) => {
  const out: Record<string, number> = {};
  for (const p of r.players) if (p.team === team) for (const [k, v] of Object.entries(p.weaponKills)) out[k] = (out[k] ?? 0) + v;
  return out;
};

function startMatch() {
  if (setup.mode === 'ai' || setup.mode === 'local') openTicket(setup.mode, setup.diff);
  const weapons = WEAPONS.filter((w) => owns(profile, 'weapon', w.id)).map((w) => w.id);
  const ai = setup.mode === 'ai';
  const p1: PlayerSetup = { name: ai ? 'You' : 'Player 1', team: 0, color: '#ff8a3d', model: profile.equipped.tank, look: myLook(), weapons };
  let p2: PlayerSetup;
  if (ai) {
    const paints = PAINTS.filter((p) => p.id !== profile.equipped.paint);
    p2 = {
      name: AI_NAMES[setup.diff], team: 1, color: '#6fc3e8', ai: setup.diff, model: rand(MODELS).id,
      look: { paint: rand(paints).value, decal: rand(DECALS).id, trail: 'smoke' }, weapons: AI_WEAPONS[setup.diff],
    };
  } else {
    p2 = {
      name: 'Player 2', team: 1, color: '#6fc3e8', model: setup.p2Tank,
      look: { paint: paintById(setup.p2Paint).value, decal: profile.equipped.decal, trail: profile.equipped.trail }, weapons,
    };
  }
  const players = Math.random() < 0.5 ? [p1, p2] : [p2, p1];
  inMatch = true;
  game = new Game({
    players,
    theme: setup.map === 'random' ? rand(Object.keys(THEMES)) : setup.map,
    seed: seed(),
    onEnd: finishMatch,
  });
  show('none');
}

// ------------------------------------------------------------------ arcade

/** Arcade: survive waves of computer tanks. Damage carries over, with a partial repair between waves. */
const arcade = { wave: 1, hp: 0, damage: 0, coins: 0, won: false };
const CALLSIGNS = ['Viper', 'Hammer', 'Rook', 'Grizzly', 'Talon', 'Mako', 'Brick', 'Jackal', 'Saber', 'Onyx', 'Havoc', 'Cinder'];
const RANKS: Record<Difficulty, string> = { easy: 'Pvt.', normal: 'Sgt.', hard: 'Maj.' };

function arcadeEnemies(w: number): Difficulty[] {
  const waves: Difficulty[][] = [
    ['easy'], ['normal'], ['easy', 'easy'], ['normal', 'easy'], ['hard'],
    ['normal', 'normal'], ['hard', 'normal'], ['normal', 'normal', 'easy'],
  ];
  return waves[w - 1] ?? (w % 2 ? ['hard', 'hard', 'normal'] : ['hard', 'normal', 'normal']);
}

function startArcade(fresh: boolean) {
  const model = modelById(profile.equipped.tank);
  if (fresh) {
    Object.assign(arcade, { wave: 1, hp: model.hp, damage: 0, coins: 0, won: false });
    openTicket('arcade');
  }
  setup.mode = 'arcade';
  const weapons = WEAPONS.filter((w) => owns(profile, 'weapon', w.id)).map((w) => w.id);
  const me: PlayerSetup = { name: 'You', team: 0, color: '#ff8a3d', model: model.id, look: myLook(), weapons, hp: arcade.hp };
  const names = [...CALLSIGNS].sort(() => Math.random() - 0.5);
  const paints = PAINTS.filter((p) => p.id !== profile.equipped.paint);
  const foes: PlayerSetup[] = arcadeEnemies(arcade.wave).map((d, i) => ({
    name: `${RANKS[d]} ${names[i]}`, team: 1, color: '#6fc3e8', ai: d, model: rand(MODELS).id,
    look: { paint: rand(paints).value, decal: rand(DECALS).id, trail: 'smoke' }, weapons: AI_WEAPONS[d],
  }));
  inMatch = true;
  game = new Game({ players: [me, ...foes], theme: rand(Object.keys(THEMES)), seed: seed(), hero: 0, onEnd: finishArcade });
  show('none');
}

function finishArcade(r: MatchResult) {
  const me = r.players[0];
  const won = r.winnerTeam === 0;
  const wave = arcade.wave;
  arcade.damage += me.damage;
  arcade.won = won;
  const cleared = won ? wave : wave - 1;
  const best = cleared > profile.stats.arcadeBest;
  noteMissions([]);
  if (account.session) {
    $('#result-coins').textContent = 'Counting your coins…';
    collect({ won, damage: me.damage, kills: r.players.filter((p) => p.team !== 0 && !p.alive).length, weaponKills: killsOf(r, 0) }, (res) => {
      arcade.coins += res.coins;
      if (res.over) arcade.won = false;
    });
  } else {
    const coins = Math.round(me.damage / 3) + (won ? 30 + wave * 20 : 0);
    arcade.coins += coins;
    profile.coins += coins;
    if (best) profile.stats.arcadeBest = cleared;
    if (!won) profile.stats.played++;
    saveProfile(profile);
    $('#result-coins').textContent = `+${coins} coins  ·  ${profile.coins} total`;
  }

  const maxHp = modelById(profile.equipped.tank).hp;
  if (won) {
    arcade.hp = Math.min(maxHp, me.hp + Math.round(maxHp * 0.35));
    arcade.wave++;
  }
  const record = Math.max(profile.stats.arcadeBest, cleared);
  $('#result-eyebrow').textContent = won ? `Wave ${wave} cleared` : 'Arcade over';
  $('#result-title').textContent = won ? `Wave ${arcade.wave} is next` : `You cleared ${cleared} ${cleared === 1 ? 'wave' : 'waves'}`;
  $<HTMLButtonElement>('#btn-rematch').disabled = false;
  $('#btn-rematch').textContent = won ? 'Next wave' : 'Play again';
  const rows: [string, string][] = won
    ? [['Armor after repairs', `${arcade.hp} / ${maxHp}`], ['Next wave', `${arcadeEnemies(arcade.wave).length} enemy ${arcadeEnemies(arcade.wave).length === 1 ? 'tank' : 'tanks'}`], ['Damage dealt this run', String(arcade.damage)]]
    : [['Waves cleared', String(cleared)], ['Best run', `${record} ${best ? '(new record)' : ''}`.trim()], ['Damage dealt', String(arcade.damage)]];
  resultTable(['Arcade', ''], rows);
  sfx.coin();
  inMatch = false;
  show('result');
}

/** Sends a finished match to the server and shows the coins it pays. */
async function collect(body: { won: boolean; damage: number; kills?: number; weaponKills?: Record<string, number> }, after?: (r: account.MatchReward) => void) {
  const id = await ticket;
  if (!id) {
    $('#result-coins').textContent = "This match couldn't be counted (the server wasn't reachable when it started).";
    return;
  }
  try {
    const r = await account.matchFinish({ id, ...body });
    useProfile(r.profile);
    after?.(r);
    $('#result-coins').textContent = r.note ?? `+${r.coins} coins  ·  ${profile.coins} total`;
    noteMissions(r.missions);
    if (r.missions.length) sfx.coin();
  } catch (e) {
    $('#result-coins').textContent = (e as Error).message;
  }
}

function resultTable(head: [string, string], rows: [string, string][]) {
  const table = $('#result-table');
  table.replaceChildren();
  const th = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of head) {
    const c = document.createElement('th');
    c.textContent = h;
    hr.append(c);
  }
  th.append(hr);
  const tb = document.createElement('tbody');
  for (const [a, b] of rows) {
    const tr = document.createElement('tr');
    for (const v of [a, b]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.append(td);
    }
    tb.append(tr);
  }
  table.append(th, tb);
}

function finishMatch(r: MatchResult, myTeam = 0, note = '') {
  const versus = setup.mode !== 'local';
  const me = r.players.find((p) => p.team === myTeam)!;
  const other = r.players.find((p) => p.team !== myTeam)!;
  const won = r.winnerTeam === myTeam;
  noteMissions([]);
  if (setup.mode === 'online') {
    // The server compares both players' reports and pays out; its answer arrives as a reward message.
    online.report(r.winnerTeam, [0, 1].map((t) => r.players.find((p) => p.team === t)?.damage ?? 0), [killsOf(r, 0), killsOf(r, 1)]);
    $('#result-coins').textContent = 'Waiting for the match result…';
  } else if (account.session) {
    $('#result-coins').textContent = 'Counting your coins…';
    collect(setup.mode === 'local' ? { won: false, damage: me.damage + other.damage } : { won, damage: me.damage, weaponKills: killsOf(r, myTeam) });
  } else {
    const coins =
      setup.mode === 'ai' ? Math.round(me.damage / 2) + (won ? 60 + { easy: 0, normal: 40, hard: 90 }[setup.diff] : 10) : 25 + Math.round((me.damage + other.damage) / 4);
    profile.coins += coins;
    profile.stats.played++;
    if (versus && won) profile.stats.wins++;
    saveProfile(profile);
    $('#result-coins').textContent = `+${coins} coins  ·  ${profile.coins} total`;
  }

  $('#result-eyebrow').textContent = note || (versus ? (won ? 'Mission complete' : 'Mission failed') : 'Match over');
  $('#result-title').textContent =
    r.winnerTeam === null ? 'Draw' : versus ? (won ? 'Victory' : 'Defeated') : `${r.winnerTeam === 0 ? me.name : other.name} wins`;
  $<HTMLButtonElement>('#btn-rematch').disabled = false;
  $('#btn-rematch').textContent = 'Rematch';
  resultTable(['Commander', 'Damage dealt'], [me, other].map((p) => [p.name + (p.team === r.winnerTeam ? '  ★' : ''), String(p.damage)]));
  sfx.coin();
  inMatch = false;
  show('result');
}

/** The server's verdict on an online match: coins, rating change and missions. */
function onlineReward(r: OnlineReward) {
  useProfile(r.profile as Profile);
  $('#result-coins').textContent = `+${r.coins} coins  ·  ${profile.coins} total`;
  const sign = r.change > 0 ? '+' : '';
  noteMissions(r.missions, r.ranked ? [`Rating ${r.rating} (${sign}${r.change})  ·  ${r.rank}`] : ['Friendly match: rating unchanged']);
  if (!$('#menu').hidden) renderMenu();
}

function pause(on: boolean) {
  if (!inMatch) return;
  // An online match keeps running for the other player while this menu is open.
  game.paused = on && setup.mode !== 'online';
  show(on ? 'pause' : 'none');
}

function quitToMenu() {
  online.leave();
  startDemo();
  show('menu');
}

// ------------------------------------------------------------------ shop

type Tab = 'tank' | 'weapon' | 'paint' | 'decal' | 'trail';
const TABS: { id: Tab; label: string }[] = [
  { id: 'tank', label: 'Tanks' },
  { id: 'weapon', label: 'Weapons' },
  { id: 'paint', label: 'Paint' },
  { id: 'decal', label: 'Decals' },
  { id: 'trail', label: 'Shell trails' },
];
let tab: Tab = 'tank';

interface ShopItem { id: string; name: string; desc: string; stats?: string; price: number; vip?: boolean; draw: (c: HTMLCanvasElement) => void }

function previewTank(c: HTMLCanvasElement, modelId: string, look: Look) {
  const g = c.getContext('2d')!;
  g.setTransform(c.width / 200, 0, 0, c.width / 200, 0, 0);
  const sky = g.createRadialGradient(100, 70, 5, 100, 70, 130);
  sky.addColorStop(0, '#4a2a22');
  sky.addColorStop(1, '#121214');
  g.fillStyle = sky;
  g.fillRect(0, 0, 200, 100);
  g.fillStyle = '#2b2522';
  g.fillRect(0, 82, 200, 18);
  g.fillStyle = '#4a3e36';
  g.fillRect(0, 82, 200, 2);
  g.save();
  g.translate(92, 84);
  const model = modelById(modelId);
  // One scale for every model, so the shop shows how big each tank really is.
  const s = 80 / Math.max(...MODELS.map((m) => tankFrame(m).tall));
  g.scale(s, s);
  drawTank(g, model, look, 0, 0, 0, 35, 1);
  g.restore();
}

function previewWeapon(c: HTMLCanvasElement, id: string) {
  const w = WEAPONS.find((x) => x.id === id)!;
  const g = c.getContext('2d')!;
  g.setTransform(c.width / 200, 0, 0, c.width / 200, 0, 0);
  g.fillStyle = '#7a5634';
  g.fillRect(0, 60, 200, 40);
  const r = w.radius * 0.45;
  if (w.kind === 'dirt') {
    g.fillStyle = '#9a6a3c';
    g.beginPath();
    g.arc(100, 60, r, Math.PI, 0);
    g.fill();
  } else {
    g.fillStyle = 'rgba(30,40,60,0.9)';
    g.beginPath();
    g.arc(100, 60, r, 0, Math.PI);
    g.fill();
  }
  const shots = w.kind === 'cluster' || w.kind === 'airstrike' ? 5 : w.shots ?? 1;
  for (let i = 0; i < shots; i++) {
    const x = 100 + (i - (shots - 1) / 2) * 16;
    g.fillStyle = w.color;
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.beginPath();
    g.arc(x, 28 - Math.abs(i - (shots - 1) / 2) * 3, w.size * 1.4, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
}

function itemsFor(t: Tab): ShopItem[] {
  const look = myLook();
  const cos = (list: Cosmetic[], f: (c: Cosmetic) => Partial<Look>) =>
    list.map((c) => ({ id: c.id, name: c.name, desc: c.vip ? 'Included with VIP membership.' : '', price: c.price, vip: c.vip, draw: (cv: HTMLCanvasElement) => previewTank(cv, profile.equipped.tank, { ...look, ...f(c) }) }));
  switch (t) {
    case 'tank':
      return MODELS.map((m) => ({
        id: m.id, name: m.name, desc: m.desc, price: m.price,
        stats: `HP ${m.hp} · Fuel ${m.fuel} · Range ${Math.round(m.powerMul * 100)}%${m.armor < 1 ? ` · Armor ${Math.round((1 - m.armor) * 100)}%` : ''}`,
        draw: (c) => previewTank(c, m.id, look),
      }));
    case 'weapon':
      return WEAPONS.map((w) => ({
        id: w.id, name: w.name, desc: w.desc, price: w.price,
        stats: `${w.damage ? `Damage ${w.damage}${w.shots ? ` ×${w.shots}` : w.kind === 'airstrike' ? ' ×5' : ''} · ` : ''}${w.radius ? `Blast ${w.radius} · ` : ''}${w.ammo < 0 ? 'Unlimited' : `${w.ammo} per match`}`,
        draw: (c) => previewWeapon(c, w.id),
      }));
    case 'paint':
      return cos(PAINTS, (c) => ({ paint: c.value }));
    case 'decal':
      return cos(DECALS, (c) => ({ decal: c.id }));
    case 'trail':
      return TRAILS.map((tr) => ({
        id: tr.id, name: tr.name, desc: 'Colours the smoke behind your shells.', price: tr.price,
        draw: (c) => previewTrail(c, tr.id),
      }));
  }
}

function previewTrail(c: HTMLCanvasElement, id: string) {
  const g = c.getContext('2d')!;
  g.setTransform(c.width / 200, 0, 0, c.width / 200, 0, 0);
  {
    for (let i = 30; i >= 0; i--) {
      const t = i / 30;
      const x = 170 - i * 5, y = 70 - Math.sin((1 - t) * Math.PI) * 40 * (1 - t) - (1 - t) * 10;
      g.fillStyle = trailColor(id, i, 0.3, 1 - t);
      g.beginPath();
      g.arc(x, y, Math.max(1, 5 * (1 - t) + (id === 'smoke' ? i * 0.15 : 0)), 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#2d2f33';
    g.beginPath();
    g.arc(170, 70, 5, 0, Math.PI * 2);
    g.fill();
  }
}

function equippedId(t: Tab): string | null {
  return t === 'weapon' ? null : profile.equipped[t as Exclude<Tab, 'weapon'>];
}

function renderShop() {
  $('#shop-coins').textContent = String(profile.coins);
  const tabs = $('#shop-tabs');
  tabs.replaceChildren(
    ...TABS.map((t) => {
      const b = document.createElement('button');
      b.className = 'tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t.id === tab));
      b.textContent = t.label;
      b.onclick = () => {
        tab = t.id;
        sfx.click();
        renderShop();
      };
      return b;
    }),
  );
  const grid = $('#shop-grid');
  grid.replaceChildren(
    ...itemsFor(tab).map((it) => {
      const owned = owns(profile, tab, it.id);
      const equipped = equippedId(tab) === it.id;
      const card = document.createElement('article');
      card.className = 'card' + (equipped ? ' equipped' : '');
      const cv = document.createElement('canvas');
      cv.width = 400;
      cv.height = 200;
      const body = document.createElement('div');
      body.className = 'body';
      const h = document.createElement('h3');
      h.textContent = it.name;
      body.append(h);
      if (it.desc) {
        const p = document.createElement('p');
        p.textContent = it.desc;
        body.append(p);
      }
      if (it.stats) {
        const s = document.createElement('span');
        s.className = 'stats';
        s.textContent = it.stats;
        body.append(s);
      }
      const btn = document.createElement('button');
      btn.className = 'btn';
      if (it.vip && !owned) {
        btn.textContent = 'Join VIP';
        btn.classList.add('vip-btn');
        btn.hidden = !account.session;
        btn.onclick = () => openBuy();
      } else if (!owned) {
        btn.textContent = it.price === 0 ? 'Free' : `Buy · ${it.price}`;
        btn.classList.add('primary');
        btn.disabled = profile.coins < it.price;
        if (btn.disabled) btn.title = `You need ${it.price - profile.coins} more coins`;
        btn.onclick = () => buy(it);
      } else if (tab === 'weapon') {
        btn.textContent = 'Owned';
        btn.disabled = true;
      } else if (equipped) {
        btn.textContent = 'Equipped';
        btn.disabled = true;
      } else {
        btn.textContent = 'Equip';
        btn.onclick = () => equip(it.id);
      }
      body.append(btn);
      card.append(cv, body);
      it.draw(cv);
      return card;
    }),
  );
}

async function buy(it: ShopItem) {
  if (profile.coins < it.price) return;
  const kind = tab;
  if (account.session) {
    try {
      useProfile(await account.buyItem(`${kind}:${it.id}`));
    } catch (e) {
      return shopError((e as Error).message);
    }
  } else {
    profile.coins -= it.price;
    profile.owned.push(`${kind}:${it.id}`);
    if (kind !== 'weapon') profile.equipped[kind] = it.id;
    saveProfile(profile);
  }
  sfx.coin();
  renderShop();
}

async function equip(id: string) {
  if (tab === 'weapon') return;
  const slot = tab;
  profile.equipped[slot] = id;
  sfx.click();
  renderShop();
  if (account.session) {
    try {
      useProfile(await account.equipItem(slot, id));
    } catch (e) {
      shopError((e as Error).message);
    }
    renderShop();
  } else saveProfile(profile);
}

function shopError(msg: string) {
  $('#shop-coins').textContent = String(profile.coins);
  alert(msg);
}

// Shop previews drawn before the tank art loaded used the old look; redraw them once it's in.
whenTankArtReady(() => {
  if (!$('#shop').hidden) renderShop();
});

function openShop() {
  renderShop();
  show('shop');
  account.getPayConfig().then((c) => {
    $('#btn-buy').hidden = !c;
    $('#btn-vip').hidden = !c?.vip;
    $('#btn-vip').textContent = profile.vip ? 'VIP ✓' : 'Get VIP';
  });
}

// ------------------------------------------------------------------ buying coins (Whop)

let watchTimer: ReturnType<typeof setInterval> | undefined;

/** After a checkout opens, check the account for the new coins or VIP for a few minutes. */
function watchForPurchase() {
  clearInterval(watchTimer);
  const seen = `${profile.paidTotal ?? 0}/${profile.vipUntil ?? 0}`;
  let tries = 0;
  watchTimer = setInterval(async () => {
    if (++tries > 60) return clearInterval(watchTimer);
    const p = await account.fetchProfile().catch(() => null);
    if (p && `${p.paidTotal ?? 0}/${p.vipUntil ?? 0}` !== seen) {
      clearInterval(watchTimer);
      const added = p.coins - profile.coins;
      const vipNow = p.vip && !profile.vip;
      useProfile(p);
      sfx.coin();
      $('#buy-status').textContent = vipNow
        ? "You're VIP now. Thank you! Your VIP paint and decal are in the Garage."
        : added > 0 ? `${added.toLocaleString('en-US')} coins added. Thank you!` : 'Your purchase was updated.';
      renderVipOffer();
      renderShop();
    }
  }, 5000);
}

async function checkout(btn: HTMLButtonElement, pack: string) {
  btn.disabled = true;
  $('#buy-status').classList.remove('error');
  $('#buy-status').textContent = 'Opening the secure payment page…';
  try {
    await account.buyPack(pack);
    $('#buy-status').textContent =
      pack === 'vip' ? 'Finish joining in the page that opened. VIP switches on here automatically.' : 'Finish paying in the page that opened. Your coins will appear here automatically.';
    watchForPurchase();
  } catch (e) {
    $('#buy-status').textContent = (e as Error).message;
    $('#buy-status').classList.add('error');
  } finally {
    btn.disabled = false;
  }
}

let vipPrice = '';
function renderVipOffer() {
  $('#buy-vip').hidden = !vipPrice || !account.session;
  $('#vip-price').textContent = profile.vip && profile.vipUntil ? `You're VIP until ${new Date(profile.vipUntil).toLocaleDateString()}` : `${vipPrice} a month`;
  $('#btn-join-vip').hidden = !!profile.vip;
}
$('#btn-join-vip').onclick = () => checkout($<HTMLButtonElement>('#btn-join-vip'), 'vip');

async function openBuy() {
  const c = await account.getPayConfig();
  if (!c) return;
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: c.currency });
  vipPrice = c.vip ? fmt.format(c.vip.price) : '';
  renderVipOffer();
  $('#buy-packs').replaceChildren(
    ...c.packs.map((pk) => {
      const b = document.createElement('button');
      b.className = 'pack';
      const amount = document.createElement('span');
      amount.className = 'amount';
      amount.textContent = `${pk.coins.toLocaleString('en-US')} coins`;
      const name = document.createElement('span');
      name.textContent = pk.name;
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = pk.note ?? '';
      const price = document.createElement('span');
      price.className = 'price';
      price.textContent = fmt.format(pk.price);
      b.append(amount, name, note, price);
      b.onclick = () => checkout(b, pk.id);
      return b;
    }),
  );
  $('#buy-status').textContent = c.sandbox ? 'Test mode: no real money is charged.' : '';
  show('buy');
}

$('#btn-buy').onclick = openBuy;
$('#btn-vip').onclick = openBuy;
$('#buy-close').onclick = () => {
  renderShop();
  show('shop');
};

// ------------------------------------------------------------------ input

const KEYMAP: Record<string, 'left' | 'right' | 'up' | 'down' | 'fire'> = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', Space: 'fire',
};

window.addEventListener('keydown', (e) => {
  if (!inMatch) return;
  if (e.code === 'Escape' || e.code === 'KeyP') {
    pause($('#pause').hidden);
    return;
  }
  if (game.paused) return;
  const k = KEYMAP[e.code];
  if (k) {
    e.preventDefault();
    if (!e.repeat) game.key(k, true);
  } else if (e.code === 'KeyQ') game.cycleWeapon(-1);
  else if (e.code === 'KeyE' || e.code === 'Tab') {
    e.preventDefault();
    game.cycleWeapon(1);
  } else if (/^Digit[1-9]$/.test(e.code)) game.selectWeapon(Number(e.code.slice(5)) - 1);
});
window.addEventListener('keyup', (e) => {
  const k = KEYMAP[e.code];
  if (k && inMatch) game.key(k, false);
});
window.addEventListener('blur', () => inMatch && setup.mode !== 'online' && !game.paused && pause(true));

document.querySelectorAll<HTMLButtonElement>('#touch [data-k]').forEach((b) => {
  const k = b.dataset.k as keyof typeof game.keys;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    game.key(k, true);
  });
  const up = () => game.key(k, false);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
});
$('#t-weapon').onclick = () => game.cycleWeapon(1);
$('#t-pause').onclick = () => pause(true);

$('#btn-ai').onclick = () => openSetup('ai');
$('#btn-local').onclick = () => openSetup('local');
$('#btn-shop').onclick = openShop;
$('#btn-start').onclick = startMatch;
$('#btn-resume').onclick = () => pause(false);
$('#btn-quit').onclick = quitToMenu;
$('#btn-arcade').onclick = () => startArcade(true);
$('#btn-rematch').onclick = () => {
  if (setup.mode === 'arcade') return startArcade(!arcade.won);
  if (setup.mode !== 'online') return startMatch();
  online.rematch();
  $<HTMLButtonElement>('#btn-rematch').disabled = true;
  $('#btn-rematch').textContent = 'Waiting for opponent';
};
$('#btn-online').onclick = () => {
  setup.mode = 'online';
  online.open();
  show('online');
};
$('#btn-result-shop').onclick = () => {
  startDemo();
  openShop();
};
$('#btn-result-menu').onclick = quitToMenu;

const online: Online = new Online({
  token: () => account.session?.token ?? null,
  rankLine: () => (profile.rating !== undefined ? `Your rank: ${rankFor(profile.rating)} (${profile.rating}). Quick matches pair you with players near your rating and move it up or down.` : ''),
  reward: onlineReward,
  signedOut: () => {
    account.logout();
    renderAccount('Please sign in again.');
    show('account');
  },
  info: () => ({
    model: profile.equipped.tank,
    look: myLook(),
    weapons: WEAPONS.filter((w) => owns(profile, 'weapon', w.id)).map((w) => w.id),
  }),
  start: (s) => {
    setup.mode = 'online';
    const colors = ['#ff8a3d', '#6fc3e8'];
    inMatch = true;
    game = new Game({
      players: s.players.map((p) => ({ ...p, color: colors[p.team] })),
      theme: s.theme,
      seed: s.seed,
      first: s.first,
      net: { me: s.you, send: (m) => online.relay(m) },
      onEnd: (r) => finishMatch(r, s.you),
    });
    show('none');
  },
  message: (m) => inMatch && game.onNet(m),
  opponentLeft: () => {
    if (inMatch) {
      game.onEnd = (r) => finishMatch(r, game.myTeam, 'Your opponent left');
      game.forfeit(1 - game.myTeam);
    } else {
      $<HTMLButtonElement>('#btn-rematch').disabled = true;
      $('#btn-rematch').textContent = 'Opponent left';
    }
  },
  rematchOffered: () => ($('#result-eyebrow').textContent = 'Your opponent wants a rematch'),
  lost: () => {
    if (!inMatch) return;
    game.onEnd = (r) => finishMatch(r, game.myTeam, 'Connection lost');
    game.forfeit(game.myTeam);
  },
});

startDemo();
show('menu');
requestAnimationFrame(frame);
// Fonts load asynchronously; redraw shop previews and labels once they arrive.
document.fonts?.ready.then(() => renderMenu());

// Exposed for automated play-testing.
(window as unknown as { __tanks: unknown }).__tanks = { get game() { return game; }, startMatch, startArcade, arcade, setup };
