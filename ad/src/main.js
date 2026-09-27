// Deus Ex Browser Runtime — promo renderer. window.__video.renderFrame(t)
// draws time t (seconds) deterministically into the 1920x1080 canvas; the
// render script steps it frame by frame and pipes the frames into ffmpeg.
import {W, H, C, FONT, clamp, lerp, inv, ease, prog, hash, rgba, font, decode, typed, glowText, brackets, cover,
  roundRect, grid, number, tag, ImageCache} from './lib.js';
import {createWire} from './wire.js';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', {alpha: false});
const cache = new ImageCache(160);
const S = {img: {}, facts: null, wire: null, frames: new Map()};

export const DURATION = 106, FPS = 30, BEAT = 0.5;
const T = {logo: [0, 4], intro: [4, 8], montage: [8, 16], question: [16, 22], title: [22, 28], method: [28, 38],
  oracle: [38, 48], x87: [48, 54], pairs: [54, 64], footage: [64, 80], pace: [80, 90], numbers: [90, 98], outro: [98, 106]};

const STILLS = ['o-intro-1', 'o-intro-27', 'o-intro-45', 'o-intro-9', 'o-intro-70', 'o-intro-cp0000-CameraPoint0',
  'o-intro-cp0070-CameraPoint68', 'o-intro-cp0071-CameraPoint67', 'o-intro-cp0047-CameraPoint45', 'o-l-statue-high',
  'o-l-paul', 'o-h-anna', 'o-h-gunther', 'o-t-observers', 'o-l-harley', 'o-intro-cp0074-CameraPoint71',
  'o-intro-cp0052-CameraPoint17', 'o-t-start', 'b-t-start', 'o-t-infolink', 'b-t-infolink', 'o-p-walton', 'b-p-walton',
  'o-t-crates', 'b-t-crates', 'o-intro-cp0002-CameraPoint4'];

// ---------------------------------------------------------------- footage
const CLIP_ROOT = '/ad/captures/browser/clips';
const FOOTAGE = [
  {t0: 64.0, t1: 67.5, clip: 'walk', f0: 20, head: 'WALK · INFOLINK', sub: 'Original player physics, collision and DataLink scripts'},
  {t0: 67.5, t1: 69.5, clip: 'walk', f0: 125, head: 'USE', sub: 'The door runs DeusExMover.Frob — the original bytecode'},
  {t0: 69.5, t1: 72.5, clip: 'instructor', f0: 95, head: 'TALK', sub: 'Original conversation flow and subtitles'},
  {t0: 72.5, t1: 75.5, clip: 'crowbar', f0: 40, head: 'FIGHT', sub: 'Original weapon states, crate fragments and contents'},
  {t0: 75.5, t1: 77.5, clip: 'menu', f0: 5, head: 'MENU', sub: 'Esc opens the original MenuMain'},
  {t0: 77.5, t1: 80.0, clip: 'observers', f0: 0, head: 'NPCs', sub: 'Character meshes posed by the original GetFrame'},
];
const clipUrl = (clip, frame) => `${CLIP_ROOT}/${clip}/f${String(frame).padStart(4, '0')}.jpg`;
const footageAt = t => {
  const seg = FOOTAGE.find(s => t >= s.t0 && t < s.t1);
  return seg ? {seg, url: clipUrl(seg.clip, seg.f0 + Math.floor((t - seg.t0) * FPS + 1e-6))} : null;
};

// ---------------------------------------------------------------- helpers
const within = (t, [a, b], pad = 0) => t >= a - pad && t < b + pad;
function background(ctx, t, alpha = 1) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 100, W * 0.5, H * 0.5, W * 0.75);
  g.addColorStop(0, rgba('#0b1826', 0.9 * alpha));
  g.addColorStop(1, rgba(C.bg, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  grid(ctx, t, 0.16 * alpha);
}
function header(ctx, t, t0, number, title, headline, sub) {
  const a = prog(t, t0, t0 + 0.5);
  tag(ctx, `${number} — ${title}`, 96, 116, a);
  if (headline) {
    font(ctx, 72, FONT.title, 700, 1);
    ctx.fillStyle = C.text;
    ctx.globalAlpha = prog(t, t0 + 0.15, t0 + 0.7);
    ctx.fillText(decode(headline, prog(t, t0 + 0.1, t0 + 0.9, ease.linear), 7), 96, 204);
    ctx.globalAlpha = 1;
  }
  if (sub) {
    font(ctx, 26, FONT.title, 500, 0.3);
    ctx.fillStyle = C.muted;
    ctx.globalAlpha = prog(t, t0 + 0.5, t0 + 1.1);
    ctx.fillText(sub, 98, 252);
    ctx.globalAlpha = 1;
  }
}
function chip(ctx, text, x, y, color = C.gold, align = 'left') {
  font(ctx, 16, FONT.mono, 600, 3);
  const w = ctx.measureText(text).width + 28;
  const x0 = align === 'right' ? x - w : x;
  ctx.fillStyle = rgba('#03070c', 0.72);
  ctx.fillRect(x0, y - 24, w, 36);
  ctx.strokeStyle = rgba(color, 0.9);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0 + 0.5, y - 23.5, w - 1, 35);
  ctx.fillStyle = color;
  ctx.fillText(text, x0 + 14, y);
}
function panel(ctx, x, y, w, h, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = rgba('#07111b', 0.82);
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = rgba(C.line, 0.9);
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.restore();
  brackets(ctx, x - 6, y - 6, w + 12, h + 12, alpha, rgba(C.gold, 0.9), 18, 2);
}
const bigCount = (value, p) => number(value * ease.out3(clamp(p)));

