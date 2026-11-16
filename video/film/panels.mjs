// Panels: the sheets of real project data that float in the film's "study" scenes and the log the late-night monitor
// scrolls, drawn in JavaScript on a canvas (headless Chromium, the installed "PxPlus IBM VGA8" font) as PNGs with alpha
// for Blender to map onto emissive planes (see screens.mjs, which does the same for the boot terminal).
//   node video/film/panels.mjs <bytes|bytecode|qa|validators|nights|all>     -> video/out/film/panels/<name>/...
// Everything on a panel is read from the repository: DeusEx.u's own bytes, the decoded bytecode of LightSwitch.Frob
// (scripts/dump-script-function.mjs), the machine code of APawn::AICanHear (tools/disasm-body.py on Engine.dll), its Rust
// port (native/script-vm/src/aievent.rs), the names of scripts/validate-*.mjs and `git log --oneline`. Times come from the
// score (video/out/music/score.json); each animated feed writes its cue times to feed.json for the Blender scene to read.
import {execFileSync} from 'node:child_process';
import {mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..');
const out = path.resolve(here, '../out/film/panels'), FPS = 30;
const score = JSON.parse(readFileSync(path.resolve(here, '../out/music/score.json'), 'utf8'));
const bar = b => b * score.bar, beat = score.beat, step = score.step;
const shotFrames = (b0, bars) => Math.round(bar(b0 + bars) * FPS) - Math.round(bar(b0) * FPS);

// ------------------------------------------------------------------------------------------------- real material
const dump = (pkg, fn) => execFileSync('node', [path.join(repo, 'scripts/dump-script-function.mjs'), pkg, fn], {cwd: repo, encoding: 'utf8'}).split('\n').filter(l => l.trim());
const asm = (from, to) => execFileSync(path.join(repo, '.cache/native-probe-env/bin/python'), [path.join(repo, 'tools/disasm-body.py'), 'Deus Ex GOTY Edition', 'Engine.dll', `${from}-${to}`],
  {cwd: repo, encoding: 'utf8'}).trimEnd().split('\n').slice(1).map(l => {
  const m = l.match(/^0x([0-9a-f]+): ([0-9a-f]+)\s+(\S+)\s*(.*)$/);
  return {addr: m[1], bytes: m[2], op: m[3], args: m[4].replace(/ ([+-]) /g, '$1')};          // "[ebp + 0xc]" -> "[ebp+0xc]"
});
const rustFile = readFileSync(path.join(repo, 'native/script-vm/src/aievent.rs'), 'utf8').split('\n');
const canHear = rustFile.slice(rustFile.findIndex(l => l.startsWith('fn can_hear')));
const rust = (...texts) => texts.map(text => {
  const line = canHear.find(l => l.trim() === text);
  if (!line) throw new Error('no such line in can_hear: ' + text);
  return line.slice(4);
});
const validators = readdirSync(path.join(repo, 'scripts')).filter(f => /^validate-.*\.mjs$/.test(f)).sort();

// ------------------------------------------------------------------------------------------------- the page
const PAGE = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: vga; src: local("PxPlus IBM VGA8"); }
html, body { margin: 0; background: #000; } canvas { display: block; }
</style><canvas id="c"></canvas><script>
const c = document.getElementById('c'), g = c.getContext('2d');
const ease = x => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const hash = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const WHITE = [214, 238, 255], CYAN = [120, 190, 255], DIM = [92, 150, 214], MINT = [120, 255, 190];
const rgba = (col, a) => 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + a + ')';
let F = null;
window.ready = async () => { await document.fonts.load('48px vga'); await document.fonts.ready; return document.fonts.check('48px vga'); };
window.setup = feed => { F = feed; return null; };
function size(w, h) { c.width = w; c.height = h; g.clearRect(0, 0, w, h); g.globalCompositeOperation = 'source-over'; g.shadowBlur = 0; }
// text with a glow under it: pass 0 draws the halo (a blurred copy), pass 1 the crisp glyphs; both from one list of {s, x, y, col, a}
function glyphs(list, font, halo = 0.5, blur = 18) {
  g.font = font; g.textBaseline = 'top';
  for (const pass of [0, 1]) {
    g.shadowBlur = pass ? 0 : blur;
    for (const t of list) {
      if (t.a <= 0.003) continue;
      g.shadowColor = rgba(CYAN, 0.9);
      g.fillStyle = pass ? rgba(t.col, t.a) : rgba(t.halo || CYAN, t.a * halo);
      g.fillText(t.s, t.x, t.y);
    }
  }
  g.shadowBlur = 0;
}
const png = () => c.toDataURL('image/png').slice(22);

// ----------------------------------------------------------------------------- bytes: a tower sheet of DeusEx.u (rows are given top to bottom)
window.bytes = spec => {
  const {rows, cw, ch, width, height, fade, sig, ox} = spec;
  size(width, height);
  g.fillStyle = 'rgba(26, 70, 118, 0.085)'; g.fillRect(0, 0, width, height);
  g.fillStyle = 'rgba(120, 190, 255, 0.34)'; g.fillRect(5, 0, 3, height); g.fillRect(width - 8, 0, 3, height);
  g.fillStyle = 'rgba(120, 190, 255, 0.10)'; g.fillRect(8, 0, 30, height); g.fillRect(width - 38, 0, 30, height);
  const list = [];
  rows.forEach((row, r) => {
    const y = 20 + r * ch, ra = 0.7 + 0.3 * hash(row.index);
    list.push({s: row.off, x: ox, y, col: CYAN, a: 0.55 * ra});
    row.bytes.forEach((b, i) => {
      const hot = sig && row.index === 0 && i < 4;
      const a = (b === 0 ? 0.24 : b >= 32 && b < 127 ? 0.95 : 0.62) * ra;
      const col = hot ? WHITE : b === 0 ? DIM : b >= 32 && b < 127 ? WHITE : CYAN;
      list.push({s: b.toString(16).toUpperCase().padStart(2, '0'), x: ox + (10 + i * 3 + (i >= 8 ? 1 : 0)) * cw, y, col, a: hot ? 1 : a});
      list.push({s: b >= 32 && b < 127 ? String.fromCharCode(b) : '.', x: ox + (60 + i) * cw, y, col: b >= 32 && b < 127 ? WHITE : DIM, a: (b >= 32 && b < 127 ? 0.8 : 0.3) * ra});
    });
  });
  glyphs(list, ch + 'px vga', 0.5, 14);
  if (sig) {                                                   // the package signature, boxed
    const y = 20 + rows.findIndex(r => r.index === 0) * ch;
    g.strokeStyle = 'rgba(214, 238, 255, 0.95)'; g.lineWidth = 3; g.shadowColor = 'rgba(120, 200, 255, 1)'; g.shadowBlur = 22;
    g.strokeRect(ox + 10 * cw - 8, y - 4, 11 * cw + 12, ch + 8); g.shadowBlur = 0;
  }
  if (fade) {
    g.globalCompositeOperation = 'destination-in';
    const grad = g.createLinearGradient(0, 0, 0, height * fade);
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = grad; g.fillRect(0, 0, width, height);
  }
  return png();
};

// ----------------------------------------------------------------------------- bytecode: LightSwitch.Frob, line by line
const TOKENS = /(@\\d+|ifnot|goto|return|native#\\d+\\[\\d+\\]|obj\\([^)]*\\)|'[^']*'|[A-Za-z_][\\w.]*|=bool|\\S)/g;
function colour(word) {
  if (/^(ifnot|goto|return|native#)/.test(word)) return [255, 255, 255];
  if (/^@/.test(word)) return DIM;
  if (/^(obj\\(|')/.test(word)) return [150, 235, 235];
  return WHITE;
}
window.bytecode = t => {
  const W = 2304, H = 1152, cw = 32, ch = 64, pitch = 82, x0 = 112, y0 = 150;
  size(W, H);
  const T = t - F.t0;
  // the sheet's ground and frame come up on the first beat
  const up = ease(T / 0.5);
  g.fillStyle = 'rgba(26, 70, 118, ' + 0.1 * up + ')'; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(120, 190, 255, ' + 0.4 * up + ')'; g.fillRect(0, 0, W, 4); g.fillRect(0, H - 4, W, 4); g.fillRect(0, 0, 4, H); g.fillRect(W - 4, 0, 4, H);
  const list = [], bars = [];
  const cur = T < F.cues.lines[F.cues.lines.length - 1] + 0.2 ? F.cues.lines.filter(x => x <= T).length - 1
    : T < F.cues.sweep[0] ? F.cues.lines.length - 1
    : Math.min(F.cues.lines.length - 1, 1 + Math.floor((T - F.cues.sweep[0]) / F.cues.sweepStep));
  const understood = ease((T - F.cues.understood) / 0.35), pulse = Math.exp(-Math.max(0, T - F.cues.understood) * 2.2) * (T >= F.cues.understood ? 1 : 0);
  F.lines.forEach((line, i) => {
    const arrive = T - F.cues.lines[i];
    if (arrive < 0) return;
    const y = i === 0 ? 46 : y0 + (i - 1) * pitch + 24;
    const typed = Math.min(line.length, Math.ceil(arrive * 70));
    const isHead = i === 0;
    const base = isHead ? 0.95 : 0.55 + 0.2 * (i === cur ? 1 : 0) + 0.45 * understood;
    const lit = (i === cur && T > F.cues.lines[F.cues.lines.length - 1] + 0.2 ? 1 : 0) * (1 - understood);
    if (!isHead) {
      const flash = Math.exp(-arrive * 5) * 0.28 + 0.2 * lit;
      g.fillStyle = 'rgba(150, 220, 255, ' + Math.min(0.5, flash + 0.12 * understood * pulse) + ')'; g.fillRect(40, y - 6, W - 80, ch + 12);
      if (lit) { g.fillStyle = rgba(WHITE, 0.9); g.fillRect(40, y - 6, 8, ch + 12); }
    }
    let x = x0;
    const shown = line.slice(0, typed);
    if (isHead) {
      list.push({s: shown, x: x0, y, col: WHITE, a: 1});
      return;
    }
    let col = 0;
    for (const m of shown.matchAll(TOKENS)) {
      const at = m.index; const word = m[0];
      list.push({s: word, x: x0 + at * cw, y, col: colour(word), a: Math.min(1, base * (arrive < 0.12 ? 1.4 : 1))});
    }
    if (typed < line.length) list.push({s: '█', x: x0 + typed * cw, y, col: WHITE, a: 0.9});
  });
  glyphs(list, ch + 'px vga', 0.55, 26);
  return png();
};

// ----------------------------------------------------------------------------- qa: machine code and its Rust translation
function check(cx, cy, s, a) {                          // a check mark and its word, drawn at s = 1 for a 120 px mark
  g.save(); g.translate(cx, cy); g.scale(s, s);
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const [w, al, blur] of [[26, 0.35, 34], [14, 1, 0]]) {
    g.lineWidth = w; g.strokeStyle = rgba(MINT, al * a); g.shadowColor = rgba(MINT, 0.95 * a); g.shadowBlur = blur;
    g.beginPath(); g.moveTo(0, 56); g.lineTo(38, 96); g.lineTo(112, 4); g.stroke();
  }
  g.restore();
}
window.qa = (side, t) => {
  const W = 1536, H = 1536, cw = 24, ch = 48, pitch = 60, x0 = 64, y0 = 52;
  size(W, H);
  const T = t - F.t0, C = F.cues;
  const up = ease((T - 0.05) / 0.4);
  g.fillStyle = 'rgba(26, 70, 118, ' + 0.1 * up + ')'; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(120, 190, 255, ' + 0.4 * up + ')'; g.fillRect(0, 0, W, 4); g.fillRect(0, H - 4, W, 4); g.fillRect(0, 0, 4, H); g.fillRect(W - 4, 0, 4, H);
  const list = [], words = [];
  const rowY = r => y0 + r * pitch;
  list.push({s: side === 'left' ? F.titles[0] : F.titles[1], x: x0, y: rowY(0), col: WHITE, a: up});
  g.fillStyle = rgba(CYAN, 0.35 * up); g.fillRect(x0, rowY(0) + ch + 6, W - 2 * x0, 3);
  if (side === 'left') {
    // each chunk of the machine code lights row by row on the three short notes of a question, whole on its long note
    let r = 2;
    F.chunks.forEach((chunk, k) => {
      const q = C.questions[k];
      const done = T >= C.answers[k][3] ? 1 : 0;
      chunk.asm.forEach((ins, j) => {
        const scan = clamp((T - (0.12 + 0.05 * (r - 2))) / 0.25);              // the sheet's rows come up top to bottom at the start
        const reach = T < q[0] ? 0 : T >= q[3] ? 1 : clamp(((T - q[0]) / (q[3] - q[0])) * chunk.asm.length - j + 0.4);
        const flash = T >= q[3] ? Math.exp(-(T - q[3]) * 3) : 0;
        const rest = T >= q[3] ? 0.5 + 0.16 * done : 0.4;
        const a = clamp((rest + (1 - rest) * reach * (T < q[3] ? 1 : 0) + 0.5 * flash) * scan);
        const y = rowY(r);
        if (T >= q[0] && T < C.answers[k][3] + 0.2) { g.fillStyle = rgba(CYAN, 0.16 * reach * (T < q[3] + 0.5 ? 1 : 0.5)); g.fillRect(x0 - 16, y - 6, W - 2 * x0 + 32, ch + 12); }
        list.push({s: ins.addr + ' ', x: x0, y, col: DIM, a: a * 0.9});
        list.push({s: ins.bytes.padEnd(12), x: x0 + 9 * cw, y, col: DIM, a: a * 0.8});
        list.push({s: ins.op.padEnd(6), x: x0 + 22 * cw, y, col: [255, 255, 255], a});
        list.push({s: ins.args, x: x0 + 28 * cw, y, col: WHITE, a});
        if (done) { g.fillStyle = rgba(MINT, 0.8 * Math.min(1, (T - C.answers[k][3]) / 0.3)); g.fillRect(x0 - 40, y - 4, 8, ch + 8); }
        r++;
      });
      r++;
    });
  } else {
    let r = 2;
    F.chunks.forEach((chunk, k) => {
      const a3 = C.answers[k], n = chunk.rust.length;
      chunk.rust.forEach((line, j) => {
        const arrive = T - a3[Math.min(3, Math.floor(j * 4 / n))];
        if (arrive >= 0) {
          const y = rowY(r + j), typed = Math.min(line.length, Math.ceil(arrive * 90));
          g.fillStyle = rgba(CYAN, Math.exp(-arrive * 4) * 0.3 + (T < a3[3] + 0.6 ? 0.07 : 0)); g.fillRect(x0 - 16, y - 6, W - 2 * x0 + 32, ch + 12);
          list.push({s: line.slice(0, typed), x: x0, y, col: WHITE, a: 1});
        }
      });
      const tc = T - a3[3];
      if (tc >= 0) {
        const s = 0.86 + 0.14 * (tc < 0.18 ? 1.5 * ease(tc / 0.18) : 1.5 - 0.5 * ease((tc - 0.18) / 0.2)), a = clamp(tc / 0.08);
        const cy = rowY(r + n) + 12;
        check(x0 + 8, cy, s * 1.3, a);
        const word = 'bit-exact', typed = Math.min(word.length, Math.ceil((tc - 0.08) * 28));
        if (typed > 0) words.push({s: word.slice(0, typed), x: x0 + 190, y: cy + 36, col: MINT, a: 1, halo: MINT});
      }
      r += n + 2 + 1;
    });
    if (T < C.answers[0][0]) {                                   // waiting for its answer: a cursor
      const on = Math.floor(T / 0.5) % 2 === 0;
      if (on) list.push({s: '█', x: x0, y: rowY(2), col: WHITE, a: 0.7 * up});
    }
  }
  glyphs(list, ch + 'px vga', 0.5, 16);
  glyphs(words, '64px vga', 0.6, 20);
  return png();
};

// ----------------------------------------------------------------------------- validators: one column of the wall, as masks (R names, G dots, B ground)
window.validatorColumn = spec => {
  const {names, W, rowH, rows, cw, ch} = spec;
  size(W, rows * rowH);
  g.fillStyle = '#000'; g.fillRect(0, 0, W, rows * rowH);
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgba(0, 0, 90, 0.22)'; g.fillRect(0, 0, W, rows * rowH);
  g.fillStyle = 'rgba(0, 0, 255, 0.55)'; g.fillRect(0, 0, 4, rows * rowH); g.fillRect(W - 4, 0, 4, rows * rowH);
  g.font = ch + 'px vga'; g.textBaseline = 'middle';
  names.forEach((name, r) => {
    const y = r * rowH + rowH / 2;
    g.fillStyle = 'rgba(0, 0, 255, 0.16)'; g.fillRect(24, (r + 1) * rowH - 2, W - 48, 2);
    g.fillStyle = 'rgba(0, 255, 0, 1)'; g.beginPath(); g.arc(60, y, 11, 0, 7); g.fill();          // the dot: filled when it has passed
    g.strokeStyle = 'rgba(0, 0, 255, 0.8)'; g.lineWidth = 3; g.beginPath(); g.arc(60, y, 16, 0, 7); g.stroke();
    g.shadowColor = 'rgba(255, 0, 0, 0.9)'; g.shadowBlur = 10; g.fillStyle = 'rgba(255, 0, 0, 0.9)';
    g.fillText(name, 100, y + 2); g.shadowBlur = 0; g.fillStyle = 'rgba(255, 0, 0, 1)'; g.fillText(name, 100, y + 2);
  });
  return png();
};
window.counter = n => {                                          // a tag that runs with the crab: how many have passed
  size(640, 192);
  const text = String(n).padStart(3, ' ') + ' / ' + F.total;
  glyphs([{s: text, x: 40, y: 56, col: MINT, a: 1, halo: MINT}], '80px vga', 0.6, 22);
  glyphs([{s: 'validated', x: 40, y: 8, col: WHITE, a: 0.7}], '40px vga', 0.4, 10);
  return png();
};

// ----------------------------------------------------------------------------- nights: the late-night monitor's log
window.nights = t => {
  const T = t - F.t0, cw = 32, ch = 64, cols = 40, rows = 15;
  size(cols * cw, rows * ch);
  g.fillStyle = '#01040a'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(40, 90, 140, 0.07)'; g.fillRect(0, 0, c.width, c.height);
  const shown = F.arrivals.filter(a => a <= T).length;
  const first = Math.max(0, shown - (rows - 1));
  const list = [];
  for (let i = first; i < shown; i++) {
    const row = i - first, fresh = i === shown - 1 ? 1 : 0;
    const line = F.lines[i];
    list.push({s: line.slice(0, 8), x: cw, y: ch * row, col: DIM, a: 0.8});
    list.push({s: line.slice(8), x: cw * 9, y: ch * row, col: WHITE, a: 0.92 + 0.08 * fresh, });
  }
  glyphs(list.map(l => l), '64px vga', 0.55, 26);
  const last = F.cursor.filter(x => x <= T).pop(), blink = last != null && T - last < 0.5;
  if (blink) { g.fillStyle = rgba(WHITE, 0.9); g.fillRect(cw, ch * (shown - first) + 6, cw - 4, ch - 12); }
  g.fillStyle = 'rgba(0, 0, 0, 0.22)';
  for (let y = 0; y < c.height; y += 4) g.fillRect(0, y, c.width, 2);
  const v = g.createRadialGradient(c.width / 2, c.height / 2, c.height * 0.3, c.width / 2, c.height / 2, c.width * 0.72);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = v; g.fillRect(0, 0, c.width, c.height);
  return png();
};
</script>`;

// ------------------------------------------------------------------------------------------------- the feeds
const hex8 = n => n.toString(16).padStart(8, '0');
const bytesFile = readFileSync(path.join(repo, 'Deus Ex GOTY Edition', 'System', 'DeusEx.u'));

// Towers of DeusEx.u: a sheet is 78 rows of a 16-byte hex dump; rows climb the wall (the file's start is at the bottom).
const TOWERS = [
  {name: 'a', offset: 0, sheets: 2, sig: true},
  {name: 'b', offset: 0x0a2000, sheets: 2},
  {name: 'c', offset: 0x2f0000, sheets: 2},
  {name: 'd', offset: 0x4c2000, sheets: 2},
];
const ROWS = 78;

const FEEDS = {
  bytes: async (page, dir) => {
    const files = [];
    for (const tower of TOWERS) for (let k = 0; k < tower.sheets; k++) {
      const rows = [];
      for (let r = 0; r < ROWS; r++) {
        const index = k * ROWS + (ROWS - 1 - r), at = tower.offset + index * 16;
        rows.push({index: at / 16, off: hex8(at), bytes: [...bytesFile.subarray(at, at + 16)]});
      }
      const spec = {rows, cw: 26, ch: 52, width: 2048, height: 4096, ox: 36, fade: k === tower.sheets - 1 ? 0.45 : 0, sig: !!tower.sig && k === 0};
      const file = `${tower.name}${k}.png`;
      writeFileSync(path.join(dir, file), Buffer.from(await page.evaluate(s => (window.setup({}), window.bytes(s)), spec), 'base64'));
      files.push(file);
    }
    return {kind: 'static', files, width: 2048, height: 4096, rows: ROWS, cell: [26, 52]};
  },
  bytecode: async (page, dir) => {
    const lines = dump('DeusEx', 'LightSwitch.Frob'), t0 = bar(12), frames = shotFrames(12, 4);
    const body = lines.slice(1);
    const feed = {
      t0, lines: ['LightSwitch.Frob  (Frob)', ...body],
      cues: {lines: [...Array(10).keys()].map(i => i * beat + 0.04), sweep: [5.3], sweepStep: 0.2, understood: 7.241},
    };
    await page.evaluate(f => window.setup(f), feed);
    for (let f = 0; f < frames; f++) writeFileSync(path.join(dir, `f${String(f + 1).padStart(4, '0')}.png`), Buffer.from(await page.evaluate(t => window.bytecode(t), t0 + f / FPS), 'base64'));
    return {kind: 'sequence', frames, width: 2304, height: 1152, cues: feed.cues, lines: feed.lines};
  },
  qa: async (page, dir) => {
    const t0 = bar(16), frames = shotFrames(16, 4);
    const notes = score.cues.theme.filter(n => n.part === 'piano' && n.t >= bar(16) && n.t < bar(20));
    const phrase = k => notes.slice(4 * k, 4 * k + 4).map(n => n.t - t0);         // the four notes of bar 16 + k: three short, one long
    const guards = asm('0x103c76b5', '0x103c76d3').slice(0, 7), distance = asm('0x103c76ea', '0x103c771c').filter(i => parseInt(i.addr, 16) <= 0x103c7719);
    const feed = {
      t0, titles: ['Engine.dll  APawn::AICanHear  0x103c7680', 'aievent.rs  fn can_hear'],
      chunks: [
        {asm: guards, rust: rust('let (less, equal) = Ext::load(volume).compare(zero);', 'if less || equal || flags(other) & 8 == 0 {', 'return F32_ZERO;', '}')},
        {asm: distance, rust: rust('let l = locations(other, pawn);', 'let dz = sub(l[2], l[5]).store();', 'let dy = sub(l[1], l[4]);', 'let dx = sub(l[0], l[3]).store();', 'let dz2 = Ext::load(dz).add(Ext::load(dz)).store();')},
      ],
      cues: {questions: [phrase(0), phrase(2)], answers: [phrase(1), phrase(3)]},
    };
    await page.evaluate(f => window.setup(f), feed);
    for (const side of ['left', 'right']) {
      mkdirSync(path.join(dir, side), {recursive: true});
      for (let f = 0; f < frames; f++) writeFileSync(path.join(dir, side, `f${String(f + 1).padStart(4, '0')}.png`), Buffer.from(await page.evaluate(([s, t]) => window.qa(s, t), [side, t0 + f / FPS]), 'base64'));
    }
    return {kind: 'sequence', frames, width: 1536, height: 1536, cues: feed.cues, rows: [feed.chunks[0].asm.length, feed.chunks[1].asm.length, feed.chunks[0].rust.length, feed.chunks[1].rust.length]};
  },
  validators: async (page, dir) => {
    const perColumn = 40, count = validators.length, columns = Math.ceil(count / perColumn), files = [];
    for (let k = 0; k < columns; k++) {
      const names = validators.slice(k * perColumn, (k + 1) * perColumn);
      const spec = {names, W: 1120, rowH: 48, rows: perColumn, cw: 20, ch: 40};
      const file = `col${String(k).padStart(2, '0')}.png`;
      writeFileSync(path.join(dir, file), Buffer.from(await page.evaluate(s => (window.setup({}), window.validatorColumn(s)), spec), 'base64'));
      files.push(file);
    }
    const t0 = bar(20), frames = shotFrames(20, 4);
    // the tag that runs with the crab, one frame per count 0..count (looked up by the scene)
    mkdirSync(path.join(dir, 'count'), {recursive: true});
    await page.evaluate(f => window.setup(f), {total: count});
    for (let n = 0; n <= count; n += 1) writeFileSync(path.join(dir, 'count', `n${String(n).padStart(3, '0')}.png`), Buffer.from(await page.evaluate(v => window.counter(v), n), 'base64'));
    return {kind: 'static', files, count, perColumn, columns, width: 1120, height: perColumn * 48, frames};
  },
  nights: async (page, dir) => {
    const t0 = bar(40), frames = shotFrames(40, 4);
    const log = execFileSync('git', ['log', '--oneline', '--reverse'], {cwd: repo, encoding: 'utf8'}).trimEnd().split('\n');
    const start = 600, bass = [0, 3, 6, 8, 11, 14];                                  // the groove's bass steps: a line arrives on each
    const arrivals = [];
    for (let b = 0; b < 4; b++) for (const s of bass) arrivals.push(b * score.bar + s * step);
    arrivals.unshift(-1, -0.9, -0.8, -0.7, -0.6, -0.5, -0.4, -0.3, -0.2, -0.1, -0.05);        // the screen is already full when the shot opens
    const lines = log.slice(start, start + arrivals.length).map(l => l.slice(0, 8) + ' ' + l.slice(9, 38));
    const cursor = []; for (let x = 0; x < 4 * score.bar; x += 1.0) cursor.push(x);
    await page.evaluate(f => window.setup(f), {t0: 0, arrivals, lines, cursor});
    for (let f = 0; f < frames; f++) writeFileSync(path.join(dir, `f${String(f + 1).padStart(4, '0')}.png`), Buffer.from(await page.evaluate(t => window.nights(t), f / FPS), 'base64'));
    return {kind: 'sequence', frames, width: 1280, height: 960, lines, arrivals};
  },
};

const which = process.argv[2];
const names = which === 'all' ? Object.keys(FEEDS) : [which];
if (!names.every(n => FEEDS[n])) { console.error(`usage: node video/film/panels.mjs <${Object.keys(FEEDS).join('|')}|all>`); process.exit(1); }
const browser = await chromium.launch({args: ['--mute-audio']});
const page = await browser.newPage();
await page.setContent(PAGE);
if (!await page.evaluate(() => window.ready())) console.warn('the VGA font did not load: the panels fall back to a default font');
for (const name of names) {
  const dir = path.join(out, name);
  rmSync(dir, {recursive: true, force: true});
  mkdirSync(dir, {recursive: true});
  const info = await FEEDS[name](page, dir);
  writeFileSync(path.join(dir, 'feed.json'), JSON.stringify({name, fps: FPS, ...info}));
  console.log(`${name}: ${info.kind}, ${info.files ? info.files.length + ' files' : info.frames + ' frames'} -> ${path.relative(repo, dir)}`);
}
await browser.close();
