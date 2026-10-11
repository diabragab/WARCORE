const KEY = 'tanks.profile.v1';

export interface Profile {
  coins: number;
  /** Owned items as "kind:id", e.g. "tank:patton", "weapon:heavy". */
  owned: string[];
  equipped: { tank: string; paint: string; decal: string; trail: string };
  stats: { played: number; wins: number };
}

const fresh = (): Profile => ({
  coins: 300,
  owned: ['tank:patton', 'weapon:shell', 'paint:olive', 'paint:sand', 'decal:none', 'trail:smoke'],
  equipped: { tank: 'patton', paint: 'olive', decal: 'none', trail: 'smoke' },
  stats: { played: 0, wins: 0 },
});

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Profile;
      const base = fresh();
      return { ...base, ...p, equipped: { ...base.equipped, ...p.equipped }, stats: { ...base.stats, ...p.stats } };
    }
  } catch {
    /* storage unavailable: play with a fresh profile */
  }
  return fresh();
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export const owns = (p: Profile, kind: string, id: string) => p.owned.includes(`${kind}:${id}`);
