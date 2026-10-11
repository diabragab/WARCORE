/** Tiny synthesized sound effects; no audio files to ship. */
class Sfx {
  private ctx?: AudioContext;
  private out?: GainNode;
  private noiseBuf?: AudioBuffer;
  muted = false;

  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.out = this.ctx.createGain();
        this.out.gain.value = 0.45;
        this.out.connect(this.ctx.destination);
        const len = this.ctx.sampleRate;
        this.noiseBuf = this.ctx.createBuffer(1, len, len);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      } catch {
        return;
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  private ready() {
    return !this.muted && this.ctx && this.out && this.ctx.state === 'running';
  }

  private noise(dur: number, f0: number, f1: number, vol: number) {
    if (!this.ready()) return;
    const c = this.ctx!, now = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf!;
    const flt = c.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(f0, now);
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), now + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(flt).connect(g).connect(this.out!);
    src.start(now, Math.random() * 0.5, dur);
  }

  private tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number) {
    if (!this.ready()) return;
    const c = this.ctx!, now = c.currentTime;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, now);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), now + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    o.connect(g).connect(this.out!);
    o.start(now);
    o.stop(now + dur);
  }

  fire() { this.noise(0.22, 2400, 300, 0.5); this.tone(150, 45, 0.22, 'sine', 0.7); }
  boom(r: number) {
    const s = Math.min(1.8, 0.5 + r / 55);
    this.noise(0.35 + 0.3 * s, 1100, 60, 0.9);
    this.tone(95, 28, 0.35 * s + 0.1, 'sine', 0.9);
  }
  thud() { this.noise(0.25, 500, 80, 0.5); }
  splash() { this.noise(0.45, 3500, 500, 0.35); }
  bounce() { this.tone(420, 180, 0.09, 'square', 0.12); }
  click() { this.tone(820, 820, 0.035, 'square', 0.06); }
  coin() { this.tone(880, 1500, 0.14, 'triangle', 0.22); }
  tick() { this.tone(1200, 1200, 0.03, 'sine', 0.08); }
}

export const sfx = new Sfx();
