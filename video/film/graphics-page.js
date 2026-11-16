// The drawing half of graphics.mjs: runs in the headless page. window.setup(cfg) once, then window.draw(f) -> PNG (base64)
// for shot frame f (1-based). Everything is drawn on a 1280x720 logical canvas scaled by H/720, so any 16:9 --size works.
// Every figure on screen arrives in cfg (steps, facts) from graphics.mjs, which names the document or git command each
// one comes from; nothing numeric is typed here except layout.
'use strict';

const C = {bg: '#0c1017', text: '#e8e4dc', dim: '#9aa3b2', faint: '#5b6677', orange: '#D97757', orangeL: '#f08a5d', cyan: 'rgb(120,200,255)', cyanL: 'rgb(214,238,255)'};
const VGA = 'vga, "PxPlus IBM VGA8", monospace', MONO = '"iA Writer Mono S", "JetBrainsMono Nerd Font", monospace', SANS = '"Noto Sans", "Liberation Sans", system-ui, sans-serif';
let cfg, cv, g, K = 1, OX = 0, facts;
const IMG = {};                                                             // name -> {img, cx, bottom, w, h}

// ------------------------------------------------------------------------------------------------------ helpers
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };
const inOut = t => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const outCubic = t => 1 - Math.pow(1 - clamp(t), 3);
const outBack = t => { t = clamp(t); const c = 1.70158, d = c + 1; return 1 + d * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const fmt = n => Math.round(n).toLocaleString('en-US');
// 1 on frame f0, falling to 0 over len frames (0 before f0)
const pulse = (f, f0, len) => (f < f0 ? 0 : clamp(1 - (f - f0) / len));
const pulseAny = (f, list, len) => list.reduce((m, f0) => Math.max(m, pulse(f, f0, len)), 0);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function text(str, x, y, o) {
  g.save();
  g.font = `${o.weight ?? ''} ${o.size}px ${o.font ?? MONO}`.trim();
  g.textAlign = o.align ?? 'left'; g.textBaseline = 'alphabetic';
  g.globalAlpha = (o.alpha ?? 1);
  if (o.glow) { g.shadowColor = o.glowColor ?? o.color; g.shadowBlur = o.glow * K; }
  g.fillStyle = o.color ?? C.text;
  g.fillText(str, x, y);
  g.restore();
}
const width = (str, size, font, weight = '') => { g.save(); g.font = `${weight} ${size}px ${font}`.trim(); const w = g.measureText(str).width; g.restore(); return w; };
function rrect(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function glowLine(pts, color, w, blur, alpha = 1) {
  g.save(); g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = w; g.lineJoin = 'round'; g.lineCap = 'round';
  g.shadowColor = color; g.shadowBlur = blur * K;
  g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); g.restore();
}
function backdrop(o = {}) {
  // near-black navy with a faint grid and a soft light behind the middle
  const r = g.createRadialGradient(640, 330, 60, 640, 360, 760);
  r.addColorStop(0, o.lift ? `rgba(30,42,60,${0.9 * o.lift})` : 'rgba(22,30,44,0.8)'); r.addColorStop(1, 'rgba(12,16,23,0)');
  g.fillStyle = C.bg; g.fillRect(-OX / K, 0, cv.width / K, 720);
  g.fillStyle = r; g.fillRect(-OX / K, 0, cv.width / K, 720);
  if (o.grid !== false) {
    g.save(); g.strokeStyle = 'rgba(120,200,255,0.045)'; g.lineWidth = 1;
    const step = 40, off = (o.scroll ?? 0) % step;
    g.beginPath();
    for (let x = -OX / K + off; x < 1280 + OX / K; x += step) { g.moveTo(x, 0); g.lineTo(x, 720); }
    for (let y = 0; y < 720; y += step) { g.moveTo(-OX / K, y); g.lineTo(1280 + OX / K, y); }
    g.stroke(); g.restore();
  }
}
function vignette(a = 0.5) {
  const v = g.createRadialGradient(640, 360, 250, 640, 360, 820);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, `rgba(0,0,0,${a})`);
  g.fillStyle = v; g.fillRect(-OX / K, 0, cv.width / K, 720);
}
// a little noise over the dark gradients, so 8-bit video does not band them (a fresh offset every frame)
let GRAIN = null;
function grain(f, a = 0.014) {
  if (!GRAIN) {
    GRAIN = document.createElement('canvas'); GRAIN.width = GRAIN.height = 256; const k = GRAIN.getContext('2d'), d = k.createImageData(256, 256), r = rng(99);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.floor(r() * 256); d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
    k.putImageData(d, 0, 0);
  }
  const r2 = rng(f * 7919 + 3), ox = Math.floor(r2() * 256), oy = Math.floor(r2() * 256);
  g.save(); g.globalAlpha = a;
  g.setTransform(1, 0, 0, 1, 0, 0);
  const pat = g.createPattern(GRAIN, 'repeat'); g.translate(-ox, -oy); g.fillStyle = pat; g.fillRect(ox, oy, cv.width, cv.height);
  g.restore();
}
function scanlines(a = 0.2) { g.fillStyle = `rgba(0,0,0,${a})`; for (let y = 0; y < 720; y += 4) g.fillRect(-OX / K, y, cv.width / K, 2); }

// a sprite stood on (x, y) (the middle of its feet): s px per sprite px, rot radians about the feet, sx/sy squash
function sprite(name, x, y, s, o = {}) {
  const m = IMG[name]; g.save();
  g.translate(x, y); g.rotate(o.rot ?? 0); g.scale((o.sx ?? 1) * s * (o.flip ? -1 : 1), (o.sy ?? 1) * s);
  g.globalAlpha = o.alpha ?? 1;
  g.imageSmoothingQuality = 'high';
  g.drawImage(m.img, -m.cx, -m.bottom);
  g.restore();
}
const loadImage = url => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
function alphaBox(img) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const k = c.getContext('2d'); k.drawImage(img, 0, 0); const d = k.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, x1 = 0, y0 = c.height, y1 = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return {x0, x1, y0, y1};
}

