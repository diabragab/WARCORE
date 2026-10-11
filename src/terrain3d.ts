// Outlines of the terrain mask, for building the 3D ground.
import { H, W } from './terrain';

/** Grid step in pixels. Coarser is faster to rebuild after each blast; 4 px reads as low-poly facets. */
const C = 4;

/**
 * Traces the solid parts of `mask` (W x H, 1 = ground) with marching squares and returns closed
 * loops in world pixels (y down). Outer edges and the edges of holes wind in opposite directions.
 */
export function traceMask(mask: Uint8Array): [number, number][][] {
  const NX = Math.ceil(W / C), NY = Math.ceil(H / C);
  // Samples on grid points, with a ring of empty points around the outside so every loop closes.
  const GW = NX + 3, GH = NY + 3;
  const s = new Uint8Array(GW * GH);
  for (let j = 0; j <= NY; j++)
    for (let i = 0; i <= NX; i++) {
      const x = Math.min(W - 1, i * C), y = Math.min(H - 1, j * C);
      s[(j + 1) * GW + i + 1] = mask[y * W + x];
    }

  // Directed segments between edge midpoints, solid ground on the right in y-down coordinates.
  // Points are stored doubled (so midpoints are integers) and keyed for linking.
  const next = new Map<number, number>();
  const key = (x: number, y: number) => x * 4096 + y;
  const add = (ax: number, ay: number, bx: number, by: number, sx: number, sy: number) => {
    const cross = (bx - ax) * (sy - ay) - (by - ay) * (sx - ax);
    if (cross < 0) next.set(key(ax, ay), key(bx, by));
    else next.set(key(bx, by), key(ax, ay));
  };
  for (let j = 0; j < GH - 1; j++)
    for (let i = 0; i < GW - 1; i++) {
      const a = s[j * GW + i], b = s[j * GW + i + 1], c = s[(j + 1) * GW + i + 1], d = s[(j + 1) * GW + i];
      const n = a + b + c + d;
      if (n === 0 || n === 4) continue;
      const X = 2 * i, Y = 2 * j;
      const top: [number, number] = [X + 1, Y], right: [number, number] = [X + 2, Y + 1];
      const bottom: [number, number] = [X + 1, Y + 2], left: [number, number] = [X, Y + 1];
      if (a && c && !b && !d) {
        add(...top, ...left, X, Y);
        add(...right, ...bottom, X + 2, Y + 2);
        continue;
      }
      if (b && d && !a && !c) {
        add(...top, ...right, X + 2, Y);
        add(...left, ...bottom, X, Y + 2);
        continue;
      }
      const cut: [number, number][] = [];
      if (a !== b) cut.push(top);
      if (b !== c) cut.push(right);
      if (c !== d) cut.push(bottom);
      if (d !== a) cut.push(left);
      const solid: [number, number] = a ? [X, Y] : b ? [X + 2, Y] : c ? [X + 2, Y + 2] : [X, Y + 2];
      add(...cut[0], ...cut[1], ...solid);
    }

  // Chain the segments into loops, then drop points that lie on a straight run.
  const loops: [number, number][][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const pts: [number, number][] = [];
    let k: number | undefined = start;
    while (k !== undefined && !seen.has(k)) {
      seen.add(k);
      pts.push([Math.floor(k / 4096), k % 4096]);
      k = next.get(k);
    }
    if (pts.length < 3) continue;
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i + pts.length - 1) % pts.length], q = pts[i], r = pts[(i + 1) % pts.length];
      if ((q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]) !== 0) out.push(q);
    }
    if (out.length < 3) continue;
    const loop = simplify(out.map(([x, y]) => [((x - 2) / 2) * C, ((y - 2) / 2) * C] as [number, number]), 1.6);
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Ramer–Douglas–Peucker on a closed loop: turns the grid's stair steps into straight slopes. */
function simplify(loop: [number, number][], eps: number): [number, number][] {
  if (loop.length < 8) return loop;
  // Split at the point farthest from the first, simplify both halves as open lines.
  let far = 0, fd = -1;
  for (let i = 1; i < loop.length; i++) {
    const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2;
    if (d > fd) (fd = d), (far = i);
  }
  const a = rdp(loop.slice(0, far + 1), eps), b = rdp([...loop.slice(far), loop[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function rdp(pts: [number, number][], eps: number): [number, number][] {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const [ax, ay] = pts[i0], [bx, by] = pts[i1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1, bd = eps;
    for (let i = i0 + 1; i < i1; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > bd) (bd = d), (best = i);
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Twice the signed area (positive = clockwise on screen, y down). */
export function signedArea(loop: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return a;
}

export function insideLoop(loop: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
