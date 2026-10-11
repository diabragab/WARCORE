import { mulberry32 } from './rng';

export const W = 1600;
export const H = 900;
export const WATER = H - 44;

type RGB = [number, number, number];

export interface Theme {
  name: string;
  skyTop: string;
  skyBottom: string;
  sun: string;
  far: string;
  near: string;
  top: RGB;
  dirt: RGB;
  dirt2: RGB;
  water: string;
  /** Burning city silhouettes, smoke and embers instead of rolling hills. */
  warzone?: boolean;
  /** Ruined city skyline (without the fires) instead of rolling hills. */
  skyline?: boolean;
  /** Night sky with stars; the "sun" is the moon. */
  stars?: boolean;
  /** Lava instead of water: glowing, with embers and falling ash. */
  lava?: boolean;
}

export const THEMES: Record<string, Theme> = {
  warzone: { name: 'Warzone', skyTop: '#140e10', skyBottom: '#8a2a16', sun: '#ff6a32', far: '#3a2a2a', near: '#1d1617', top: [92, 80, 72], dirt: [62, 52, 47], dirt2: [45, 37, 34], water: '#1b2125', warzone: true },
  grass: { name: 'Grassland', skyTop: '#33507a', skyBottom: '#f0b98a', sun: '#ffe3ae', far: '#7d7f9a', near: '#5f6f7d', top: [104, 156, 62], dirt: [118, 84, 52], dirt2: [92, 64, 40], water: '#24587a' },
  desert: { name: 'Desert', skyTop: '#5b6fa8', skyBottom: '#f6d29a', sun: '#fff1c2', far: '#c79a7a', near: '#a9775a', top: [222, 184, 112], dirt: [196, 146, 86], dirt2: [168, 118, 70], water: '#2f7c8a' },
  night: { name: 'Night Ops', skyTop: '#04070f', skyBottom: '#1b2a4a', sun: '#e6edf8', far: '#18213a', near: '#10182a', top: [56, 92, 64], dirt: [72, 58, 48], dirt2: [54, 44, 36], water: '#0e2742', stars: true },
  volcano: { name: 'Volcano', skyTop: '#160806', skyBottom: '#7a2610', sun: '#ff7a2a', far: '#3b1d17', near: '#24120e', top: [78, 66, 62], dirt: [62, 42, 36], dirt2: [44, 28, 24], water: '#ff5a1f', lava: true },
  city: { name: 'Ruined City', skyTop: '#55667a', skyBottom: '#c9cdd0', sun: '#fff6de', far: '#727a85', near: '#4d545d', top: [118, 116, 110], dirt: [96, 90, 84], dirt2: [74, 70, 66], water: '#2c4a5e', skyline: true },
  snow: { name: 'Tundra', skyTop: '#1f2f4f', skyBottom: '#9fb6cf', sun: '#eef4ff', far: '#7b8ca6', near: '#5d6d86', top: [236, 242, 248], dirt: [104, 112, 126], dirt2: [84, 90, 104], water: '#1d4466' },
};

export class Terrain {
  mask = new Uint8Array(W * H);
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  private lit: HTMLCanvasElement;
  private dirty = true;