window.setup = async c => {
  cfg = c; facts = c.facts;
  cv = document.getElementById('c'); cv.width = c.W; cv.height = c.H; g = cv.getContext('2d');
  K = c.H / 720; OX = (c.W - 1280 * K) / 2;
  await document.fonts.load('64px vga'); await document.fonts.load('20px "iA Writer Mono S"'); await document.fonts.load('600 40px "Noto Sans"'); await document.fonts.ready;
  for (const [name, url] of Object.entries(c.images)) {
    const img = await loadImage(url), b = name === 'plate' ? null : alphaBox(img);
    IMG[name] = {img, w: img.width, h: img.height, cx: b ? (b.x0 + b.x1) / 2 : 0, bottom: b ? b.y1 : 0, box: b};
  }
  SHOT[c.id].init?.();
  return {font: document.fonts.check('64px vga'), info: SHOT[c.id].info?.()};
};
window.draw = f => {
  g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = C.bg; g.fillRect(0, 0, cv.width, cv.height);
  g.setTransform(K, 0, 0, K, OX, 0);
  SHOT[cfg.id].draw(f);
  grain(f);
  g.setTransform(1, 0, 0, 1, 0, 0);
  return cv.toDataURL('image/png').slice(22);
};

const SHOT = {};

// ===================================================================================================================
// 1. frame-times: the Island's frame time falling over the project's history, the crab riding the line down
// ===================================================================================================================
SHOT['frame-times'] = {
  init() {
    const S = this;
    S.steps = cfg.steps; S.x0 = 200; S.dx = 145; S.yTop = 235; S.yBot = 520; S.msTop = 100; S.msBot = 3.5;
    S.px = k => S.x0 + k * S.dx;
    S.py = ms => S.yTop + (S.yBot - S.yTop) * Math.log(S.msTop / ms) / Math.log(S.msTop / S.msBot);
    // the crab arrives at node k on the k-th kick of the shot (kick on every beat) and leaves 4 frames after landing
    const kicks = cfg.cues.kick;
    S.arr = kicks.slice(0, S.steps.length); S.accent = kicks[S.steps.length];
    S.dep = S.arr.map(a => a + 4);
    S.theta = S.steps.slice(0, -1).map((_, k) => Math.atan2(S.py(S.steps[k + 1].ms) - S.py(S.steps[k].ms), S.dx));
  },
  info() { return `arrivals ${this.arr.join(',')} accent ${this.accent}`; },
  // where the crab is at frame f: {k (node it stands on or leaves), s (0..1 along the segment), x, y, rot, flight}
  crab(f) {
    const S = this, n = S.steps.length;
    for (let k = 0; k < n - 1; k++) {
      if (f >= S.dep[k] && f < S.arr[k + 1]) {
        const u = (f - S.dep[k]) / (S.arr[k + 1] - S.dep[k]), s = 0.5 * smooth(u) + 0.5 * u * u;   // a drop: the landing is the fastest part
        const x = lerp(S.px(k), S.px(k + 1), s), y = lerp(S.py(S.steps[k].ms), S.py(S.steps[k + 1].ms), s);
        const hop = (7 + 0.07 * Math.abs(S.py(S.steps[k + 1].ms) - S.py(S.steps[k].ms))) * 4 * u * (1 - u);
        return {k, s, u, x, y, hop, rot: S.theta[k] + (-0.16) * Math.sin(Math.PI * u) + 0.1 * (u - 0.5), flight: true};
      }
    }
    // standing on a node: the last arrival at or before f
    let k = 0; for (let i = 0; i < n; i++) if (f >= S.arr[i]) k = i;
    const prev = k > 0 ? S.theta[k - 1] : S.theta[0], next = k < n - 1 ? S.theta[k] : 0;
    const lean = k === n - 1 ? lerp(prev, 0, smooth((f - S.arr[k]) / 10)) : lerp(prev, next, smooth((f - S.arr[k]) / 4));
    return {k, s: 0, u: 0, x: S.px(k), y: S.py(S.steps[k].ms), hop: 0, rot: lean, flight: false, since: f - S.arr[k]};
  },
  value(f) {                     // the readouts' ms and fps at frame f
    const S = this, c = S.crab(f), A = S.steps[c.k];
    if (!c.flight) return {ms: A.label, fps: A.fpsLabel};
    const B = S.steps[c.k + 1], ms = Math.exp(lerp(Math.log(A.ms), Math.log(B.ms), c.s)), fps = 1000 / ms;
    // the figures roll between two documented values; the fps roll never passes the value it is rolling to (the last step's is capped by the display)
    const fr = Math.min(fps, B.fps);
    return {ms: ms >= 50 ? String(Math.round(ms)) : ms.toFixed(1), fps: fr < 20 ? fr.toFixed(1) : String(Math.round(fr))};
  },
  draw(f) {
    const S = this, st = S.steps, n = st.length, c = S.crab(f);
    const beat = pulseAny(f, cfg.cues.kick, 5);
    backdrop({scroll: f * 0.6, lift: 1}); vignette(0.35);
    // axes: the log scale's ticks, the two targets (16.7 ms is 60 fps, 8.3 ms is 120 fps: AGENTS.md)
    g.save();
    for (const v of [100, 50, 20, 10, 5]) {
      const y = S.py(v); g.strokeStyle = 'rgba(232,228,220,0.07)'; g.lineWidth = 1; g.beginPath(); g.moveTo(130, y); g.lineTo(1216, y); g.stroke();
      text(String(v), 118, y + 6, {size: 18, color: C.faint, align: 'right'});
    }
    text('ms', 118, S.yTop - 22, {size: 18, color: C.faint, align: 'right'});
    g.restore();
    const lit60 = c.k >= 4 && f >= S.arr[4] ? 1 : 0, lit120 = c.k >= 6 ? 1 : 0;
    for (const [v, label, color, lit, t0] of [[16.7, '60 fps', C.cyan, lit60, S.arr[4]], [8.3, '120 fps', C.orangeL, lit120, S.arr[6]]]) {
      const y = S.py(v), hit = lit ? pulse(f, t0, 14) : 0;
      g.save(); g.setLineDash([10, 8]); g.strokeStyle = color; g.globalAlpha = lit ? 0.55 + 0.4 * hit : 0.26; g.lineWidth = lit ? 2 : 1.5;
      g.beginPath(); g.moveTo(132, y); g.lineTo(1216, y); g.stroke(); g.restore();
      text(label, 140, y - 8, {size: 20, color, alpha: lit ? 1 : 0.6, glow: lit ? 8 + 14 * hit : 0});
    }
    // heading
    text('UNATCO ISLAND', 64, 88, {size: 24, color: C.orangeL, weight: 'bold'});
    text('milliseconds per frame, log scale, 2026', 64, 114, {size: 18, color: C.dim});
    // readouts, top right
    const val = S.value(f), flash = pulseAny(f, S.arr, 4);
    text('MS PER FRAME', 900, 84, {size: 18, color: C.dim, align: 'right'});
    text(val.ms, 856, 156, {font: VGA, size: 64, color: C.orangeL, align: 'right', glow: 10 + 14 * flash, alpha: 1});
    text('ms', 900, 156, {font: VGA, size: 32, color: C.orange, align: 'right', alpha: 0.9});
    text('FRAMES PER SECOND', 1216, 84, {size: 18, color: C.dim, align: 'right'});
    text(val.fps, 1156, 156, {font: VGA, size: 64, color: C.cyanL, align: 'right', glow: 10 + 14 * flash, glowColor: C.cyan});
    text('fps', 1216, 156, {font: VGA, size: 32, color: C.cyan, align: 'right', alpha: 0.9});
    // fps is 1000 / ms (the first two as the doc states them: about 12 and 17.5); the last step's was measured
    text('fps = 1000 / ms', 1216, 186, {size: 18, color: C.faint, align: 'right', alpha: c.k >= n - 1 ? 1 - smooth((f - S.arr[n - 1]) / 6) : 1});
    if (c.k >= n - 1) text('118.9 measured, 120 Hz display', 1216, 186, {size: 18, color: C.dim, align: 'right', alpha: smooth((f - S.arr[n - 1]) / 6)});
    // the line, up to the crab; the area under it
    const pts = []; for (let k = 0; k <= c.k; k++) pts.push([S.px(k), S.py(st[k].ms)]);
    if (c.flight) pts.push([c.x, c.y]);
    if (pts.length > 1) {
      const fill = g.createLinearGradient(0, S.yTop, 0, S.yBot);
      fill.addColorStop(0, 'rgba(120,200,255,0.11)'); fill.addColorStop(1, 'rgba(120,200,255,0)');
      g.fillStyle = fill; g.beginPath(); g.moveTo(pts[0][0], S.yBot + 30); pts.forEach(p => g.lineTo(p[0], p[1])); g.lineTo(pts[pts.length - 1][0], S.yBot + 30); g.closePath(); g.fill();
    }
    if (pts.length > 1) glowLine(pts, C.cyan, 4, 14 + 10 * beat);
    // the steps: a dot, a ring on arrival, the figure and the date under it
    for (let k = 0; k <= c.k; k++) {
      const x = S.px(k), y = S.py(st[k].ms), q = f - S.arr[k];
      const ring = pulse(f, S.arr[k], 10);
      g.save(); g.fillStyle = C.cyanL; g.shadowColor = C.cyan; g.shadowBlur = 12 * K; g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill(); g.restore();
      if (ring > 0) { g.save(); g.strokeStyle = C.orangeL; g.globalAlpha = ring; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 8 + 34 * (1 - ring), 0, 7); g.stroke(); g.restore(); }
      const a = smooth(q / 4);
      text(st[k].label, x - 30, y + 46, {font: VGA, size: 32, color: C.orangeL, align: 'center', alpha: a, glow: 6});
      text(st[k].date, x - 30, y + 70, {size: 18, color: C.dim, align: 'center', alpha: a});
    }
    // which machine and which figure each stretch of the line is
    const gstart = [], gend = [];
    st.forEach((s, k) => { gstart[s.group] ??= k; gend[s.group] = k; });
    cfg.groups.forEach((cap, gi) => {
      const k0 = gstart[gi], k1 = gend[gi], enter = f - S.arr[k0];
      if (enter < 0) return;
      const a = smooth(enter / 6), x0 = S.px(k0) - 44, x1 = S.px(k1) + (gi === 3 ? 90 : 30), mid = (x0 + x1) / 2;
      g.save(); g.globalAlpha = a; g.strokeStyle = 'rgba(120,200,255,0.5)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x0, 618); g.lineTo(x0, 608); g.lineTo(x1, 608); g.lineTo(x1, 618); g.stroke(); g.restore();
      text(cap[0], mid, 640, {size: 20, color: C.text, align: 'center', alpha: a});
      text(cap[1], mid, 662, {size: 18, color: C.dim, align: 'center', alpha: a});
    });
    // the crab, on the line
    const stand = c.flight ? c : {...c, hop: 0};
    let sx = 1, sy = 1;
    if (c.flight) { sy = 1 + 0.07 * Math.sin(Math.PI * c.u); sx = 1 - 0.04 * Math.sin(Math.PI * c.u); }
    else { const q = c.since ?? 99, d = clamp(1 - q / 9); sy = 1 - 0.2 * d * d * Math.cos(q * 0.9); sx = 1 + 0.12 * d * d; }
    let pose = 'ride-open';
    if (c.flight && c.k >= 2 && c.k <= 4 && c.u > 0.15) pose = 'ride-wide';
    if (c.k >= n - 1 || f >= S.arr[n - 1]) pose = 'ride-smile';
    let hopA = 0;
    if (f >= S.accent) { const q = f - S.accent; hopA = 18 * Math.max(0, Math.sin(clamp(q / 12) * Math.PI)); }
    const bob = !c.flight && c.k >= n - 1 ? 2 * Math.sin(f * 0.35) : 0;
    g.save(); g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 0;
    sprite(pose, stand.x, stand.y + 5 - stand.hop - hopA + bob, 0.3, {rot: stand.rot, sx, sy});
    g.restore();
    // a bright edge on the beat
    if (beat > 0) { g.fillStyle = `rgba(240,138,93,${0.05 * beat})`; g.fillRect(-OX / K, 0, cv.width / K, 720); }
  },
};

