// Drawing and timing helpers for the promo renderer. Everything is a pure
// function of time so any frame can be rendered independently.

export const W = 1920, H = 1080;

// Palette follows the viewer's own identity (src/viewer/style.css).
export const C = {
  bg: '#03070c', bg2: '#060d16', panel: '#091521', line: '#24445d', steel: '#345069', ice: '#73accb',
  gold: '#e4bd7c', goldHi: '#f3d7a4', goldLo: '#8f6f3e', text: '#e5eef6', muted: '#8daac1', dim: '#4d6478',
  ok: '#7fe0a6', bad: '#ff5d5d', cyan: '#7fd3ff',
};

export const FONT = {
  title: '"Avenir Next", "Helvetica Neue", Arial, sans-serif',
  cond: '"Avenir Next Condensed", "Avenir Next", Arial, sans-serif',
  mono: '"Berkeley Mono", "IntelOne Mono", Menlo, monospace',
  din: '"DIN Condensed", "Avenir Next Condensed", sans-serif',
};

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const inv = (a, b, x) => clamp((x - a) / (b - a));
export const ease = {
  linear: t => t,
  inOut: t => t * t * (3 - 2 * t),
  out3: t => 1 - Math.pow(1 - t, 3),
  in3: t => t * t * t,
  out5: t => 1 - Math.pow(1 - t, 5),
  inOut3: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  outBack: t => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
  expo: t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
};
// Progress of `t` through [a, b] with easing.
export const prog = (t, a, b, e = ease.out3) => e(inv(a, b, t));
// Fade in over [a, a+fi] and out over [b-fo, b].
export const window01 = (t, a, b, fi = 0.4, fo = 0.4) => Math.min(inv(a, a + fi, t), 1 - inv(b - fo, b, t));

// Deterministic hash noise.
export function hash(n) {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return s / 4294967296; };
}

export function rgba(hex, a = 1) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

export function font(ctx, size, family = FONT.title, weight = 600, spacing = 0) {
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.letterSpacing = `${spacing}px`;
}

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+=<>/\\|[]{}';
// Text that resolves from scrambled glyphs, left to right, over progress p.
export function decode(text, p, seed = 1, spread = 0.35) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const at = (i / Math.max(1, text.length)) * (1 - spread);
    if (c === ' ' || p >= at + spread) out += c;
    else if (p < at) out += ' ';
    else out += GLYPHS[Math.floor(hash(seed * 131 + i * 17 + Math.floor(p * 40)) * GLYPHS.length)];
  }
  return out;
}
// Typewriter: first n characters by progress.
export const typed = (text, p) => text.slice(0, Math.floor(clamp(p) * text.length + 1e-6));

export function glowText(ctx, text, x, y, color, blur = 18, alpha = 0.55) {
  ctx.save();
  ctx.shadowColor = rgba(color, alpha);
  ctx.shadowBlur = blur;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// HUD-style corner brackets around a rect, drawn on with progress p.
export function brackets(ctx, x, y, w, h, p = 1, color = C.gold, len = 26, width = 2) {
  if (p <= 0) return;
  const l = len * clamp(p);
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha *= clamp(p * 1.5);
  ctx.beginPath();
  ctx.moveTo(x, y + l); ctx.lineTo(x, y); ctx.lineTo(x + l, y);
  ctx.moveTo(x + w - l, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + l);
  ctx.moveTo(x + w, y + h - l); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - l, y + h);
  ctx.moveTo(x + l, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - l);
  ctx.stroke();
  ctx.restore();
}

// Draw an image covering a rect with a Ken Burns zoom/pan (z: scale, px/py: pan -1..1).
export function cover(ctx, img, x, y, w, h, z = 1, px = 0, py = 0) {
  if (!img) return;
  const iw = img.width, ih = img.height;
  const s = Math.max(w / iw, h / ih) * z;
  const dw = iw * s, dh = ih * s;
  const dx = x + (w - dw) / 2 + px * (dw - w) / 2, dy = y + (h - dh) / 2 + py * (dh - h) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// Faint dotted grid with slow drift.
export function grid(ctx, t, alpha = 0.18, step = 48) {
  ctx.save();
  ctx.fillStyle = rgba(C.steel, alpha);
  const ox = (t * 6) % step, oy = (t * 3) % step;
  for (let y = -step + oy; y < H + step; y += step)
    for (let x = -step + ox; x < W + step; x += step) ctx.fillRect(x, y, 2, 2);
  ctx.restore();
}

export function number(n) { return Math.round(n).toLocaleString('en-US'); }

// Small uppercase label with a gold tick, e.g. section tags.
export function tag(ctx, text, x, y, alpha = 1, color = C.gold) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y - 13, 3, 16);
  font(ctx, 17, FONT.mono, 500, 3.2);
  ctx.fillStyle = C.muted;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x + 16, y);
  ctx.restore();
}

export class ImageCache {
  constructor(limit = 400) { this.map = new Map(); this.limit = limit; }
  async get(url) {
    if (this.map.has(url)) return this.map.get(url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`missing ${url}`);
    const bitmap = await createImageBitmap(await response.blob());
    this.map.set(url, bitmap);
    if (this.map.size > this.limit) {
      const [oldest, old] = this.map.entries().next().value;
      old.close?.();
      this.map.delete(oldest);
    }
    return bitmap;
  }
}
