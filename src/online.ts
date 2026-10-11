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

const NAME_KEY = 'tanks.name';
const SERVER_KEY = 'tanks.server';
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function store(key: string, value?: string): string | null {
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
function inPreview(): boolean {
  const { hostname, protocol } = location;
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === 'tauri.localhost' || protocol === 'tauri:' || protocol === 'file:';
  return !local && /claude/.test(hostname);
}

/** Lobby UI plus the WebSocket connection to the match server. */
export class Online {
  private ws: WebSocket | null = null;
  private inGame = false;

  constructor(private hooks: Hooks) {
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

  open() {
    this.leave();
    $<HTMLInputElement>('#on-name').value = store(NAME_KEY) ?? '';
    $<HTMLInputElement>('#on-server').value = store(SERVER_KEY) ?? defaultServer();
    $('#on-pick').hidden = false;
    $('#on-wait').hidden = true;
    this.status(
      inPreview()
        ? "This shared preview can't open network connections, so online matches work in the desktop app or on the hosted game site."
        : '',
    );
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

  private connect(first: { t: 'create' } | { t: 'join'; code: string }) {
    this.leave();
    store(NAME_KEY, this.name);
    const url = $<HTMLInputElement>('#on-server').value.trim();
    if (url !== defaultServer()) store(SERVER_KEY, url);
    this.status('Connecting…');
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
      this.status(first.t === 'create' ? 'Creating a room…' : 'Joining…');
      ws.send(JSON.stringify({ ...first, info: this.hooks.info() }));
    };
    ws.onmessage = (ev) => this.receive(JSON.parse(ev.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!opened) this.status(`Couldn't reach the match server at ${url}. Check the address under "Server address".`, true);
      else if (this.inGame) this.hooks.lost();
      else this.status('Disconnected from the match server.', true);
      this.inGame = false;
    };
  }

  private receive(m: { t: string; [k: string]: unknown }) {
    switch (m.t) {
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
