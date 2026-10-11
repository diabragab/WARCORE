import type { NetMsg, PlayerSetup } from './game';
import type { Look } from './data';
import { sfx } from './sfx';

export interface OnlineStart {
  seed: number;
  theme: string;
  first: number;
  you: number;
  players: Omit<PlayerSetup, 'color'>[];
}

interface Hooks {
  info: () => { name: string; model: string; look: Look; weapons: string[] };
  start: (s: OnlineStart) => void;
  message: (m: NetMsg) => void;
  opponentLeft: () => void;
  rematchOffered: () => void;
  lost: () => void;
}

export const NAME_KEY = 'tanks.name';
const SERVER_KEY = 'tanks.server';
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
  return null;
}

/** Where the match server lives: same site when the server hosts the game, otherwise a configured address. */
function defaultServer(): string {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_SERVER_URL;
  if (env) return env;
  const { protocol, host, hostname, port } = location;
  const servedByUs = protocol.startsWith('http') && port !== '5173' && hostname !== 'tauri.localhost' && !hostname.endsWith('claude.ai') && !hostname.endsWith('claudeusercontent.com');
  if (servedByUs) return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}`;
  return 'ws://localhost:8787';
}

/** True inside a sandboxed preview page (for example a shared link) that blocks WebSockets. */
export function inPreview(): boolean {
  const { hostname, protocol } = location;
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === 'tauri.localhost' || protocol === 'tauri:' || protocol === 'file:';
  return !local && /claude/.test(hostname);
}

/** The game server's web address (for accounts), derived from the match server address. */
export function serverHttp(): string {
  return (store(SERVER_KEY) ?? defaultServer()).replace(/^ws/, 'http').replace(/\/+$/, '');
}

/** Lobby UI plus the WebSocket connection to the match server. */
export class Online {
  private ws: WebSocket | null = null;
  private inGame = false;

  constructor(private hooks: Hooks) {
    $('#on-quick').onclick = () => this.quick();
    $('#on-cancel').onclick = () => {
      this.leave();
      this.view('idle');
      this.status('');
    };
    $('#on-create').onclick = () => this.connect({ t: 'create' });
    $('#on-join').onclick = () => this.join();
    $<HTMLInputElement>('#on-code').onkeydown = (e) => e.key === 'Enter' && this.join();
    $('#on-back').onclick = () => {
      this.leave();
      $('#online').hidden = true;
      $('#menu').hidden = false;
    };
  }

  get name(): string {
    return $<HTMLInputElement>('#on-name').value.trim() || 'Commander';
  }

  /** Opening Online goes straight into matchmaking. */
  open() {
    this.leave();
    let name = store(NAME_KEY);
    if (!name) {
      name = `Tanker${Math.floor(1000 + Math.random() * 9000)}`;
      store(NAME_KEY, name);
    }
    $<HTMLInputElement>('#on-name').value = name;
    $<HTMLInputElement>('#on-server').value = store(SERVER_KEY) ?? defaultServer();
    $('#on-pick').hidden = false;
    $('#on-wait').hidden = true;
    if (inPreview()) {
      this.view('idle');
      this.status("This shared preview can't open network connections, so online matches work in the Windows app or on war-core.online.", true);
    } else this.quick();
  }

  private view(v: 'idle' | 'search') {
    $('#on-idle').hidden = v !== 'idle';
    $('#on-search').hidden = v !== 'search';
  }

  private quick() {
    this.view('search');
    $('#on-count').textContent = 'Connecting to the server…';
    this.connect({ t: 'quick' });
  }

  private status(text: string, error = false) {
    const el = $('#on-status');
    el.textContent = text;
    el.classList.toggle('error', error);
  }

  private join() {
    const code = $<HTMLInputElement>('#on-code').value.trim().toUpperCase();
    if (code.length !== 4) return this.status('Room codes are 4 letters, like KXQP.', true);
    this.connect({ t: 'join', code });
  }

  private connect(first: { t: 'quick' } | { t: 'create' } | { t: 'join'; code: string }) {
    if (first.t !== 'quick') this.view('idle');
    this.leave();
    store(NAME_KEY, this.name);
    const url = $<HTMLInputElement>('#on-server').value.trim();
    if (url !== defaultServer()) store(SERVER_KEY, url);
    this.status(first.t === 'quick' ? '' : 'Connecting…');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.status(`That server address doesn't look right: ${url}`, true);
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      if (first.t !== 'quick') this.status(first.t === 'create' ? 'Creating a room…' : 'Joining…');
      ws.send(JSON.stringify({ ...first, info: this.hooks.info() }));
    };
    ws.onmessage = (ev) => this.receive(JSON.parse(ev.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.view('idle');
      if (!opened) this.status(`Couldn't reach the match server at ${url}. Check the address under "Server address".`, true);
      else if (this.inGame) this.hooks.lost();
      else this.status('Disconnected from the match server.', true);
      this.inGame = false;
    };
  }

  private receive(m: { t: string; [k: string]: unknown }) {
    switch (m.t) {
      case 'queued': {
        const n = Number(m.online) || 1;
        $('#on-count').textContent = n > 1 ? `${n} players online. You'll be matched with the next player who searches.` : "You're the only one searching right now. The match starts as soon as someone else joins.";
        break;
      }
      case 'created':
        $('#on-pick').hidden = true;
        $('#on-wait').hidden = false;
        $('#on-room').textContent = String(m.code);
        this.status('Waiting for your friend to join…');
        break;
      case 'error':
        this.status(String(m.message), true);
        break;
      case 'start':
        this.inGame = true;
        sfx.coin();
        this.hooks.start(m as unknown as OnlineStart);
        break;
      case 'relay':
        this.hooks.message(m.data as NetMsg);
        break;
      case 'left':
        this.inGame = false;
        this.hooks.opponentLeft();
        break;
      case 'rematch-offer':
        this.hooks.rematchOffered();
        break;
    }
  }

  relay(data: NetMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'relay', data }));
  }

  rematch() {
    this.ws?.send(JSON.stringify({ t: 'rematch' }));
  }

  leave() {
    const ws = this.ws;
    this.ws = null;
    this.inGame = false;
    ws?.close();
  }
}
