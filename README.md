# WARCORE

Worms-style turn-based artillery. Runs in the browser and as a Windows app (Tauri, no Electron).

## What's in it

- Destructible terrain, wind, fall damage, knockback and water you can drown in
- Play vs Computer (Recruit / Sergeant / General) and two players on one keyboard
- Seven weapons: Shell, Heavy Shell, Dirt Ball, Bouncer, Triple Shot, Cluster Bomb, Mega Nuke
- Garage & Shop: earn coins from matches, buy tanks (Patton, Jackal, Longbow, Bastion),
  weapons, paint, decals and shell trails. Progress is saved in the browser (localStorage).
- Online match: one player creates a room and shares the 4-letter code, the other joins with it

## Controls

← → drive (uses fuel) · ↑ ↓ aim · hold Space to charge, release to fire · Q / E or 1–7 switch weapon · Esc pause.
Touch screens get on-screen buttons.

## Develop

```sh
npm install
npm run dev          # http://localhost:5173
npm run build        # web build in dist/
npm run build:web    # one self-contained HTML file in dist-single/
```

## Online match server

`server/index.mjs` pairs players by room code and relays turns over WebSockets. It also serves the built web game,
so one deploy hosts both.

```sh
npm run build && npm run server   # http://localhost:8787, online play works between browsers on that address
```

Deploy on your own Linux server (Ubuntu/Debian). Point the domain's DNS A record at the server, then as root:

```sh
curl -fsSL https://raw.githubusercontent.com/diabragab/tanks/main/deploy/install.sh | DOMAIN=war-core.online sh
```

The installer checks whether the server already hosts websites:

- Nothing on ports 80/443: the game runs behind its own Caddy, which gets the HTTPS certificate.
- nginx or Apache already on 80/443 (other sites or games on the same machine): the game listens on
  `127.0.0.1:8787`, and the script adds one new site for the domain to your web server and gets a certificate
  with certbot. Your other sites keep working. Use `WARCORE_PORT=<port>` if 8787 is taken.

Windows server with IIS already hosting a website: open PowerShell as Administrator and run

```powershell
$env:DOMAIN='war-core.online'; irm https://raw.githubusercontent.com/diabragab/tanks/main/deploy/install-windows.ps1 | iex
```

It installs Node.js, builds the game into `C:\warcore`, runs it on `127.0.0.1:8787` as a startup task, and adds an
IIS site bound to the domain that forwards to it (URL Rewrite + ARR + WebSockets). Add HTTPS with win-acme.

Run the same command again to update. The Windows build connects to `wss://war-core.online` unless the repo
variable `WARCORE_SERVER_URL` says otherwise.

That installs Docker if needed and runs the game behind Caddy, which handles HTTPS once a domain is set. To redeploy on every push to
`main`, add repo secrets `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_SSH_KEY` (see `.github/workflows/deploy.yml`).

Other hosts: `Dockerfile` runs it anywhere that runs containers; `render.yaml` sets it up on Render's free tier.
The desktop app and other builds find the server through `VITE_SERVER_URL` at build time
(for example `VITE_SERVER_URL=wss://tanks.onrender.com npm run tauri build`). Players can also type an address
under "Server address" in the lobby.

How turns stay in sync: the player whose turn it is runs that turn. Their device streams its aim, sends the exact
shot, and once everything settles sends the resulting tank state and terrain, so both screens agree before the next turn.

## Accounts and coin purchases (Whop)

Players sign in (or create an account) before playing. Accounts live in `DATA_DIR/accounts.json` on the server
(`C:\warcore\data` on the Windows server, a Docker volume otherwise), with scrypt-hashed passwords.

Coin packs are sold through Whop checkout (`server/payments.mjs`, packs and prices at the top). The server creates a
one-time checkout per purchase, and Whop's signed `payment.succeeded` webhook credits the coins (the server re-reads the
payment from Whop before crediting, once per payment). Purchases stay hidden until these are set. On the Windows server,
put them in `C:\warcore\secrets.cmd`:

```bat
set WHOP_API_KEY=...
set WHOP_COMPANY_ID=biz_...
set WHOP_WEBHOOK_SECRET=ws_...
set WHOP_SANDBOX=1
```

then restart the `WARCORE` scheduled task. In Whop, create a webhook for `https://war-core.online/api/whop/webhook`
with payment (and refund) events. Remove `WHOP_SANDBOX` to take real payments.

