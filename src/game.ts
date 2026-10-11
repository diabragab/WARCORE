import { Terrain, THEMES, W, H, WATER, type Theme } from './terrain';
import { AIRBOMB, BOMBLET, modelById, weaponById, type Look, type TankModel, type Weapon } from './data';
import { D2R, drawTank, pivotHeight, roundRect, shade, trailColor } from './draw';
import { mulberry32 } from './rng';
import { sfx } from './sfx';

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface PlayerSetup {
  name: string;
  team: number;
  color: string;
  ai?: Difficulty;
  model: string;
  look: Look;
  weapons: string[];
  /** Starting health, if not the tank's full health (arcade carries damage between waves). */
  hp?: number;
}

export interface MatchResult {
  winnerTeam: number | null;
  players: { name: string; team: number; damage: number; ai?: Difficulty; alive: boolean; hp: number; kills: number; weaponKills: Record<string, number> }[];
}

export interface GameOptions {
  players: PlayerSetup[];
  theme: string;
  seed: number;
  demo?: boolean;
  /** Index of the player who shoots first. */
  first?: number;
  /** Online play: which team is on this device, and how to reach the other one. */
  net?: { me: number; send: (m: NetMsg) => void };
  onEnd?: (r: MatchResult) => void;
  /** Arcade: this player gets every other turn, with the enemies taking turns in between. */
  hero?: number;
}

interface TankState { x: number; y: number; hp: number; alive: boolean; drowned: boolean; damage: number; ammo: number[]; kills?: number; weaponKills?: Record<string, number> }

/**
 * Online turns: the shooter's device is in charge of its own turn. It streams its aim,
 * sends the exact shot, and once everything settles sends the resulting state (sync)
 * so both screens agree before the next turn starts.
 */
export type NetMsg =
  | { k: 'pos'; x: number; y: number; tilt: number; elev: number; facing: 1 | -1; wi: number; power: number; charging: boolean; fuel: number; timer: number }
  | { k: 'fire'; x: number; y: number; tilt: number; elev: number; facing: 1 | -1; wi: number; power: number }
  | { k: 'sync'; tanks: TankState[]; hash: number; terrain: number[] };

const G = 300;
const MAX_SPEED = 780;
const WIND_MAX = 70;
const TURN_TIME = 30;
const CHARGE_RATE = 62;

interface Tank {
  name: string;
  remote: boolean;
  team: number;
  color: string;
  ai?: Difficulty;
  model: TankModel;
  look: Look;
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  tilt: number;
  hp: number;
  maxHp: number;
  hpShown: number;
  alive: boolean;
  drowned: boolean;
  elev: number;
  facing: 1 | -1;
  power: number;
  lastPower: number;
  charging: boolean;
  fuel: number;
  moveAcc: number;
  arsenal: { w: Weapon; ammo: number }[];
  wi: number;
  damage: number;
  recoil: number;
  trackPhase: number;
  kills: number;
  weaponKills: Record<string, number>;
  /** Who hit this tank last and with what, so a kill can be credited (drownings and falls included). */
  lastHit: { by: Tank; weapon: string } | null;
}

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  px: number;
  py: number;
  age: number;
  owner: Tank | null;
}

interface Proj extends Body {
  w: Weapon;
  bounces: number;
  trail: { x: number; y: number }[];
  look: Look;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  kind: 'spark' | 'smoke' | 'debris' | 'text' | 'ring' | 'flash' | 'drop' | 'fire' | 'chunk' | 'flake';
  grav: number;
  rot?: number;
  spin?: number;
  text?: string;
}

type Phase = 'aim' | 'flying' | 'settle' | 'over';

interface AiState {
  stage: 'think' | 'aim' | 'charge';
  t: number;
  elev: number;
  facing: 1 | -1;
  power: number;
  wi: number;
  move: number;
}

export class Game {
  terrain: Terrain;
  theme: Theme;
  tanks: Tank[] = [];
  projectiles: Proj[] = [];
  particles: Particle[] = [];
  phase: Phase = 'aim';
  turn = -1;
  wind = 0;
  timer = TURN_TIME;
  settleT = 0;
  overT = 0;
  time = 0;
  shake = 0;
  banner = 0;
  paused = false;
  private flashT = 0;
  private cloudSprite = cloudSprite();
  private vignette: HTMLCanvasElement | null = null;
  keys = { left: false, right: false, up: false, down: false, fire: false };
  private rnd: () => number;
  private bg: HTMLCanvasElement;
  private clouds: { x: number; y: number; s: number }[] = [];
  private ai: AiState | null = null;
  private ended = false;
  private lastTick = 0;
  private turnNo = 0;
  private foeTurn = -1;
  private netT = 0;
  private syncs: Extract<NetMsg, { k: 'sync' }>[] = [];

  constructor(private opts: GameOptions) {
    this.rnd = mulberry32(opts.seed);
    this.theme = THEMES[opts.theme] ?? THEMES.grass;
    this.terrain = new Terrain(opts.seed, this.theme);
    this.bg = this.paintBackground();
    for (let i = 0; i < 6; i++) this.clouds.push({ x: this.rnd() * W, y: 60 + this.rnd() * 200, s: 0.6 + this.rnd() * 0.9 });
    this.spawnTanks();
    this.turn = (opts.first ?? 0) - 1;
    this.nextTurn();
  }

  get current(): Tank {
    return this.tanks[this.turn];
  }

  get humanTurn(): boolean {
    return this.phase === 'aim' && !this.current.ai && !this.current.remote && !this.opts.demo;
  }

  private snd(fn: () => void) {
    if (!this.opts.demo) fn();
  }

  // ---------------------------------------------------------------- setup

  private spawnTanks() {
    const n = this.opts.players.length;
    this.opts.players.forEach((p, i) => {
      const model = modelById(p.model);
      let x = n === 1 ? W / 2 : 170 + (i * (W - 340)) / (n - 1) + (this.rnd() - 0.5) * 120;
      // Nudge spawn away from water and caves.
      for (let tries = 0; tries < 40 && this.terrain.surfaceY(x) > WATER - 30; tries++) x += i < n / 2 ? 15 : -15;
      const y = this.terrain.surfaceY(x) - 1;
      const arsenal = p.weapons.map((id) => weaponById(id)).filter(Boolean).map((w) => ({ w, ammo: w.ammo }));
      this.tanks.push({
        name: p.name, team: p.team, color: p.color, ai: p.ai, model, look: p.look,
        remote: !!this.opts.net && p.team !== this.opts.net.me,
        x, y, vx: 0, vy: 0, grounded: false, tilt: 0,
        hp: Math.min(model.hp, p.hp ?? model.hp), maxHp: model.hp, hpShown: Math.min(model.hp, p.hp ?? model.hp), alive: true, drowned: false,
        elev: 45, facing: x < W / 2 ? 1 : -1, power: 0, lastPower: -1, charging: false,
        fuel: model.fuel, moveAcc: 0, arsenal, wi: 0, damage: 0, recoil: 0, trackPhase: 0, kills: 0, weaponKills: {}, lastHit: null,
      });
    });
  }

