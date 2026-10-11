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
) {
  const g = model.geo;
  const paint = look.paint;
  const hw = g.bodyW / 2;
  const hullTop = -(g.treadH + g.bodyH);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);

  // Barrel keeps its world angle while the hull tilts with the ground.
  ctx.save();
  ctx.translate(0, -pivotHeight(model));
  ctx.rotate(-tilt + (facing > 0 ? -elev * D2R : Math.PI + elev * D2R));
  ctx.fillStyle = shade(paint, -0.45);
  ctx.fillRect(-recoil, -g.barrelW / 2, g.barrelL, g.barrelW);
  ctx.fillStyle = shade(paint, -0.6);
  ctx.fillRect(g.barrelL - 5 - recoil, -g.barrelW / 2 - 1, 5, g.barrelW + 2);
  ctx.restore();

  ctx.scale(facing, 1);

  // Turret dome
  ctx.fillStyle = shade(paint, -0.08);
  ctx.strokeStyle = shade(paint, -0.55);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(-1, hullTop, g.turretR, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = shade(paint, -0.35);
  ctx.fillRect(-4, hullTop - g.turretR - 2, 5, 2.5);

  // Hull
  ctx.fillStyle = paint;
  ctx.beginPath();
  ctx.moveTo(-hw, -g.treadH);
  ctx.lineTo(hw, -g.treadH);
  ctx.lineTo(hw - g.topInset * 0.6, hullTop);
  ctx.lineTo(-hw + g.topInset, hullTop);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = shade(paint, 0.35);
  ctx.beginPath();
  ctx.moveTo(-hw + g.topInset + 1, hullTop + 1.2);
  ctx.lineTo(hw - g.topInset * 0.6 - 1, hullTop + 1.2);
  ctx.stroke();

  drawDecal(ctx, look.decal, model, paint);

  // Tracks
  ctx.fillStyle = '#26282b';
  roundRect(ctx, -hw - 2, -g.treadH, g.bodyW + 4, g.treadH, g.treadH / 2);
  ctx.fill();
  const wheels = Math.max(3, Math.floor(g.bodyW / 8));
  ctx.fillStyle = '#5c6066';
  for (let i = 0; i < wheels; i++) {
    const wx = -hw + 2 + (i * (g.bodyW - 4)) / (wheels - 1);
    ctx.beginPath();
    ctx.arc(wx, -g.treadH / 2, g.treadH / 2 - 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawDecal(ctx: CanvasRenderingContext2D, decal: string, m: TankModel, paint: string) {
  const g = m.geo;
  const cy = -g.treadH - g.bodyH / 2;
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
