// Deus Ex Browser Runtime — promo renderer. window.__video.renderFrame(t)
// draws time t (seconds) deterministically into the 1920x1080 canvas; the
// render script steps it frame by frame and pipes the frames into ffmpeg.
// Sections and cuts follow the soundtrack's bars: music.mjs writes them to ad/build/score.json (timeline.js).
import {W, H, C, FONT, clamp, lerp, inv, ease, prog, hash, rgba, font, decode, typed, glowText, brackets, cover,
  roundRect, grid, number, tag, ImageCache} from './lib.js';
import {createWire} from './wire.js';
import {grid as barGrid, FPS} from './timeline.js';

const score = await (await fetch('/ad/build/score.json')).json();
const G = barGrid(score), {bar, span} = G, SECTIONS = G.sections, DURATION = G.duration;

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', {alpha: false});
// stills stay loaded; footage frames rotate through their own cache (an evicted bitmap is closed)
const cache = new ImageCache(1000), frameCache = new ImageCache(48);
const S = {img: {}, facts: null, wire: null, frames: new Map()};
export {DURATION, FPS};

// ---------------------------------------------------------------- footage (ad/captures/play, capture-play.mjs)
const CLIP_ROOT = '/ad/captures/play';
const shot = (b0, b1, clip, f0, extra = {}) => ({t0: bar(b0), t1: bar(b1), clip, f0, ...extra});
const FOOTAGE = [
  // the cold open: 00_Intro, running in Play, over the theme's intro (its second block is slower)
  shot(2, 3, 'i-globe', 30, {z: [1.0, 1.05]}),
  shot(3, 4, 'i-room', 10, {z: [1.04, 1.0]}),
  shot(4, 5, 'i-room', 84, {z: [1.0, 1.05]}),
  shot(5, 6, 'i-statue', 10, {z: [1.0, 1.04]}),
  shot(6, 7, 'i-nsf', 0, {z: [1.04, 1.0]}),
  shot(7, 8, 'i-clone', 0, {z: [1.0, 1.08], fadeAt: 48}),   // the dive into the eye, then black until the gong (the clip cuts to the NSF at 60)
  // the reveal: the cinematic keeps playing while the frame becomes a browser window
  shot(8, 10, 'i-page', 60, {reveal: true}),
  shot(10, 12, 'i-logo', 60, {title: true}),
  // gameplay, over the main groove
  shot(12, 13.5, 'p-arrival', 10, {head: 'ARRIVE', sub: 'The original LoadMap, Login and DeusExHUD'}),
  shot(13.5, 15, 'p-paul', 230, {head: 'TALK', sub: 'Third-person conversations: ConPlay, its camera, lip sync'}),
  shot(15, 16.5, 'p-fight', 36, {head: 'FIGHT', sub: 'Weapon states and tracers; the NSF aim and fire back'}),
  shot(16.5, 18, 'p-fight', 128, {head: 'HIT', sub: 'Hit regions, armor and damage, compared with the original'}),
  shot(18, 19.5, 'p-gunther', 130, {head: 'RESCUE', sub: 'The cell’s button and door run DeusExMover’s bytecode'}),
  shot(19.5, 21, 't-crowbar', 30, {head: 'BREAK', sub: 'Two crowbar hits: the crate’s original fragments and contents'}),
  shot(21, 22.5, 't-keypad', 15, {head: 'HACK', sub: 'The keypad’s original window, keys and code'}),
  shot(22.5, 24, 't-datacube', 8, {head: 'READ', sub: 'A DataCube, through the original text parser and windows'}),
];
const clipUrl = (clip, frame) => `${CLIP_ROOT}/${clip}/f${String(frame).padStart(4, '0')}.jpg`;
const footageAt = t => {
  const seg = FOOTAGE.find(s => t >= s.t0 && t < s.t1);
  if (!seg) return null;
  const frame = seg.f0 + Math.floor((t - seg.t0) * FPS + 1e-6);
  return {seg, url: clipUrl(seg.clip, Math.min(frame, (S.clipLengths[seg.clip] ?? 1e9) - 1))};
};

// the original/Play frame pairs of the Stage 4 acceptance work (ad/build/assets/pairs, graded with the original's gamma ramp)
const PAIRS = [
  ['00_Intro__in2-in1', '00_Intro', 'the opening cinematic'],
  ['00_Intro__in2-in3', '00_Intro', 'Page and Simons'],
  ['01_NYC_UNATCOIsland__cvA4', '01_NYC_UNATCOIsland', 'a conversation camera over the bay'],
  ['01_NYC_UNATCOHQ__mm2', '01_NYC_UNATCOHQ', 'MeetManderley, a conversation'],
  ['02_NYC_Hotel__hotel1', '02_NYC_Hotel', 'a bathroom mirror, JC in the reflection'],
  ['06_HongKong_WanChai_Garage__garage2', '06_HongKong_WanChai_Garage', 'the garage'],
  ['10_Paris_Club__club1', '10_Paris_Club', 'La Porte de l’Enfer'],
  ['15_Area51_Final__a51f', '15_Area51_Final', 'a security terminal, two live cameras'],
];
const STILLS = PAIRS.flatMap(([id]) => [`pairs/${id}-o`, `pairs/${id}-p`]);

// ---------------------------------------------------------------- helpers
const T = Object.fromEntries(Object.keys(SECTIONS).map(name => [name, span(name)]));
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
function header(ctx, t, t0, num, title, headline, sub) {
  const a = prog(t, t0, t0 + 0.5);
  tag(ctx, `${num} — ${title}`, 96, 116, a);
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
  ctx.save();
  ctx.textAlign = 'left';
  font(ctx, 16, FONT.mono, 600, 3);
  const w = ctx.measureText(text).width + 28;
  const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  ctx.fillStyle = rgba('#03070c', 0.72);
  ctx.fillRect(x0, y - 24, w, 36);
  ctx.strokeStyle = rgba(color, 0.9);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0 + 0.5, y - 23.5, w - 1, 35);
  ctx.fillStyle = color;
  ctx.fillText(text, x0 + 14, y);
  ctx.restore();
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
const cursor = (ctx, t, x, y, w, h) => { if (Math.floor(t * 2.4) % 2 === 0) { ctx.fillStyle = C.gold; ctx.fillRect(x, y, w, h); } };

