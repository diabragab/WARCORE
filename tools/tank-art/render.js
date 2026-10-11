// Runs in the browser page that build.mjs opens. Renders parts of a 3D model with an
// orthographic camera and packs them into one sprite sheet.
import * as THREE from 'three';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(1);
const scene = new THREE.Scene();
let root = null;

const meshes = () => {
  const out = [];
  root.traverse((o) => o.isMesh && out.push(o));
  return out;
};
// Blender stores colours in linear space.
const lin = ([r, g, b]) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

window.load = async (url) => {
  root = await new TDSLoader().loadAsync(url);
  scene.add(root);
  root.updateMatrixWorld(true);
  return meshes().map((m) => {
    const b = new THREE.Box3().setFromObject(m);
    const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => x.name);
    return { name: m.name, mats, min: b.min.toArray(), max: b.max.toArray() };
  });
};

/**
 * Renders the meshes in `only`, viewed along `dir`, at `ppu` pixels per model unit.
 * `occluders` hide what is behind them without being drawn. With `mask`, the material
 * named there renders white and everything else black, unlit.
 * Returns the canvas plus where each world-space `anchor` lands in it.
 */
function shot(o) {
  const only = new Set(o.only);
  const occ = new Set(o.occluders || []);
  const box = new THREE.Box3();
  for (const m of meshes()) {
    if (!m.userData.orig) m.userData.orig = m.material;
    const orig = Array.isArray(m.userData.orig) ? m.userData.orig : [m.userData.orig];
    m.visible = only.has(m.name) || occ.has(m.name);
    m.renderOrder = occ.has(m.name) ? -1 : 0;
    if (only.has(m.name)) box.expandByObject(m);
    const mats = orig.map((x) => {
      if (occ.has(m.name)) return new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
      if (o.mask) return new THREE.MeshBasicMaterial({ color: x.name === o.mask ? 0xffffff : 0x000000, side: THREE.DoubleSide });
      const s = o.mats[x.name] || { c: [0.5, 0.5, 0.5] };
      return new THREE.MeshStandardMaterial({ color: lin(s.c), roughness: s.rough ?? 0.5, metalness: s.metal ?? 0.2, side: THREE.DoubleSide });
    });
    m.material = Array.isArray(m.userData.orig) ? mats : mats[0];
  }

  const dir = new THREE.Vector3(...o.dir).normalize();
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, size * 10);
  cam.up.set(0, 0, 1);
  cam.position.copy(center).addScaledVector(dir, -size * 3);
  cam.lookAt(center);
  cam.updateMatrixWorld();
  const inv = cam.matrixWorldInverse;
  const pts = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(new THREE.Vector3(x, y, z).applyMatrix4(inv));
  const pad = o.pad ?? 0.06;
  const l = Math.min(...pts.map((p) => p.x)) - pad, b = Math.min(...pts.map((p) => p.y)) - pad;
  const w = Math.ceil((Math.max(...pts.map((p) => p.x)) + pad - l) * o.ppu);
  const h = Math.ceil((Math.max(...pts.map((p) => p.y)) + pad - b) * o.ppu);
  const r = l + w / o.ppu, t = b + h / o.ppu;
  Object.assign(cam, { left: l, right: r, top: t, bottom: b });
  cam.updateProjectionMatrix();
  renderer.setSize(w, h, false);

  // Key light from the upper left, a soft sky/ground fill and a cool rim from the right.
  for (const c of scene.children.filter((c) => c.isLight)) scene.remove(c);
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3020, 1.1));
  const key = new THREE.DirectionalLight(0xfff1dc, 2.6);
  key.position.copy(center).addScaledVector(up, size).addScaledVector(right, -size * 0.6).addScaledVector(dir, -size * 0.9);
  const rim = new THREE.DirectionalLight(0xbcd4ff, 1.0);
  rim.position.copy(center).addScaledVector(right, size).addScaledVector(dir, size * 0.5).addScaledVector(up, size * 0.3);
  for (const lt of [key, rim]) {
    lt.target.position.copy(center);
    scene.add(lt, lt.target);
  }
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, cam);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(renderer.domElement, 0, 0);
  const anchors = {};
  for (const [k, p] of Object.entries(o.anchors || {})) {
    const v = new THREE.Vector3(...p).applyMatrix4(inv);
    anchors[k] = [+(((v.x - l) / (r - l)) * w).toFixed(2), +(((t - v.y) / (t - b)) * h).toFixed(2)];
  }
  return { canvas, anchors };
}

/**
 * Renders every part twice (lit with the paint material in white, and its paint mask),
 * then packs them: lit parts on the top row, masks (white, paint coverage in alpha) below.
 */
window.sheet = (cfg) => {
  const parts = cfg.parts.map((p) => {
    const common = { only: p.meshes, occluders: p.occluders, dir: cfg.dir, ppu: cfg.ppu, anchors: cfg.anchors };
    const lit = shot({ ...common, mats: cfg.mats });
    const mask = shot({ ...common, mask: cfg.paint });
    return { name: p.name, lit, mask };
  });
  const W = parts.reduce((s, p) => s + p.lit.canvas.width + 2, 0);
  const H = Math.max(...parts.map((p) => p.lit.canvas.height));
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H * 2 + 2;
  const g = out.getContext('2d');
  const meta = { ppu: cfg.ppu, parts: {} };
  let x = 0;
  for (const p of parts) {
    const { width: w, height: h } = p.lit.canvas;
    g.drawImage(p.lit.canvas, x, 0);
    const lit = p.lit.canvas.getContext('2d').getImageData(0, 0, w, h);
    const m = p.mask.canvas.getContext('2d').getImageData(0, 0, w, h);
    for (let i = 0; i < m.data.length; i += 4) {
      m.data[i + 3] = Math.round((m.data[i] * lit.data[i + 3]) / 255);
      m.data[i] = m.data[i + 1] = m.data[i + 2] = 255;
    }
    g.putImageData(m, x, H + 2);
    meta.parts[p.name] = { x, y: 0, maskY: H + 2, w, h, anchors: p.lit.anchors };
    x += w + 2;
  }
  return { png: out.toDataURL('image/png'), meta };
};

window.ready = true;
