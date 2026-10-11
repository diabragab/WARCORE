// Exports a light version of the 3D tank for the 3D renderer:
//   src/assets/tank3d-mesh.bin   int16 positions + uint16 indices for each bucket
//   src/assets/tank3d-mesh.json  buckets: part (body/turret/barrel), material (paint/dark/track), offsets
// Coordinates are in model units with the origin on the ground under the middle of the tracks:
// x forward, y up, z toward the viewer's side. The barrel's origin is its hinge, so it can rotate.
// Usage: cd tools/tank-art && npm install && node mesh.mjs
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const buf = fs.readFileSync(path.join(repo, 'art/tank/tank_separete.3ds'));
const root = new TDSLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
root.updateMatrixWorld(true);

const MATERIAL = { 'Material.016': 'paint', 'Material.006': 'dark', 'Material.019': 'track' };
const BASE = new THREE.Vector3(1.505, -3.52, -0.14); // ground under the middle of the red tank
const PIVOT = new THREE.Vector3(2.84, -3.505, 4.26); // barrel hinge
// How much of each bucket's triangles to keep. The tracks are very dense (10k vertices each).
const KEEP = { track: 0.06, dark: 0.3, paint: 0.4 };
const QUANT = 2000; // int16 units per model unit

// Model space (x forward, y sideways, z up) to tank space (x forward, y up, z toward the viewer).
const toTank = (v, origin) => new THREE.Vector3(v.x - origin.x, v.z - origin.z, -(v.y - origin.y));

const meshes = [];
root.traverse((o) => o.isMesh && meshes.push(o));
const red = meshes.filter((m) => {
  const b = new THREE.Box3().setFromObject(m);
  return b.min.y > -6.4 && b.max.y < -0.6 && !m.name.startsWith('Plane');
});
const box = (m) => new THREE.Box3().setFromObject(m);
const partOf = (m) => {
  const b = box(m);
  if (Math.abs(b.min.x - 2.29) < 0.05) return 'barrel';
  if (b.min.z >= 2.5 && b.min.x >= -1) return 'turret';
  return 'body';
};

await MeshoptSimplifier.ready;
const buckets = new Map();
for (const m of red) {
  const part = partOf(m);
  const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
  const pos = g.attributes.position;
  const idx = g.index.array;
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  for (const grp of g.groups.length ? g.groups : [{ start: 0, count: idx.length, materialIndex: 0 }]) {
    const mat = MATERIAL[mats[grp.materialIndex].name] || 'dark';
    const key = `${part}:${mat}`;
    if (!buckets.has(key)) buckets.set(key, { part, mat, pos: [], idx: [] });
    const b = buckets.get(key);
    const origin = part === 'barrel' ? PIVOT : BASE;
    const remap = new Map();
    for (let i = grp.start; i < grp.start + grp.count; i++) {
      const v = idx[i];
      if (!remap.has(v)) {
        remap.set(v, b.pos.length / 3);
        const p = toTank(new THREE.Vector3().fromBufferAttribute(pos, v), origin);
        b.pos.push(p.x, p.y, p.z);
      }
      b.idx.push(remap.get(v));
    }
  }
}

const out = [];
const meta = { quant: QUANT, base: BASE.toArray(), pivot: toTank(PIVOT, BASE).toArray(), buckets: [] };
let bytes = 0;
for (const b of buckets.values()) {
  // Weld duplicate vertices so the simplifier can collapse across them.
  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  geo.setIndex(b.idx);
  geo = mergeVertices(geo, 1e-4);
  const P = geo.attributes.position.array;
  const I = new Uint32Array(geo.index.array);
  const target = Math.max(36, Math.floor((I.length * KEEP[b.mat]) / 3) * 3);
  const [simple] = MeshoptSimplifier.simplify(I, P, 3, target, 0.02);
  // Keep only the vertices still in use.
  const used = new Map();
  const pos = [];
  const tris = [];
  for (const v of simple) {
    if (!used.has(v)) {
      used.set(v, pos.length / 3);
      pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    }
    tris.push(used.get(v));
  }
  const p16 = Int16Array.from(pos, (x) => Math.round(x * QUANT));
  const i16 = Uint16Array.from(tris);
  meta.buckets.push({ part: b.part, mat: b.mat, offset: bytes, vertices: p16.length / 3, indices: i16.length });
  out.push(Buffer.from(p16.buffer), Buffer.from(i16.buffer));
  bytes += p16.byteLength + i16.byteLength;
  if (bytes % 4) {
    const pad = 4 - (bytes % 4);
    out.push(Buffer.alloc(pad));
    bytes += pad;
  }
  console.log(`${b.part}:${b.mat}`, I.length / 3, '->', i16.length / 3, 'triangles');
}
fs.writeFileSync(path.join(repo, 'src/assets/tank3d-mesh.bin'), Buffer.concat(out));
fs.writeFileSync(path.join(repo, 'src/assets/tank3d-mesh.json'), JSON.stringify(meta) + '\n');
console.log('bytes', bytes);