// ---------------------------------------------------------------- scenes
function sLogo(ctx, t) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  // Stuttered frames of the original logo sequence before it settles.
  const stutter = [[0.10, 0.16, 'o-intro-1'], [0.26, 0.33, 'o-intro-27'], [0.42, 0.50, 'o-intro-45']];
  for (const [a, b, name] of stutter) if (t >= a && t < b) {
    ctx.globalAlpha = 0.9;
    cover(ctx, S.img[name], 0, 0, W, H, 1.05);
  }
  const a = prog(t, 0.55, 1.6, ease.inOut);
  const flicker = 0.88 + 0.12 * hash(Math.floor(t * 24) + 3);
  ctx.globalAlpha = a * flicker;
  cover(ctx, S.img['o-intro-9'], 0, 0, W, H, lerp(1.0, 1.12, ease.inOut(inv(0.55, 4.0, t))), 0, -0.04);
  ctx.globalAlpha = 1;
  tag(ctx, 'ORIGINAL GAME · IN-ENGINE CAPTURE', 96, 116, prog(t, 1.1, 1.6));
  font(ctx, 30, FONT.mono, 600, 6);
  ctx.fillStyle = C.text;
  ctx.fillText(typed('DEUS EX  (2000)', prog(t, 1.6, 2.2, ease.linear)), 96, H - 150);
  font(ctx, 20, FONT.mono, 400, 2);
  ctx.fillStyle = C.muted;
  ctx.fillText(typed('Unreal Engine 1 · DeusEx.exe · Direct3D · 00_Intro', prog(t, 2.2, 3.0, ease.linear)), 96, H - 110);
}

const INTRO = [
  [4.0, 5.0, 'o-intro-cp0000-CameraPoint0', 'CAMERAPOINT0 · SEQ 000', 1.02, 1.10, 0, 0],
  [5.0, 6.0, 'o-intro-cp0070-CameraPoint68', 'CAMERAPOINT68 · SEQ 070', 1.0, 1.07, 0.2, -0.1],
  [6.0, 7.0, 'o-intro-cp0071-CameraPoint67', 'CAMERAPOINT67 · SEQ 071', 1.07, 1.0, -0.2, 0],
  [7.0, 8.0, 'o-intro-cp0047-CameraPoint45', 'CAMERAPOINT45 · SEQ 047', 1.1, 1.1, -0.6, 0.6],
];
function sIntro(ctx, t) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const shot = INTRO.find(s => t >= s[0] && t < s[1]) ?? INTRO.at(-1);
  const [a, b, name, label, z0, z1, px0, px1] = shot;
  const p = ease.inOut(inv(a, b, t));
  const bar = 118;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, bar, W, H - 2 * bar); ctx.clip();
  cover(ctx, S.img[name], 0, bar, W, H - 2 * bar, lerp(z0, z1, p) * 1.02, lerp(px0, px1, p), 0);
  ctx.restore();
  font(ctx, 17, FONT.mono, 500, 3);
  ctx.fillStyle = C.muted;
  ctx.fillText(`00_INTRO · ${label}`, 96, H - bar / 2 + 6);
  ctx.textAlign = 'right';
  ctx.fillText('OPENING CINEMATIC · ORIGINAL ENGINE', W - 96, bar / 2 + 6);
  ctx.textAlign = 'left';
}

const MONTAGE = [
  ['o-l-statue-high', 'LIBERTY ISLAND', '01_NYC_UNATCOIsland'],
  ['o-l-paul', 'PAUL DENTON', '01_NYC_UNATCOIsland'],
  ['o-h-anna', 'ANNA NAVARRE', '01_NYC_UNATCOHQ'],
  ['o-h-gunther', 'GUNTHER HERMANN', '01_NYC_UNATCOHQ'],
  ['o-t-observers', 'THE OBSERVATION DECK', '00_Training'],
  ['o-l-harley', 'HARLEY FILBEN', '01_NYC_UNATCOIsland'],
  ['o-intro-cp0074-CameraPoint71', 'THE DENTON CLONE', '00_Intro'],
  ['o-intro-cp0052-CameraPoint17', 'GREASEL', '00_Intro'],
];
function sMontage(ctx, t) {
  const i = clamp(Math.floor(t - 8), 0, MONTAGE.length - 1);
  const [name, title, map] = MONTAGE[i];
  const p = t - 8 - i;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  cover(ctx, S.img[name], 0, 0, W, H, lerp(1.06, 1.0, ease.out3(p)), i % 2 ? 0.3 : -0.3, 0);
  const m = 60;
  brackets(ctx, m, m, W - 2 * m, H - 2 * m, prog(p, 0, 0.25), rgba(C.gold, 0.85), 34, 2);
  chip(ctx, 'ORIGINAL', W - m - 20, m + 52, C.gold, 'right');
  font(ctx, 46, FONT.title, 700, 7);
  ctx.fillStyle = C.text;
  ctx.fillText(decode(title, prog(p, 0.02, 0.35, ease.linear), i + 3), m + 36, H - m - 70);
  font(ctx, 20, FONT.mono, 500, 2);
  ctx.fillStyle = C.goldHi;
  ctx.fillText(typed(map, prog(p, 0.1, 0.45, ease.linear)), m + 38, H - m - 34);
}

function sQuestion(ctx, t) {
  background(ctx, t);
  ctx.globalAlpha = 0.12;
  cover(ctx, S.img['o-t-start'], 0, 0, W, H, 1.1);
  ctx.globalAlpha = 1;
  const x = 150;
  font(ctx, 104, FONT.title, 700, 1);
  ctx.fillStyle = C.text;
  ctx.fillText(typed('Deus Ex, 2000.', prog(t, 16.3, 17.0, ease.linear)), x, 450);
  font(ctx, 104, FONT.title, 700, 1);
  ctx.fillStyle = C.gold;
  glowText(ctx, typed('Rebuilt in the browser,', prog(t, 17.7, 18.7, ease.linear)), x, 580, C.gold, 30, 0.35);
  font(ctx, 30, FONT.mono, 500, 1);
  ctx.fillStyle = C.muted;
  ctx.fillText(typed('piece by piece — from its own data, UnrealScript bytecode and x86 machine code', prog(t, 19.2, 20.8, ease.linear)), x + 4, 670);
  // blinking cursor after the last typed line
  if (Math.floor(t * 2) % 2 === 0 && t > 16.3) {
    const line = t < 17.7 ? 0 : t < 19.2 ? 1 : 2;
    const texts = ['Deus Ex, 2000.', 'Rebuilt in the browser,', 'piece by piece — from its own data, UnrealScript bytecode and x86 machine code'];
    const starts = [16.3, 17.7, 19.2], ends = [17.0, 18.7, 20.8];
    font(ctx, line < 2 ? 104 : 30, line < 2 ? FONT.title : FONT.mono, line < 2 ? 700 : 500, line < 2 ? 1 : 1);
    const shown = typed(texts[line], prog(t, starts[line], ends[line], ease.linear));
    const cx = x + (line === 2 ? 4 : 0) + ctx.measureText(shown).width + 10;
    ctx.fillStyle = C.gold;
    ctx.fillRect(cx, [450, 580, 670][line] - (line < 2 ? 80 : 26), line < 2 ? 16 : 8, line < 2 ? 88 : 30);
  }
}

