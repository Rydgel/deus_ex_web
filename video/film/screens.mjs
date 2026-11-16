// Screen feeds: what the film's monitors and panels show, drawn in JavaScript on a canvas (headless Chromium, the
// installed "PxPlus IBM VGA8" font) and saved as PNG sequences that Blender maps onto the props as emissive textures.
//   node video/film/screens.mjs boot        -> video/out/film/screens/boot/f0001.png ...
// Times come from the score (video/out/music/score.json), so what a screen does lands on the music.
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..');
const out = path.resolve(here, '../out/film/screens'), FPS = 30;
const score = JSON.parse(readFileSync(path.resolve(here, '../out/music/score.json'), 'utf8'));
const bar = b => b * score.bar;

// ------------------------------------------------------------------------------------------------- the terminal
// A text screen of COLS x ROWS VGA cells. `script` is a list of {t, ...}: type (characters appear from t at `cps`),
// print (a whole line at t), newline, clear. The cursor blinks on the score's cursor cues.
const typed = (t, text, cps = 14) => [...text].map((ch, i) => ({t: t + i / cps, put: ch}));
const size = file => readFileSync(path.join(repo, 'Deus Ex GOTY Edition', 'System', file)).length.toLocaleString('en-US');
const listing = file => `${file.padEnd(14)}${size(file).padStart(12)}`;

const FEEDS = {
  // The opening: a prompt from the year 2000, the game's own files (their real sizes), and the request.
  boot: () => {
    const prompt = 'C:\\DeusEx\\System>', events = [];
    events.push({t: bar(1), on: true}, {t: bar(1), print: prompt});
    events.push(...typed(bar(1) + 0.55, 'dir', 4), {t: bar(1) + 1.75, newline: true});
    ['DeusEx.exe', 'DeusEx.u', 'Engine.dll', 'Render.dll'].forEach((file, k) => events.push({t: bar(2 + k), print: listing(file)}, {t: bar(2 + k), newline: true}));
    events.push({t: bar(5) + 1.2, newline: true}, {t: bar(5) + 1.2, print: prompt});
    events.push(...typed(bar(5) + 1.5, 'claude', 12), {t: bar(6) - 0.05, newline: true}, {t: bar(6), print: '> '});
    events.push(...typed(bar(6) + 0.2, 'run this in a browser. 100% faithful.', 13.5));
    events.push({t: bar(7.5), flash: bar(8) - bar(7.5)});
    return {duration: bar(8), cols: 40, rows: 15, events, cursor: score.cues.cursor};
  },
};

// drawn in the page: state at time t from the events, then the canvas
const PAGE = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: vga; src: local("PxPlus IBM VGA8"); }
html, body { margin: 0; background: #000; } canvas { display: block; }
</style><canvas id="c"></canvas><script>
const c = document.getElementById('c'), g = c.getContext('2d');
let F = null;
window.setup = async feed => {
  F = feed; F.cw = 32; F.ch = 64; c.width = F.cols * F.cw; c.height = F.rows * F.ch;
  await document.fonts.load('64px vga'); await document.fonts.ready;
  return [c.width, c.height, document.fonts.check('64px vga')];
};
window.draw = t => {
  const lines = ['']; let on = false, flash = 0;
  for (const e of F.events) {
    if (e.t > t) continue;
    if (e.on) on = true;
    if (e.put) lines[lines.length - 1] += e.put;
    if (e.print) lines[lines.length - 1] += e.print;
    if (e.newline) lines.push('');
    if (e.flash) flash = Math.min(1, (t - e.t) / e.flash);
  }
  g.fillStyle = '#01040a'; g.fillRect(0, 0, c.width, c.height);
  if (on) {
    const warm = Math.min(1, (t - F.events[0].t) / 0.35);                     // the tube warming up
    g.fillStyle = 'rgba(40, 90, 140, ' + (0.07 * warm) + ')'; g.fillRect(0, 0, c.width, c.height);
    g.font = '64px vga'; g.textBaseline = 'top';
    const last = F.cursor.filter(x => x <= t).pop(), blink = last != null && t - last < 0.5;
    const row0 = 1, col0 = 1;
    for (const pass of [0, 1]) {                                               // a soft glow under crisp glyphs
      g.shadowColor = 'rgba(120, 200, 255, 0.9)'; g.shadowBlur = pass ? 0 : 26;
      g.fillStyle = pass ? 'rgba(214, 238, 255, ' + warm + ')' : 'rgba(120, 190, 255, ' + (0.55 * warm) + ')';
      lines.forEach((line, r) => g.fillText(line, col0 * F.cw, (row0 + r) * F.ch));
      if (blink || flash > 0) g.fillRect((col0 + lines[lines.length - 1].length) * F.cw, (row0 + lines.length - 1) * F.ch + 6, F.cw - 4, F.ch - 12);
    }
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(0, 0, 0, 0.22)';                                       // scanlines
    for (let y = 0; y < c.height; y += 4) g.fillRect(0, y, c.width, 2);
    const v = g.createRadialGradient(c.width / 2, c.height / 2, c.height * 0.3, c.width / 2, c.height / 2, c.width * 0.72);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.5)');
    g.fillStyle = v; g.fillRect(0, 0, c.width, c.height);
  }
  if (flash > 0) { g.fillStyle = 'rgba(225, 242, 255, ' + (flash * flash) + ')'; g.fillRect(0, 0, c.width, c.height); }
  return c.toDataURL('image/png').slice(22);
};
</script>`;

const name = process.argv[2];
if (!FEEDS[name]) { console.error(`usage: node video/film/screens.mjs <${Object.keys(FEEDS).join('|')}>`); process.exit(1); }
const feed = FEEDS[name](), dir = path.join(out, name), frames = Math.ceil(feed.duration * FPS) + 1;
rmSync(dir, {recursive: true, force: true});
mkdirSync(dir, {recursive: true});
const browser = await chromium.launch({args: ['--mute-audio']});
const page = await browser.newPage();
await page.setContent(PAGE);
const [w, h, font] = await page.evaluate(f => window.setup(f), feed);
if (!font) console.warn('the VGA font did not load: the screen falls back to a default font');
for (let f = 0; f < frames; f++) writeFileSync(path.join(dir, `f${String(f + 1).padStart(4, '0')}.png`), Buffer.from(await page.evaluate(t => window.draw(t), f / FPS), 'base64'));
await browser.close();
writeFileSync(path.join(dir, 'feed.json'), JSON.stringify({name, frames, fps: FPS, width: w, height: h}));
console.log(`${name}: ${frames} frames ${w}x${h} -> ${path.relative(repo, dir)}`);
