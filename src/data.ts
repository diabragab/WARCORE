import CATALOG from '../shared/catalog.json';

export type WeaponKind = 'shell' | 'cluster' | 'dirt' | 'bouncer' | 'airstrike' | 'homing' | 'teleport';

export interface Weapon {
  id: string;
  name: string;
  desc: string;
  price: number;
  /** Rounds per match; -1 means unlimited. */
  ammo: number;
  radius: number;
  damage: number;
  kind: WeaponKind;
  shots?: number;
  spread?: number;
  bounces?: number;
  color: string;
  size: number;
}

export const WEAPONS: Weapon[] = [
  { id: 'shell', name: 'Shell', desc: 'Standard round. Never runs out.', price: 0, ammo: -1, radius: 30, damage: 34, kind: 'shell', color: '#2d2f33', size: 4 },
  { id: 'heavy', name: 'Heavy Shell', desc: 'Wider crater and a harder hit.', price: 150, ammo: 3, radius: 44, damage: 48, kind: 'shell', color: '#4a3b2a', size: 6 },
  { id: 'dirt', name: 'Dirt Ball', desc: 'Builds a mound. Hide behind it or bury a rival.', price: 120, ammo: 3, radius: 55, damage: 0, kind: 'dirt', color: '#8a5a2b', size: 6 },
  { id: 'bouncer', name: 'Bouncer', desc: 'Skips off the ground twice, then blows.', price: 200, ammo: 2, radius: 30, damage: 36, kind: 'bouncer', bounces: 2, color: '#3d6b8c', size: 5 },
  { id: 'triple', name: 'Triple Shot', desc: 'Three shells fired in a fan.', price: 250, ammo: 2, radius: 24, damage: 22, kind: 'shell', shots: 3, spread: 5, color: '#5b5f2a', size: 4 },
  { id: 'cluster', name: 'Cluster Bomb', desc: 'Splits into five bomblets on impact.', price: 350, ammo: 2, radius: 24, damage: 24, kind: 'cluster', color: '#8c2f2f', size: 6 },
  { id: 'teleport', name: 'Teleporter', desc: 'Your tank jumps to wherever it lands.', price: 300, ammo: 2, radius: 0, damage: 0, kind: 'teleport', color: '#3fd0c9', size: 5 },
  { id: 'airstrike', name: 'Airstrike', desc: 'Marks a spot, then five bombs drop from the sky.', price: 450, ammo: 1, radius: 26, damage: 24, kind: 'airstrike', color: '#d1452f', size: 5 },
  { id: 'homing', name: 'Homing Missile', desc: 'Locks on to the nearest enemy after it peaks.', price: 500, ammo: 2, radius: 30, damage: 32, kind: 'homing', color: '#9aa4ad', size: 5 },
  { id: 'nuke', name: 'Mega Nuke', desc: 'Flattens the neighbourhood. One per match.', price: 800, ammo: 1, radius: 95, damage: 75, kind: 'shell', color: '#c9a227', size: 8 },
];

/** The bombs an Airstrike calls in. Kills by them count for the Airstrike. */
export const AIRBOMB: Weapon = { id: 'airstrike', name: 'Air Bomb', desc: '', price: 0, ammo: -1, radius: 26, damage: 24, kind: 'shell', color: '#3b3f45', size: 5 };

export const BOMBLET: Weapon = { id: 'bomblet', name: 'Bomblet', desc: '', price: 0, ammo: -1, radius: 20, damage: 17, kind: 'shell', color: '#8c2f2f', size: 3 };

export interface TankGeo { bodyW: number; bodyH: number; treadH: number; turretR: number; barrelL: number; barrelW: number; topInset: number }

export interface TankModel {
  id: string;
  name: string;
  desc: string;
  price: number;
  hp: number;
  /** Pixels the tank can drive per turn. */
  fuel: number;
  powerMul: number;
  /** Multiplier on damage taken. */
  armor: number;
  geo: TankGeo;
}

/** Tank art is drawn at 1.3x the original sizes; hitboxes follow the art. */
const geo = (g: TankGeo): TankGeo => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v * 1.3])) as unknown as TankGeo;

