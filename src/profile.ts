import { pushProfile } from './account';

const KEY = 'tanks.profile.v1';

export interface Profile {
  coins: number;
  /** Owned items as "kind:id", e.g. "tank:patton", "weapon:heavy". */
  owned: string[];
  equipped: { tank: string; paint: string; decal: string; trail: string };
  stats: { played: number; wins: number; arcadeBest: number };
  /** Bought coins already counted in this copy (the server adds any newer purchases when it saves). */
  paidSeen?: number;
}

const fresh = (): Profile => ({
  coins: 300,
  owned: ['tank:patton', 'weapon:shell', 'paint:olive', 'paint:sand', 'decal:none', 'trail:smoke'],
  equipped: { tank: 'patton', paint: 'olive', decal: 'none', trail: 'smoke' },
  stats: { played: 0, wins: 0, arcadeBest: 0 },
});

/** Fills in anything missing from a saved profile (older saves, or an account's stored copy). */
export function normalize(p: Partial<Profile>): Profile {
  const base = fresh();
  const owned = [...new Set([...base.owned, ...(p.owned ?? [])])];
  return { ...base, ...p, owned, equipped: { ...base.equipped, ...p.equipped }, stats: { ...base.stats, ...p.stats } };
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw) as Profile);
  } catch {
    /* storage unavailable: play with a fresh profile */
  }
  return fresh();
}

export function saveProfile(p: Profile, sync = true) {
  if (sync) pushProfile(p);
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export const owns = (p: Profile, kind: string, id: string) => p.owned.includes(`${kind}:${id}`);
