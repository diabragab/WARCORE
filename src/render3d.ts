// 3D look: draws the ground and the tanks with three.js. Everything still plays out on the flat
// gameplay plane (z = 0); the camera looks at that plane square-on from slightly above, with an
// off-centre lens, so the plane maps onto the 2D canvas exactly and the 2D effects (shells,
// explosions, labels) line up, while the ground's top and sides recede into depth.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import MESH_URL from './assets/tank3d-mesh.bin?url';
import MESH from './assets/tank3d-mesh.json';
import { H, W, type Terrain, type Theme } from './terrain';
import { insideLoop, signedArea, traceMask } from './terrain3d';
import type { TankModel, Look } from './data';

/** What the renderer needs to know about a tank. */
export interface Tank3D {
  model: TankModel;
  look: Look;
  x: number;
  y: number;
  tilt: number;
  elev: number;
  facing: number;
  recoil: number;
  alive: boolean;
  drowned: boolean;
}

/** Ground slab: how far it reaches in front of and behind the gameplay plane, in world pixels. */
const FRONT = 40, BACK = 110;
/** Camera: distance from the gameplay plane, and how far above the top of the view it sits. */
const DIST = 1500, LIFT = 260;

type Bucket = { part: 'body' | 'turret' | 'barrel'; mat: 'paint' | 'dark' | 'track'; geo: THREE.BufferGeometry };

/** Settings > Graphics: the 3D look (default) or the classic 2D drawing. */
export const look3d = { enabled: true };

let shared: Renderer3D | null | undefined;
/** The one 3D renderer (browsers allow few WebGL contexts), or null when WebGL isn't available. */
export function getRenderer3D(): Renderer3D | null {
  if (shared === undefined) {
    try {
      shared = new Renderer3D();
    } catch {
      shared = null;
    }
  }
  return shared;
}