// ===================================================================================================================
// 2. build: a rhythmic montage of the project's real parts and numbers, accelerating into the cut
// ===================================================================================================================
SHOT.build = {
  init() {
    const S = this, kicks = cfg.cues.kick.slice(0, 8), k7 = kicks[7];
    // the first eight cards on the kick eighths, then a roll that gets shorter until the last card
    const durs = [5, 4, 4, 3, 3, 2, 2, 2];
    S.starts = [...kicks]; let t = k7 + 6;
    for (const d of durs) { S.starts.push(t); t += d; }
    S.starts.push(t);                                                        // the last card runs to the cut
    S.names = ['script-vm', 'lodmesh-kernel', 'galaxy-kernel', 'total', 'worker', 'js', 'validators', 'docs', 'commits', 'days', 'stage4', 'stage5', 'stage6', 'map0', 'map1', 'map2', 'maps'];
    S.cards = S.names.map((name, i) => ({name, f0: S.starts[i], f1: (S.starts[i + 1] ?? cfg.frames + 1) - 1}));
    S.mapsShown = ['01_NYC_UNATCOIsland', '06_HongKong_WanChai_Market', '15_Area51_Bunker'];
    S.crates = Object.fromEntries(facts.crates.map(c => [c.name, c]));
    S.about = {'script-vm': 'the simulation core: object image, script VM, physics', 'lodmesh-kernel': 'mesh posing and lighting: GetFrame, DrawLodMesh', 'galaxy-kernel': 'Galaxy audio: music, mixer, reverb'};
    S.perDay = []; { const d0 = Date.parse(facts.first), d1 = Date.parse(facts.last); for (let d = d0; d <= d1; d += 864e5) S.perDay.push(facts.perDay[new Date(d).toISOString().slice(0, 10)] ?? 0); }
  },
  info() { return this.cards.map(c => `${c.name}:${c.f0}-${c.f1}`).join(' '); },
  cardAt(f) { let i = 0; for (let k = 0; k < this.cards.length; k++) if (f >= this.cards[k].f0) i = k; return i; },
  draw(f) {
    const S = this, i = S.cardAt(f), card = S.cards[i], q = f - card.f0, n = card.f1 - card.f0 + 1, p = n > 1 ? q / (n - 1) : 1;
    const cutFlash = pulse(f, card.f0, 3);
    backdrop({scroll: f * 3, lift: 1}); vignette(0.3);
    const slam = 1 + 0.1 * Math.pow(clamp(1 - q / 3), 2);                  // every card lands a little big
    const count = (v, over) => Math.round(v * (0.12 + 0.88 * outCubic(q / Math.max(1, Math.min(over, n - 1)))));
    const tag = (str, x = 64, y = 92) => text(str, x, y, {size: 24, color: C.orangeL, weight: 'bold'});
    const code = lines => {
      g.save(); g.beginPath(); g.rect(640, 0, 640, 720); g.clip(); g.globalAlpha = 0.085; const off = (q * 30 + card.f0 * 7) % (lines.length * 22);
      lines.forEach((l, j) => { const y = ((j * 22 - off) % (lines.length * 22) + lines.length * 22) % (lines.length * 22) + 20; text(l, 640, y, {size: 17, color: C.cyan}); });
      g.restore();
    };
    const big = (str, x, y, size, color, o = {}) => { g.save(); g.translate(x, y); g.scale(slam, slam); text(str, 0, 0, {font: VGA, size, color, glow: 12, glowColor: o.glowColor ?? color, align: o.align, alpha: o.alpha}); g.restore(); };
    const nm = card.name;
    if (S.crates[nm]) {
      const cr = S.crates[nm];
      code(facts.code[nm]);
      tag(`native/${nm}`);
      big(nm, 64, 300, 128, C.orange);
      text(S.about[nm], 64, 360, {size: 28, color: C.text});
      big(count(cr.lines, 9).toLocaleString('en-US'), 64, 480, 96, C.cyanL, {glowColor: C.cyan});
      text(`lines of Rust, in ${cr.files} ${cr.files === 1 ? 'file' : 'files'}`, 64, 530, {size: 28, color: C.dim});
      g.save(); g.fillStyle = C.orange; rrect(64, 566, 304, 40, 6); g.fill(); g.restore();
      text('Rust to WebAssembly', 80, 594, {size: 24, color: C.bg, weight: 'bold'});
    } else if (nm === 'total') {
      const tot = facts.rust.lines;
      tag('native/');
      big(count(tot, 9).toLocaleString('en-US'), 64, 300, 160, C.cyanL, {glowColor: C.cyan});
      text('lines of Rust in 3 crates', 64, 360, {size: 34, color: C.text});
      const total = facts.crates.reduce((a, c) => a + c.lines, 0), cols = {'script-vm': C.orange, 'galaxy-kernel': C.cyan, 'lodmesh-kernel': C.text};
      let x = 64; const bw = 1000 * outCubic(q / 6);
      for (const cr of facts.crates) {
        const w = bw * cr.lines / total; g.fillStyle = cols[cr.name]; g.globalAlpha = 0.9; g.fillRect(x, 430, Math.max(0, w - 3), 54); g.globalAlpha = 1;
        if (cr.name === 'lodmesh-kernel') text(`${cr.name} ${fmt(cr.lines)}`, x + w - 3, 412, {size: 22, color: C.dim, align: 'right', alpha: smooth(q / 6)});
        else text(`${cr.name} ${fmt(cr.lines)}`, cr.name === 'galaxy-kernel' ? x + w - 3 : x + 4, 520, {size: 22, color: C.dim, align: cr.name === 'galaxy-kernel' ? 'right' : 'left', alpha: smooth(q / 6)});
        x += w;
      }
    } else if (nm === 'worker') {
      tag('the page and the worker');
      big('Web Worker', 64, 240, 96, C.orange);
      text('keeps the simulation off the page\'s main thread', 64, 290, {size: 28, color: C.text});
      const lane = (y, label, color, phase) => {
        g.fillStyle = 'rgba(232,228,220,0.06)'; g.fillRect(64, y, 1152, 74);
        text(label, 80, y + 44, {size: 26, color: C.text});
        for (let b = 0; b < 5; b++) { const x = 720 + ((b * 100 + (q + phase) * 22) % 500); g.fillStyle = color; g.globalAlpha = 0.85; g.fillRect(x, y + 14, 64, 46); g.globalAlpha = 1; }
      };
      lane(340, 'page: three.js, WebGL2, Web Audio', C.cyan, 0);
      lane(430, 'worker: the Rust core and the script VM', C.orange, 3);
    } else if (nm === 'js') {
      tag('src/ scripts/ test/ ...');
      big(count(facts.jsLines, 6).toLocaleString('en-US'), 64, 320, 160, C.cyanL, {glowColor: C.cyan});
      text('lines of JavaScript', 64, 390, {size: 38, color: C.text});
      text(`in ${fmt(facts.jsFiles)} files, .mjs and .js`, 64, 436, {size: 26, color: C.dim});
      g.fillStyle = C.orange; g.fillRect(64, 480, 990 * outCubic(q / 5), 8);
    } else if (nm === 'validators' || nm === 'docs' || nm === 'commits') {
      const list = nm === 'validators' ? facts.validators : nm === 'docs' ? facts.docs : facts.subjects.map(s => `${s[0]}  ${s[1].length > 40 ? s[1].slice(0, 37) + '...' : s[1]}`);
      const num = nm === 'validators' ? facts.validators.length : nm === 'docs' ? facts.docs.length : facts.commits;
      const label = nm === 'validators' ? 'validators' : nm === 'docs' ? 'notes in docs/' : 'commits';
      const where = nm === 'validators' ? 'scripts/validate-*.mjs' : nm === 'docs' ? 'docs/**/*.md' : `git log, ${facts.first} to ${facts.last}`;
      tag(where);
      big(fmt(num), 64, 330, 160, C.cyanL, {glowColor: C.cyan});
      text(label, 64, 396, {size: 40, color: C.text});
      g.save(); g.beginPath(); g.rect(560, 40, 656, 500); g.clip();
      const row = 30, off = (q * 83 + card.f0 * 29) % (list.length * row);
      for (let j = 0; j < 22; j++) {
        const idx = (Math.floor(off / row) + j) % list.length, y = 70 + j * row - (off % row);
        text(list[idx], 568, y, {size: 22, color: j === 9 ? C.cyanL : C.cyan, alpha: j === 9 ? 1 : 0.5});
      }
      g.restore();
    } else if (nm === 'days') {
      tag(`first commit ${facts.first}, last ${facts.last}`);
      big(String(facts.days), 64, 260, 160, C.cyanL, {glowColor: C.cyan});
      text('days', 64 + 3 * 80 + 24, 260, {size: 40, color: C.text});
      const max = Math.max(...S.perDay), bw = 990 / S.perDay.length;
      S.perDay.forEach((v, j) => { const h = 280 * v / max * outCubic(clamp((q + 1) / 3 - j / S.perDay.length * 0.5)); g.fillStyle = v ? C.orange : 'rgba(232,228,220,0.12)'; g.fillRect(64 + j * bw, 620 - Math.max(h, 3), bw - 3, Math.max(h, 3)); });
      text('commits a day', 64, 664, {size: 20, color: C.dim});
    } else if (/^stage/.test(nm)) {
      const row = {stage4: ['STAGE 4', '70 of 70', 'criteria', 'presentation: meshes, lighting, effects, HUD, sound'], stage5: ['STAGE 5', '50 of 50', 'scenarios', 'gameplay: movement, AI, combat, conversations'], stage6: ['STAGE 6', '54 of 54', 'rows', 'saves, map travel, the whole campaign']}[nm];
      tag('README.md, Status');
      big(row[0], 64, 230, 64, C.orange);
      big(row[1], 64, 400, 192, C.cyanL, {glowColor: C.cyan});
      text(row[2], 64, 470, {size: 44, color: C.text});
      text(row[3], 64, 520, {size: 26, color: C.dim});
      g.fillStyle = C.cyan; g.fillRect(64, 560, 990, 10);
    } else if (/^map\d/.test(nm)) {
      const name = S.mapsShown[Number(nm.slice(3))], idx = facts.maps.indexOf(name) + 1;
      tag('the 83 single-player maps');
      big(`${idx} / ${facts.maps.length}`, 64, 230, 96, C.cyanL, {glowColor: C.cyan});
      big(name, 64, 400, name.length > 20 ? 64 : 80, C.text, {glowColor: C.cyan});
      g.fillStyle = C.orange; g.fillRect(64, 450, 990 * idx / facts.maps.length, 8);
    } else if (nm === 'maps') {
      tag('README.md: all start and run');
      big(String(facts.maps.length), 64, 400, 256, C.cyanL, {glowColor: C.cyan});
      text('maps', 64 + 3 * 128 + 30, 400, {font: VGA, size: 96, color: C.orange});
      text('every single-player map starts and runs', 64, 470, {size: 32, color: C.text});
      g.fillStyle = C.cyan; g.fillRect(64, 510, 990, 10);
    }
    // the cut marks along the bottom, one a card, the latest lit
    for (let j = 0; j < S.cards.length; j++) { const lit = j <= i; g.fillStyle = j === i ? C.orangeL : lit ? 'rgba(232,228,220,0.5)' : 'rgba(232,228,220,0.12)'; g.fillRect(64 + j * (1152 / S.cards.length), 690, 1152 / S.cards.length - 6, j === i ? 10 : 5); }
    // the crab in the corner, hopping on every cut
    const hop = 12 * pulse(f, card.f0, 5), pose = i === S.cards.length - 1 ? 'front-smile' : (i % 2 ? 'front-open' : 'front-focus');
    sprite(pose, 1140, 654 - hop, 0.26, {sy: 1 - 0.06 * pulse(f, card.f0, 3)});
    if (q < 4) { const x = lerp(-100, 1380, q / 3), w = g.createLinearGradient(x - 90, 0, x + 90, 0); w.addColorStop(0, 'rgba(240,138,93,0)'); w.addColorStop(0.5, 'rgba(240,138,93,0.35)'); w.addColorStop(1, 'rgba(240,138,93,0)'); g.fillStyle = w; g.fillRect(x - 90, 0, 180, 720); }
    if (cutFlash > 0) { g.fillStyle = `rgba(214,238,255,${0.16 * cutFlash})`; g.fillRect(-OX / K, 0, cv.width / K, 720); }
    if (f >= cfg.frames - 2) { g.fillStyle = `rgba(255,255,255,${0.35 * (f - (cfg.frames - 3))})`; g.fillRect(-OX / K, 0, cv.width / K, 720); }
  },
};

