# Tanks

Worms-style turn-based artillery. Runs in the browser and as a desktop app (Tauri, no Electron).

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

Deploy: `Dockerfile` runs it anywhere that runs containers; `render.yaml` sets it up on Render's free tier.
The desktop app and other builds find the server through `VITE_SERVER_URL` at build time
(for example `VITE_SERVER_URL=wss://tanks.onrender.com npm run tauri build`). Players can also type an address
under "Server address" in the lobby.

How turns stay in sync: the player whose turn it is runs that turn. Their device streams its aim, sends the exact
shot, and once everything settles sends the resulting tank state and terrain, so both screens agree before the next turn.

## Desktop app (Tauri 2)

Needs Rust (https://rustup.rs) plus the platform prerequisites from https://tauri.app/start/prerequisites/.

```sh
npm run tauri dev    # desktop window with hot reload
npm run tauri build  # installers in src-tauri/target/release/bundle/
```

`.github/workflows/desktop.yml` builds Windows, macOS and Linux installers on GitHub once this lives in a repo
(push a `v*` tag or run it by hand).

## Layout

- `src/game.ts`: match simulation, physics, AI, rendering
- `src/terrain.ts`: bitmap terrain and themes
- `src/data.ts`: weapons, tank models, cosmetics and prices
- `src/main.ts`: menus, setup, shop, input
- `src/online.ts`: online lobby and connection
- `server/`: match server
- `src-tauri/`: desktop wrapper
