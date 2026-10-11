export type WeaponKind = 'shell' | 'cluster' | 'dirt' | 'bouncer';

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
  { id: 'nuke', name: 'Mega Nuke', desc: 'Flattens the neighbourhood. One per match.', price: 800, ammo: 1, radius: 95, damage: 75, kind: 'shell', color: '#c9a227', size: 8 },
];

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

export const MODELS: TankModel[] = [
  { id: 'patton', name: 'Patton', desc: 'All-rounder. Does everything fine.', price: 0, hp: 100, fuel: 110, powerMul: 1, armor: 1, geo: { bodyW: 34, bodyH: 10, treadH: 8, turretR: 9, barrelL: 22, barrelW: 4, topInset: 6 } },
  { id: 'jackal', name: 'Jackal', desc: 'Light scout. Drives far, breaks easily.', price: 300, hp: 80, fuel: 200, powerMul: 1, armor: 1, geo: { bodyW: 30, bodyH: 8, treadH: 7, turretR: 7, barrelL: 19, barrelW: 3, topInset: 9 } },
  { id: 'longbow', name: 'Longbow', desc: 'Artillery barrel with extra range.', price: 450, hp: 90, fuel: 90, powerMul: 1.15, armor: 1, geo: { bodyW: 34, bodyH: 9, treadH: 8, turretR: 8, barrelL: 32, barrelW: 3, topInset: 6 } },
  { id: 'bastion', name: 'Bastion', desc: 'Heavy armour, slow tracks.', price: 600, hp: 140, fuel: 60, powerMul: 0.95, armor: 0.85, geo: { bodyW: 42, bodyH: 12, treadH: 9, turretR: 11, barrelL: 23, barrelW: 5, topInset: 5 } },
];

export interface Cosmetic { id: string; name: string; price: number; value: string }

export const PAINTS: Cosmetic[] = [
  { id: 'olive', name: 'Olive Drab', price: 0, value: '#6b7a3a' },
  { id: 'sand', name: 'Desert Sand', price: 0, value: '#c2a46b' },
  { id: 'crimson', name: 'Crimson', price: 150, value: '#a83232' },
  { id: 'navy', name: 'Navy', price: 150, value: '#2f4d7a' },
  { id: 'arctic', name: 'Arctic', price: 120, value: '#d9dee3' },
  { id: 'violet', name: 'Violet', price: 300, value: '#7a4bb0' },
  { id: 'gold', name: 'Parade Gold', price: 700, value: '#d4a62a' },
];

export const DECALS: Cosmetic[] = [
  { id: 'none', name: 'Plain', price: 0, value: '' },
  { id: 'star', name: 'Star', price: 80, value: '' },
  { id: 'stripes', name: 'Racing Stripes', price: 120, value: '' },
  { id: 'chevron', name: 'Chevron', price: 100, value: '' },
  { id: 'flames', name: 'Flames', price: 220, value: '' },
  { id: 'skull', name: 'Skull', price: 260, value: '' },
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
