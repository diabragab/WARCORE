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
}

export const THEMES: Record<string, Theme> = {
  warzone: { name: 'Warzone', skyTop: '#140e10', skyBottom: '#8a2a16', sun: '#ff6a32', far: '#3a2a2a', near: '#1d1617', top: [92, 80, 72], dirt: [62, 52, 47], dirt2: [45, 37, 34], water: '#1b2125', warzone: true },
  grass: { name: 'Grassland', skyTop: '#33507a', skyBottom: '#f0b98a', sun: '#ffe3ae', far: '#7d7f9a', near: '#5f6f7d', top: [104, 156, 62], dirt: [118, 84, 52], dirt2: [92, 64, 40], water: '#24587a' },
  desert: { name: 'Desert', skyTop: '#5b6fa8', skyBottom: '#f6d29a', sun: '#fff1c2', far: '#c79a7a', near: '#a9775a', top: [222, 184, 112], dirt: [196, 146, 86], dirt2: [168, 118, 70], water: '#2f7c8a' },
  snow: { name: 'Tundra', skyTop: '#1f2f4f', skyBottom: '#9fb6cf', sun: '#eef4ff', far: '#7b8ca6', near: '#5d6d86', top: [236, 242, 248], dirt: [104, 112, 126], dirt2: [84, 90, 104], water: '#1d4466' },
};

export class Terrain {
  mask = new Uint8Array(W * H);
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;

  constructor(seed: number, public theme: Theme) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
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
    for (let x = 0; x < W; x++) {
      let depth = -1;
      const grassH = 6 + Math.floor(rnd() * 3);
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        if (!this.mask[i]) { depth = -1; continue; }
        depth++;
        const o = i * 4;
        const n = rnd() * 14 - 7;
        if (depth < grassH) {
          const s = depth < 2 ? 14 : 0;
          d[o] = top[0] + n + s; d[o + 1] = top[1] + n + s; d[o + 2] = top[2] + n + s;
        } else {
          // Soft strata: blend the two dirt tones instead of hard stripes.
          const band = (Math.sin(y * 0.045 + Math.sin(x * 0.009) * 1.6) + 1) / 2;
          const m = band * band * (3 - 2 * band) * 0.7;
          const deep = Math.min(1, depth / 500) * 30;
          for (let k = 0; k < 3; k++) d[o + k] = dirt[k] * (1 - m) + dirt2[k] * m + n - deep;
        }
        d[o + 3] = 255;
      }
    }
    this.ctx.putImageData(img, 0, 0);
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
    this.paint(mulberry32(seed ^ 0x5bd1e995));
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
