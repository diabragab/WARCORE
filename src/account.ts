import type { Profile } from './profile';
import { inPreview, NAME_KEY, serverHttp, store } from './online';

const KEY = 'tanks.account';

export interface Session { name: string; token: string }

/** The signed-in player, if any. Guests keep their progress in this browser only. */
export let session: Session | null = (() => {
  try {
    const s = JSON.parse(store(KEY) || 'null');
    return s && typeof s.token === 'string' ? (s as Session) : null;
  } catch {
    return null;
  }
})();

export const accountsAvailable = () => !inPreview();

function setSession(s: Session | null) {
  session = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  if (s) store(NAME_KEY, s.name);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${serverHttp()}${path.startsWith('/') ? path : `/api/account/${path}`}`, {
      method,
      headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach the WARCORE server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && session && path !== 'login') setSession(null);
  if (!res.ok) throw new Error(data.error || `The server answered with an error (${res.status}).`);
  return data as T;
}

type AuthReply = { name: string; token: string; profile: Profile };

/** Creates an account. Every account starts with the same fresh profile. */
export async function register(name: string, password: string): Promise<Profile> {
  const r = await call<AuthReply>('POST', 'register', { name, password });
  setSession({ name: r.name, token: r.token });
  return r.profile;
}

/** Signs in and returns the account's saved progress. */
export async function login(name: string, password: string): Promise<Profile> {
  const r = await call<AuthReply>('POST', 'login', { name, password });
  setSession({ name: r.name, token: r.token });
  return r.profile;
}

export async function logout() {
  if (session) call('POST', 'logout').catch(() => {});
  setSession(null);
}

/** Latest saved progress for the signed-in player, or null if signed out. */
export async function fetchProfile(): Promise<Profile | null> {
  if (!session) return null;
  return (await call<{ profile: Profile }>('GET', 'profile')).profile;
}

// Everything that changes coins is decided by the server; these ask it and return the updated profile.

export const buyItem = async (item: string) => (await call<{ profile: Profile }>('POST', 'buy', { item })).profile;
export const equipItem = async (slot: string, id: string) => (await call<{ profile: Profile }>('POST', 'equip', { slot, id })).profile;
export const claimDaily = () => call<{ coins: number; streak: number; profile: Profile }>('POST', 'daily', {});

export interface MissionDone { text: string; coins: number }
export interface MatchReward { coins: number; missions: MissionDone[]; note?: string; over?: boolean; wave?: number; profile: Profile }

/** Tells the server a match started; the id it returns is needed to collect the reward. */
export const matchStart = async (mode: 'ai' | 'local' | 'arcade', diff?: string) => (await call<{ id: string }>('POST', 'match/start', { mode, diff })).id;
export const matchFinish = (body: { id: string; won: boolean; damage: number; kills?: number; weaponKills?: Record<string, number> }) =>
  call<MatchReward>('POST', 'match/finish', body);

export interface Leader { name: string; value: number; rank: string; vip: boolean }
export const leaderboard = () => call<{ rating: Leader[]; wins: Leader[]; arcade: Leader[] }>('GET', '/api/leaderboard');

export interface Purchase { time: string; type: 'payment' | 'refund'; player: string; item: string; coins: number; amount: number; currency: string; payment: string; reason: string | null }
export const purchases = async () => (await call<{ purchases: Purchase[] }>('GET', '/api/admin/purchases')).purchases;

export interface CoinPack { id: string; name: string; coins: number; price: number; note?: string }
export interface PayConfig {
  enabled: boolean;
  sandbox: boolean;
  currency: string;
  packs: CoinPack[];
  vip?: { id: string; name: string; price: number; days: number };
  pass?: { id: string; name: string; price: number; currency: string };
}

let payConfig: Promise<PayConfig | null> | null = null;
/** Coin packs on sale, or null if payments aren't set up on the server. */
export function getPayConfig(): Promise<PayConfig | null> {
  payConfig ??= fetch(`${serverHttp()}/api/pay/config`)
    .then((r) => (r.ok ? r.json() : null))
    .then((c: PayConfig | null) => (c?.enabled ? c : null))
    .catch(() => null);
  return payConfig;
}

/** Opens the Whop checkout for a coin pack ('vip' for the monthly membership, 'pass' for the Game Pass) in the player's browser. */
export async function buyPack(pack: string) {
  const tauri = '__TAURI_INTERNALS__' in window;
  // Open the tab during the click so popup blockers allow it. (window.open with 'noopener' always returns null,
  // which used to look like a blocked popup and opened the checkout a second time in this tab.)
  const tab = tauri ? null : window.open('', '_blank');
  let url: string;
  try {
    ({ url } = await call<{ url: string }>('POST', '/api/pay/checkout', { pack }));
  } catch (e) {
    tab?.close();
    throw e;
  }
  if (tauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else if (tab) {
    tab.opener = null;
    tab.location.href = url;
  } else {
    location.href = url;
  }
}