export class Renderer3D {
  readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera();
  private buckets: Bucket[] | null = null;
  private terrainKey: Terrain | null = null;
  private terrainVersion = -1;
  private ground: THREE.Mesh | null = null;
  private groundTex: THREE.CanvasTexture | null = null;
  private lights = new THREE.Group();
  private tanks = new Map<Tank3D, { root: THREE.Group; yaw: THREE.Group; barrel: THREE.Group; paint: THREE.MeshStandardMaterial; heading: number }>();
  private dark = new THREE.MeshStandardMaterial({ color: '#2a2630', roughness: 0.5, metalness: 0.35, flatShading: true });
  private track = new THREE.MeshStandardMaterial({ color: '#555555', roughness: 0.65, metalness: 0.1, flatShading: true });
  private wreck = new THREE.MeshStandardMaterial({ color: '#3a3633', roughness: 0.9, metalness: 0.1, flatShading: true });

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(this.lights);
    this.camera.position.set(W / 2, H + LIFT, DIST);
    this.camera.updateMatrixWorld();
    fetch(MESH_URL)
      .then((r) => r.arrayBuffer())
      .then((buf) => (this.buckets = decodeMesh(buf)))
      .catch(() => {});
  }

  /** True once the tank model has loaded; until then the game draws its 2D tanks. */
  get ready() {
    return this.buckets !== null;
  }

  /** Renders the ground and tanks for one frame into `this.canvas` at w x h pixels. */
  render(terrain: Terrain, theme: Theme, tanks: Tank3D[], w: number, h: number) {
    if (this.canvas.width !== w || this.canvas.height !== h) this.renderer.setSize(w, h, false);
    if (this.terrainKey !== terrain) this.newMatch(terrain, theme);
    if (this.terrainVersion !== terrain.version) this.buildGround(terrain, theme);

    for (const t of tanks) this.placeTank(t);
    for (const [t, o] of this.tanks)
      if (!tanks.includes(t)) {
        this.scene.remove(o.root);
        this.tanks.delete(t);
      }

    // Off-centre frustum: the gameplay plane z = 0 fills the view exactly, seen from above.
    const n = 10, cx = W / 2, cy = H + LIFT;
    this.camera.projectionMatrix.makePerspective(((0 - cx) * n) / DIST, ((W - cx) * n) / DIST, ((H - cy) * n) / DIST, ((0 - cy) * n) / DIST, n, DIST * 4);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.renderer.render(this.scene, this.camera);
    return this.canvas;
  }

  private newMatch(terrain: Terrain, theme: Theme) {
    this.terrainKey = terrain;
    this.terrainVersion = -1;
    for (const o of this.tanks.values()) this.scene.remove(o.root);
    this.tanks.clear();
    this.lights.clear();
    const night = !!theme.stars;
    this.lights.add(new THREE.HemisphereLight(mix(theme.skyBottom, '#ffffff', 0.5), rgb(theme.dirt), night ? 0.9 : 1.3));
    const key = new THREE.DirectionalLight(mix(theme.sun, '#ffffff', 0.4), night ? 1.2 : 2.0);
    key.position.set(W / 2 - 500, H + 900, 900);
    key.target.position.set(W / 2, H / 2, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -1100, right: 1100, top: 900, bottom: -900, near: 100, far: 3500 });
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 1.5;
    this.lights.add(key, key.target);
    // A soft fill from the front so the faces toward the camera never go flat black.
    const fill = new THREE.DirectionalLight(mix(theme.skyTop, '#ffffff', 0.6), night ? 0.4 : 0.7);
    fill.position.set(W / 2 + 600, H / 2, 1500);
    fill.target.position.set(W / 2, H / 2, 0);
    this.lights.add(fill, fill.target);
  }

  /** Rebuilds the ground slab from the terrain mask (after every blast). */
  private buildGround(terrain: Terrain, theme: Theme) {
    this.terrainVersion = terrain.version;
    if (this.ground) {
      this.scene.remove(this.ground);
      this.ground.geometry.dispose();
    }
    if (!this.groundTex || this.groundTex.image !== terrain.canvas) {
      this.groundTex?.dispose();
      this.groundTex = new THREE.CanvasTexture(terrain.canvas);
      this.groundTex.colorSpace = THREE.SRGBColorSpace;
      this.groundTex.repeat.set(1 / W, 1 / H);
      this.groundTex.anisotropy = 4;
    }
    this.groundTex.needsUpdate = true;

    // Loops from the mask, flipped to y-up; outer edges become shapes, the others their holes.
    const loops = traceMask(terrain.mask);
    const outers = loops.filter((l) => signedArea(l) < 0);
    const holes = loops.filter((l) => signedArea(l) >= 0);
    const shapes = outers.map((l) => ({ loop: l, shape: new THREE.Shape(l.map(([x, y]) => new THREE.Vector2(x, H - y))) }));
    for (const hole of holes) {
      const [hx, hy] = hole[0];
      // The smallest outline that contains the hole owns it.
      let best: (typeof shapes)[number] | null = null;
      for (const s of shapes)
        if (insideLoop(s.loop, hx, hy) && (!best || Math.abs(signedArea(s.loop)) < Math.abs(signedArea(best.loop)))) best = s;
      best?.shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, H - y))));
    }
    let geo: THREE.BufferGeometry = new THREE.ExtrudeGeometry(
      shapes.map((s) => s.shape),
      { depth: FRONT + BACK, bevelEnabled: false, curveSegments: 1, steps: 1 },
    );
    geo.translate(0, 0, -BACK);
    // Smooth over the small steps of the outline, keep the edge between the face and the walls sharp.
    geo = toCreasedNormals(geo, 1.0);
    paintWalls(geo, terrain);

    // alphaTest drops the see-through texels at the edge of the outline (they'd show as black).
    const front = new THREE.MeshStandardMaterial({ map: this.groundTex, roughness: 0.95, metalness: 0, alphaTest: 0.5 });
    const walls = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    this.ground = new THREE.Mesh(geo, [front, walls]);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  private placeTank(t: Tank3D) {
    if (!this.buckets || (!t.alive && t.drowned)) {
      const o = this.tanks.get(t);
      if (o) o.root.visible = false;
      return;
    }
    let o = this.tanks.get(t);
    if (!o) {
      o = this.buildTank(t);
      this.tanks.set(t, o);
    }
    o.root.visible = true;
    const u = t.model.geo.bodyW * 0.19; // world pixels per model unit, as for the 2D art
    const g = t.model.geo;
    const sx = g.barrelL / g.bodyW / (22 / 34), sy = g.barrelW / g.bodyW / (4 / 34);
    const dead = !t.alive;
    const tilt = t.tilt + (dead ? 0.15 : 0);
    const elev = dead ? -10 : t.elev;
    o.root.position.set(t.x, H - t.y, 0);
    o.root.rotation.set(0, 0, -tilt);
    o.root.scale.setScalar(u);
    // Turn round through the side facing the camera instead of flipping.
    const want = t.facing > 0 ? 0 : -Math.PI;
    o.heading += (want - o.heading) * 0.25;
    if (Math.abs(want - o.heading) < 0.01) o.heading = want;
    o.yaw.rotation.y = o.heading;
    o.barrel.rotation.z = (elev + t.facing * tilt * (180 / Math.PI)) * (Math.PI / 180);
    o.barrel.scale.set(sx, sy, sy);
    o.barrel.position.x = MESH.pivot[0] - t.recoil / u;
    o.paint.color.set(t.look.paint);
    o.root.traverse((c) => {
      if (c instanceof THREE.Mesh) c.material = dead ? this.wreck : c.userData.mat;
    });
  }

  /**
   * Where the middle of a tank's side panel shows on screen (world pixels), for drawing its
   * decal in 2D, and how much the camera enlarges it. Null while the tank is turning round.
   */
  decalSpot(t: Tank3D): { x: number; y: number; zoom: number } | null {
    const o = this.tanks.get(t);
    if (!o || !o.root.visible || !t.alive || Math.abs(o.heading - (t.facing > 0 ? 0 : -Math.PI)) > 0.02) return null;
    o.root.updateMatrixWorld(true);
    const p = o.yaw.localToWorld(new THREE.Vector3(-0.105, 1.44, 1.54));
    const zoom = DIST / (DIST - p.z);
    p.project(this.camera);
    return { x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H, zoom };
  }

  private buildTank(t: Tank3D) {
    const paint = new THREE.MeshStandardMaterial({ color: t.look.paint, roughness: 0.45, metalness: 0.2, flatShading: true });
    const mats = { paint, dark: this.dark, track: this.track };
    const root = new THREE.Group();
    const yaw = new THREE.Group();
    const hull = new THREE.Group();
    const barrel = new THREE.Group();
    barrel.position.set(MESH.pivot[0], MESH.pivot[1], MESH.pivot[2]);
    for (const b of this.buckets!) {
      const mesh = new THREE.Mesh(b.geo, mats[b.mat]);
      mesh.userData.mat = mats[b.mat];
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      (b.part === 'barrel' ? barrel : hull).add(mesh);
    }
    yaw.add(hull, barrel);
    root.add(yaw);
    this.scene.add(root);
    return { root, yaw, barrel, paint, heading: t.facing > 0 ? 0 : -Math.PI };
  }
}