VIP is a monthly Whop membership ($4.99, set in `shared/catalog.json`). Each paid month adds 31 VIP days to the
account (renewals are matched to the account through the Whop membership id), and a refund takes them away. VIP doubles
coins from matches, missions and the daily reward, unlocks the VIP paint and decal, and shows a VIP badge.

The Game Pass is a one-time Whop payment (€50, `pass` in `shared/catalog.json`; its plan is created in euros while the
packs and VIP stay in dollars). It sets `pass` on the account, which unlocks every item in the catalog, including ones
added later, and counts as VIP for life. A refund removes it. Pass owners can't open another checkout, since there is
nothing left for them to buy.

Every payment and refund is appended to `DATA_DIR/purchases.log` (one JSON line each). Accounts named in
`ADMIN_USERS` (comma separated, e.g. `set ADMIN_USERS=diab` in `secrets.cmd`) see a "Purchase log" button on their
account screen.

## Economy, missions and ranks

The server decides every coin (`server/economy.mjs`); the game only asks. Prices live in `shared/catalog.json`, which
both the game and the server read. Matches against the computer, two-player games and arcade waves are opened with
`match/start` and paid on `match/finish` with server-side formulas, minimum match lengths, damage caps and a daily cap
on match coins. Online matches are paid by the match server once both players' reports agree (a player who leaves
loses). Quick online matches are ranked: Elo from 1000 (K=32), Bronze to Diamond, pairing players with close ratings
first. Each player also gets a daily reward (with a streak) and three daily missions. `GET /api/leaderboard` feeds the
leaderboard screen and the landing page.

## Tank art

Tanks are drawn from `src/assets/tank3d.png`, rendered from the low-poly 3D tank in `art/tank/` (`tank_separete.blend`,
exported as `.3ds`). The sheet holds the body, turret and barrel, lit with the paint in white, plus each part's paint
mask; the game tints the paint to the player's colour and aims the barrel. Each model scales the art to its hull width
and stretches the gun to its barrel length. To re-render after changing the model:

```sh
cd tools/tank-art && npm install && npm run build   # writes src/assets/tank3d.png and tank3d.json
```

The tool needs Playwright with Chromium (set `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` if they aren't installed there).

### 3D look

By default the ground and tanks are drawn in 3D with three.js (`src/render3d.ts`); Settings > Graphics switches back
to the classic 2D drawing. The game itself is unchanged: everything still happens on the flat gameplay plane, and the
camera looks at that plane square-on from above with an off-centre lens, so shells, explosions and labels (still drawn
in 2D) line up with the 3D scene. The ground is the terrain outline (`src/terrain3d.ts`, marching squares) extruded
into a slab and rebuilt after every blast; its face shows the painted 2D terrain. The tank is a simplified copy of the
model, made with `node tools/tank-art/mesh.mjs` (writes `src/assets/tank3d-mesh.*`).

## Desktop app (Tauri 2)

Needs Rust (https://rustup.rs) plus the platform prerequisites from https://tauri.app/start/prerequisites/.

```sh
npm run tauri dev    # desktop window with hot reload
npm run tauri build  # installers in src-tauri/target/release/bundle/
```

`.github/workflows/desktop.yml` builds the Windows installer (.msi and setup .exe) on GitHub on every push to `main`;
download it from the run's artifacts. Pushing a `v*` tag (e.g. `v0.1.0`) also publishes it as a GitHub Release. Set the repo variable `WARCORE_SERVER_URL` (e.g. `wss://warcore.example.com`)
so the Windows app connects to your server for online play.

## Layout

- `src/game.ts`: match simulation, physics, AI, rendering
- `src/terrain.ts`: bitmap terrain and themes
- `src/data.ts`: weapons, tank models and cosmetics
- `src/draw.ts`: 2D tank drawing (`src/assets/tank3d.*`, made by `tools/tank-art` from `art/tank`)
- `src/render3d.ts`, `src/terrain3d.ts`: the 3D look (three.js)
- `shared/catalog.json`: prices, VIP items, maps and ranks (read by the game and the server)
- `src/main.ts`: menus, setup, shop, input
- `src/online.ts`: online lobby and connection
- `server/`: match server (`index.mjs`), accounts, economy, Whop payments
- `src-tauri/`: desktop wrapper