// ===================================================================================================================
// 3. top-note: the game, pulled back to a browser window, the counters coming in on the beats
// ===================================================================================================================
SHOT['top-note'] = {
  init() {
    const S = this, kicks = cfg.cues.kick;
    S.V = {x: 320, y: 222, w: 640, h: 360};                                  // the game's viewport, in the final layout
    S.win = {x: 320, y: 138, w: 640, h: 444};
    S.pullStart = 40; S.pullEnd = 112;
    const kAfter = kicks.filter(k => k >= 100);                              // the counters land on kicks after the pull-back
    // the top note (the highest lead note) is the climax; its frame is the lead's midi-88
    S.top = cfg.cues.notes.filter(n => n.part === 'lead').sort((a, b) => b.midi - a.midi)[0];
    const order = [['L', 0], ['R', 0], ['L', 1], ['R', 1], ['L', 2], ['R', 2], ['L', 3], ['R', 3]];
    const topF = S.top.f, slots = kAfter.filter(k => Math.abs(k - topF) > 3);
    // six counters before the top note, two after it
    const before = slots.filter(k => k < topF).slice(0, 6), after = slots.filter(k => k > topF).slice(0, 2);
    const frames = [...before, ...after];
    const first = facts.first.slice(5), last = facts.last.slice(5);
    const mon = s => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(s.slice(0, 2)) - 1] + ' ' + Number(s.slice(3));
    // the counters: [side, row, value, caption, sub]; each value is computed in graphics.mjs (git at one pinned commit, the README)
    const defs = {
      days: ['L', 0, facts.days, 'days', `${mon(first)} to ${mon(last)}`],
      crates: ['R', 0, facts.crates.length, 'Rust crates', 'to WebAssembly'],
      commits: ['L', 1, facts.commits, 'commits', 'on master'],
      rust: ['R', 1, facts.rust.lines, 'lines of Rust', 'in native/'],
      maps: ['L', 2, facts.maps.length, 'maps', 'all start and run'],
      js: ['R', 2, facts.jsLines, 'JavaScript lines', 'mjs and js'],
      validators: ['L', 3, facts.validators.length, 'validators', 'in scripts/'],
      docs: ['R', 3, facts.docs.length, 'notes in docs/', 'markdown files'],
    };
    S.counters = ['days', 'crates', 'commits', 'rust', 'maps', 'js', 'validators', 'docs'].map((k, j) => ({k, f0: frames[j], side: defs[k][0], row: defs[k][1], value: defs[k][2], cap: defs[k][3], sub: defs[k][4]}));
  },
  info() { return `counters ${this.counters.map(c => c.k + '@' + c.f0).join(' ')} top note f${this.top.f} (midi ${this.top.midi}); pull-back f${this.pullStart}-${this.pullEnd}`; },
  cam(f) {
    const S = this, p = inOut((f - S.pullStart) / (S.pullEnd - S.pullStart));
    const push = 1 + 0.035 * smooth(f / S.pullStart) * (1 - p);
    const z0 = 1280 / S.V.w, z = Math.pow(z0, 1 - p) * (f < S.pullStart ? push : 1);
    const c0 = [S.V.x + S.V.w / 2, S.V.y + S.V.h / 2], cx = lerp(c0[0], 640, p), cy = lerp(c0[1], 360, p);
    return {z, cx, cy, p};
  },
  draw(f) {
    const S = this, {z, cx, cy, p} = S.cam(f), V = S.V, W = S.win;
    const kick = pulseAny(f, cfg.cues.kick, 6), topP = pulse(f, S.top.f, 40);
    g.save();
    g.translate(640, 360); g.scale(z, z); g.translate(-cx, -cy);               // world to screen
    // backdrop in world coordinates, a little larger than the screen at the widest pull-back
    g.fillStyle = C.bg; g.fillRect(-1200, -700, 3700, 2100);
    const r = g.createRadialGradient(640, 360, 40, 640, 360, 800);
    r.addColorStop(0, `rgba(${40 + 60 * topP},${52 + 30 * topP},${72 + 10 * topP},0.9)`); r.addColorStop(1, 'rgba(12,16,23,0)');
    g.fillStyle = r; g.fillRect(-1200, -700, 3700, 2100);
    g.strokeStyle = 'rgba(120,200,255,0.05)'; g.lineWidth = 1; g.beginPath();
    for (let x = -1200; x < 2500; x += 40) { g.moveTo(x, -700); g.lineTo(x, 1400); }
    for (let y = -700; y < 1400; y += 40) { g.moveTo(-1200, y); g.lineTo(2500, y); }
    g.stroke();
    // the window: shadow, frame, tab strip, toolbar
    g.save(); g.shadowColor = `rgba(217,119,87,${0.18 + 0.25 * kick * p + 0.4 * topP})`; g.shadowBlur = (46 + 40 * topP) * K * z; g.fillStyle = '#161d29'; rrect(W.x, W.y, W.w, W.h, 10); g.fill(); g.restore();
    g.fillStyle = '#161d29'; rrect(W.x, W.y, W.w, W.h, 10); g.fill();
    g.fillStyle = '#10161f'; g.fillRect(W.x, W.y, W.w, 40);
    for (let j = 0; j < 3; j++) { g.fillStyle = '#3a4558'; g.beginPath(); g.arc(W.x + 20 + j * 22, W.y + 20, 6, 0, 7); g.fill(); }
    g.fillStyle = '#1c2533'; g.beginPath(); g.roundRect(W.x + 92, W.y + 8, 190, 32, [8, 8, 0, 0]); g.fill();
    g.fillStyle = C.orange; rrect(W.x + 106, W.y + 18, 13, 13, 3); g.fill();
    text('Deus Ex', W.x + 130, W.y + 30, {font: SANS, size: 16, color: C.text});
    text('x', W.x + 266, W.y + 29, {size: 15, color: C.dim, align: 'center'});
    text('+', W.x + 304, W.y + 30, {size: 20, color: C.dim, align: 'center'});
    g.fillStyle = '#1c2533'; g.fillRect(W.x, W.y + 40, W.w, 44);
    g.strokeStyle = C.dim; g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(W.x + 36, W.y + 54); g.lineTo(W.x + 26, W.y + 62); g.lineTo(W.x + 36, W.y + 70); g.moveTo(W.x + 27, W.y + 62); g.lineTo(W.x + 44, W.y + 62); g.stroke();
    g.beginPath(); g.moveTo(W.x + 62, W.y + 54); g.lineTo(W.x + 72, W.y + 62); g.lineTo(W.x + 62, W.y + 70); g.moveTo(W.x + 71, W.y + 62); g.lineTo(W.x + 54, W.y + 62); g.stroke();
    g.beginPath(); g.arc(W.x + 98, W.y + 62, 8, 0.6, 5.6); g.stroke();
    g.fillStyle = '#0c1017'; rrect(W.x + 124, W.y + 48, W.w - 148, 28, 14); g.fill();
    text('localhost:5173', W.x + 146, W.y + 68, {size: 18, color: '#c7ccd6'});
    // the viewport: the game's frame
    g.save(); g.beginPath(); g.roundRect(V.x, V.y, V.w, V.h, [0, 0, 10, 10]); g.clip();
    const pl = IMG.plate; g.imageSmoothingQuality = 'high'; g.drawImage(pl.img, V.x, V.y, V.w, V.h);
    g.restore();
    g.restore();
    vignette(0.4);
    // everything else is on the screen, not in the world
    // the counters
    for (const c of S.counters) {
      const q = f - c.f0; if (q < 0) continue;
      const a = smooth(q / 4), slide = (1 - outCubic(q / 8)) * 44 * (c.side === 'L' ? -1 : 1);
      const x = (c.side === 'L' ? 64 : 984) + slide, y = 138 + c.row * 112, w = 232, h = 100;
      const flash = pulse(f, c.f0, 7) + 0.8 * pulse(f, S.top.f, 14);
      g.save(); g.globalAlpha = a;
      g.fillStyle = 'rgba(22,30,44,0.92)'; rrect(x, y, w, h, 6); g.fill();
      g.fillStyle = C.orange; g.fillRect(c.side === 'L' ? x + w - 4 : x, y, 4, h);
      if (flash > 0) { g.strokeStyle = `rgba(240,138,93,${clamp(flash)})`; g.lineWidth = 2; rrect(x, y, w, h, 6); g.stroke(); }
      const shown = Math.round(c.value * outCubic(q / 14));
      const nStr = shown.toLocaleString('en-US'), sizeN = 48;
      text(nStr, x + (c.side === 'L' ? 16 : 22), y + 46, {font: VGA, size: sizeN, color: flash > 0.3 ? '#ffffff' : C.cyanL, glow: 8 + 10 * clamp(flash), glowColor: C.cyan});
      text(c.cap, x + (c.side === 'L' ? 16 : 22), y + 72, {size: 20, color: C.text});
      text(c.sub, x + (c.side === 'L' ? 16 : 22), y + 92, {size: 18, color: C.dim});
      g.restore();
    }
    // the top note: a ring out of the window and a light behind it
    if (topP > 0) {
      const t = 1 - topP; g.save(); g.strokeStyle = `rgba(240,138,93,${0.7 * topP})`; g.lineWidth = 4; rrect(W.x - 20 - 260 * t, W.y - 20 - 150 * t, W.w + 40 + 520 * t, W.h + 40 + 300 * t, 16 + 40 * t); g.stroke(); g.restore();
    }
  },
};