// ---------------------------------------------------------------- 1. the cold open
function sOpen(ctx, t) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (t < bar(2)) {
    const x = 150, y = 560;
    font(ctx, 96, FONT.title, 700, 1);
    const text = typed('Deus Ex, 2000.', prog(t, bar(0.6), bar(0.6) + 0.8, ease.linear));
    ctx.globalAlpha = 1 - prog(t, bar(2) - 0.3, bar(2));
    ctx.fillStyle = C.text;
    ctx.fillText(text, x, y);
    cursor(ctx, t, x + ctx.measureText(text).width + 12, y - 78, 14, 86);
    ctx.globalAlpha = prog(t, 0.4, 1.2) * (1 - prog(t, bar(2) - 0.3, bar(2)));
    tag(ctx, 'ION STORM · UNREAL ENGINE 1', x + 4, y + 70);
    ctx.globalAlpha = 1;
    return;
  }
  cinematic(ctx, t);
}
// letterboxed footage of the intro, as the original shows it
function cinematic(ctx, t) {
  const f = footageAt(t);
  if (!f) return;
  const img = S.frames.get(f.url), {seg} = f;
  const p = ease.inOut(inv(seg.t0, seg.t1, t));
  const barH = 110;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, barH, W, H - 2 * barH); ctx.clip();
  cover(ctx, img, 0, 0, W, H, lerp(seg.z?.[0] ?? 1, seg.z?.[1] ?? 1, p));
  if (seg.fadeAt != null) { ctx.fillStyle = `rgba(0,0,0,${clamp(((t - seg.t0) * FPS - seg.fadeAt) / 10)})`; ctx.fillRect(0, 0, W, H); }
  ctx.restore();
  font(ctx, 17, FONT.mono, 500, 3);
  ctx.fillStyle = C.muted;
  ctx.globalAlpha = prog(t, bar(2), bar(2) + 0.6);
  ctx.fillText('00_INTRO', 96, H - barH / 2 + 6);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- 2. the reveal: a browser window; the title on Play's logo map
function sReveal(ctx, t) {
  const f = footageAt(t);
  if (!f) return;
  const img = S.frames.get(f.url);
  if (f.seg.reveal) {
    background(ctx, t, 0.7);
    // the full-bleed frame shrinks into a browser window
    const s = prog(t, bar(8), bar(8) + 1.2, ease.inOut3);
    const win = {w: lerp(W, 1460, s), h: lerp(H, 900, s)};
    win.x = (W - win.w) / 2; win.y = lerp(0, 90, s);
    const chrome = 52 * s;
    ctx.save();
    roundRect(ctx, win.x, win.y, win.w, win.h, 14 * s);
    ctx.fillStyle = '#10171f';
    ctx.fill();
    ctx.clip();
    cover(ctx, img, win.x, win.y + chrome, win.w, win.h - chrome, 1.0);
    if (s > 0.02) {
      ctx.globalAlpha = s;
      ctx.fillStyle = '#1a232d';
      ctx.fillRect(win.x, win.y, win.w, chrome);
      for (const [k, c] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
        ctx.fillStyle = c; ctx.beginPath(); ctx.arc(win.x + 26 + k * 22, win.y + chrome / 2, 6.5, 0, Math.PI * 2); ctx.fill();
      }
      roundRect(ctx, win.x + win.w / 2 - 280, win.y + 11, 560, chrome - 22, 9);
      ctx.fillStyle = '#0c1218'; ctx.fill();
      font(ctx, 17, FONT.mono, 500, 0.5);
      ctx.fillStyle = C.muted;
      ctx.textAlign = 'center';
      ctx.fillText('localhost:5173', win.x + win.w / 2, win.y + chrome / 2 + 6);
      ctx.textAlign = 'left';
    }
    ctx.restore();
    if (s > 0.5) {
      ctx.strokeStyle = rgba(C.line, s);
      ctx.lineWidth = 1;
      roundRect(ctx, win.x, win.y, win.w, win.h, 14 * s);
      ctx.stroke();
    }
    // the line under the window
    const text = typed('Running in your browser.', prog(t, bar(9) + 0.1, bar(9) + 1.0, ease.linear));
    ctx.textAlign = 'center';
    font(ctx, 46, FONT.title, 700, 1);
    ctx.fillStyle = C.text;
    ctx.fillText(text, W / 2, 1050);
    ctx.textAlign = 'left';
    return;
  }
  // the title over Play's own logo map (DX.dx's camera flight, where the intro travels)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = prog(t, bar(10), bar(10) + 0.5);
  cover(ctx, img, 0, 0, W, H, lerp(1.0, 1.04, inv(bar(10), bar(12), t)), 0, -0.25);
  ctx.globalAlpha = 1;
  const g = ctx.createLinearGradient(0, H * 0.55, 0, H);
  g.addColorStop(0, rgba('#000000', 0)); g.addColorStop(1, rgba('#000000', 0.85));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  font(ctx, 46, FONT.mono, 600, 30);
  ctx.fillStyle = C.text;
  ctx.fillText(decode('BROWSER RUNTIME', prog(t, bar(10) + 0.3, bar(10) + 1.1, ease.linear), 11), W / 2 + 15, 900);
  const line = 680 * prog(t, bar(10) + 0.2, bar(10) + 0.9, ease.out5);
  ctx.fillStyle = rgba(C.gold, 0.9);
  ctx.fillRect(W / 2 - line / 2, 840, line, 2);
  font(ctx, 30, FONT.title, 500, 1);
  ctx.fillStyle = C.muted;
  ctx.globalAlpha = prog(t, bar(11), bar(11) + 0.5);
  ctx.fillText('Reverse-engineered, not emulated.', W / 2, 968);
  ctx.globalAlpha = 1;
  chip(ctx, 'BROWSER · DXONLY, THE LOGO MAP THE INTRO ENDS ON', W / 2, 70, C.cyan, 'center');
  ctx.textAlign = 'left';
}