export const MODELS: TankModel[] = [
  { id: 'patton', name: 'Patton', desc: 'All-rounder. Does everything fine.', price: 0, hp: 100, fuel: 110, powerMul: 1, armor: 1, geo: geo({ bodyW: 34, bodyH: 10, treadH: 8, turretR: 9, barrelL: 22, barrelW: 4, topInset: 6 }) },
  { id: 'jackal', name: 'Jackal', desc: 'Light scout. Drives far, breaks easily.', price: 300, hp: 80, fuel: 200, powerMul: 1, armor: 1, geo: geo({ bodyW: 30, bodyH: 8, treadH: 7, turretR: 7, barrelL: 19, barrelW: 3, topInset: 9 }) },
  { id: 'longbow', name: 'Longbow', desc: 'Artillery barrel with extra range.', price: 450, hp: 90, fuel: 90, powerMul: 1.15, armor: 1, geo: geo({ bodyW: 34, bodyH: 9, treadH: 8, turretR: 8, barrelL: 32, barrelW: 3, topInset: 6 }) },
  { id: 'howitzer', name: 'Howitzer', desc: 'Long-range gun. Hits from across the map.', price: 900, hp: 85, fuel: 70, powerMul: 1.3, armor: 1, geo: geo({ bodyW: 38, bodyH: 9, treadH: 8, turretR: 8, barrelL: 38, barrelW: 4, topInset: 8 }) },
  { id: 'titan', name: 'Titan', desc: 'Super-heavy. Shrugs off hits, barely moves.', price: 1200, hp: 180, fuel: 45, powerMul: 0.95, armor: 0.8, geo: geo({ bodyW: 46, bodyH: 14, treadH: 10, turretR: 12, barrelL: 25, barrelW: 6, topInset: 5 }) },
  { id: 'bastion', name: 'Bastion', desc: 'Heavy armour, slow tracks.', price: 600, hp: 140, fuel: 60, powerMul: 0.95, armor: 0.85, geo: geo({ bodyW: 42, bodyH: 12, treadH: 9, turretR: 11, barrelL: 23, barrelW: 5, topInset: 5 }) },
];

export interface Cosmetic { id: string; name: string; price: number; value: string; vip?: boolean }

export const PAINTS: Cosmetic[] = [
  { id: 'olive', name: 'Olive Drab', price: 0, value: '#6b7a3a' },
  { id: 'sand', name: 'Desert Sand', price: 0, value: '#c2a46b' },
  { id: 'crimson', name: 'Crimson', price: 150, value: '#a83232' },
  { id: 'navy', name: 'Navy', price: 150, value: '#2f4d7a' },
  { id: 'arctic', name: 'Arctic', price: 120, value: '#d9dee3' },
  { id: 'violet', name: 'Violet', price: 300, value: '#7a4bb0' },
  { id: 'gold', name: 'Parade Gold', price: 700, value: '#d4a62a' },
  { id: 'obsidian', name: 'VIP Obsidian', price: 0, value: '#23212b', vip: true },
];

export const DECALS: Cosmetic[] = [
  { id: 'none', name: 'Plain', price: 0, value: '' },
  { id: 'star', name: 'Star', price: 80, value: '' },
  { id: 'stripes', name: 'Racing Stripes', price: 120, value: '' },
  { id: 'chevron', name: 'Chevron', price: 100, value: '' },
  { id: 'flames', name: 'Flames', price: 220, value: '' },
  { id: 'skull', name: 'Skull', price: 260, value: '' },
  { id: 'crown', name: 'VIP Crown', price: 0, value: '', vip: true },
];

export const TRAILS: Cosmetic[] = [
  { id: 'smoke', name: 'Smoke', price: 0, value: '' },
  { id: 'fire', name: 'Fire', price: 100, value: '' },
  { id: 'plasma', name: 'Plasma', price: 180, value: '' },
  { id: 'sparkle', name: 'Sparkle', price: 220, value: '' },
  { id: 'rainbow', name: 'Rainbow', price: 400, value: '' },
];

export interface Look { paint: string; decal: string; trail: string }

export const weaponById = (id: string) => WEAPONS.find((w) => w.id === id)!;
export const modelById = (id: string) => MODELS.find((m) => m.id === id) ?? MODELS[0];
export const paintById = (id: string) => PAINTS.find((p) => p.id === id) ?? PAINTS[0];

// Prices come from the shared catalog, which the server uses to charge for purchases.
const PRICES = CATALOG.prices as Record<string, Record<string, number>>;
for (const [kind, list] of [['weapon', WEAPONS], ['tank', MODELS], ['paint', PAINTS], ['decal', DECALS], ['trail', TRAILS]] as const)
  for (const it of list as { id: string; price: number }[]) it.price = PRICES[kind][it.id] ?? it.price;

export const RANKS = CATALOG.ranks;
export const rankFor = (rating: number) => [...RANKS].reverse().find((r) => rating >= r.min)!.name;
export const VIP_INFO = CATALOG.vip;