// ===================================================================================================================
// 4. title: the last chord, the title, the credits; then one cursor on the four last cues, and dark
// ===================================================================================================================
SHOT.title = {
  init() {
    const S = this;
    S.piano = cfg.cues.notes.filter(n => n.part === 'piano').slice(0, 4);   // the four slow notes of the motif
    S.cursor = cfg.cues.cursor;
    S.clear0 = S.piano[3].f + 14; S.clear1 = S.clear0 + 10;
    S.credits = [
      'Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0.',
      'Virtual Playing Orchestra by Paul Battersby, built on Sonatina Symphonic Orchestra (CC Sampling Plus 1.0), Mattias Westlund\'s samples (CC BY-SA 3.0), No Budget Orchestra (CC BY-SA 4.0), VSCO 2 Community Edition (CC0), University of Iowa samples and others.',
      'FluidR3 GM soundfont by Frank Wen (MIT).',
      'The quoted phrase is from the Deus Ex main theme by Alexander Brandon; the theme belongs to its composer and publisher.',
    ];
    // wrap each credit to the block's width at its size
    const size = 19, maxW = 1152; S.lines = [];
    S.credits.forEach((c, ci) => { let line = ''; for (const w of c.split(' ')) { const t = line ? line + ' ' + w : w; if (width(t, size, MONO) > maxW && line) { S.lines.push([ci, line]); line = w; } else line = t; } S.lines.push([ci, line]); });
    S.rng = rng(7);
  },
  info() { return `piano notes f${this.piano.map(n => n.f).join(',')}; clear f${this.clear0}-${this.clear1}; cursor on f${this.cursor.join(',')} (15 frames each)`; },
  draw(f) {
    const S = this;
    const black = smooth((f - 300) / 128);
    g.fillStyle = `rgb(${12 * (1 - black)},${16 * (1 - black)},${23 * (1 - black)})`; g.fillRect(-OX / K, 0, cv.width / K, 720);
    // everything below clears together (the cursor stage follows)
    const gone = smooth((f - S.clear0) / (S.clear1 - S.clear0));
    if (gone < 1) {
      const A = 1 - gone, lift = -10 * gone, hit = pulse(f, 1, 14);
      g.save(); g.globalAlpha = A; g.translate(0, lift);
      backdrop({lift: 1 + hit}); vignette(0.35);
      const fl = pulse(f, 1, 10);                                            // the chord's flash, behind the type
      if (fl > 0) { const rg = g.createRadialGradient(400, 280, 40, 400, 280, 900); rg.addColorStop(0, `rgba(240,138,93,${0.5 * fl * fl})`); rg.addColorStop(1, `rgba(217,119,87,${0.14 * fl * fl})`); g.fillStyle = rg; g.fillRect(-OX / K, 0, cv.width / K, 720); }
      // the title, landing with the chord
      const land = outBack(f / 8), sc = lerp(1.06, 1, clamp(f / 8)), tA = clamp(1 - 0.0 * f);
      g.save(); g.translate(64, 0); g.scale(sc, sc); g.translate(-64, 0);
      text('Deus Ex,', 64, 184, {font: SANS, size: 84, weight: '600', color: C.text, alpha: tA});
      text('in the browser', 64, 272, {font: SANS, size: 84, weight: '600', color: C.text, alpha: tA});
      g.restore();
      text('made by Jerome Mahuet & Claude', 64, 338, {size: 30, color: C.orangeL, alpha: smooth((f - 12) / 8)});
      text('No game data is included. You need your own copy of Deus Ex.', 64, 384, {size: 22, color: C.text, alpha: 0.9 * smooth((f - 18) / 8)});
      // the four notes of the motif as four blocks (A B C E), each lighting on its note
      const base = 468, semis = [0, 2, 3, 7];
      S.piano.forEach((n, j) => {
        const on = f >= n.f, glow = pulse(f, n.f, 24), x = 64 + j * 44, h = 34, y = base - (n.midi - 69) * 4.5 - h;
        g.save(); g.fillStyle = on ? C.orangeL : 'rgba(232,228,220,0.18)'; g.shadowColor = C.orange; g.shadowBlur = (on ? 6 + 22 * glow : 0) * K; g.fillRect(x, y, 26, h); g.restore();
      });
      // the credits, small, one after another
      const y0 = 524;
      g.save(); g.fillStyle = 'rgba(232,228,220,0.14)'; g.fillRect(64, y0 - 30, 1152, 1); g.restore();
      S.lines.forEach(([ci, line], j) => text(line, 64, y0 + j * 22, {size: 19, color: '#c9cdd6', alpha: smooth((f - 26 - ci * 4) / 8) * 0.95}));
      // the crab beside the title, breathing, blinking twice
      const blink = (f >= 66 && f < 70) || (f >= 112 && f < 116);
      const br = Math.sin(f * 0.12), enter = outBack((f + 1) / 10);
      sprite(blink ? 'front-blink' : 'front-smile', 1020, 484 - 4 * Math.max(0, br), 0.62 * lerp(0.9, 1, clamp(enter)), {sy: 1 + 0.012 * br, sx: 1 - 0.008 * br});
      g.restore();
    }
    // the cursor: on at each of the last four cues for half a second, a VGA block like the first scene's
    const on = S.cursor.some(c => f >= c && f < c + 15);
    if (on) {
      const w = 28, h = 52, x = 640 - w / 2, y = 360 - h / 2;
      for (const pass of [0, 1]) {
        g.save(); g.shadowColor = 'rgba(120,200,255,0.9)'; g.shadowBlur = (pass ? 0 : 30) * K;
        g.fillStyle = pass ? 'rgba(214,238,255,1)' : 'rgba(120,190,255,0.6)'; g.fillRect(x, y, w, h); g.restore();
      }
    }
    if (f >= S.clear1) { scanlines(0.16 * (1 - black)); vignette(0.5); }
  },
};