// ---------------------------------------------------------------- 3. gameplay
function sIsland(ctx, t) {
  const f = footageAt(t);
  if (!f) return;
  const img = S.frames.get(f.url), {seg} = f;
  const lt = t - seg.t0, len = seg.t1 - seg.t0;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  cover(ctx, img, 0, 0, W, H, 1.0);
  // top: the live-capture chip; bottom left (clear of the game's belt): the caption
  const index = FOOTAGE.filter(s => s.head).indexOf(seg);
  if (lt < 0.5) chip(ctx, 'BROWSER · PLAY · LIVE', W / 2, 54, C.cyan, 'center');
  caption(ctx, t, seg, len, lt, index);
}
function caption(ctx, t, seg, len, lt, index) {
  const a = Math.min(prog(lt, 0.05, 0.35), 1 - prog(lt, len - 0.25, len));
  if (a <= 0) return;
  // above the HUD's weapon box and clear of the belt (both start near y 945 at 1080p)
  const x = 64, y = 900;
  ctx.save();
  ctx.globalAlpha = a;
  const g = ctx.createRadialGradient(x + 300, y - 20, 20, x + 300, y - 20, 520);
  g.addColorStop(0, rgba('#000000', 0.55)); g.addColorStop(1, rgba('#000000', 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.gold;
  ctx.fillRect(x, y - 64, 4, 84);
  font(ctx, 46, FONT.title, 700, 6);
  ctx.fillStyle = C.text;
  ctx.fillText(decode(seg.head, prog(lt, 0.05, 0.45, ease.linear), seg.head.length + index), x + 22, y - 18);
  font(ctx, 21, FONT.mono, 500, 0.3);
  ctx.fillStyle = C.goldHi;
  ctx.fillText(typed(seg.sub, prog(lt, 0.25, 1.0, ease.linear)), x + 24, y + 16);
  ctx.restore();
}

// ---------------------------------------------------------------- 4. the method: data, bytecode, native code; the Rust core; x87
function hexRows(bytes, perRow = 16) {
  const rows = [];
  for (let i = 0; i < bytes.length; i += perRow) rows.push(bytes.slice(i, i + perRow));
  return rows;
}
function sMethod(ctx, t) {
  background(ctx, t);
  if (t < bar(27)) return sources(ctx, t);
  if (t < bar(30)) return translation(ctx, t);
  return precision(ctx, t);
}
function sources(ctx, t) {
  const t0 = bar(24);
  header(ctx, t, t0, '01', 'THE SOURCE OF TRUTH', 'NOTHING INVENTED.',
    'Every behavior is traced to the game’s own data, bytecode or machine code.');
  const F = S.facts;
  const cards = [
    {x: 96, t0: bar(24.4), head: 'ORIGINAL DATA', sub: `System/DeusEx.u · package v${F.pkg.version}`},
    {x: 686, t0: bar(24.9), head: 'UNREALSCRIPT BYTECODE', sub: `${F.bytecode.function} · ${F.bytecode.size} bytes`},
    {x: 1276, t0: bar(25.4), head: 'NATIVE x86 · ENGINE.DLL', sub: 'APawn::AICanHear @ 0x103c7680'},
  ];
  const y = 318, w = 548, h = 560;
  for (const [k, card] of cards.entries()) {
    const a = prog(t, card.t0, card.t0 + 0.4);
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
      const shown = Math.floor(clamp(lt / 1.2) * F.pkg.header.length);
      font(ctx, 21, FONT.mono, 500, 1);
      rows.forEach((row, r) => {
        ctx.fillStyle = C.dim;
        ctx.fillText((r * 8).toString(16).padStart(4, '0'), card.x + 28, yy + 140 + r * 34);
        row.forEach((byte, c) => {
          const i = r * 8 + c;
          if (i >= shown) return;
          ctx.fillStyle = i < 4 ? C.goldHi : i < 8 ? C.ice : C.text;
          ctx.fillText(byte.toUpperCase(), card.x + 110 + c * 44, yy + 140 + r * 34);
        });
      });
      ctx.globalAlpha = a * prog(t, card.t0 + 0.8, card.t0 + 1.2);
      font(ctx, 18, FONT.mono, 500, 0.5);
      ctx.fillStyle = C.goldHi; ctx.fillText('C1 83 2A 9E', card.x + 28, yy + 430);
      ctx.fillStyle = C.muted; ctx.fillText('package signature 0x9E2A83C1', card.x + 180, yy + 430);
      ctx.fillStyle = C.ice; ctx.fillText(`${number(F.pkg.names)} names · ${number(F.pkg.exports)} exports · ${number(F.pkg.imports)} imports`, card.x + 28, yy + 466);
      font(ctx, 20, FONT.title, 600, 1);
      ctx.fillStyle = C.text;
      ctx.fillText(`${F.evidence.packagesValidated}/${F.evidence.packagesValidated} packages · ${F.evidence.mapsDecoded} maps decoded`, card.x + 28, yy + 520);
    } else if (k === 1) {
      const lines = F.bytecode.statements.slice(0, 11);
      const active = Math.floor(clamp((lt - 0.3) / 3.5) * lines.length);
      font(ctx, 18, FONT.mono, 500, 0.3);
      lines.forEach((s, i) => {
        const la = prog(t, card.t0 + 0.2 + i * 0.07, card.t0 + 0.4 + i * 0.07);
        if (la <= 0) return;
        const ly = yy + 138 + i * 31;
        if (i === active) { ctx.fillStyle = rgba(C.gold, 0.16); ctx.fillRect(card.x + 18, ly - 21, w - 36, 29); }
        ctx.globalAlpha = a * la;
        ctx.fillStyle = C.dim; ctx.fillText(s.offset.toString(16).padStart(4, '0'), card.x + 28, ly);
        ctx.fillStyle = C.ice; ctx.fillText(s.token.toString(16).padStart(2, '0').toUpperCase(), card.x + 84, ly);
        ctx.fillStyle = C.goldHi; ctx.fillText(s.op, card.x + 122, ly);
        ctx.fillStyle = C.text;
        ctx.fillText(s.operand.length > 22 ? s.operand.slice(0, 21) + '…' : s.operand, card.x + 268, ly);
      });
      ctx.globalAlpha = a * prog(t, card.t0 + 1.0, card.t0 + 1.4);
      font(ctx, 20, FONT.title, 600, 1);
      ctx.fillStyle = C.text;
      ctx.fillText('run by our own UnrealScript VM', card.x + 28, yy + 520);
    } else {
      const lines = F.disassembly.slice(0, 11);
      const active = Math.floor(clamp((lt - 0.3) / 3.0) * lines.length);
      font(ctx, 18, FONT.mono, 500, 0.3);
      lines.forEach((d, i) => {
        const la = prog(t, card.t0 + 0.2 + i * 0.07, card.t0 + 0.4 + i * 0.07);
        if (la <= 0) return;
        const ly = yy + 138 + i * 31;
        if (i === active) { ctx.fillStyle = rgba(C.gold, 0.16); ctx.fillRect(card.x + 18, ly - 21, w - 36, 29); }
        ctx.globalAlpha = a * la;
        ctx.fillStyle = C.dim; ctx.fillText(d.address.slice(-6), card.x + 28, ly);
        ctx.fillStyle = /^f/.test(d.text) ? C.goldHi : C.text;
        const text = d.text.replace('dword ptr ', '').replace(/\s+/g, ' ');
        ctx.fillText(text.length > 30 ? text.slice(0, 29) + '…' : text, card.x + 120, ly);
      });
      ctx.globalAlpha = a * prog(t, card.t0 + 1.0, card.t0 + 1.4);
      font(ctx, 20, FONT.title, 600, 1);
      ctx.fillStyle = C.text;
      ctx.fillText('can a guard hear you? the original says', card.x + 28, yy + 520);
    }
    ctx.restore();
  }
}
function codeColumn(ctx, lines, x, y, w, h, t, speed, format) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const lh = 30;
  const offset = (t * speed) % (lines.length * lh);
  font(ctx, 18, FONT.mono, 500, 0.2);
  const count = Math.ceil(h / lh) + 2, first = Math.floor(offset / lh);
  for (let i = 0; i < count; i++) {
    const index = (first + i) % lines.length;
    const ly = y + 26 + i * lh - (offset % lh);
    const centered = Math.abs(ly - (y + h / 2)) < lh / 2;
    if (centered) {
      ctx.fillStyle = rgba(C.gold, 0.18); ctx.fillRect(x, ly - 21, w, lh);
      ctx.fillStyle = C.gold; ctx.fillRect(x, ly - 21, 3, lh);
    }
    format(ctx, lines[index], x + 18, ly, centered);
  }
  const g1 = ctx.createLinearGradient(0, y, 0, y + 90);
  g1.addColorStop(0, rgba('#07111b', 1)); g1.addColorStop(1, rgba('#07111b', 0));
  ctx.fillStyle = g1; ctx.fillRect(x, y, w, 90);
  const g2 = ctx.createLinearGradient(0, y + h - 90, 0, y + h);
  g2.addColorStop(0, rgba('#07111b', 0)); g2.addColorStop(1, rgba('#07111b', 1));
  ctx.fillStyle = g2; ctx.fillRect(x, y + h - 90, w, 90);
  ctx.restore();
}
function translation(ctx, t) {
  const t0 = bar(27);
  header(ctx, t, t0, '02', 'THE TRANSLATION', 'RUST, COMPILED TO WEBASSEMBLY.',
    'The original DLL runs only in the test oracle, under an x86 emulator. The browser never executes it.');
  const F = S.facts;
  const y = 330, h = 450, lw = 800, rx = 1024;
  const a = prog(t, t0 + 0.3, t0 + 0.8);
  panel(ctx, 96, y, lw, h, a);
  panel(ctx, rx, y, lw, h, a);
  ctx.save();
  ctx.globalAlpha = a;
  font(ctx, 18, FONT.mono, 600, 3);
  ctx.fillStyle = C.gold;
  ctx.fillText('ORIGINAL · ENGINE.DLL · x86 + x87', 100, y - 22);
  ctx.fillText('TRANSLATION · native/script-vm/src/aievent.rs', rx + 4, y - 22);
  codeColumn(ctx, F.disassembly, 97, y + 1, lw - 2, h - 2, t - t0, 46, (c, d, x, ly, hot) => {
    c.fillStyle = C.dim; c.fillText(d.address, x, ly);
    c.fillStyle = /^f/.test(d.text) ? C.goldHi : hot ? C.text : rgba(C.text, 0.8);
    c.fillText(d.text.replace(/\s+/g, ' '), x + 150, ly);
  });
  codeColumn(ctx, F.port, rx + 1, y + 1, lw - 2, h - 2, t - t0, 24, (c, line, x, ly, hot) => {
    const comment = /^\s*\/\//.test(line);
    c.fillStyle = comment ? C.dim : /\.store\(\)/.test(line) ? C.goldHi : hot ? C.text : rgba(C.text, 0.82);
    c.fillText(line.length > 64 ? line.slice(0, 63) + '…' : line, x, ly);
  });
  const beat = ((t - t0) / (G.barLength(27) / 4)) % 1;
  ctx.fillStyle = rgba(C.ok, 0.25 + 0.75 * (1 - beat));
  ctx.textAlign = 'center';
  font(ctx, 44, FONT.title, 700, 0);
  ctx.fillText('≡', (96 + lw + rx) / 2, y + h / 2 + 14);
  ctx.textAlign = 'left';
  ctx.restore();
  // the oracle's verdict
  const s = prog(t, bar(28.2), bar(28.2) + 0.4, ease.outBack);
  if (s > 0) {
    ctx.save();
    ctx.globalAlpha = clamp(s);
    const x = 96, yy = 850;
    font(ctx, 16, FONT.mono, 600, 3);
    ctx.fillStyle = C.muted;
    ctx.fillText('validate-event-manager.mjs · the Rust port against the original body', x, yy);
    font(ctx, 62, FONT.din, 700, 1);
    ctx.fillStyle = C.ok;
    glowText(ctx, '98 OF 98 SCENARIOS EQUAL', x, yy + 72, C.ok, 26, 0.35);
    font(ctx, 20, FONT.mono, 500, 0.3);
    ctx.fillStyle = C.text;
    ctx.fillText('18 hand-written, 80 seeded · 3,362 operations · Engine.dll under Unicorn as the reference', x + 2, yy + 112);
    ctx.textAlign = 'right';
    font(ctx, 20, FONT.mono, 500, 0.3);
    ctx.fillStyle = C.muted;
    ctx.globalAlpha = clamp(s) * prog(t, bar(28.8), bar(28.8) + 0.5);
    ctx.fillText(`${number(F.code.rustLines)} lines of Rust · ${F.code.rustCrates.length} crates · script VM, physics, AI, audio`, W - 96, yy + 112);
    ctx.restore();
  }
}
function bitBar(ctx, x, y, segments, t, seed, cell = 21.6) {
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
function precision(ctx, t) {
  const t0 = bar(30);
  header(ctx, t, t0, '03', 'PRECISION', 'THE x87 KEEPS 80 BITS.',
    'Native float math reproduced to the bit, including every place the original rounds.');
  const a1 = prog(t, t0 + 0.4, t0 + 0.8), a2 = prog(t, t0 + 0.7, t0 + 1.1);
  ctx.save();
  ctx.globalAlpha = a1;
  font(ctx, 20, FONT.mono, 600, 3);
  ctx.fillStyle = C.text;
  ctx.fillText('x87 EXTENDED · 80 BITS · Rust: Ext', 96, 350);
  bitBar(ctx, 96, 400, [[1, C.bad, 'S'], [15, C.ice, 'EXPONENT 15'], [64, C.gold, 'MANTISSA 64']], t, 1);
  ctx.globalAlpha = a2;
  font(ctx, 20, FONT.mono, 600, 3);
  ctx.fillStyle = C.text;
  ctx.fillText('FLOAT32 STORE · 32 BITS · Rust: .store()', 96, 520);
  const used = bitBar(ctx, 96, 570, [[1, C.bad, 'S'], [8, C.ice, 'EXP 8'], [23, C.gold, 'MANTISSA 23']], t, 2);
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = rgba(C.muted, 0.6);
  ctx.strokeRect(96 + used * 21.6, 570, (80 - used) * 21.6, 40);
  ctx.setLineDash([]);
  font(ctx, 17, FONT.mono, 600, 1);
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'center';
  ctx.fillText('ROUNDED AWAY AT EVERY fstp', 96 + (used + (80 - used) / 2) * 21.6, 597);
  ctx.textAlign = 'left';
  ctx.restore();
  // AICanHear's stores, next to the Rust lines that place them
  const stores = S.facts.disassembly.filter(d => /^fstp? dword/.test(d.text)).slice(0, 3);
  const rust = S.facts.port.filter(line => /\.store\(\)/.test(line)).slice(0, 3).map(line => line.trim());
  stores.forEach((d, i) => {
    const la = prog(t, bar(30.6) + i * 0.25, bar(30.6) + 0.3 + i * 0.25);
    if (la <= 0) return;
    const ly = 720 + i * 50;
    ctx.save();
    ctx.globalAlpha = la;
    font(ctx, 22, FONT.mono, 500, 0.3);
    ctx.fillStyle = C.dim; ctx.fillText(d.address, 96, ly);
    ctx.fillStyle = C.goldHi; ctx.fillText(d.text.replace(/\s+/g, ' '), 270, ly);
    ctx.fillStyle = C.ok; ctx.fillText('≡', 790, ly);
    ctx.fillStyle = C.text; ctx.fillText(rust[i] ?? '', 840, ly);
    ctx.restore();
  });
  const ca = prog(t, bar(31.2), bar(31.2) + 0.6);
  ctx.save();
  ctx.globalAlpha = ca;
  font(ctx, 28, FONT.title, 600, 0.5);
  ctx.fillStyle = C.text;
  ctx.fillText('Every fst / fstp where the original rounds — proven against the DLL, never approximated.', 96, 960);
  ctx.restore();
}

// ---------------------------------------------------------------- 5. one camera, two engines
const FR = {x: 176, y: 150, w: 1568, h: 882};
function sPairs(ctx, t) {
  background(ctx, t, 0.6);
  const t0 = T.pairs[0], per = (T.pairs[1] - t0) / PAIRS.length;
  const i = clamp(Math.floor((t - t0) / per), 0, PAIRS.length - 1);
  const p = (t - t0 - i * per) / per;
  const [id, map, what] = PAIRS[i];
  const orig = S.img[`pairs/${id}-o`], play = S.img[`pairs/${id}-p`];
  const {x, y, w, h} = FR, mid = x + w / 2;
  // the divider sweeps in from the right, rests near the middle with a slow drift, then leaves to the left
  const split = p < 0.12 ? lerp(x + w, mid + 140, ease.out3(inv(0, 0.12, p))) : p < 0.85 ? lerp(mid + 140, mid - 140, ease.inOut(inv(0.12, 0.85, p))) :
    lerp(mid - 140, x, ease.in3(inv(0.85, 1, p)));
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, w, h);
  cover(ctx, play, x, y, w, h, 1.0);
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, split - x, h); ctx.clip();
  cover(ctx, orig, x, y, w, h, 1.0);
  ctx.restore();
  ctx.shadowColor = rgba(C.gold, 0.9);
  ctx.shadowBlur = 16;
  ctx.fillStyle = C.goldHi;
  ctx.fillRect(split - 1.5, y, 3, h);
  ctx.restore();
  ctx.strokeStyle = rgba(C.line, 1);
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
  brackets(ctx, x - 10, y - 10, w + 20, h + 20, 1, rgba(C.gold, 0.9), 30, 2);
  chip(ctx, 'ORIGINAL · DeusEx.exe', x + 18, y + 44, C.gold);
  chip(ctx, 'BROWSER · PLAY', x + w - 18, y + 44, C.cyan, 'right');
  // header and the map
  tag(ctx, '04 — ONE CAMERA, TWO ENGINES', 96, 70, prog(t, t0, t0 + 0.4));
  font(ctx, 22, FONT.mono, 500, 0.5);
  ctx.fillStyle = C.goldHi;
  ctx.textAlign = 'right';
  ctx.fillText(typed(`${map} · ${what}`, prog(p, 0.05, 0.35, ease.linear)), W - 96, 72);
  ctx.textAlign = 'left';
  // the count, on the last pairs
  const ca = prog(t, T.pairs[1] - 4 * per, T.pairs[1] - 3.5 * per);
  if (ca > 0) {
    const F = S.facts;
    ctx.save();
    ctx.globalAlpha = ca;
    ctx.fillStyle = rgba('#03070c', 0.8);
    ctx.fillRect(x + 18, y + h - 96, 1000, 78);
    font(ctx, 34, FONT.din, 700, 1);
    ctx.fillStyle = C.text;
    ctx.fillText(`${F.captures.pairs} FRAME PAIRS FROM ${F.captures.maps.length} MAPS. THE STAGE 4 GATE: 70 OF 70 ROWS.`, x + 40, y + h - 46);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- 6. the road: commits per day, milestones, the stages
function sProgress(ctx, t) {
  background(ctx, t);
  const t0 = T.progress[0];
  if (t < bar(44)) return calendar(ctx, t, t0);
  stagesCard(ctx, t, bar(44));
}
function calendar(ctx, t, t0) {
  const F = S.facts;
  tag(ctx, '05 — THE ROAD', 96, 116, prog(t, t0, t0 + 0.4));
  font(ctx, 120, FONT.din, 700, 2);
  ctx.fillStyle = C.gold;
  const cp = prog(t, t0 + 0.2, t0 + 1.8);
  glowText(ctx, number(F.git.commits * cp), 96, 260, C.gold, 30, 0.35);
  const cw = ctx.measureText(number(F.git.commits)).width;
  font(ctx, 46, FONT.title, 700, 2);
  ctx.fillStyle = C.text;
  ctx.globalAlpha = prog(t, t0 + 0.4, t0 + 0.9);
  ctx.fillText(`commits in ${F.git.days} days`, 96 + cw + 30, 260);
  ctx.globalAlpha = 1;
  const days = F.git.calendar, max = Math.max(...days.map(d => d.commits));
  const x0 = 110, x1 = W - 110, base = 960, top = 600;
  const bw = (x1 - x0) / days.length;
  ctx.fillStyle = rgba(C.line, 1);
  ctx.fillRect(x0, base + 2, x1 - x0, 2);
  days.forEach((d, i) => {
    const g = prog(t, t0 + 0.3 + i * 0.03, t0 + 0.9 + i * 0.03, ease.out3);
    const bh = (base - top) * d.commits / max * g;
    const bx = x0 + i * bw + bw * 0.15, w = bw * 0.7;
    ctx.fillStyle = d.commits === max ? C.goldHi : rgba(C.gold, 0.72);
    ctx.fillRect(bx, base - bh, w, bh);
    if (i % 7 === 0) {
      font(ctx, 14, FONT.mono, 500, 1);
      ctx.fillStyle = C.muted;
      ctx.fillText(d.date.slice(5), bx, base + 28);
    }
  });
  // labels on the first of six rows where they clear the previous label on that row
  const rowsEnd = Array(6).fill(-Infinity);
  font(ctx, 17, FONT.title, 600, 0.3);
  F.milestones.forEach(([date, label], i) => {
    const di = days.findIndex(d => d.date === date);
    if (di < 0) return;
    const cx = x0 + di * bw + bw / 2, tw = ctx.measureText(label).width;
    const lx = clamp(cx - 8, 40, W - 40 - tw);
    let row = rowsEnd.findIndex(end => end + 24 < lx);
    if (row < 0) row = rowsEnd.indexOf(Math.min(...rowsEnd));
    rowsEnd[row] = lx + tw;
    const ma = prog(t, t0 + 1.0 + i * 0.3, t0 + 1.3 + i * 0.3);
    if (ma <= 0) return;
    const ly = 330 + row * 44;
    const done = /Stage \d complete/.test(label);
    ctx.save();
    ctx.globalAlpha = ma;
    ctx.strokeStyle = rgba(done ? C.ok : C.ice, 0.45);
    ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.moveTo(cx, ly + 8); ctx.lineTo(cx, base - 8); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = done ? C.ok : C.ice;
    ctx.beginPath(); ctx.arc(cx, ly + 8, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = done ? C.ok : C.text;
    ctx.fillText(label, lx, ly - 6);
    ctx.restore();
  });
}
function stagesCard(ctx, t, t0) {
  const F = S.facts, s6 = F.stage6;
  tag(ctx, '05 — THE ROAD', 96, 116, 1);
  font(ctx, 64, FONT.title, 700, 1);
  ctx.fillStyle = C.text;
  ctx.globalAlpha = prog(t, t0, t0 + 0.5);
  ctx.fillText(decode('STAGES 3, 4 AND 5 CLOSED. THE CAMPAIGN NEXT.', prog(t, t0, t0 + 0.8, ease.linear), 5), 96, 204);
  ctx.globalAlpha = 1;
  const cards = F.stages, w = 400, gap = 32, x0 = (W - (cards.length * w + (cards.length - 1) * gap)) / 2, y = 290, h = 300;
  cards.forEach((st, i) => {
    const a = prog(t, t0 + 0.3 + i * 0.3, t0 + 0.6 + i * 0.3);
    if (a <= 0) return;
    const x = x0 + i * (w + gap), done = Boolean(st.closed);
    panel(ctx, x, y + (1 - a) * 20, w, h, a);
    ctx.save();
    ctx.globalAlpha = a;
    font(ctx, 18, FONT.mono, 600, 3);
    ctx.fillStyle = C.muted;
    ctx.fillText(`STAGE ${st.stage}`, x + 28, y + 48);
    font(ctx, 90, FONT.din, 700, 1);
    ctx.fillStyle = done ? C.ok : C.gold;
    glowText(ctx, done ? (st.gate.match(/^\d+ of \d+/) ? st.gate.replace(' of ', '/') : '✓') : `${s6.total.PASS}/${s6.rows}`, x + 26, y + 150, done ? C.ok : C.gold, 22, 0.3);
    font(ctx, 21, FONT.title, 600, 0.3);
    ctx.fillStyle = C.text;
    const words = st.name.split(' '), lines = [''];
    for (const word of words) { if (ctx.measureText(`${lines.at(-1)} ${word}`).width > w - 56) lines.push(word); else lines[lines.length - 1] = `${lines.at(-1)} ${word}`.trim(); }
    lines.forEach((line, k) => ctx.fillText(line, x + 28, y + 196 + k * 28));
    font(ctx, 16, FONT.mono, 500, 1);
    ctx.fillStyle = done ? C.ok : C.goldHi;
    ctx.fillText(done ? `CLOSED ${st.closed}` : 'IN PROGRESS · ROWS PASSING', x + 28, y + h - 24);
    ctx.restore();
  });
  // Stage 6 in detail
  const facts = [
    [`${s6.endings} of 3`, 'endings equal the original, from their in-world triggers'],
    [`${s6.chains.length}`, 'missions’ required chains equal the original under Wine'],
    [number(s6.conversations), `conversations run to their end, in all ${s6.censusRows} mission lists`],
    [`${s6.clauses.Persistence.PASS} of ${s6.clauses.Persistence.PASS}`, 'persistence rows: saves, loads, return visits'],
  ];
  facts.forEach(([value, label], i) => {
    const a = prog(t, t0 + 1.6 + i * 0.35, t0 + 1.9 + i * 0.35);
    if (a <= 0) return;
    const x = 96 + (i % 2) * 880, yy = 700 + Math.floor(i / 2) * 120;
    ctx.save();
    ctx.globalAlpha = a;
    font(ctx, 66, FONT.din, 700, 1);
    ctx.fillStyle = C.gold;
    ctx.fillText(value, x, yy + 56);
    const vw = ctx.measureText(value).width;
    font(ctx, 24, FONT.title, 500, 0.3);
    ctx.fillStyle = C.text;
    ctx.fillText(label, x + vw + 24, yy + 44);
    ctx.restore();
  });
}

// ---------------------------------------------------------------- 7. the numbers
function sNumbers(ctx, t) {
  background(ctx, t);
  const F = S.facts, t0 = T.numbers[0];
  tag(ctx, '06 — THE EVIDENCE', 96, 116, prog(t, t0, t0 + 0.4));
  const tiles = [
    [F.code.runtimeLines, 'lines of JavaScript: the page, glue, validators'],
    [F.code.rustLines, 'lines of Rust, compiled to WebAssembly'],
    [F.code.validators, 'validators against original data'],
    [F.code.nativeOracles, 'native-code oracle checks'],
    [F.code.docs, 'evidence documents'],
    [0, 'Windows binaries run in the browser'],
  ];
  const cols = 3, tw = 540, th = 300, gx = 42, gy = 50, x0 = (W - (cols * tw + (cols - 1) * gx)) / 2, y0 = 210;
  tiles.forEach(([value, label], i) => {
    const s = t0 + 0.2 + i * 0.3;
    const a = prog(t, s, s + 0.4);
    if (a <= 0) return;
    const x = x0 + (i % cols) * (tw + gx), y = y0 + Math.floor(i / cols) * (th + gy) + (1 - a) * 24;
    panel(ctx, x, y, tw, th, a);
    ctx.save();
    ctx.globalAlpha = a;
    font(ctx, 128, FONT.din, 700, 2);
    const shown = bigCount(value, prog(t, s + 0.1, s + 1.4, ease.linear));
    const color = i === 5 ? C.ok : C.gold;
    glowText(ctx, shown, x + 40, y + 170, color, 24, 0.3);
    font(ctx, 24, FONT.title, 600, 0.3);
    ctx.fillStyle = C.text;
    ctx.fillText(label, x + 44, y + 236);
    ctx.restore();
  });
}

// ---------------------------------------------------------------- 8. the end card
function wireOrbit({cx = 3000, cy = -1500, cz = -100, radius = 7600, height = 4300, angle = 200, fov = 45}) {
  const a = angle * Math.PI / 180;
  return {eye: [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, height], target: [cx, cy, cz], fov};
}
function drawWire(ctx, view, alpha = 1) {
  const layer = S.wire.render(view);
  ctx.save();
  ctx.filter = 'blur(7px)';
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha * 0.8;
  ctx.drawImage(layer, 0, 0);
  ctx.filter = 'none';
  ctx.globalAlpha = alpha;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}
function sOutro(ctx, t) {
  background(ctx, t, 0.7);
  const t0 = T.outro[0], lt = t - t0, end = DURATION;
  drawWire(ctx, {...wireOrbit({angle: 250 + lt * 4, radius: 7400 + lt * 420, height: 2600 + lt * 260, cz: 2600}),
    scan: lerp(-1600, 8400, ease.inOut(inv(t0, t0 + 4, t))), opacity: 0.6 * (1 - prog(t, end - 3, end - 1)), near: 4000, far: 20000},
    prog(t, t0, t0 + 0.3));
  const g = ctx.createRadialGradient(W / 2, 500, 50, W / 2, 500, 950);
  g.addColorStop(0, rgba('#03070c', 0.9));
  g.addColorStop(1, rgba('#03070c', 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const F = S.facts;
  const a = prog(t, t0 + 0.2, t0 + 0.8) * (1 - prog(t, end - 2.2, end - 0.8));
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = 'center';
  font(ctx, 150, FONT.title, 700, 40);
  glowText(ctx, decode('DEUS EX', prog(t, t0, t0 + 0.9, ease.linear), 3, 0.5), W / 2 + 20, 450, C.gold, 40, 0.42);
  font(ctx, 32, FONT.mono, 600, 22);
  ctx.fillStyle = C.text;
  ctx.fillText('BROWSER RUNTIME', W / 2 + 11, 520);
  ctx.globalAlpha = a * prog(t, bar(53), bar(53) + 0.6);
  font(ctx, 26, FONT.mono, 500, 1);
  ctx.fillStyle = C.muted;
  ctx.fillText(`Stages 3, 4 and 5 complete · Stage 6, saves and the campaign: ${F.stage6.total.PASS} of ${F.stage6.rows} rows`, W / 2, 620);
  ctx.globalAlpha = a * prog(t, bar(54), bar(54) + 0.7);
  font(ctx, 42, FONT.title, 600, 1);
  ctx.fillStyle = C.goldHi;
  ctx.fillText('Built from evidence. Nothing invented.', W / 2, 705);
  ctx.textAlign = 'left';
  ctx.restore();
}

const SCENES = [
  [T.open, sOpen], [T.reveal, sReveal], [T.island, sIsland], [T.method, sMethod], [T.pairs, sPairs],
  [T.progress, sProgress], [T.numbers, sNumbers], [[T.outro[0], DURATION], sOutro],
];

// ---------------------------------------------------------------- post
const MAJOR = Object.values(SECTIONS).map(([b]) => bar(b)).filter(t => t > 0);
const CUTS = [...MAJOR, ...FOOTAGE.map(s => s.t0), bar(27), bar(30), bar(44),
  ...PAIRS.map((_, i) => T.pairs[0] + i * (T.pairs[1] - T.pairs[0]) / PAIRS.length)];
const HITS = [bar(8), bar(12), bar(32), bar(52)];
const grainCanvas = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const data = g.createImageData(512, 512);
  let s = 12345;
  for (let i = 0; i < data.data.length; i += 4) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const v = s >>> 24;
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
  let glitch = 0;
  for (const cut of CUTS) {
    const major = MAJOR.includes(cut), d = Math.abs(t - cut), r = major ? 0.13 : 0.06;
    if (d < r) glitch = Math.max(glitch, (major ? 1 : 0.45) * (1 - d / r));
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
    ctx.globalAlpha = 0.2 * glitch;
    ctx.filter = 'sepia(1) saturate(6) hue-rotate(160deg)';
    ctx.drawImage(tmp, -10 * glitch, 0);
    ctx.filter = 'sepia(1) saturate(6) hue-rotate(-30deg)';
    ctx.drawImage(tmp, 10 * glitch, 0);
    ctx.restore();
  }
  // a flash on each gong
  for (const hit of HITS) {
    const flash = Math.max(0, 1 - Math.abs(t - hit) / 0.2);
    if (flash > 0) { ctx.fillStyle = rgba(C.goldHi, 0.3 * flash); ctx.fillRect(0, 0, W, H); }
  }
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = ctx.createPattern(scanCanvas, 'repeat');
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.05;
  ctx.globalCompositeOperation = 'overlay';
  const ox = Math.floor(hash(frame * 3) * 512), oy = Math.floor(hash(frame * 5) * 512);
  ctx.translate(-ox, -oy);
  ctx.fillStyle = ctx.createPattern(grainCanvas, 'repeat');
  ctx.fillRect(ox, oy, W, H);
  ctx.restore();
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  const edge = Math.max(1 - inv(0, 0.4, t), inv(DURATION - 0.8, DURATION, t));
  if (edge > 0) { ctx.fillStyle = `rgba(0,0,0,${edge})`; ctx.fillRect(0, 0, W, H); }
}

// ---------------------------------------------------------------- driver
async function init() {
  const fonts = [`700 100px ${FONT.title}`, `600 40px ${FONT.title}`, `500 40px ${FONT.title}`, `600 30px ${FONT.mono}`,
    `500 30px ${FONT.mono}`, `400 30px ${FONT.mono}`, `700 100px ${FONT.din}`];
  await Promise.all(fonts.map(f => document.fonts.load(f)));
  S.facts = await (await fetch('/ad/build/facts.json')).json();
  S.clipLengths = await (await fetch('/ad/build/clips.json')).json();
  S.wire = await createWire('/reports/00_Training/world.obj', W, H);
  await Promise.all(STILLS.map(async name => { S.img[name] = await cache.get(`/ad/build/assets/${name}.jpg`); }));
  return {duration: DURATION, fps: FPS, edges: S.wire.edges, clips: S.clipLengths};
}

async function renderFrame(t) {
  const f = footageAt(t);
  if (f && !S.frames.has(f.url)) {
    if (S.frames.size > 8) S.frames.delete(S.frames.keys().next().value);
    S.frames.set(f.url, await frameCache.get(f.url));
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