function wireOrbit(t, {cx = 3000, cy = -1500, cz = -100, radius = 7600, height = 4300, angle = 200, fov = 45}) {
  const a = angle * Math.PI / 180;
  return {eye: [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, height], target: [cx, cy, cz], fov};
}
function drawWire(ctx, view, alpha = 1, bloom = true) {
  const layer = S.wire.render(view);
  ctx.save();
  ctx.globalAlpha = alpha;
  if (bloom) {
    ctx.filter = 'blur(7px)';
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha * 0.8;
    ctx.drawImage(layer, 0, 0);
    ctx.filter = 'none';
  }
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

function sTitle(ctx, t) {
  background(ctx, t, 0.8);
  const lt = t - 22;
  const view = wireOrbit(t, {cx: 2600, cy: -1300, angle: 208 + lt * 4.5, radius: 5600 - lt * 150, height: 3000 - lt * 90, fov: 52});
  drawWire(ctx, {...view, scan: lerp(-1600, 8400, ease.inOut(inv(22.0, 25.8, t))), opacity: 0.95, near: 2500, far: 13000},
    prog(t, 22.0, 22.4));
  // shade under the title for legibility
  const g = ctx.createRadialGradient(W / 2, 470, 50, W / 2, 470, 900);
  g.addColorStop(0, rgba('#03070c', 0.78));
  g.addColorStop(1, rgba('#03070c', 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  font(ctx, 200, FONT.title, 700, 52);
  const title = decode('DEUS EX', prog(t, 22.25, 23.3, ease.linear), 3, 0.5);
  glowText(ctx, title, W / 2 + 26, 520, C.gold, 44, 0.45);
  const line = 620 * prog(t, 23.0, 23.8, ease.out5);
  ctx.fillStyle = rgba(C.gold, 0.9);
  ctx.fillRect(W / 2 - line / 2, 575, line, 2);
  font(ctx, 38, FONT.mono, 600, 24);
  ctx.fillStyle = C.text;
  ctx.fillText(decode('BROWSER RUNTIME', prog(t, 23.2, 24.0, ease.linear), 11), W / 2 + 12, 640);
  font(ctx, 30, FONT.title, 500, 1);
  ctx.fillStyle = C.muted;
  ctx.globalAlpha = prog(t, 24.5, 25.2);
  ctx.fillText('Reverse-engineered, not emulated.', W / 2, 720);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

function hexRows(bytes, perRow = 16) {
  const rows = [];
  for (let i = 0; i < bytes.length; i += perRow) rows.push(bytes.slice(i, i + perRow));
  return rows;
}
function sMethod(ctx, t) {
  background(ctx, t);
  header(ctx, t, 28.0, '01', 'THE SOURCE OF TRUTH', 'NOTHING INVENTED.',
    'The rule: every behavior traced to original data, bytecode or native instructions.');
  const F = S.facts;
  const cards = [
    {x: 96, t0: 29.2, head: 'ORIGINAL DATA', sub: `System/DeusEx.u · package v${F.pkg.version}`},
    {x: 686, t0: 29.9, head: 'UNREALSCRIPT BYTECODE', sub: `${F.bytecode.function} · ${F.bytecode.size} bytes`},
    {x: 1276, t0: 30.6, head: 'NATIVE x86 · ENGINE.DLL', sub: 'checkMove @ 0x103c3290'},
  ];
  const y = 318, w = 548, h = 520;
  for (const [k, card] of cards.entries()) {
    const a = prog(t, card.t0, card.t0 + 0.45);
    if (a <= 0) continue;
    const yy = y + (1 - a) * 30;
    panel(ctx, card.x, yy, w, h, a);
    ctx.save();
    ctx.globalAlpha = a;
    font(ctx, 24, FONT.title, 700, 4);
    ctx.fillStyle = C.gold;
    ctx.fillText(card.head, card.x + 28, yy + 50);
    font(ctx, 17, FONT.mono, 400, 0.5);
    ctx.fillStyle = C.muted;
    ctx.fillText(card.sub, card.x + 28, yy + 80);
    ctx.fillStyle = rgba(C.line, 1);
    ctx.fillRect(card.x + 28, yy + 98, w - 56, 1);
    const lt = t - card.t0;
    if (k === 0) {
      const rows = hexRows(F.pkg.header, 8);
      const shown = Math.floor(clamp(lt / 2.2) * F.pkg.header.length);
      font(ctx, 21, FONT.mono, 500, 1);
      rows.forEach((row, r) => {
        ctx.fillStyle = C.dim;
        ctx.fillText((r * 8).toString(16).padStart(4, '0'), card.x + 28, yy + 140 + r * 34);
        row.forEach((byte, c) => {
          const index = r * 8 + c;
          if (index >= shown) return;
          ctx.fillStyle = index < 4 ? C.goldHi : index < 8 ? C.ice : C.text;
          ctx.fillText(byte.toUpperCase(), card.x + 110 + c * 44, yy + 140 + r * 34);
        });
      });
      ctx.globalAlpha = a * prog(t, card.t0 + 1.2, card.t0 + 1.6);
      font(ctx, 18, FONT.mono, 500, 0.5);
      ctx.fillStyle = C.goldHi; ctx.fillText('C1 83 2A 9E', card.x + 28, yy + 420);
      ctx.fillStyle = C.muted; ctx.fillText('package signature 0x9E2A83C1', card.x + 180, yy + 420);
      ctx.fillStyle = C.ice; ctx.fillText(`${number(F.pkg.names)} names · ${number(F.pkg.exports)} exports · ${number(F.pkg.imports)} imports`, card.x + 28, yy + 452);
      ctx.globalAlpha = a * prog(t, card.t0 + 2.2, card.t0 + 2.7);
      font(ctx, 20, FONT.title, 600, 1);
      ctx.fillStyle = C.text;
      ctx.fillText(`${F.evidence.packagesValidated}/${F.evidence.packagesValidated} packages · ${F.evidence.mapsDecoded} maps decoded`, card.x + 28, yy + 494);
    } else if (k === 1) {
      const lines = F.bytecode.statements.slice(0, 11);
      const active = Math.floor(clamp((lt - 0.4) / 5.5) * lines.length);
      font(ctx, 18, FONT.mono, 500, 0.3);
      lines.forEach((s, i) => {
        const la = prog(t, card.t0 + 0.3 + i * 0.12, card.t0 + 0.5 + i * 0.12);
        if (la <= 0) return;
        const ly = yy + 138 + i * 31;
        if (i === active) {
          ctx.fillStyle = rgba(C.gold, 0.16);
          ctx.fillRect(card.x + 18, ly - 21, w - 36, 29);
        }
        ctx.globalAlpha = a * la;
        ctx.fillStyle = C.dim;
        ctx.fillText(s.offset.toString(16).padStart(4, '0'), card.x + 28, ly);
        ctx.fillStyle = C.ice;
        ctx.fillText(s.token.toString(16).padStart(2, '0').toUpperCase(), card.x + 84, ly);
        ctx.fillStyle = C.goldHi;
        ctx.fillText(s.op, card.x + 122, ly);
        ctx.fillStyle = C.text;
        const operand = s.operand.length > 22 ? s.operand.slice(0, 21) + '…' : s.operand;
        ctx.fillText(operand, card.x + 268, ly);
      });
      ctx.globalAlpha = a * prog(t, card.t0 + 2.2, card.t0 + 2.7);
      font(ctx, 20, FONT.title, 600, 1);
      ctx.fillStyle = C.text;
      ctx.fillText('executed by our own UnrealScript VM', card.x + 28, yy + 494);
    } else {
      const lines = F.disassembly.slice(0, 11);
      const active = Math.floor(clamp((lt - 0.4) / 5.5) * lines.length);
      font(ctx, 18, FONT.mono, 500, 0.3);
      lines.forEach((d, i) => {
        const la = prog(t, card.t0 + 0.3 + i * 0.12, card.t0 + 0.5 + i * 0.12);
        if (la <= 0) return;
        const ly = yy + 138 + i * 31;
        if (i === active) {
          ctx.fillStyle = rgba(C.gold, 0.16);
          ctx.fillRect(card.x + 18, ly - 21, w - 36, 29);
        }
        ctx.globalAlpha = a * la;
        ctx.fillStyle = C.dim;
        ctx.fillText(d.address.slice(-6), card.x + 28, ly);
        const x87 = /^f/.test(d.text);
        ctx.fillStyle = x87 ? C.goldHi : C.text;
        const text = d.text.replace('dword ptr ', '').replace(/\s+/g, ' ');
        ctx.fillText(text.length > 30 ? text.slice(0, 29) + '…' : text, card.x + 120, ly);
      });
      ctx.globalAlpha = a * prog(t, card.t0 + 2.2, card.t0 + 2.7);
      font(ctx, 20, FONT.title, 600, 1);
      ctx.fillStyle = C.text;
      ctx.fillText('translated to JavaScript, routine by routine', card.x + 28, yy + 494);
    }
    ctx.restore();
  }
  // convergence into the runtime
  const c = prog(t, 34.6, 35.6, ease.inOut);
  if (c > 0) {
    const targetX = W / 2, targetY = 930;
    ctx.save();
    ctx.strokeStyle = rgba(C.gold, 0.7);
    ctx.lineWidth = 2;
    for (const card of cards) {
      const sx = card.x + w / 2, sy = y + h + 6;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      const ex = lerp(sx, targetX, c), ey = lerp(sy, targetY - 30, c);
      ctx.bezierCurveTo(sx, sy + 50 * c, ex, ey - 30 * c, ex, ey);
      ctx.stroke();
      const pulse = (t * 1.3 + card.x / 600) % 1;
      if (c >= 1) {
        const px = lerp(sx, targetX, pulse), py = lerp(sy, targetY - 30, pulse);
        ctx.fillStyle = C.goldHi;
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
    const pa = prog(t, 35.3, 35.9);
    ctx.save();
    ctx.globalAlpha = pa;
    const pw = 760, ph = 64;
    roundRect(ctx, targetX - pw / 2, targetY - 32, pw, ph, 32);
    ctx.fillStyle = rgba('#0c1a28', 0.95);
    ctx.fill();
    ctx.strokeStyle = C.gold;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textAlign = 'center';
    font(ctx, 26, FONT.title, 700, 6);
    ctx.fillStyle = C.text;
    ctx.fillText('JAVASCRIPT RUNTIME  ·  WEBGL2', targetX + 3, targetY + 10);
    ctx.textAlign = 'left';
    ctx.restore();
  }
}

function codeColumn(ctx, lines, x, y, w, h, t, speed, color, highlightEvery, format) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const lh = 30;
  const offset = (t * speed) % (lines.length * lh);
  font(ctx, 18, FONT.mono, 500, 0.2);
  const count = Math.ceil(h / lh) + 2;
  const first = Math.floor(offset / lh);
  const hl = Math.floor(t / highlightEvery);
  for (let i = 0; i < count; i++) {
    const index = (first + i) % lines.length;
    const ly = y + 26 + i * lh - (offset % lh);
    const centered = Math.abs(ly - (y + h / 2)) < lh / 2;
    if (centered) {
      ctx.fillStyle = rgba(C.gold, 0.18);
      ctx.fillRect(x, ly - 21, w, lh);
      ctx.fillStyle = C.gold;
      ctx.fillRect(x, ly - 21, 3, lh);
    }
    format(ctx, lines[index], x + 18, ly, centered, hl);
  }
  // fade edges
  const g1 = ctx.createLinearGradient(0, y, 0, y + 90);
  g1.addColorStop(0, rgba('#07111b', 1)); g1.addColorStop(1, rgba('#07111b', 0));
  ctx.fillStyle = g1; ctx.fillRect(x, y, w, 90);
  const g2 = ctx.createLinearGradient(0, y + h - 90, 0, y + h);
  g2.addColorStop(0, rgba('#07111b', 0)); g2.addColorStop(1, rgba('#07111b', 1));
  ctx.fillStyle = g2; ctx.fillRect(x, y + h - 90, w, 90);
  ctx.restore();
}
function sOracle(ctx, t) {
  background(ctx, t);
  header(ctx, t, 38.0, '02', 'THE ORACLE', 'CHECKED AGAINST THE ORIGINAL.',
    'The original DLL runs in an x86 emulator as a reference — the browser never executes it.');
  const F = S.facts;
  const y = 346, h = 430, lw = 800, rx = 1024;
  const a = prog(t, 38.4, 38.9);
  panel(ctx, 96, y, lw, h, a);
  panel(ctx, rx, y, lw, h, a);
  ctx.save();
  ctx.globalAlpha = a;
  font(ctx, 18, FONT.mono, 600, 3);
  ctx.fillStyle = C.gold;
  ctx.fillText('ORIGINAL · ENGINE.DLL · x86 + x87', 100, y - 22);
  ctx.fillText('TRANSLATION · script-pawn-nav.mjs', rx + 4, y - 22);
  codeColumn(ctx, F.disassembly, 97, y + 1, lw - 2, h - 2, t - 38, 34, C.text, 0.5, (c, d, x, ly, hot) => {
    c.fillStyle = C.dim; c.fillText(d.address, x, ly);
    c.fillStyle = /^f/.test(d.text) ? C.goldHi : hot ? C.text : rgba(C.text, 0.8);
    c.fillText(d.text.replace(/\s+/g, ' '), x + 150, ly);
  });
  codeColumn(ctx, F.port, rx + 1, y + 1, lw - 2, h - 2, t - 38, 34, C.text, 0.5, (c, line, x, ly, hot) => {
    const code = line.replace(/\s+\/\/.*$/, '');
    const comment = (line.match(/\/\/.*$/) ?? [''])[0];
    c.fillStyle = hot ? C.text : rgba(C.text, 0.8);
    const shown = code.length > 58 ? code.slice(0, 57) + '…' : code;
    c.fillText(shown, x, ly);
    if (comment && shown.length < 44) {
      c.fillStyle = C.dim;
      c.fillText(comment.slice(0, 60 - shown.length), x + c.measureText(shown).width + 14, ly);
    }
  });
  // comparator between the panels
  const cy = y + h / 2;
  const beat = (t * 2) % 1;
  ctx.fillStyle = rgba(C.ok, 0.25 + 0.75 * (1 - beat));
  ctx.textAlign = 'center';
  font(ctx, 44, FONT.title, 700, 0);
  ctx.fillText('≡', (96 + lw + rx) / 2, cy + 14);
  ctx.textAlign = 'left';
  ctx.restore();
  // measured totals
  const meters = [
    ['COLLISION RAYS', F.evidence.collisionRays, 39.4],
    ['EXTENT TRACES', F.evidence.extentTraces, 39.9],
    ['PLACEMENT CHAINS', F.evidence.placementChains, 40.4],
    ['PHYSICS QUERIES', F.evidence.physicsQueries, 40.9],
  ];
  const mw = 404;
  meters.forEach(([label, value, t0], i) => {
    const ma = prog(t, t0, t0 + 0.4);
    if (ma <= 0) return;
    const x = 96 + i * (mw + 36), my = 850;
    const fill = prog(t, t0 + 0.2, t0 + 2.2, ease.inOut3);
    ctx.save();
    ctx.globalAlpha = ma;
    font(ctx, 16, FONT.mono, 600, 3);
    ctx.fillStyle = C.muted;
    ctx.fillText(label, x, my);
    font(ctx, 54, FONT.din, 700, 1);
    ctx.fillStyle = C.text;
    ctx.fillText(bigCount(value, fill), x, my + 62);
    ctx.fillStyle = rgba(C.line, 1);
    ctx.fillRect(x, my + 80, mw, 6);
    ctx.fillStyle = fill >= 1 ? C.ok : C.gold;
    ctx.fillRect(x, my + 80, mw * fill, 6);
    if (fill >= 1) {
      font(ctx, 18, FONT.mono, 700, 2);
      ctx.fillStyle = C.ok;
      ctx.fillText('MATCH', x + mw - 70, my + 62);
    }
    ctx.restore();
  });
  // stamp
  const s = prog(t, 44.8, 45.25, ease.outBack);
  if (s > 0) {
    ctx.save();
    ctx.fillStyle = rgba('#03070c', 0.9 * prog(t, 44.8, 45.2));
    ctx.fillRect(0, y - 50, W, h + 90);
    ctx.translate(W / 2, y + h / 2);
    ctx.scale(lerp(1.3, 1, s), lerp(1.3, 1, s));
    ctx.globalAlpha = clamp(s);
    ctx.textAlign = 'center';
    font(ctx, 170, FONT.din, 700, 4);
    glowText(ctx, 'maxError 0', 0, 40, C.ok, 40, 0.5);
    font(ctx, 26, FONT.mono, 500, 1);
    ctx.fillStyle = C.text;
    ctx.fillText('decoration rolling physics vs. the original DLL · bit-exact', 0, 116);
    ctx.textAlign = 'left';
    ctx.restore();
  }
}

function bitBar(ctx, x, y, cells, segments, t, seed, cell = 21.6) {
  let index = 0;
  for (const [count, color, label] of segments) {
    font(ctx, 15, FONT.mono, 600, 2);
    ctx.fillStyle = color;
    ctx.fillText(label, x + index * cell, y - 14);
    for (let i = 0; i < count; i++, index++) {
      const bx = x + index * cell;
      ctx.fillStyle = rgba(color, 0.16);
      ctx.fillRect(bx + 1, y, cell - 2, 40);
      const bit = hash(seed * 997 + index * 31 + Math.floor(t * 9 + index * 0.13)) > 0.5 ? '1' : '0';
      font(ctx, 18, FONT.mono, 600, 0);
      ctx.fillStyle = bit === '1' ? color : rgba(color, 0.45);
      ctx.fillText(bit, bx + cell / 2 - 5, y + 27);
    }
  }
  return index;
}
function sX87(ctx, t) {
  background(ctx, t);
  header(ctx, t, 48.0, '03', 'PRECISION', 'THE x87 KEEPS 80 BITS. JAVASCRIPT, 64.',
    'Native float math is reproduced to the bit, including where the original rounds.');
  const a1 = prog(t, 48.6, 49.1), a2 = prog(t, 49.0, 49.5);
  ctx.save();
  ctx.globalAlpha = a1;
  font(ctx, 20, FONT.mono, 600, 3);
  ctx.fillStyle = C.text;
  ctx.fillText('x87 EXTENDED · 80 BITS', 96, 350);
  bitBar(ctx, 96, 400, 80, [[1, C.bad, 'S'], [15, C.ice, 'EXPONENT 15'], [64, C.gold, 'MANTISSA 64']], t, 1);
  ctx.globalAlpha = a2;
  ctx.fillStyle = C.text;
  font(ctx, 20, FONT.mono, 600, 3);
  ctx.fillText('JAVASCRIPT NUMBER · 64 BITS', 96, 520);
  const used = bitBar(ctx, 96, 570, 64, [[1, C.bad, 'S'], [11, C.ice, 'EXPONENT 11'], [52, C.gold, 'MANTISSA 52']], t, 2);
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = rgba(C.muted, 0.6);
  ctx.strokeRect(96 + used * 21.6, 570, (80 - used) * 21.6, 40);
  ctx.setLineDash([]);
  font(ctx, 17, FONT.mono, 600, 1);
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'center';
  ctx.fillText('16 BITS SHORT', 96 + (used + (80 - used) / 2) * 21.6, 597);
  ctx.textAlign = 'left';
  ctx.restore();
  // real rounding stores from checkMove
  const stores = S.facts.disassembly.filter(d => /^fstp? /.test(d.text)).slice(0, 4);
  stores.forEach((d, i) => {
    const la = prog(t, 50.0 + i * 0.35, 50.35 + i * 0.35);
    if (la <= 0) return;
    const ly = 720 + i * 44;
    ctx.save();
    ctx.globalAlpha = la;
    font(ctx, 22, FONT.mono, 500, 0.3);
    ctx.fillStyle = C.dim;
    ctx.fillText(d.address, 96, ly);
    ctx.fillStyle = C.goldHi;
    ctx.fillText(d.text.replace(/\s+/g, ' '), 290, ly);
    ctx.fillStyle = C.muted;
    ctx.fillText('→ rounds to float32 here', 820, ly);
    ctx.restore();
  });
  const ca = prog(t, 51.8, 52.4);
  ctx.save();
  ctx.globalAlpha = ca;
  font(ctx, 28, FONT.title, 600, 0.5);
  ctx.fillStyle = C.text;
  ctx.fillText('Every fst / fstp placed where the original rounds — proven against the DLL, never approximated.', 96, 960);
  ctx.restore();
}

const PAIRS = [
  ['o-t-start', 'b-t-start', 'Training · PlayerStart — same eye, same rotator, same HUD layout'],
  ['o-t-infolink', 'b-t-infolink', 'InfoLink — original DataLink script, frame textures and bitmap font'],
  ['o-p-walton', 'b-p-walton', 'Walton Simons — original mesh and skin · mesh lighting still open'],
  ['o-t-crates', 'b-t-crates', 'Breakable crates — original meshes, textures and placement'],
];
// Game captures sit in a frame so the promo's labels never cover the game's own HUD.
const FR = {x: 176, y: 34, w: 1568, h: 882};
function framed(ctx, t, draw) {
  background(ctx, t, 0.6);
  ctx.save();
  ctx.beginPath(); ctx.rect(FR.x, FR.y, FR.w, FR.h); ctx.clip();
  ctx.fillStyle = '#000';
  ctx.fillRect(FR.x, FR.y, FR.w, FR.h);
  draw();
  ctx.restore();
  ctx.strokeStyle = rgba(C.line, 1);
  ctx.lineWidth = 1;
  ctx.strokeRect(FR.x - 0.5, FR.y - 0.5, FR.w + 1, FR.h + 1);
  brackets(ctx, FR.x - 10, FR.y - 10, FR.w + 20, FR.h + 20, 1, rgba(C.gold, 0.9), 30, 2);
}
function sPairs(ctx, t) {
  const i = clamp(Math.floor((t - 54) / 2.5), 0, PAIRS.length - 1);
  const p = t - 54 - i * 2.5;
  const [orig, brow, caption] = PAIRS[i];
  const {x, y, w, h} = FR;
  const mid = x + w / 2;
  const split = p < 0.35 ? x + w : p < 0.95 ? lerp(x + w, mid, ease.inOut3(inv(0.35, 0.95, p))) :
    p < 2.1 ? mid + Math.sin((p - 0.95) * 1.6) * 36 : lerp(mid + Math.sin(1.15 * 1.6) * 36, x, ease.in3(inv(2.1, 2.5, p)));
  framed(ctx, t, () => {
    cover(ctx, S.img[brow], x, y, w, h, 1.0);
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, split - x, h); ctx.clip();
    cover(ctx, S.img[orig], x, y, w, h, 1.0);
    ctx.restore();
    ctx.save();
    ctx.shadowColor = rgba(C.gold, 0.9);
    ctx.shadowBlur = 16;
    ctx.fillStyle = C.goldHi;
    ctx.fillRect(split - 1.5, y, 3, h);
    ctx.restore();
    ctx.fillStyle = C.gold;
    ctx.beginPath(); ctx.arc(split, y + h / 2, 12, 0, Math.PI * 2); ctx.fill();
  });
  const by = y + h + 58;
  chip(ctx, 'ORIGINAL · DeusEx.exe · D3D', x, by, C.gold);
  chip(ctx, 'BROWSER · WebGL2', x + w, by, C.cyan, 'right');
  const ca = Math.min(prog(p, 0.4, 0.8), 1 - prog(p, 2.2, 2.45));
  if (ca > 0) {
    ctx.save();
    ctx.globalAlpha = ca;
    font(ctx, 22, FONT.mono, 500, 0.3);
    ctx.fillStyle = C.text;
    ctx.textAlign = 'center';
    ctx.fillText(caption, mid, by + 52);
    ctx.textAlign = 'left';
    ctx.restore();
  }
}

function sFootage(ctx, t) {
  const f = footageAt(t);
  if (!f) return;
  const img = S.frames.get(f.url);
  const lt = t - f.seg.t0, len = f.seg.t1 - f.seg.t0;
  framed(ctx, t, () => cover(ctx, img, FR.x, FR.y, FR.w, FR.h, lerp(1.0, 1.03, ease.inOut(inv(0, len, lt)))));
  const by = FR.y + FR.h + 70;
  chip(ctx, 'BROWSER · LIVE CAPTURE', FR.x + FR.w, by, C.cyan, 'right');
  const a = Math.min(prog(lt, 0.05, 0.4), 1 - prog(lt, len - 0.2, len));
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = C.gold;
  ctx.fillRect(FR.x, by - 30, 4, 38);
  font(ctx, 34, FONT.title, 700, 5);
  ctx.fillStyle = C.text;
  const head = decode(f.seg.head, prog(lt, 0.05, 0.5, ease.linear), f.seg.head.length);
  ctx.fillText(head, FR.x + 22, by);
  const hw = ctx.measureText(f.seg.head).width;
  font(ctx, 22, FONT.mono, 500, 0.3);
  ctx.fillStyle = C.goldHi;
  ctx.fillText(typed(f.seg.sub, prog(lt, 0.3, 1.0, ease.linear)), FR.x + 22 + hw + 28, by - 3);
  ctx.restore();
}

function sPace(ctx, t) {
  background(ctx, t);
  const F = S.facts;
  tag(ctx, '06 — PACE', 96, 116, prog(t, 80.0, 80.5));
  const cp = prog(t, 80.3, 82.3, ease.out3);
  font(ctx, 150, FONT.din, 700, 2);
  ctx.fillStyle = C.gold;
  glowText(ctx, number(F.git.commits * cp), 96, 290, C.gold, 30, 0.35);
  const cw = ctx.measureText(number(F.git.commits)).width;
  font(ctx, 54, FONT.title, 700, 2);
  ctx.fillStyle = C.text;
  ctx.globalAlpha = prog(t, 80.6, 81.1);
  ctx.fillText('commits', 96 + cw + 30, 290);
  font(ctx, 34, FONT.title, 500, 1);
  ctx.fillStyle = C.muted;
  ctx.globalAlpha = prog(t, 81.2, 81.8);
  ctx.fillText(`in ${F.git.days} days · ${number(F.git.insertions)} lines added`, 100, 352);
  ctx.globalAlpha = 1;
  // calendar chart
  const days = F.git.calendar, max = Math.max(...days.map(d => d.commits));
  const x0 = 110, x1 = W - 110, base = 950, top = 560;
  const bw = (x1 - x0) / days.length;
  ctx.fillStyle = rgba(C.line, 1);
  ctx.fillRect(x0, base + 2, x1 - x0, 2);
  days.forEach((d, i) => {
    const g = prog(t, 81.0 + i * 0.09, 81.8 + i * 0.09, ease.out3);
    const bh = (base - top) * d.commits / max * g;
    const bx = x0 + i * bw + bw * 0.18, w = bw * 0.64;
    const peak = d.commits === max;
    ctx.fillStyle = peak ? C.goldHi : rgba(C.gold, 0.75);
    ctx.fillRect(bx, base - bh, w, bh);
    font(ctx, 15, FONT.mono, 500, 1);
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'center';
    ctx.fillText(d.date.slice(5), bx + w / 2, base + 30);
    if (d.commits && g > 0.9) {
      ctx.fillStyle = peak ? C.goldHi : C.text;
      font(ctx, 17, FONT.mono, 600, 0);
      ctx.fillText(String(d.commits), bx + w / 2, base - bh - 10);
    }
    ctx.textAlign = 'left';
  });
  // milestones
  const ms = [['2026-09-09', 'Training renders'], ['2026-09-13', 'Doors run original bytecode'],
    ['2026-09-16', 'UI natives from Extension.dll'], ['2026-09-18', 'NPC navigation, bit-exact'],
    ['2026-09-21', 'Conversations & subtitles'], ['2026-09-23', 'Crowbar, crates, original HUD'],
    ['2026-09-25', 'Main menu, real Login']];
  ms.forEach(([date, label], i) => {
    const di = days.findIndex(d => d.date === date);
    if (di < 0) return;
    const ma = prog(t, 83.4 + i * 0.55, 83.8 + i * 0.55);
    if (ma <= 0) return;
    const cx = x0 + di * bw + bw / 2;
    const ly = 432 + (i % 3) * 40;
    ctx.save();
    ctx.globalAlpha = ma;
    ctx.strokeStyle = rgba(C.ice, 0.6);
    ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.moveTo(cx, ly + 10); ctx.lineTo(cx, base - 8); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.ice;
    ctx.beginPath(); ctx.arc(cx, ly + 10, 5, 0, Math.PI * 2); ctx.fill();
    font(ctx, 18, FONT.title, 600, 0.3);
    ctx.fillStyle = C.text;
    const tw = ctx.measureText(label).width;
    const lx = clamp(cx - tw / 2, 40, W - 40 - tw);
    ctx.fillText(label, lx, ly - 4);
    ctx.restore();
  });
}

function sNumbers(ctx, t) {
  background(ctx, t);
  const F = S.facts;
  tag(ctx, '07 — THE EVIDENCE', 96, 116, prog(t, 90.0, 90.5));
  const tiles = [
    [F.code.runtimeLines, 'lines of JavaScript source'],
    [F.code.validators, 'validators against original data'],
    [F.code.nativeOracles, 'native-code oracle checks'],
    [F.code.docs, 'evidence documents'],
    [`${F.evidence.packagesValidated}/${F.evidence.packagesValidated}`, 'original packages validated'],
    [0, 'Windows binaries run in the browser'],
  ];
  const cols = 3, tw = 540, th = 300, gx = 42, gy = 50, x0 = (W - (cols * tw + (cols - 1) * gx)) / 2, y0 = 210;
  tiles.forEach(([value, label], i) => {
    const t0 = 90.3 + i * 0.35;
    const a = prog(t, t0, t0 + 0.45);
    if (a <= 0) return;
    const x = x0 + (i % cols) * (tw + gx), y = y0 + Math.floor(i / cols) * (th + gy) + (1 - a) * 24;
    panel(ctx, x, y, tw, th, a);
    ctx.save();
    ctx.globalAlpha = a;
    font(ctx, 128, FONT.din, 700, 2);
    const shown = typeof value === 'number' ? bigCount(value, prog(t, t0 + 0.1, t0 + 1.6, ease.linear)) : value;
    ctx.fillStyle = i === 5 ? C.ok : C.gold;
    glowText(ctx, shown, x + 40, y + 170, i === 5 ? C.ok : C.gold, 24, 0.3);
    font(ctx, 26, FONT.title, 600, 0.5);
    ctx.fillStyle = C.text;
    ctx.fillText(label, x + 44, y + 236);
    ctx.restore();
  });
}

function sOutro(ctx, t) {
  background(ctx, t, 0.7);
  const lt = t - 98;
  const view = wireOrbit(t, {angle: 250 + lt * 4, radius: 6800 + lt * 520, height: 3600 + lt * 380});
  drawWire(ctx, {...view, opacity: 0.8 * (1 - prog(t, 104.2, 105.6)), near: 4000, far: 20000}, 1);
  const g = ctx.createRadialGradient(W / 2, 500, 50, W / 2, 500, 950);
  g.addColorStop(0, rgba('#03070c', 0.8));
  g.addColorStop(1, rgba('#03070c', 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const a = prog(t, 98.3, 99.0) * (1 - prog(t, 104.6, 105.6));
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = 'center';
  font(ctx, 132, FONT.title, 700, 36);
  glowText(ctx, 'DEUS EX', W / 2 + 18, 440, C.gold, 36, 0.4);
  font(ctx, 30, FONT.mono, 600, 20);
  ctx.fillStyle = C.text;
  ctx.fillText('BROWSER RUNTIME', W / 2 + 10, 505);
  ctx.globalAlpha = a * prog(t, 99.4, 100.0);
  font(ctx, 26, FONT.mono, 500, 1);
  ctx.fillStyle = C.muted;
  ctx.fillText('Stage 3 · original script & native runtime — in progress', W / 2, 610);
  ctx.globalAlpha = a * prog(t, 100.3, 101.0);
  font(ctx, 40, FONT.title, 600, 1);
  ctx.fillStyle = C.goldHi;
  ctx.fillText('Built from evidence. Nothing invented.', W / 2, 690);
  ctx.textAlign = 'left';
  ctx.restore();
}

const SCENES = [
  [T.logo, sLogo], [T.intro, sIntro], [T.montage, sMontage], [T.question, sQuestion], [T.title, sTitle],
  [T.method, sMethod], [T.oracle, sOracle], [T.x87, sX87], [T.pairs, sPairs], [T.footage, sFootage],
  [T.pace, sPace], [T.numbers, sNumbers], [T.outro, sOutro],
];

// ---------------------------------------------------------------- post
const CUTS = [4, 8, 16, 22, 28, 38, 48, 54, 64, 80, 90, 98, 9, 10, 11, 12, 13, 14, 15, 5, 6, 7, 56.5, 59, 61.5,
  67.5, 69.5, 72.5, 75.5, 77.5];
const grainCanvas = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const data = g.createImageData(512, 512);
  let s = 12345;
  for (let i = 0; i < data.data.length; i += 4) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const v = (s >>> 24);
    data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
    data.data[i + 3] = 255;
  }
  g.putImageData(data, 0, 0);
  return c;
})();
const scanCanvas = (() => {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 4;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fillRect(0, 0, 4, 1);
  return c;
})();
const tmp = document.createElement('canvas');
tmp.width = W; tmp.height = H;
const tctx = tmp.getContext('2d');

function post(ctx, t) {
  const frame = Math.round(t * FPS);
  // glitch around cuts
  let glitch = 0;
  for (const cut of CUTS) {
    const d = Math.abs(t - cut);
    const major = Number.isInteger(cut) && [4, 8, 16, 22, 28, 38, 48, 54, 64, 80, 90, 98].includes(cut);
    if (d < (major ? 0.14 : 0.07)) glitch = Math.max(glitch, (major ? 1 : 0.5) * (1 - d / (major ? 0.14 : 0.07)));
  }
  if (glitch > 0) {
    tctx.drawImage(canvas, 0, 0);
    const bands = 6 + Math.floor(hash(frame) * 8);
    for (let i = 0; i < bands; i++) {
      const y = Math.floor(hash(frame * 7 + i) * H), h = 8 + Math.floor(hash(frame * 13 + i) * 90);
      const dx = (hash(frame * 17 + i) - 0.5) * 160 * glitch;
      ctx.drawImage(tmp, 0, y, W, h, dx, y, W, h);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.22 * glitch;
    ctx.filter = 'sepia(1) saturate(6) hue-rotate(160deg)';
    ctx.drawImage(tmp, -10 * glitch, 0);
    ctx.filter = 'sepia(1) saturate(6) hue-rotate(-30deg)';
    ctx.drawImage(tmp, 10 * glitch, 0);
    ctx.restore();
  }
  // flash on the title hit
  const flash = Math.max(0, 1 - Math.abs(t - 22.0) / 0.18);
  if (flash > 0) {
    ctx.fillStyle = rgba(C.goldHi, 0.35 * flash);
    ctx.fillRect(0, 0, W, H);
  }
  // scanlines, grain, vignette
  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = ctx.createPattern(scanCanvas, 'repeat');
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.055;
  ctx.globalCompositeOperation = 'overlay';
  const ox = Math.floor(hash(frame * 3) * 512), oy = Math.floor(hash(frame * 5) * 512);
  ctx.translate(-ox, -oy);
  ctx.fillStyle = ctx.createPattern(grainCanvas, 'repeat');
  ctx.fillRect(ox, oy, W, H);
  ctx.restore();
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  // fade from/to black at the very ends
  const edge = Math.max(1 - inv(0, 0.4, t), inv(DURATION - 0.6, DURATION, t));
  if (edge > 0) {
    ctx.fillStyle = `rgba(0,0,0,${edge})`;
    ctx.fillRect(0, 0, W, H);
  }
}

// ---------------------------------------------------------------- driver
async function init() {
  const fonts = [`700 100px ${FONT.title}`, `600 40px ${FONT.title}`, `500 40px ${FONT.title}`, `600 30px ${FONT.mono}`,
    `500 30px ${FONT.mono}`, `400 30px ${FONT.mono}`, `700 100px ${FONT.din}`];
  await Promise.all(fonts.map(f => document.fonts.load(f)));
  S.facts = await (await fetch('/ad/build/facts.json')).json();
  S.wire = await createWire('/reports/00_Training/world.obj', W, H);
  await Promise.all(STILLS.map(async name => { S.img[name] = await cache.get(`/ad/build/assets/${name}.jpg`); }));
  return {duration: DURATION, fps: FPS, edges: S.wire.edges};
}

async function renderFrame(t) {
  const f = footageAt(t);
  if (f && !S.frames.has(f.url)) {
    if (S.frames.size > 8) S.frames.delete(S.frames.keys().next().value);
    S.frames.set(f.url, await cache.get(f.url));
  }
  ctx.save();
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  for (const [range, draw] of SCENES) if (within(t, range)) {
    ctx.save();
    draw(ctx, t);
    ctx.restore();
  }
  ctx.restore();
  post(ctx, t);
}

window.__video = {ready: init(), renderFrame, duration: DURATION, fps: FPS};