  constructor(seed: number, public theme: Theme) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.lit = document.createElement('canvas');
    this.lit.width = W;
    this.lit.height = H;
    this.generate(mulberry32(seed));
    this.paint(mulberry32(seed ^ 0x5bd1e995));
  }

  private generate(rnd: () => number) {
    const base = H * (0.5 + rnd() * 0.12);
    const layers = [
      { f: 0.002 + rnd() * 0.002, a: 90 + rnd() * 60, p: rnd() * 7 },
      { f: 0.006 + rnd() * 0.004, a: 40 + rnd() * 40, p: rnd() * 7 },
      { f: 0.018 + rnd() * 0.01, a: 8 + rnd() * 10, p: rnd() * 7 },
    ];
    for (let x = 0; x < W; x++) {
      let h = base;
      for (const l of layers) h += Math.sin(x * l.f + l.p) * l.a;
      h = Math.max(200, Math.min(WATER - 40, h));
      for (let y = Math.floor(h); y < H; y++) this.mask[y * W + x] = 1;
    }
  }

  private paint(rnd: () => number) {
    const img = this.ctx.createImageData(W, H);
    const d = img.data;
    const { top, dirt, dirt2 } = this.theme;
    const noise = valueNoise(rnd);
    const surface = new Int32Array(W).fill(H);
    for (let x = 0; x < W; x++) {
      let depth = -1;
      const grassH = 7 + Math.floor(noise(x * 0.08, 3) * 5);
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        if (!this.mask[i]) { depth = -1; continue; }
        depth++;
        if (surface[x] === H) surface[x] = y;
        const o = i * 4;
        // Layered noise: large blotches, medium grain, fine speckle.
        const big = noise(x * 0.012, y * 0.012) - 0.5;
        const mid = noise(x * 0.06, y * 0.06) - 0.5;
        const n = big * 34 + mid * 16 + (rnd() * 10 - 5);
        if (depth < grassH) {
          const lit = depth < 2 ? 22 : depth < 4 ? 8 : -depth * 2;
          for (let k = 0; k < 3; k++) d[o + k] = top[k] + n * 0.6 + lit;
        } else {
          const band = (Math.sin(y * 0.045 + Math.sin(x * 0.009) * 1.6 + big * 2) + 1) / 2;
          const m = band * band * (3 - 2 * band) * 0.75;
          const deep = Math.min(1, depth / 420) * 38;
          // Darker just under the topsoil, like a shaded lip.
          const lip = depth < grassH + 5 ? 18 - (depth - grassH) * 3 : 0;
          for (let k = 0; k < 3; k++) d[o + k] = dirt[k] * (1 - m) + dirt2[k] * m + n - deep - lip;
        }
        d[o + 3] = 255;
      }
    }
    this.ctx.putImageData(img, 0, 0);
    this.decorate(rnd, surface);
  }

  /** Rocks in the soil and grass, rubble or snow along the surface. */
  private decorate(rnd: () => number, surface: Int32Array) {
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'source-atop';
    const { dirt, top } = this.theme;
    for (let i = 0; i < 140; i++) {
      const x = rnd() * W;
      const sy = surface[Math.floor(x)];
      if (sy >= H) continue;
      const y = sy + 24 + rnd() * (H - sy);
      const r = 2 + rnd() * rnd() * 9;
      const tone = 0.75 + rnd() * 0.45;
      const g = c.createLinearGradient(x, y - r, x, y + r);
      g.addColorStop(0, `rgba(${dirt[0] * tone + 22},${dirt[1] * tone + 20},${dirt[2] * tone + 18},0.9)`);
      g.addColorStop(1, `rgba(${dirt[0] * tone * 0.7},${dirt[1] * tone * 0.7},${dirt[2] * tone * 0.7},0.9)`);
      c.fillStyle = g;
      c.beginPath();
      const sides = 5 + Math.floor(rnd() * 4);
      const rot = rnd() * Math.PI;
      for (let k = 0; k < sides; k++) {
        const ang = rot + (k / sides) * Math.PI * 2;
        const rr = r * (0.65 + rnd() * 0.45);
        c.lineTo(x + Math.cos(ang) * rr * 1.3, y + Math.sin(ang) * rr);
      }
      c.closePath();
      c.fill();
    }
    c.restore();
    // Surface details are drawn over the edge so they poke out above the ground.
    const kind = this.theme.warzone ? 'rubble' : top[1] > top[0] + 30 ? 'grass' : top[0] > 200 && top[2] > 200 ? 'snow' : 'sand';
    for (let x = 0; x < W; x++) {
      const y = surface[x];
      if (y >= H) continue;
      if (kind === 'grass') {
        const blades = rnd() < 0.7 ? 1 : 2;
        for (let b = 0; b < blades; b++) {
          const h = 2 + rnd() * rnd() * 9;
          const shadeK = 0.75 + rnd() * 0.5;
          c.strokeStyle = `rgb(${top[0] * shadeK + 20},${top[1] * shadeK + 25},${top[2] * shadeK})`;
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(x + 0.5, y + 1);
          c.lineTo(x + 0.5 + (rnd() - 0.5) * 3, y + 1 - h);
          c.stroke();
        }
      } else if (kind === 'rubble' && rnd() < 0.08) {
        c.fillStyle = rnd() < 0.5 ? '#2a2422' : '#5a4e46';
        c.save();
        c.translate(x, y + 1);
        c.rotate((rnd() - 0.5) * 1.2);
        c.fillRect(-2, -2 - rnd() * 3, 3 + rnd() * 6, 2 + rnd() * 3);
        c.restore();
      } else if (kind === 'snow' && rnd() < 0.5) {
        c.fillStyle = 'rgba(255,255,255,0.9)';
        c.fillRect(x, y - rnd() * 1.5, 1, 1.5);
      }
    }
  }

  /** Cheap fingerprint of the mask, used to spot drift between online players. */
  hash(): number {
    let h = 0x811c9dc5;
    const m = this.mask;
    for (let i = 0; i < m.length; i += 7) h = Math.imul(h ^ (m[i] + (i & 0xff)), 16777619);
    return h >>> 0;
  }

  /** Run-length encoding of the mask: alternating runs of empty and solid pixels. */
  encode(): number[] {
    const runs: number[] = [];
    let cur = 0, n = 0;
    for (let i = 0; i < this.mask.length; i++) {
      if (this.mask[i] === cur) n++;
      else {
        runs.push(n);
        cur = this.mask[i];
        n = 1;
      }
    }
    runs.push(n);
    return runs;
  }

  /** Replace the mask with an encoded one and repaint. */
  decode(runs: number[], seed: number) {
    let i = 0, v = 0;
    for (const r of runs) {
      this.mask.fill(v, i, i + r);
      i += r;
      v ^= 1;
    }
    this.ctx.clearRect(0, 0, W, H);
    this.dirty = true;
    this.paint(mulberry32(seed ^ 0x5bd1e995));
  }

  /** The terrain with a lit top edge and a soft shadow, rebuilt only after the ground changes. */
  get image(): HTMLCanvasElement {
    if (this.dirty) {
      this.dirty = false;
      const c = this.lit.getContext('2d')!;
      c.clearRect(0, 0, W, H);
      // Canvas filters exist in Chromium (web and the Windows app); elsewhere draw the plain terrain.
      if ('filter' in c) c.filter = 'drop-shadow(0px -1.5px 0px rgba(255,240,220,0.35)) drop-shadow(0px 6px 10px rgba(0,0,0,0.55))';
      c.drawImage(this.canvas, 0, 0);
      if ('filter' in c) c.filter = 'none';
    }
    return this.lit;
  }

  solid(x: number, y: number): boolean {
    x |= 0; y |= 0;
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return this.mask[y * W + x] === 1;
  }

  surfaceY(x: number): number {
    x = Math.max(0, Math.min(W - 1, x | 0));
    for (let y = 0; y < H; y++) if (this.mask[y * W + x]) return y;
    return H;
  }

  carve(cx: number, cy: number, r: number) {
    this.dirty = true;
    this.forCircle(cx, cy, r, (i) => (this.mask[i] = 0));
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    // Scorch the crater rim: source-atop only darkens terrain that is still there.
    c.globalCompositeOperation = 'source-atop';
    const g = c.createRadialGradient(cx, cy, r, cx, cy, r + 9);
    g.addColorStop(0, 'rgba(28,18,10,0.6)');
    g.addColorStop(1, 'rgba(28,18,10,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cy, r + 9, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  add(cx: number, cy: number, r: number) {
    this.dirty = true;
    this.forCircle(cx, cy, r, (i) => (this.mask[i] = 1));
    const c = this.ctx;
    const [r1, g1, b1] = this.theme.dirt;
    const g = c.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r);
    g.addColorStop(0, `rgb(${r1 + 20},${g1 + 16},${b1 + 10})`);
    g.addColorStop(1, `rgb(${r1 - 18},${g1 - 14},${b1 - 10})`);
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
  }

  private forCircle(cx: number, cy: number, r: number, fn: (i: number) => void) {
    const r2 = r * r;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, cy + r); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, cx + r); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) fn(y * W + x);
      }
  }
}

/** Smooth 2D value noise in [0, 1], seeded. */
function valueNoise(rnd: () => number) {
  const N = 256;
  const perm = new Uint8Array(N * 2);
  const vals = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    perm[i] = i;
    vals[i] = rnd();
  }
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < N; i++) perm[N + i] = perm[i];
  const v = (x: number, y: number) => vals[perm[(perm[x & 255] + y) & 511]];
  const sm = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = sm(x - xi), fy = sm(y - yi);
    const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}