function decodeMesh(buf: ArrayBuffer): Bucket[] {
  return MESH.buckets.map((b) => {
    const p16 = new Int16Array(buf, b.offset, b.vertices * 3);
    const i16 = new Uint16Array(buf, b.offset + b.vertices * 6, b.indices);
    const pos = new Float32Array(p16.length);
    for (let i = 0; i < p16.length; i++) pos[i] = p16[i] / MESH.quant;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(i16), 1));
    geo.computeVertexNormals();
    return { part: b.part as Bucket['part'], mat: b.mat as Bucket['mat'], geo };
  });
}

/**
 * Colours the extruded walls with the colour of the painted ground just inside the outline,
 * so grass tops stay grass, fresh craters show earth and scorch marks carry into the depth.
 */
function paintWalls(geo: THREE.BufferGeometry, terrain: Terrain) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3).fill(1);
  const walls = geo.groups.find((g) => g.materialIndex === 1);
  if (walls) {
    const px = terrain.ctx.getImageData(0, 0, W, H).data;
    const col = new THREE.Color();
    for (let i = walls.start; i < walls.start + walls.count; i++) {
      const x = pos.getX(i), y = H - pos.getY(i), z = pos.getZ(i);
      // Step inward (against the wall's outward normal) until we're on painted ground.
      const nx = nrm.getX(i), ny = -nrm.getY(i);
      // Average a few samples on painted ground, to smooth out the soil's speckle.
      let r = 0, g = 0, b = 0, n = 0;
      for (let d = 3; d <= 24 && n < 4; d += 3) {
        const sx = Math.min(W - 1, Math.max(0, Math.round(x - nx * d))), sy = Math.min(H - 1, Math.max(0, Math.round(y - ny * d)));
        const o = (sy * W + sx) * 4;
        if (px[o + 3] > 200) {
          r += px[o];
          g += px[o + 1];
          b += px[o + 2];
          n++;
        }
      }
      n = Math.max(1, n);
      col.setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
      // Undersides of overhangs sit in shadow; the back edge a little darker for depth.
      const shade = (nrm.getY(i) < -0.5 ? 0.55 : 1) * (0.82 + (0.18 * (z + BACK)) / (FRONT + BACK));
      col.multiplyScalar(shade).toArray(colors, i * 3);
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

const rgb = ([r, g, b]: [number, number, number]) => new THREE.Color(`rgb(${r},${g},${b})`);
const mix = (a: string, b: string, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), t);
