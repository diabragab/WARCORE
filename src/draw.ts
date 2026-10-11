import type { Look, TankModel } from './data';

export const D2R = Math.PI / 180;

export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt),
  );
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

/** Height of the barrel pivot above the tank's base point. */
export const pivotHeight = (m: TankModel) => m.geo.treadH + m.geo.bodyH + m.geo.turretR * 0.45;

export function drawTank(
  ctx: CanvasRenderingContext2D,
  model: TankModel,
  look: Look,
  x: number,
  y: number,
  tilt: number,
  elev: number,
  facing: number,
  recoil = 0,
  trackPhase = 0,
) {
  const g = model.geo;
  const paint = look.paint;
  const hw = g.bodyW / 2;
  const hullTop = -(g.treadH + g.bodyH);
  const dark = shade(paint, -0.55);

  // Contact shadow on the ground (not tilted)
  ctx.save();
  const sh = ctx.createRadialGradient(x, y + 1, 1, x, y + 1, hw + 6);
  sh.addColorStop(0, 'rgba(0,0,0,0.45)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh;
  ctx.beginPath();
  ctx.ellipse(x, y + 1, hw + 6, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);

  // Barrel keeps its world angle while the hull tilts with the ground.
  ctx.save();
  ctx.translate(0, -pivotHeight(model));
  ctx.rotate(-tilt + (facing > 0 ? -elev * D2R : Math.PI + elev * D2R));
  const bw = g.barrelW;
  const bg = ctx.createLinearGradient(0, -bw / 2, 0, bw / 2);
  bg.addColorStop(0, shade(paint, -0.15));
  bg.addColorStop(0.35, shade(paint, 0.25));
  bg.addColorStop(1, shade(paint, -0.6));
  ctx.fillStyle = bg;
  ctx.fillRect(-recoil, -bw / 2, g.barrelL, bw);
  // fume extractor and muzzle brake
  ctx.fillRect(g.barrelL * 0.45 - recoil, -bw / 2 - 1, bw * 1.6, bw + 2);
  ctx.fillStyle = shade(paint, -0.65);
  ctx.fillRect(g.barrelL - bw * 1.4 - recoil, -bw / 2 - 1.3, bw * 1.4, bw + 2.6);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(g.barrelL - bw * 0.9 - recoil, -bw / 2 - 1.3, 1, bw + 2.6);
  ctx.restore();

  ctx.scale(facing, 1);
  ctx.lineJoin = 'round';

  // Turret: angular modern shape
  const tr = g.turretR;
  const tg = ctx.createLinearGradient(0, hullTop - tr, 0, hullTop);
  tg.addColorStop(0, shade(paint, 0.22));
  tg.addColorStop(1, shade(paint, -0.25));
  ctx.fillStyle = tg;
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-tr * 1.7, hullTop);
  ctx.lineTo(-tr * 1.5, hullTop - tr * 0.9);
  ctx.lineTo(tr * 0.6, hullTop - tr * 1.0);
  ctx.lineTo(tr * 1.45, hullTop - tr * 0.4);
  ctx.lineTo(tr * 1.4, hullTop);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // turret bustle line + highlight
  ctx.strokeStyle = shade(paint, 0.4);
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.moveTo(-tr * 1.1, hullTop - tr * 0.8);
  ctx.lineTo(tr * 0.5, hullTop - tr * 0.9);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // commander cupola and antenna
  ctx.fillStyle = shade(paint, -0.2);
  ctx.beginPath();
  ctx.ellipse(-tr * 0.5, hullTop - tr * 0.95, tr * 0.38, tr * 0.22, 0, Math.PI, 0);
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,20,20,0.75)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(-tr * 1.0, hullTop - tr * 0.8);
  ctx.quadraticCurveTo(-tr * 1.3, hullTop - tr * 1.6, -tr * 1.6, hullTop - tr * 2.1);
  ctx.stroke();
  ctx.fillStyle = '#ff3b2a';
  ctx.fillRect(-tr * 1.6 - 0.8, hullTop - tr * 2.1 - 0.8, 1.6, 1.6);

  // Hull with sloped glacis
  const hg = ctx.createLinearGradient(0, hullTop, 0, -g.treadH);
  hg.addColorStop(0, shade(paint, 0.18));
  hg.addColorStop(0.5, paint);
  hg.addColorStop(1, shade(paint, -0.35));
  ctx.fillStyle = hg;
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-hw - 1, -g.treadH + 1);
  ctx.lineTo(hw + 3, -g.treadH + 1);
  ctx.lineTo(hw - g.topInset * 0.2, hullTop + g.bodyH * 0.35);
  ctx.lineTo(hw - g.topInset * 0.9, hullTop);
  ctx.lineTo(-hw + g.topInset * 0.6, hullTop);
  ctx.lineTo(-hw - 1, hullTop + g.bodyH * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // top highlight and panel line
  ctx.strokeStyle = shade(paint, 0.45);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-hw + g.topInset * 0.6 + 1, hullTop + 1);
  ctx.lineTo(hw - g.topInset * 0.9 - 1, hullTop + 1);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.moveTo(-hw + 2, hullTop + g.bodyH * 0.55);
  ctx.lineTo(hw - 2, hullTop + g.bodyH * 0.55);
  ctx.stroke();

  drawDecal(ctx, look.decal, model, paint);

  // Side skirt over the top of the tracks, with rivets
  const skY = -g.treadH - 1;
  ctx.fillStyle = shade(paint, -0.3);
  ctx.fillRect(-hw - 1, skY, g.bodyW + 3, 3);
  ctx.fillStyle = shade(paint, 0.3);
  for (let rx = -hw + 2; rx < hw; rx += 5) ctx.fillRect(rx, skY + 1, 1, 1);

  // Tracks
  const tg2 = ctx.createLinearGradient(0, -g.treadH, 0, 0);
  tg2.addColorStop(0, '#3b3d41');
  tg2.addColorStop(1, '#141517');
  ctx.fillStyle = tg2;
  roundRect(ctx, -hw - 3, -g.treadH + 2, g.bodyW + 6, g.treadH - 2, (g.treadH - 2) / 2);
  ctx.fill();
  // moving track links
  ctx.save();
  roundRect(ctx, -hw - 3, -g.treadH + 2, g.bodyW + 6, g.treadH - 2, (g.treadH - 2) / 2);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  const link = 3;
  const off = (((trackPhase * facing) % link) + link) % link;
  for (let lx = -hw - 3 + off; lx < hw + 3; lx += link) {
    ctx.fillRect(lx, -g.treadH + 2, 1, 1.4);
    ctx.fillRect(lx, -1.4, 1, 1.4);
  }
  ctx.restore();
  // road wheels
  const wheels = Math.max(4, Math.floor(g.bodyW / 8));
  const wr = (g.treadH - 2) / 2 - 1;
  for (let i = 0; i < wheels; i++) {
    const wx = -hw + 1 + (i * (g.bodyW - 2)) / (wheels - 1);
    const wy = -(g.treadH - 2) / 2;
    const r = i === 0 || i === wheels - 1 ? wr * 0.85 : wr;
    const wg = ctx.createRadialGradient(wx - r * 0.3, wy - r * 0.3, 0.5, wx, wy, r);
    wg.addColorStop(0, '#9aa0a6');
    wg.addColorStop(1, '#3d4146');
    ctx.fillStyle = wg;
    ctx.beginPath();
    ctx.arc(wx, wy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#26282b';
    ctx.beginPath();
    ctx.arc(wx, wy, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawDecal(ctx: CanvasRenderingContext2D, decal: string, m: TankModel, paint: string) {
  const g = m.geo;
  const cy = -g.treadH - g.bodyH * 0.45;
  const light = '#f2ead2';
  ctx.save();
  switch (decal) {
    case 'star': {
      const r = g.bodyH * 0.42;
      ctx.fillStyle = light;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? r * 0.45 : r;
        ctx.lineTo(Math.cos(a) * rr - 2, cy + Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'stripes':
      ctx.fillStyle = light;
      ctx.fillRect(-g.bodyW / 2 + 3, cy - 2.5, g.bodyW - 6, 1.6);
      ctx.fillRect(-g.bodyW / 2 + 3, cy + 0.8, g.bodyW - 6, 1.6);
      break;
    case 'chevron':
      ctx.strokeStyle = '#f0c040';
      ctx.lineWidth = 1.8;
      for (const off of [-4, 1]) {
        ctx.beginPath();
        ctx.moveTo(off - 3, cy - 3);
        ctx.lineTo(off, cy);
        ctx.lineTo(off - 3, cy + 3);
        ctx.stroke();
      }
      break;
    case 'flames': {
      const colors = ['#ffcf3f', '#ff7a1a', '#e2361b'];
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = colors[i];
        ctx.beginPath();
        const x0 = g.bodyW / 2 - 3 - i * 2;
        ctx.moveTo(x0, cy + 4);
        ctx.quadraticCurveTo(x0 - 6, cy + 1, x0 - 16 + i * 3, cy - 4 + i);
        ctx.quadraticCurveTo(x0 - 8, cy - 1, x0, cy - 3);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'skull':
      ctx.fillStyle = light;
      ctx.beginPath();
      ctx.arc(-2, cy - 0.5, g.bodyH * 0.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-4, cy + 1.5, 4, 2.5);
      ctx.fillStyle = shade(paint, -0.6);
      ctx.fillRect(-4, cy - 1.5, 1.6, 1.6);
      ctx.fillRect(-1.6, cy - 1.5, 1.6, 1.6);
      break;
    case 'crown': {
      const w = g.bodyH * 1.1, h = g.bodyH * 0.55;
      ctx.fillStyle = '#f2c84b';
      ctx.strokeStyle = '#8a6514';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-w / 2 - 2, cy + h / 2);
      ctx.lineTo(-w / 2 - 2, cy - h / 2);
      ctx.lineTo(-w / 4 - 2, cy);
      ctx.lineTo(-2, cy - h / 2 - 1.5);
      ctx.lineTo(w / 4 - 2, cy);
      ctx.lineTo(w / 2 - 2, cy - h / 2);
      ctx.lineTo(w / 2 - 2, cy + h / 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Colour of a trail dot for a given cosmetic; i is the dot index from the head. */
export function trailColor(trail: string, i: number, t: number, alpha: number): string {
  switch (trail) {
    case 'fire': return `hsla(${40 - i * 1.4},100%,${60 - i * 0.6}%,${alpha})`;
    case 'plasma': return `hsla(${185 + i * 2},100%,65%,${alpha})`;
    case 'sparkle': return `hsla(48,100%,${70 + Math.sin(i + t * 20) * 20}%,${alpha})`;
    case 'rainbow': return `hsla(${(i * 14 + t * 240) % 360},90%,60%,${alpha})`;
    default: return `rgba(225,225,220,${alpha * 0.8})`;
  }
}
