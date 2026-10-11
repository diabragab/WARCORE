// Renders art/tank/tank_separete.3ds into the tank sprite sheet the game draws:
//   src/assets/tank3d.png   lit parts (paint rendered white) on top, paint masks below
//   src/assets/tank3d.json  where each part sits in the sheet, plus anchor points
// Usage: cd tools/tank-art && npm install && npm run build
// Needs Playwright with Chromium. Set PLAYWRIGHT_MODULE to its index.mjs if it isn't installed here.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

// Material colours from the Cycles shaders in tank_separete.blend (linear RGB).
// The model holds four copies of the tank; we use the red one (Material.016 is its paint).
const MATS = {
  'Material.016': { c: [0.8, 0.8, 0.8], rough: 0.45, metal: 0.2 }, // paint, tinted in game
  'Material.006': { c: [0.052, 0.042, 0.07], rough: 0.5, metal: 0.35 }, // dark metal
  'Material.019': { c: [0.168, 0.168, 0.168], rough: 0.6, metal: 0.1 }, // tracks, antenna
};
const PAINT = 'Material.016';
// Side view, looking slightly down so the turret top shows.
const DIR = [0, 1, -0.22];
const PPU = 40;
// World points (model units) we need in sprite pixels.
const ANCHORS = {
  base: [1.505, -4.5, -0.14], // ground contact, middle of the tracks
  pivot: [2.84, -3.505, 4.26], // barrel hinge, inside the mantlet
  muzzle: [4.93, -3.505, 4.26],
  top: [1.1, -3.5, 5.54], // turret roof
  panel: [1.4, -5.06, 1.3], // middle of the hull's side panel, for decals
  panelL: [-0.55, -5.06, 1.3],
  panelR: [3.35, -5.06, 1.3],
  panelT: [1.4, -5.06, 2.0],
};

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = http
  .createServer((req, res) => {
    const file = path.join(repo, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(repo)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }).end(data);
    });
  })
  .listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.goto(`http://127.0.0.1:${port}/tools/tank-art/index.html`);
await page.waitForFunction(() => window.ready);
const objects = await page.evaluate((u) => window.load(u), '/art/tank/tank_separete.3ds');

// Pick the red tank's meshes and split them: barrel, turret (everything on top of the hull), body.
const red = objects.filter((o) => o.min[1] > -6.4 && o.max[1] < -0.6 && !o.name.startsWith('Plane'));
const barrel = red.filter((o) => Math.abs(o.min[0] - 2.29) < 0.05).map((o) => o.name);
const turret = red.filter((o) => !barrel.includes(o.name) && o.min[2] >= 2.5 && o.min[0] >= -1).map((o) => o.name);
const body = red.filter((o) => !barrel.includes(o.name) && !turret.includes(o.name)).map((o) => o.name);

const { png, meta } = await page.evaluate((cfg) => window.sheet(cfg), {
  mats: MATS,
  paint: PAINT,
  dir: DIR,
  ppu: PPU,
  anchors: ANCHORS,
  parts: [
    { name: 'body', meshes: body },
    // The hull hides the bottom of the turret ring.
    { name: 'turret', meshes: turret, occluders: body },
    { name: 'barrel', meshes: barrel },
  ],
});
fs.writeFileSync(path.join(repo, 'src/assets/tank3d.png'), Buffer.from(png.split(',')[1], 'base64'));
fs.writeFileSync(path.join(repo, 'src/assets/tank3d.json'), JSON.stringify(meta, null, 1) + '\n');
console.log('body', body.length, 'turret', turret.length, 'barrel', barrel.length, 'meshes');
console.log(JSON.stringify(meta.parts, null, 1));
await browser.close();
server.close();