  private paintBackground(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    const t = this.theme;
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, t.skyTop);
    sky.addColorStop(1, t.skyBottom);
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    if (t.stars)
      for (let i = 0; i < 220; i++) {
        g.globalAlpha = 0.3 + this.rnd() * 0.7;
        g.fillStyle = '#ffffff';
        g.fillRect(this.rnd() * W, this.rnd() * H * 0.55, 1 + this.rnd() * 1.5, 1 + this.rnd() * 1.5);
      }
    g.globalAlpha = 1;
    const sx = 300 + this.rnd() * 1000, sy = 170 + this.rnd() * 80;
    const glow = g.createRadialGradient(sx, sy, 10, sx, sy, 220);
    glow.addColorStop(0, t.sun);
    glow.addColorStop(0.18, t.sun + 'aa');
    glow.addColorStop(1, t.sun + '00');
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);
    g.fillStyle = t.sun;
    g.beginPath();
    g.arc(sx, sy, 38, 0, Math.PI * 2);
    g.fill();
    const ridge = (color: string, base: number, amp: number, f: number) => {
      const ph = this.rnd() * 10;
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(0, H);
      for (let x = 0; x <= W; x += 8)
        g.lineTo(x, base + Math.sin(x * f + ph) * amp + Math.sin(x * f * 3.1 + ph) * amp * 0.3);
      g.lineTo(W, H);
      g.fill();
    };
    if (t.warzone || t.skyline) this.paintRuins(g);
    else {
      g.globalAlpha = 0.55;
      ridge(t.far, H * 0.42, 50, 0.004);
      g.globalAlpha = 0.7;
      ridge(t.near, H * 0.52, 40, 0.007);
      g.globalAlpha = 1;
    }
    return c;
  }

  /** Skyline of ruined buildings with fires glowing behind them. */
  private paintRuins(g: CanvasRenderingContext2D) {
    const t = this.theme;
    const layer = (color: string, base: number, minH: number, maxH: number, alpha: number) => {
      g.globalAlpha = alpha;
      g.fillStyle = color;
      for (let x = -20; x < W; ) {
        const w = 40 + this.rnd() * 90;
        const h = minH + this.rnd() * (maxH - minH);
        const top = base - h;
        g.beginPath();
        g.moveTo(x, H);
        g.lineTo(x, top + this.rnd() * 20);
        // broken roofline
        const steps = 2 + Math.floor(this.rnd() * 4);
        for (let i = 1; i <= steps; i++) g.lineTo(x + (w * i) / steps, top + this.rnd() * 30);
        g.lineTo(x + w, H);
        g.fill();
        if (this.rnd() < 0.25) g.fillRect(x + w * 0.5, top - 60, 3, 60); // antenna
        if (t.warzone && this.rnd() < 0.35) {
          const fire = g.createRadialGradient(x + w / 2, base, 4, x + w / 2, base, 120);
          fire.addColorStop(0, 'rgba(255,120,40,0.35)');
          fire.addColorStop(1, 'rgba(255,60,20,0)');
          const prev: string | CanvasGradient | CanvasPattern = g.fillStyle;
          g.fillStyle = fire;
          g.fillRect(x - 100, base - 140, w + 200, 200);
          g.fillStyle = prev;
        }
        x += w + this.rnd() * 30;
      }
    };
    layer(t.far, H * 0.5, 80, 240, 0.8);
    layer(t.near, H * 0.62, 60, 200, 0.9);
    g.globalAlpha = 1;
    if (!t.warzone) return;
    const haze = g.createLinearGradient(0, H * 0.35, 0, H * 0.75);
    haze.addColorStop(0, 'rgba(120,30,15,0)');
    haze.addColorStop(1, 'rgba(120,30,15,0.35)');
    g.fillStyle = haze;
    g.fillRect(0, 0, W, H);
  }

  // ---------------------------------------------------------------- input

  key(k: keyof Game['keys'], down: boolean) {
    if (!this.humanTurn) {
      this.keys[k] = down;
      return;
    }
    const t = this.current;
    if (k === 'fire') {
      if (down && !this.keys.fire && !t.charging) {
        t.charging = true;
        t.power = 0;
      } else if (!down && t.charging) {
        this.fire(t);
      }
    }
    this.keys[k] = down;
  }

  cycleWeapon(dir: number) {
    if (!this.humanTurn) return;
    const t = this.current;
    if (t.charging) return;
    const n = t.arsenal.length;
    for (let i = 1; i <= n; i++) {
      const j = (t.wi + dir * i + n * n) % n;
      if (t.arsenal[j].ammo !== 0) {
        t.wi = j;
        this.snd(() => sfx.click());
        return;
      }
    }
  }

  selectWeapon(idx: number) {
    if (!this.humanTurn) return;
    const t = this.current;
    if (!t.charging && t.arsenal[idx] && t.arsenal[idx].ammo !== 0) {
      t.wi = idx;
      this.snd(() => sfx.click());
    }
  }

  // ---------------------------------------------------------------- turn flow

  private nextTurn() {
    const n = this.tanks.length;
    const h = this.opts.hero;
    if (h !== undefined && this.tanks[h].alive && (this.turnNo === 0 || this.turn !== h)) {
      this.turn = h;
    } else {
      const from = h !== undefined ? (this.foeTurn < 0 ? h : this.foeTurn) : this.turn;
      for (let i = 1; i <= n; i++) {
        const j = (from + i) % n;
        if (this.tanks[j].alive && j !== h) {
          this.turn = j;
          if (h !== undefined) this.foeTurn = j;
          break;
        }
      }
    }
    const t = this.current;
    // Wind comes from the seed and turn number so both online players get the same value.
    this.turnNo++;
    const wr = mulberry32(this.opts.seed + this.turnNo * 7919);
    this.wind = Math.round((wr() * 2 - 1) * 10) * (WIND_MAX / 10);
    t.fuel = t.model.fuel;
    t.power = 0;
    t.charging = false;
    if (t.arsenal[t.wi].ammo === 0) t.wi = 0;
    this.timer = TURN_TIME;
    this.phase = 'aim';
    this.banner = 1.6;
    this.ai = t.ai ? { stage: 'think', t: 0, elev: 45, facing: 1, power: 50, wi: 0, move: 0 } : null;
    this.keys.fire = false;
  }

  private fire(t: Tank) {
    if (this.opts.net && !t.remote)
      this.opts.net.send({ k: 'fire', x: t.x, y: t.y, tilt: t.tilt, elev: t.elev, facing: t.facing, wi: t.wi, power: t.power });
    t.charging = false;
    const slot = t.arsenal[t.wi];
    if (slot.ammo === 0) return;
    if (slot.ammo > 0) slot.ammo--;
    const w = slot.w;
    t.lastPower = t.power;
    const pv = this.pivot(t);
    const shots = w.shots ?? 1;
    for (let s = 0; s < shots; s++) {
      const off = shots > 1 ? (s - (shots - 1) / 2) * (w.spread ?? 0) : 0;
      const a = (t.facing > 0 ? t.elev + off : 180 - t.elev - off) * D2R;
      const speed = (Math.max(4, t.power) / 100) * MAX_SPEED * t.model.powerMul;
      const bx = pv.x + Math.cos(a) * t.model.geo.barrelL;
      const by = pv.y - Math.sin(a) * t.model.geo.barrelL;
      this.projectiles.push({
        x: bx, y: by, px: bx, py: by, vx: Math.cos(a) * speed, vy: -Math.sin(a) * speed,
        age: 0, owner: t, w, bounces: w.bounces ?? 0, trail: [], look: t.look,
      });
      if (s === 0) {
        for (let i = 0; i < 5; i++)
          this.particles.push({
            x: bx, y: by, vx: Math.cos(a) * (80 + i * 40), vy: -Math.sin(a) * (80 + i * 40), life: 0.15, max: 0.15,
            size: 9 - i, color: '', kind: 'fire', grav: 0,
          });
        for (let i = 0; i < 10; i++)
          this.particles.push({
            x: bx, y: by, vx: Math.cos(a) * 60 + (this.rnd() - 0.5) * 60, vy: -Math.sin(a) * 60 + (this.rnd() - 0.5) * 60,
            life: 0.6, max: 0.6, size: 5 + this.rnd() * 6, color: '#d8d2c4', kind: 'smoke', grav: -20,
          });
      }
    }
    t.recoil = 5;
    this.phase = 'flying';
    this.snd(() => sfx.fire());
  }

  private pivot(t: Tank) {
    const h = pivotHeight(t.model);
    return { x: t.x + Math.sin(t.tilt) * h, y: t.y - Math.cos(t.tilt) * h };
  }

  // ---------------------------------------------------------------- update

  update(dt: number) {
    if (this.paused) return;
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 30);
    this.flashT = Math.max(0, this.flashT - dt * 4);
    this.ambient(dt);
    this.banner = Math.max(0, this.banner - dt);
    for (const c of this.clouds) {
      c.x += (this.wind * 0.35 + 4) * dt * c.s;
      if (c.x > W + 200) c.x = -200;
      if (c.x < -200) c.x = W + 200;
    }

    if (this.theme.warzone && Math.random() < dt * 14)
      this.particles.push({
        x: Math.random() * W, y: H * 0.55 + Math.random() * H * 0.3, vx: (Math.random() - 0.5) * 20, vy: -30 - Math.random() * 40,
        life: 3, max: 3, size: 1.5 + Math.random() * 1.5, color: Math.random() < 0.5 ? '#ff8a3a' : '#ffcf6a', kind: 'spark', grav: -4,
      });

    switch (this.phase) {
      case 'aim': {
        const t = this.current;
        this.timer -= dt;
        if (!t.ai && !this.opts.demo && this.timer < 5 && Math.ceil(this.timer) !== this.lastTick) {
          this.lastTick = Math.ceil(this.timer);
          this.snd(() => sfx.tick());
        }
        if (t.remote) {
          this.timer = Math.max(0, this.timer);
          break;
        }
        if (this.opts.net && (this.netT += dt) > 1 / 15) {
          this.netT = 0;
          this.opts.net.send({ k: 'pos', x: t.x, y: t.y, tilt: t.tilt, elev: t.elev, facing: t.facing, wi: t.wi, power: t.power, charging: t.charging, fuel: t.fuel, timer: this.timer });
        }
        if (this.timer <= 0) {
          if (t.charging) this.fire(t);
          else {
            this.phase = 'settle';
            this.settleT = 0;
          }
          break;
        }
        if (t.ai) this.updateAi(t, dt);
        else this.updateHuman(t, dt);
        break;
      }
      case 'flying':
        if (this.projectiles.length === 0) {
          this.phase = 'settle';
          this.settleT = 0;
        }
        break;
      case 'settle':
        this.settleT += dt;
        if (this.settleT > 0.8 && this.tanks.every((t) => !t.alive || t.grounded)) this.resolve();
        break;
      case 'over':
        this.overT += dt;
        if (this.overT > 1.6 && !this.ended) {
          this.ended = true;
          this.opts.onEnd?.(this.result());
        }
        break;
    }

    this.updateProjectiles(dt);
    for (const t of this.tanks) this.updateTank(t, dt);
    this.updateParticles(dt);
  }

  private updateHuman(t: Tank, dt: number) {
    if (this.keys.up) t.elev = Math.min(90, t.elev + 40 * dt);
    if (this.keys.down) t.elev = Math.max(-15, t.elev - 40 * dt);
    if (!t.charging) {
      if (this.keys.left) this.drive(t, -1, dt);
      else if (this.keys.right) this.drive(t, 1, dt);
    } else {
      t.power = Math.min(100, t.power + CHARGE_RATE * dt);
      if (t.power >= 100) this.fire(t);
    }
  }

  private drive(t: Tank, dir: 1 | -1, dt: number) {
    if (t.facing !== dir) {
      t.facing = dir;
      return;
    }
    if (!t.grounded || t.fuel <= 0) return;
    t.moveAcc += 46 * dt;
    while (t.moveAcc >= 1 && t.fuel > 0) {
      t.moveAcc -= 1;
      const nx = t.x + dir;
      if (nx < 10 || nx > W - 10) break;
      let up = 0;
      while (this.terrain.solid(nx, t.y - up) && up <= 5) up++;
      if (up > 5) break;
      let ny = t.y - up;
      if (this.terrain.solid(nx, ny - 14)) break;
      let down = 0;
      while (!this.terrain.solid(nx, ny + 1) && down < 4) {
        ny++;
        down++;
      }
      t.x = nx;
      t.y = ny;
      t.fuel -= 1;
      t.trackPhase += 1;
    }
  }

  private updateTank(t: Tank, dt: number) {
    t.recoil = Math.max(0, t.recoil - dt * 20);
    t.hpShown += (Math.max(0, t.hp) - t.hpShown) * Math.min(1, dt * 5);
    if (!t.alive) return;
    const hw = t.model.geo.bodyW * 0.3;
    const tr = this.terrain;
    let k = 0;
    while (tr.solid(t.x, t.y) && k < 80) {
      t.y--;
      k++;
    }
    const supported = () => tr.solid(t.x, t.y + 1) || tr.solid(t.x - hw, t.y + 1) || tr.solid(t.x + hw, t.y + 1);
    if (t.grounded && !supported()) {
      t.grounded = false;
      t.vy = 0;
    }
    if (!t.grounded) {
      t.vy += G * dt;
      t.vx *= 1 - 0.4 * dt;
      const steps = Math.min(80, Math.ceil(Math.max(Math.abs(t.vx), Math.abs(t.vy)) * dt) + 1);
      for (let s = 0; s < steps; s++) {
        const nx = t.x + (t.vx * dt) / steps;
        if (tr.solid(nx, t.y - 5) || nx < 8 || nx > W - 8) t.vx = -t.vx * 0.2;
        else t.x = nx;
        const ny = t.y + (t.vy * dt) / steps;
        if (t.vy > 0 && supported()) {
          if (t.vy > 380) this.hurt(t, Math.round((t.vy - 380) / 9), null);
          if (t.vy > 120) this.snd(() => sfx.thud());
          t.grounded = true;
          t.vx = 0;
          t.vy = 0;
          break;
        } else if (t.vy < 0 && tr.solid(t.x, ny - 16)) t.vy = 0;
        else t.y = ny;
      }
      if (t.y > WATER + 6 && !t.drowned) {
        t.drowned = true;
        t.hp = 0;
        this.splash(t.x, 1.6);
      }
    }
    if (t.grounded) {
      const gl = this.groundY(t.x - hw * 1.4, t.y);
      const gr = this.groundY(t.x + hw * 1.4, t.y);
      const target = Math.max(-0.5, Math.min(0.5, Math.atan2(gr - gl, hw * 2.8)));
      t.tilt += (target - t.tilt) * Math.min(1, dt * 10);
    }
  }

  private groundY(x: number, from: number) {
    for (let y = from - 14; y < from + 24; y++) if (this.terrain.solid(x, y)) return y;
    return from + 24;
  }

  private resolve() {
    if (this.opts.net) {
      if (this.current.remote) {
        // Wait for the shooter's device to say how the turn ended.
        const sync = this.syncs.shift();
        if (!sync) return;
        this.applySync(sync);
      } else {
        this.opts.net.send({
          k: 'sync',
          tanks: this.tanks.map((t) => ({ x: t.x, y: t.y, hp: t.hp, alive: t.alive, drowned: t.drowned, damage: t.damage, ammo: t.arsenal.map((a) => a.ammo), kills: t.kills, weaponKills: t.weaponKills })),
          hash: this.terrain.hash(),
          terrain: this.terrain.encode(),
        });
      }
    }
    let died = false;
    for (const t of this.tanks) {
      if (t.alive && t.hp <= 0) {
        t.alive = false;
        died = true;
        const h = t.lastHit;
        if (h && h.by.team !== t.team) {
          h.by.kills++;
          h.by.weaponKills[h.weapon] = (h.by.weaponKills[h.weapon] ?? 0) + 1;
        }
        if (!t.drowned) this.explode(t.x, t.y - 8, { radius: 38, damage: 20 }, null);
      }
    }
    if (died) {
      this.settleT = 0;
      return;
    }
    const teams = new Set(this.tanks.filter((t) => t.alive).map((t) => t.team));
    if (teams.size <= 1) {
      this.phase = 'over';
      this.overT = 0;
      return;
    }
    this.nextTurn();
  }

  private applySync(m: Extract<NetMsg, { k: 'sync' }>) {
    m.tanks.forEach((s, i) => {
      const t = this.tanks[i];
      if (!t) return;
      Object.assign(t, { x: s.x, y: s.y, hp: s.hp, alive: s.alive, drowned: s.drowned, damage: s.damage, vx: 0, vy: 0, grounded: true });
      if (s.kills !== undefined) Object.assign(t, { kills: s.kills, weaponKills: { ...s.weaponKills } });
      s.ammo.forEach((a, j) => t.arsenal[j] && (t.arsenal[j].ammo = a));
    });
    if (this.terrain.hash() !== m.hash) this.terrain.decode(m.terrain, this.opts.seed);
  }

  /** Message from the other online player. */
  onNet(m: NetMsg) {
    const t = this.current;
    if (m.k === 'sync') {
      this.syncs.push(m);
      return;
    }
    if (!t.remote || this.phase !== 'aim') return;
    Object.assign(t, { x: m.x, y: m.y, tilt: m.tilt, elev: m.elev, facing: m.facing, wi: m.wi, power: m.power });
    if (m.k === 'pos') {
      t.charging = m.charging;
      t.fuel = m.fuel;
      this.timer = m.timer;
    } else {
      this.fire(t);
    }
  }

  get myTeam(): number {
    return this.opts.net?.me ?? 0;
  }

  set onEnd(fn: (r: MatchResult) => void) {
    this.opts.onEnd = fn;
  }

  /** The other online player left: the remaining side wins. */
  forfeit(team: number) {
    for (const t of this.tanks) if (t.team === team) t.alive = false;
    this.projectiles = [];
    this.phase = 'over';
    this.overT = 1;
  }

  result(): MatchResult {
    const alive = this.tanks.filter((t) => t.alive);
    return {
      winnerTeam: alive.length ? alive[0].team : null,
      players: this.tanks.map((t) => ({
        name: t.name, team: t.team, damage: t.damage, ai: t.ai, alive: t.alive, hp: t.alive ? Math.max(1, Math.round(t.hp)) : 0, kills: t.kills, weaponKills: { ...t.weaponKills },
      })),
    };
  }

  get winnerName(): string | null {
    const a = this.tanks.find((t) => t.alive);
    return a ? a.name : null;
  }

  // ---------------------------------------------------------------- projectiles

  private tankAt(x: number, y: number, owner: Tank | null, age: number): Tank | null {
    for (const t of this.tanks) {
      if (!t.alive || (t === owner && age < 0.3)) continue;
      const g = t.model.geo;
      if (Math.abs(x - t.x) < g.bodyW / 2 + 2 && y < t.y + 2 && y > t.y - g.treadH - g.bodyH - g.turretR) return t;
    }
    return null;
  }

  /** Moves a body one frame; shared by real shells and the AI's trajectory search. */
  private advance(p: Body, dt: number): 'terrain' | 'tank' | 'water' | 'out' | null {
    p.vx += this.wind * dt;
    p.vy += G * dt;
    p.age += dt;
    const n = Math.max(1, Math.ceil((Math.hypot(p.vx, p.vy) * dt) / 2));
    const sx = (p.vx * dt) / n, sy = (p.vy * dt) / n;
    for (let i = 0; i < n; i++) {
      p.px = p.x;
      p.py = p.y;
      p.x += sx;
      p.y += sy;
      if (p.y > WATER + 3) return 'water';
      if (p.x < -400 || p.x > W + 400) return 'out';
      if (this.terrain.solid(p.x, p.y)) return 'terrain';
      if (this.tankAt(p.x, p.y, p.owner, p.age)) return 'tank';
    }
    return null;
  }

  private updateProjectiles(dt: number) {
    const keep: Proj[] = [];
    const list = this.projectiles;
    this.projectiles = []; // impacts may add bomblets here
    for (const p of list) {
      p.trail.unshift({ x: p.x, y: p.y });
      if (p.trail.length > 26) p.trail.pop();
      if (p.w.kind === 'homing') this.steer(p, dt);
      const hit = p.age > 9 ? 'terrain' : this.advance(p, dt);
      if (!hit) {
        keep.push(p);
        continue;
      }
      if (hit === 'water') {
        this.splash(p.x, 1);
        continue;
      }
      if (hit === 'out') continue;
      if (p.w.kind === 'bouncer' && p.bounces > 0 && hit === 'terrain') {
        p.bounces--;
        p.x = p.px;
        p.y = p.py;
        const n = this.normalAt(p.x, p.y);
        const d = p.vx * n.x + p.vy * n.y;
        p.vx = (p.vx - 2 * d * n.x) * 0.62;
        p.vy = (p.vy - 2 * d * n.y) * 0.62;
        this.snd(() => sfx.bounce());
        keep.push(p);
        continue;
      }
      if (hit === 'tank' && p.w.kind === 'homing') {
        // A homing missile that reaches a tank strikes it square, wherever it touched the hull.
        const t = this.tankAt(p.x, p.y, p.owner, p.age)!;
        p.x = t.x;
        p.y = t.y - (t.model.geo.treadH + t.model.geo.bodyH) / 2;
      }
      this.impact(p);
    }
    this.projectiles = keep.concat(this.projectiles);
  }

  /** Homing missile: shortly after launch it turns toward the nearest enemy. */
  private steer(p: Proj, dt: number) {
    if (p.age < 0.5) return;
    let best: Tank | null = null, bd = Infinity;
    for (const t of this.tanks) {
      if (!t.alive || t.team === p.owner?.team) continue;
      const d = Math.hypot(t.x - p.x, t.y - p.y);
      if (d < bd) (bd = d), (best = t);
    }
    if (!best) return;
    const g = best.model.geo;
    // Fly in high over the hills, then dive once it's nearly above the target.
    const dx = best.x - p.x;
    const lift = Math.max(0, Math.min(220, (Math.abs(dx) - 50) * 0.45));
    const want = Math.atan2(best.y - (g.treadH + g.bodyH) / 2 - lift - p.y, dx);
    const cur = Math.atan2(p.vy, p.vx);
    let diff = want - cur;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const rate = bd < 260 ? 6 : 3.6;
    const turn = Math.max(-rate * dt, Math.min(rate * dt, diff));
    const speed = Math.max(300, Math.min(560, Math.hypot(p.vx, p.vy)));
    // Cancel this frame's wind and most of the gravity, so the missile flies where it points.
    p.vx = Math.cos(cur + turn) * speed - this.wind * dt;
    p.vy = Math.sin(cur + turn) * speed - 300 * dt * 0.85;
    if (Math.random() < 0.6)
      this.particles.push({ x: p.x, y: p.y, vx: -p.vx * 0.1, vy: -p.vy * 0.1, life: 0.3, max: 0.3, size: 4, color: '', kind: 'fire', grav: 0 });
  }

  private normalAt(x: number, y: number) {
    let nx = 0, ny = 0;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      if (!this.terrain.solid(x + Math.cos(a) * 6, y + Math.sin(a) * 6)) {
        nx += Math.cos(a);
        ny += Math.sin(a);
      }
    }
    const l = Math.hypot(nx, ny);
    return l ? { x: nx / l, y: ny / l } : { x: 0, y: -1 };
  }

  private impact(p: Proj) {
    const w = p.w;
    if (w.kind === 'teleport') return this.teleport(p);
    if (w.kind === 'airstrike') return this.callAirstrike(p);
    if (w.kind === 'dirt') {
      this.terrain.add(p.x, p.y, w.radius);
      this.shake = 4;
      this.snd(() => sfx.thud());
      for (let i = 0; i < 16; i++) this.debris(p.x, p.y, 120);
      return;
    }
    this.explode(p.x, p.y, w, p.owner, w.id === 'bomblet' ? 'cluster' : w.id);
    if (w.kind === 'cluster') {
      const br = mulberry32(this.opts.seed ^ Math.imul(Math.round(p.x), 73856093) ^ Math.imul(Math.round(p.y), 19349663));
      for (let i = 0; i < 5; i++) {
        const vx = (i - 2) * 65 + (br() - 0.5) * 30;
        this.projectiles.push({
          x: p.px, y: p.py - 4, px: p.px, py: p.py - 4, vx, vy: -230 - br() * 80,
          age: 0, owner: p.owner, w: BOMBLET, bounces: 0, trail: [], look: p.look,
        });
      }
    }
  }

  /** Teleporter: the tank that fired it reappears where it landed. */
  private teleport(p: Proj) {
    const t = p.owner;
    if (!t || !t.alive) return;
    const flash = (x: number, y: number) => {
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2;
        this.particles.push({ x, y: y - 12, vx: Math.cos(a) * 120, vy: Math.sin(a) * 120, life: 0.5, max: 0.5, size: 2, color: '#7ff5ee', kind: 'spark', grav: 0 });
      }
      this.particles.push({ x, y: y - 12, vx: 0, vy: 0, life: 0.45, max: 0.45, size: 46, color: '#7ff5ee', kind: 'ring', grav: 0 });
    };
    flash(t.x, t.y);
    t.x = Math.max(12, Math.min(W - 12, p.px));
    t.y = Math.min(p.py, WATER - 4);
    t.vx = 0;
    t.vy = 0;
    t.grounded = false;
    flash(t.x, t.y);
    this.snd(() => sfx.bounce());
  }

  /** Airstrike: the flare marks the spot and five bombs fall on it one after another. */
  private callAirstrike(p: Proj) {
    for (let i = 0; i < 14; i++)
      this.particles.push({ x: p.px, y: p.py, vx: (this.rnd() - 0.5) * 30, vy: -40 - this.rnd() * 60, life: 1.4, max: 1.4, size: 6 + this.rnd() * 6, color: '#ff4a3a', kind: 'smoke', grav: -10 });
    for (let i = 0; i < 5; i++) {
      const x = p.px + (i - 2) * 34, y = -40 - i * 70;
      this.projectiles.push({ x, y, px: x, py: y, vx: -this.wind * 1.2, vy: 260, age: 0, owner: p.owner, w: AIRBOMB, bounces: 0, trail: [], look: p.look });
    }
    this.snd(() => sfx.click());
  }

  private hurt(t: Tank, dmg: number, by: Tank | null) {
    if (dmg <= 0 || !t.alive) return;
    t.hp -= dmg;
    if (by && by.team !== t.team) by.damage += dmg;
    this.particles.push({
      x: t.x, y: t.y - 40, vx: 0, vy: -38, life: 1.4, max: 1.4, size: 22, color: '#ffd166', kind: 'text', grav: 0, text: `-${dmg}`,
    });
  }

  private explode(x: number, y: number, w: { radius: number; damage: number }, owner: Tank | null, weapon = '') {
    const r = w.radius;
    this.terrain.carve(x, y, r);
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const g = t.model.geo;
      const cx = t.x, cy = t.y - (g.treadH + g.bodyH) / 2;
      const d = Math.hypot(cx - x, cy - y);
      const reach = r + g.bodyW * 0.3;
      if (d >= reach) continue;
      const f = Math.max(0, Math.min(1, 1 - Math.max(0, d - 8) / reach));
      const dmg = Math.round(w.damage * f * t.model.armor);
      if (owner && dmg > 0) t.lastHit = { by: owner, weapon };
      this.hurt(t, dmg, owner);
      if (w.damage > 0) {
        const a = Math.atan2(cy - y, cx - x);
        const imp = f * w.damage * 5.5;
        t.vx += Math.cos(a) * imp;
        t.vy += Math.sin(a) * imp - imp * 0.55;
        t.grounded = false;
        t.y -= 1;
      }
    }
    const R = () => this.rnd();
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.3, max: 0.3, size: r * 2.2, color: '#fff3c4', kind: 'flash', grav: 0 });
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.5, max: 0.5, size: r * 1.8, color: '#ffe2b0', kind: 'ring', grav: 0 });
    // Fireball: overlapping hot puffs that rise and cool into smoke.
    for (let i = 0; i < 8 + r / 5; i++) {
      const a = R() * Math.PI * 2, sp = R() * r * 2.2;
      this.particles.push({
        x: x + Math.cos(a) * r * 0.2, y: y + Math.sin(a) * r * 0.2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
        life: 0.45 + R() * 0.4, max: 0.85, size: r * (0.35 + R() * 0.35), color: '', kind: 'fire', grav: -60,
      });
    }
    const n = 14 + r * 0.7;
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2, sp = 90 + R() * r * 8;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80, life: 0.5 + R() * 0.7, max: 1.2, size: 1.5 + R() * 2,
        color: R() < 0.5 ? '#ffd166' : '#ff8a3a', kind: 'spark', grav: 320,
      });
    }
    // Rotating chunks of ground
    const [dr, dg, db] = this.theme.dirt;
    for (let i = 0; i < 6 + r / 4; i++) {
      const a = -Math.PI * (0.1 + R() * 0.8), sp = 120 + R() * r * 6;
      const k = 0.6 + R() * 0.6;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1 + R() * 0.8, max: 1.8, size: 3 + R() * 5,
        color: `rgb(${dr * k},${dg * k},${db * k})`, kind: 'chunk', grav: 600, rot: R() * 6, spin: (R() - 0.5) * 14,
      });
    }
    for (let i = 0; i < n * 0.4; i++) this.debris(x, y, 140 + r * 3);
    // Lingering smoke column
    for (let i = 0; i < 8 + r / 6; i++) {
      this.particles.push({
        x: x + (R() - 0.5) * r, y: y + (R() - 0.5) * r * 0.5, vx: (R() - 0.5) * 30, vy: -25 - R() * 45,
        life: 2 + R() * 2.2, max: 4.2, size: r * (0.4 + R() * 0.4), color: this.theme.warzone ? '#2a2422' : '#4b4540', kind: 'smoke', grav: -8,
      });
    }
    this.flashT = Math.min(1, 0.3 + r / 90);
    this.shake = Math.min(20, 3 + r / 5);
    this.snd(() => sfx.boom(r));
  }

  private debris(x: number, y: number, speed: number) {
    const [r, g, b] = this.theme.dirt;
    const a = -Math.PI * this.rnd(), s = speed * (0.4 + this.rnd());
    this.particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.8 + this.rnd() * 0.6, max: 1.4, size: 2 + this.rnd() * 3,
      color: `rgb(${r},${g},${b})`, kind: 'debris', grav: 520,
    });
  }

  private splash(x: number, scale: number) {
    for (let i = 0; i < 18 * scale; i++) {
      this.particles.push({
        x: x + (this.rnd() - 0.5) * 10, y: WATER, vx: (this.rnd() - 0.5) * 140, vy: -120 - this.rnd() * 220 * scale,
        life: 0.9, max: 0.9, size: 2 + this.rnd() * 2.5, color: '#cfe8f5', kind: 'drop', grav: 520,
      });
    }
    this.snd(() => sfx.splash());
  }

  private updateParticles(dt: number) {
    for (const p of this.particles) {
      p.life -= dt;
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'smoke') p.vx += this.wind * 0.3 * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    if (this.particles.length > 900) this.particles.splice(0, this.particles.length - 900);
  }

  // ---------------------------------------------------------------- AI

  /** Where a shot would land: same physics as real shells, run ahead of time. */
  private simulate(t: Tank, elev: number, facing: number, power: number) {
    const pv = this.pivot(t);
    const a = (facing > 0 ? elev : 180 - elev) * D2R;
    const speed = (Math.max(4, power) / 100) * MAX_SPEED * t.model.powerMul;
    const x = pv.x + Math.cos(a) * t.model.geo.barrelL, y = pv.y - Math.sin(a) * t.model.geo.barrelL;
    const b: Body = { x, y, px: x, py: y, vx: Math.cos(a) * speed, vy: -Math.sin(a) * speed, age: 0, owner: t };
    for (let i = 0; i < 600; i++) {
      const hit = this.advance(b, 1 / 60);
      if (hit) return { x: b.x, y: b.y, hit };
    }
    return { x: b.x, y: b.y, hit: 'out' as const };
  }

  private planAi(t: Tank): AiState {
    const enemies = this.tanks.filter((e) => e.alive && e.team !== t.team);
    const target = enemies.sort((a, b) => Math.abs(a.x - t.x) - Math.abs(b.x - t.x))[0];
    const tx = target.x, ty = target.y - 8;
    const toward: 1 | -1 = tx >= t.x ? 1 : -1;
    const score = (e: number, f: number, p: number) => {
      const r = this.simulate(t, e, f, p);
      let s = r.hit === 'out' || r.hit === 'water' ? 1e4 + Math.abs(r.x - tx) : Math.hypot(r.x - tx, r.y - ty);
      if (Math.hypot(r.x - t.x, r.y - t.y) < 70) s += 600;
      return s;
    };
    let best = { s: Infinity, e: 45, f: toward as 1 | -1, p: 60 };
    for (const f of [toward, -toward as 1 | -1]) {
      for (let e = 8; e <= 86; e += 6)
        for (let p = 20; p <= 100; p += 4) {
          const s = score(e, f, p);
          if (s < best.s) best = { s, e, f, p };
        }
      if (best.s < 40) break;
    }
    for (let e = best.e - 4; e <= best.e + 4; e += 1)
      for (let p = best.p - 4; p <= Math.min(100, best.p + 4); p += 0.5) {
        const s = score(e, best.f, p);
        if (s < best.s) best = { s, e, f: best.f, p };
      }

    const noise = { easy: [7, 9], normal: [2.5, 4], hard: [0.6, 1.2] }[t.ai!];
    const elev = best.e + (this.rnd() * 2 - 1) * noise[0];
    const power = Math.max(10, Math.min(100, best.p + (this.rnd() * 2 - 1) * noise[1]));

    // Pick a weapon: stronger ones when the shot looks good.
    let wi = 0;
    const usable = t.arsenal
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.ammo !== 0 && s.w.kind !== 'dirt' && s.w.kind !== 'bouncer' && s.w.kind !== 'teleport')
      .filter(({ s }) => Math.hypot(tx - t.x, ty - t.y) > s.w.radius + 50);
    if (usable.length) {
      if (t.ai === 'easy') wi = usable[Math.floor(this.rnd() * usable.length)].i;
      else if (best.s < 40 && (t.ai === 'hard' || this.rnd() < 0.6))
        wi = usable.reduce((a, b) => (b.s.w.damage * (b.s.w.shots ?? 1) > a.s.w.damage * (a.s.w.shots ?? 1) ? b : a)).i;
    }
    return { stage: 'aim', t: 0, elev: Math.max(-15, Math.min(90, elev)), facing: best.f, power, wi, move: 0 };
  }

  private updateAi(t: Tank, dt: number) {
    const ai = this.ai!;
    ai.t += dt;
    if (ai.stage === 'think') {
      if (ai.t > 0.8) {
        this.ai = this.planAi(t);
        t.wi = this.ai.wi;
      }
      return;
    }
    if (ai.stage === 'aim') {
      t.facing = ai.facing;
      const d = ai.elev - t.elev;
      t.elev += Math.sign(d) * Math.min(Math.abs(d), 50 * dt);
      if (Math.abs(d) < 0.01 && ai.t > 0.5) {
        ai.stage = 'charge';
        t.charging = true;
        t.power = 0;
      }
      return;
    }
    t.power = Math.min(ai.power, t.power + CHARGE_RATE * dt);
    if (t.power >= ai.power) this.fire(t);
  }

  // ---------------------------------------------------------------- render

  render(ctx: CanvasRenderingContext2D, cw: number, ch: number) {
    const scale = Math.min(cw / W, ch / H);
    const ox = (cw - W * scale) / 2, oy = (ch - H * scale) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#10151c';
    ctx.fillRect(0, 0, cw, ch);
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    ctx.setTransform(scale, 0, 0, scale, ox + sx * scale, oy + sy * scale);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    ctx.drawImage(this.bg, 0, 0);
    this.drawClouds(ctx);
    ctx.drawImage(this.terrain.image, 0, 0);

    for (const t of this.tanks) if (!t.alive && !t.drowned) this.drawWreck(ctx, t);
    for (const t of this.tanks) if (t.alive) drawTank(ctx, t.model, t.look, t.x, t.y, t.tilt, t.elev, t.facing, t.recoil, t.trackPhase);
    if (this.phase === 'aim' && !this.opts.demo) this.drawAimGuide(ctx, this.current);
    this.drawProjectiles(ctx);
    this.drawParticles(ctx);
    this.drawWater(ctx);
    this.drawGrade(ctx);
    for (const t of this.tanks) if (t.alive) this.drawTankLabel(ctx, t);
    ctx.restore();
    if (!this.opts.demo) this.drawHud(ctx);
  }

  private drawClouds(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalAlpha = this.theme.warzone ? 0.7 : 0.55;
    if (this.theme.warzone) ctx.filter = 'brightness(0.25) sepia(0.6)';
    for (const c of this.clouds) {
      const w = 260 * c.s, h = 110 * c.s;
      ctx.drawImage(this.cloudSprite, c.x - w / 2, c.y - h / 2, w, h);
    }
    ctx.restore();
  }

  private drawWreck(ctx: CanvasRenderingContext2D, t: Tank) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    drawTank(ctx, t.model, { ...t.look, paint: '#3a3633', decal: 'none' }, t.x, t.y, t.tilt + 0.15, -10, t.facing);
    ctx.restore();
    if (Math.random() < 0.12)
      this.particles.push({
        x: t.x + (Math.random() - 0.5) * 12, y: t.y - 16, vx: 0, vy: -25, life: 2.2, max: 2.2, size: 10, color: '#3d3833', kind: 'smoke', grav: -6,
      });
    if (Math.random() < 0.25)
      this.particles.push({
        x: t.x + (Math.random() - 0.5) * 14, y: t.y - 12, vx: (Math.random() - 0.5) * 10, vy: -30, life: 0.5, max: 0.5, size: 5 + Math.random() * 4, color: '', kind: 'fire', grav: -40,
      });
  }

  private drawAimGuide(ctx: CanvasRenderingContext2D, t: Tank) {
    if (t.ai) return;
    const pv = this.pivot(t);
    const a = (t.facing > 0 ? t.elev : 180 - t.elev) * D2R;
    const r0 = t.model.geo.barrelL + 8;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pv.x + Math.cos(a) * r0, pv.y - Math.sin(a) * r0);
    ctx.lineTo(pv.x + Math.cos(a) * (r0 + 70), pv.y - Math.sin(a) * (r0 + 70));
    ctx.stroke();
    ctx.setLineDash([]);
    const cx = pv.x + Math.cos(a) * (r0 + 84), cy = pv.y - Math.sin(a) * (r0 + 84);
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.moveTo(cx - 13, cy);
    ctx.lineTo(cx - 4, cy);
    ctx.moveTo(cx + 4, cy);
    ctx.lineTo(cx + 13, cy);
    ctx.stroke();
    ctx.restore();
  }

  private drawProjectiles(ctx: CanvasRenderingContext2D) {
    for (const p of this.projectiles) {
      ctx.save();
      if (p.look.trail !== 'smoke') ctx.globalCompositeOperation = 'lighter';
      p.trail.forEach((pt, i) => {
        const al = 1 - i / p.trail.length;
        ctx.fillStyle = trailColor(p.look.trail, i, this.time, al * (p.look.trail === 'smoke' ? 0.5 : 0.7));
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, Math.max(0.8, p.w.size * 0.8 * al + (p.look.trail === 'smoke' ? i * 0.22 : 0)), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
      if (p.look.trail === 'sparkle' && Math.random() < 0.5)
        this.particles.push({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40, life: 0.5, max: 0.5, size: 2, color: '#fff3a0', kind: 'spark', grav: 0 });
      // hot glow
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.w.size * 4);
      glow.addColorStop(0, 'rgba(255,190,110,0.55)');
      glow.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(p.x - p.w.size * 4, p.y - p.w.size * 4, p.w.size * 8, p.w.size * 8);
      ctx.restore();
      // shell body pointing along its flight
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(p.vy, p.vx));
      const L = p.w.size * 2.2, R2 = p.w.size * 0.85;
      const bodyG = ctx.createLinearGradient(0, -R2, 0, R2);
      bodyG.addColorStop(0, shade(p.w.color, 0.5));
      bodyG.addColorStop(1, shade(p.w.color, -0.4));
      ctx.fillStyle = bodyG;
      ctx.beginPath();
      ctx.moveTo(L * 0.6, 0);
      ctx.quadraticCurveTo(L * 0.3, -R2, -L * 0.2, -R2);
      ctx.lineTo(-L * 0.5, -R2);
      ctx.lineTo(-L * 0.5, R2);
      ctx.lineTo(-L * 0.2, R2);
      ctx.quadraticCurveTo(L * 0.3, R2, L * 0.6, 0);
      ctx.fill();
      ctx.fillStyle = '#c9a227';
      ctx.fillRect(-L * 0.3, -R2, 1.5, R2 * 2);
      ctx.restore();
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D) {
    // Normal-blended pass: smoke, debris, text
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.max);
      switch (p.kind) {
        case 'smoke': {
          const r = p.size * (1.7 - a * 0.7);
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          g.addColorStop(0, p.color);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalAlpha = Math.min(1, a * 1.4) * 0.55;
          ctx.fillStyle = g;
          ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
          break;
        }
        case 'chunk':
          ctx.globalAlpha = Math.min(1, a * 2);
          ctx.fillStyle = p.color;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate((p.rot ?? 0) + this.time * (p.spin ?? 0));
          ctx.beginPath();
          ctx.moveTo(-p.size / 2, -p.size / 3);
          ctx.lineTo(p.size / 3, -p.size / 2);
          ctx.lineTo(p.size / 2, p.size / 4);
          ctx.lineTo(-p.size / 4, p.size / 2);
          ctx.fill();
          ctx.restore();
          break;
        case 'text':
          ctx.globalAlpha = Math.min(1, a * 2);
          ctx.font = `700 ${p.size}px "Chakra Petch", system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.lineWidth = 4;
          ctx.strokeStyle = '#1a1410';
          ctx.strokeText(p.text!, p.x, p.y);
          ctx.fillStyle = p.color;
          ctx.fillText(p.text!, p.x, p.y);
          break;
        case 'debris':
        case 'drop':
        case 'flake':
          ctx.globalAlpha = Math.min(1, a * 1.5);
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
          break;
      }
    }
    // Additive pass: fire, flashes, sparks
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.max);
      switch (p.kind) {
        case 'fire': {
          const r = p.size * (1.3 - a * 0.3);
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          g.addColorStop(0, `rgba(255,240,200,${a})`);
          g.addColorStop(0.35, `rgba(255,150,50,${a * 0.85})`);
          g.addColorStop(1, 'rgba(200,40,10,0)');
          ctx.globalAlpha = 1;
          ctx.fillStyle = g;
          ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
          break;
        }
        case 'flash': {
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
          g.addColorStop(0, `rgba(255,250,220,${a})`);
          g.addColorStop(0.3, `rgba(255,190,80,${a * 0.7})`);
          g.addColorStop(1, 'rgba(255,120,40,0)');
          ctx.globalAlpha = 1;
          ctx.fillStyle = g;
          ctx.fillRect(p.x - p.size, p.y - p.size, p.size * 2, p.size * 2);
          break;
        }
        case 'ring':
          ctx.strokeStyle = p.color;
          ctx.globalAlpha = a * 0.6;
          ctx.lineWidth = 4 * a;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (1 - a) + 4, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'spark': {
          ctx.globalAlpha = Math.min(1, a * 1.6);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = p.size;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.025, p.y - p.vy * 0.025);
          ctx.stroke();
          break;
        }
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Weather and ambience for each map. */
  private ambient(dt: number) {
    const t = this.theme;
    const spawn = (rate: number, make: () => Particle) => {
      if (Math.random() < dt * rate) this.particles.push(make());
    };
    if (t.name === 'Tundra')
      spawn(40, () => ({ x: Math.random() * (W + 200) - 100, y: -10, vx: 0, vy: 30 + Math.random() * 30, life: 30, max: 30, size: 1.5 + Math.random() * 2, color: 'rgba(255,255,255,0.85)', kind: 'flake', grav: 0 }));
    else if (t.lava) {
      spawn(14, () => ({ x: Math.random() * (W + 200) - 100, y: -10, vx: 0, vy: 18 + Math.random() * 20, life: 40, max: 40, size: 1.5 + Math.random() * 1.5, color: 'rgba(90,84,80,0.8)', kind: 'flake', grav: 0 }));
      spawn(10, () => ({ x: Math.random() * W, y: WATER, vx: (Math.random() - 0.5) * 20, vy: -40 - Math.random() * 60, life: 2.5, max: 2.5, size: 1.5 + Math.random() * 1.5, color: Math.random() < 0.5 ? '#ff8a3a' : '#ffcf6a', kind: 'spark', grav: -4 }));
    } else if (t.name === 'Desert')
      spawn(10, () => ({ x: Math.random() * W, y: H * 0.4 + Math.random() * H * 0.4, vx: 0, vy: -4, life: 6, max: 6, size: 1.5, color: 'rgba(240,210,160,0.6)', kind: 'flake', grav: 0 }));
    for (const p of this.particles) if (p.kind === 'flake') {
      p.vx += (this.wind * 0.6 - p.vx) * dt;
      if (p.y > WATER || this.terrain.solid(p.x, p.y)) p.life = Math.min(p.life, 0.3);
    }
  }

  private drawWater(ctx: CanvasRenderingContext2D) {
    const base = this.theme.water;
    const wave = (x: number, off: number, amp: number, speed: number) => WATER + off + Math.sin(x * 0.018 + this.time * speed) * amp + Math.sin(x * 0.047 - this.time * speed * 1.3) * amp * 0.4;
    // back layer
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 12) ctx.lineTo(x, wave(x, -5, 4, 1.4));
    ctx.lineTo(W, H);
    ctx.fill();
    // front layer with depth gradient
    ctx.globalAlpha = 0.92;
    const g = ctx.createLinearGradient(0, WATER, 0, H);
    g.addColorStop(0, shade(base, 0.15));
    g.addColorStop(1, shade(base, -0.6));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 12) ctx.lineTo(x, wave(x, 2, 3, -1.9));
    ctx.lineTo(W, H);
    ctx.fill();
    // crest highlights
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = shade(base, 0.6);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 12) {
      const y = wave(x, 2, 3, -1.9);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (this.theme.lava) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const glow = ctx.createLinearGradient(0, WATER - 90, 0, WATER + 10);
      glow.addColorStop(0, 'rgba(255,90,20,0)');
      glow.addColorStop(1, `rgba(255,110,30,${0.22 + Math.sin(this.time * 2) * 0.05})`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, WATER - 90, W, 100);
      ctx.restore();
    }
  }

  /** Darkened corners plus a brief warm flash after big explosions. */
  private drawGrade(ctx: CanvasRenderingContext2D) {
    if (!this.vignette) {
      const v = document.createElement('canvas');
      v.width = W;
      v.height = H;
      const g = v.getContext('2d')!;
      const grad = g.createRadialGradient(W / 2, H * 0.45, H * 0.35, W / 2, H * 0.5, W * 0.7);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, this.theme.warzone ? 'rgba(20,4,2,0.6)' : 'rgba(0,0,0,0.42)');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      this.vignette = v;
    }
    ctx.drawImage(this.vignette, 0, 0);
    if (this.flashT > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,150,70,${this.flashT * 0.18})`;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  private drawTankLabel(ctx: CanvasRenderingContext2D, t: Tank) {
    const y = t.y - pivotHeight(t.model) - 38;
    ctx.font = '600 15px "Chakra Petch", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(16,20,26,0.85)';
    ctx.strokeText(t.name, t.x, y);
    ctx.fillStyle = '#f3ecd8';
    ctx.fillText(t.name, t.x, y);
    const bw = 48;
    ctx.fillStyle = 'rgba(16,20,26,0.8)';
    roundRect(ctx, t.x - bw / 2 - 2, y + 5, bw + 4, 8, 3);
    ctx.fill();
    ctx.fillStyle = t.color;
    ctx.fillRect(t.x - bw / 2, y + 7, (bw * Math.max(0, t.hpShown)) / t.maxHp, 4);
    if (this.phase === 'aim' && t === this.current) {
      const by = y - 30 + Math.sin(this.time * 6) * 4;
      ctx.fillStyle = t.color;
      ctx.beginPath();
      ctx.moveTo(t.x - 8, by);
      ctx.lineTo(t.x + 8, by);
      ctx.lineTo(t.x, by + 10);
      ctx.fill();
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const t = this.current;
    const font = (w: number, s: number) => `${w} ${s}px "Chakra Petch", system-ui, sans-serif`;
    const panel = (x: number, y: number, w: number, h: number) => {
      ctx.fillStyle = 'rgba(14,14,17,0.8)';
      roundRect(ctx, x, y, w, h, 6);
      ctx.fill();
    };

    // Turn + timer
    panel(20, 18, 300, 64);
    ctx.fillStyle = t.color;
    ctx.fillRect(20, 18, 6, 64);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#9fb0c2';
    ctx.font = font(600, 13);
    ctx.fillText(t.ai ? 'COMPUTER IS AIMING' : t.remote ? 'OPPONENT IS AIMING' : 'YOUR SHOT', 40, 40);
    ctx.fillStyle = '#f3ecd8';
    ctx.font = font(700, 24);
    ctx.fillText(t.name, 40, 69);
    if (this.phase === 'aim') {
      ctx.textAlign = 'right';
      ctx.font = font(700, 30);
      ctx.fillStyle = this.timer < 5 ? '#ff8a3d' : '#f3ecd8';
      ctx.fillText(String(Math.ceil(this.timer)), 306, 66);
    }

    // Wind
    const wx = W / 2;
    panel(wx - 150, 18, 300, 64);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#9fb0c2';
    ctx.font = font(600, 13);
    ctx.fillText('WIND', wx, 38);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(wx - 120, 50, 240, 10);
    const wv = this.wind / WIND_MAX;
    ctx.fillStyle = '#7fc8e8';
    ctx.fillRect(wv >= 0 ? wx : wx + wv * 120, 50, Math.abs(wv) * 120, 10);
    ctx.fillStyle = '#f3ecd8';
    ctx.fillRect(wx - 1, 46, 2, 18);
    ctx.font = font(700, 14);
    const ws = Math.round(Math.abs(wv) * 10);
    ctx.fillText(ws === 0 ? 'calm' : `${wv < 0 ? '◀ ' : ''}${ws}${wv > 0 ? ' ▶' : ''}`, wx, 76);

    // Weapon
    const slot = t.arsenal[t.wi];
    panel(W - 320, 18, 300, 64);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#9fb0c2';
    ctx.font = font(600, 13);
    ctx.fillText(t.ai ? 'WEAPON' : 'WEAPON  ·  Q / E TO SWITCH', W - 302, 40);
    ctx.fillStyle = '#f3ecd8';
    ctx.font = font(700, 22);
    ctx.fillText(slot.w.name, W - 302, 68);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffb067';
    ctx.fillText(slot.ammo < 0 ? '∞' : `×${slot.ammo}`, W - 36, 68);

    // Power, angle, fuel
    const px = W / 2 - 260, py = H - 74;
    panel(px, py, 520, 56);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#9fb0c2';
    ctx.font = font(600, 12);
    ctx.fillText('ANGLE', px + 16, py + 22);
    ctx.fillText('POWER', px + 110, py + 22);
    ctx.fillText('FUEL', px + 420, py + 22);
    ctx.fillStyle = '#f3ecd8';
    ctx.font = font(700, 20);
    ctx.fillText(`${Math.round(t.elev)}°`, px + 16, py + 46);
    const bx = px + 110, bw = 290;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(bx, py + 32, bw, 12);
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    grad.addColorStop(0, '#f2d36b');
    grad.addColorStop(1, '#ff6a3d');
    ctx.fillStyle = grad;
    ctx.fillRect(bx, py + 32, (bw * t.power) / 100, 12);
    if (t.lastPower >= 0) {
      ctx.fillStyle = '#f3ecd8';
      ctx.fillRect(bx + (bw * t.lastPower) / 100 - 1, py + 28, 2, 20);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(px + 420, py + 32, 84, 12);
    ctx.fillStyle = '#9ccf6a';
    ctx.fillRect(px + 420, py + 32, (84 * t.fuel) / t.model.fuel, 12);

    if (!t.ai && this.phase === 'aim') {
      ctx.textAlign = 'left';
      ctx.font = font(500, 13);
      ctx.fillStyle = 'rgba(243,236,216,0.8)';
      ctx.fillText('← → drive   ↑ ↓ aim   hold SPACE to fire   Esc pause', 24, H - 18);
    }

    if (this.banner > 0 && this.phase === 'aim') {
      ctx.globalAlpha = Math.min(1, this.banner * 2);
      ctx.textAlign = 'center';
      ctx.font = `700 56px "Chakra Petch", system-ui, sans-serif`;
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(16,20,26,0.8)';
      const msg = t.name.toUpperCase();
      ctx.strokeText(msg, W / 2, H * 0.3);
      ctx.fillStyle = t.color;
      ctx.fillText(msg, W / 2, H * 0.3);
      ctx.font = font(700, 18);
      ctx.fillStyle = '#f3ecd8';
      ctx.fillText(t.ai || t.remote ? 'TAKING AIM' : 'YOUR TURN', W / 2, H * 0.3 - 56);
      ctx.globalAlpha = 1;
    }
  }
}

/** Soft cloud puff drawn once and reused. */
function cloudSprite(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 260;
  c.height = 110;
  const g = c.getContext('2d')!;
  const puffs = [[130, 62, 46], [92, 70, 34], [170, 70, 36], [112, 48, 34], [150, 46, 30], [60, 78, 24], [204, 78, 24]];
  for (const [x, y, r] of puffs) {
    const rg = g.createRadialGradient(x, y - r * 0.3, r * 0.1, x, y, r);
    rg.addColorStop(0, 'rgba(255,255,255,0.95)');
    rg.addColorStop(0.6, 'rgba(235,238,245,0.7)');
    rg.addColorStop(1, 'rgba(220,225,235,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}
