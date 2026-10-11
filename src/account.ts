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

/** Creates an account that starts with this browser's current progress. */
export async function register(name: string, password: string, profile: Profile): Promise<Profile> {
  const r = await call<AuthReply>('POST', 'register', { name, password, profile });
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

/** Called with the server's copy after each save, which can include newly bought coins. */
export let onServerProfile: ((p: Profile) => void) | null = null;
export const setOnServerProfile = (fn: (p: Profile) => void) => (onServerProfile = fn);

let pending: Profile | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Saves progress to the account shortly after each change (purchases, match rewards). */
export function pushProfile(p: Profile) {
  if (!session) return;
  pending = structuredClone(p);
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const body = pending;
    pending = null;
    try {
      const r = await call<{ profile: Profile }>('PUT', 'profile', { profile: body });
      onServerProfile?.(r.profile);
    } catch {
      // Keep it for the next change if the server couldn't be reached.
      if (!pending && session) pending = body;
    }
  }, 400);
}

export interface CoinPack { id: string; name: string; coins: number; price: number; note?: string }
export interface PayConfig { enabled: boolean; sandbox: boolean; currency: string; packs: CoinPack[] }

let payConfig: Promise<PayConfig | null> | null = null;
/** Coin packs on sale, or null if payments aren't set up on the server. */
export function getPayConfig(): Promise<PayConfig | null> {
  payConfig ??= fetch(`${serverHttp()}/api/pay/config`)
    .then((r) => (r.ok ? r.json() : null))
    .then((c: PayConfig | null) => (c?.enabled ? c : null))
    .catch(() => null);
  return payConfig;
}

/** Opens the Whop checkout for a coin pack in the player's browser. */
export async function buyPack(pack: string) {
  const { url } = await call<{ url: string }>('POST', '/api/pay/checkout', { pack });
  if ('__TAURI_INTERNALS__' in window) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else if (!window.open(url, '_blank', 'noopener')) {
    location.href = url;
  }
}
