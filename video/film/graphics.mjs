// The film's drawn shots: frame-times, build, top-note, title. Each is a page with a canvas in headless Chromium (the
// repository's Playwright, the installed "PxPlus IBM VGA8" font) saved as a PNG sequence, like screens.mjs:
//   node video/film/graphics.mjs <frame-times|build|top-note|title> [--size 1280x720] [--only 1,40,80] [--out dir] [--facts-refresh]
// -> video/out/film/<id>/f0001.png ...   (--only draws just those frames, for looking; it deletes nothing)
// A shot's frame f (1-based) is film frame F0 + f - 1 with F0 = round(bar * score.bar * 30), the grid animatic.mjs uses
// (frameAt), so a cue at time t falls on shot frame round(t * 30) - F0 + 1. Times come from video/out/music/score.json.
// The drawing is in graphics-page.js (a 1280x720 logical canvas scaled to --size); this file prepares what it shows:
//   - the numbers: frame times typed in below from the docs named beside each, counts computed from git at one pinned
//     commit (video/out/film/graphics-facts.json, so the shots agree; --facts-refresh takes HEAD again);
//   - the pictures: the crab sprites (video/out/film/sprites/, rendered with blender/sprite.py) and the Denton plate.
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..');
const out = path.resolve(here, '../out/film'), FPS = 30;
const score = JSON.parse(readFileSync(path.resolve(here, '../out/music/score.json'), 'utf8'));

// ------------------------------------------------------------------------------------------------------- the shots
// bar and frame count as given for the shots; `frames` is checked against animatic.mjs's rule, round(t1 * 30) - round(t0 * 30)
const SHOTS = {'frame-times': {bar: 44, frames: 124}, build: {bar: 46, frames: 124}, 'top-note': {bar: 68, frames: 248}, title: {bar: 72, frames: 428}};
const ORDER = ['frame-times', 'build', 'top-note', 'title'];     // the storyboard's neighbours: the next shot's bar is this one's end
const NEXT_BAR = {'frame-times': 46, build: 48, 'top-note': 72, title: null};

const args = process.argv.slice(2);
const id = args.find(a => !a.startsWith('--'));
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
if (!SHOTS[id]) { console.error(`usage: node video/film/graphics.mjs <${ORDER.join('|')}> [--size 1280x720] [--only 1,40,80] [--out dir] [--facts-refresh]`); process.exit(1); }
const [W, H] = opt('--size', '1280x720').split('x').map(Number);
const shot = SHOTS[id], t0 = shot.bar * score.bar, F0 = Math.round(t0 * FPS);
const t1 = NEXT_BAR[id] != null ? NEXT_BAR[id] * score.bar : score.duration;
if (Math.round(t1 * FPS) - F0 !== shot.frames) throw new Error(`${id}: ${shot.frames} frames, but the score gives ${Math.round(t1 * FPS) - F0}`);

// ------------------------------------------------------------------------------------------------------- git facts
const git = (...a) => execFileSync('git', a, {cwd: repo, encoding: 'utf8', maxBuffer: 1 << 29});
const sumLines = (rev, ...globs) => git('grep', '-I', '-c', '', rev, '--', ...globs).trim().split('\n').reduce((acc, line) => ({lines: acc.lines + Number(line.split(':').pop()), files: acc.files + 1}), {lines: 0, files: 0});

function computeFacts() {
  const rev = git('rev-parse', 'HEAD').trim();
  const names = git('ls-tree', '-r', '--name-only', rev).trim().split('\n');
  const first = git('log', '--reverse', '--format=%ad', '--date=short', rev).split('\n')[0];
  const last = git('log', '-1', '--format=%ad', '--date=short', rev).trim();
  const perDay = {};
  for (const d of git('log', '--format=%ad', '--date=short', rev).trim().split('\n')) perDay[d] = (perDay[d] ?? 0) + 1;
  const crates = ['script-vm', 'lodmesh-kernel', 'galaxy-kernel'].map(name => ({name, ...sumLines(rev, `native/${name}/*.rs`)}));
  const rust = sumLines(rev, '*.rs'), mjs = sumLines(rev, '*.mjs'), js = sumLines(rev, '*.js');
  // the maps: the game's own list, the 83 single-player ones (every installed map but the 5 multiplayer DXMP_ ones; status.md "83 single-player maps")
  const mapsDir = path.join(repo, 'Deus Ex GOTY Edition', 'Maps');
  const maps = readdirSync(mapsDir).filter(n => n.endsWith('.dx') && !n.startsWith('DXMP_')).map(n => n.slice(0, -3)).sort();
  // real lines of the project's Rust, as a texture behind the crate cards: a stretch from the middle of one file each
  const sample = (file, from, n) => git('show', `${rev}:${file}`).split('\n').slice(from, from + n).map(s => s.replace(/\t/g, '    ').slice(0, 96));
  return {
    rev, taken: new Date().toISOString().slice(0, 10), first, last,
    commits: Number(git('rev-list', '--count', rev).trim()),
    days: Math.round((Date.parse(last) - Date.parse(first)) / 864e5),
    perDay,
    crates, rust, mjs, js,
    jsLines: mjs.lines + js.lines, jsFiles: mjs.files + js.files,
    validators: names.filter(n => /^scripts\/validate-.*\.mjs$/.test(n)).map(n => n.slice('scripts/'.length)).sort(),
    docs: names.filter(n => /^docs\/.*\.md$/.test(n)).map(n => n.slice('docs/'.length)).sort(),
    maps,
    subjects: git('log', '-n', '80', '--format=%h\t%s', rev).trim().split('\n').map(l => l.split('\t')),
    code: {
      'script-vm': sample('native/script-vm/src/interp.rs', 400, 60),
      'lodmesh-kernel': sample('native/lodmesh-kernel/src/lod.rs', 120, 60),
      'galaxy-kernel': sample('native/galaxy-kernel/src/mixer.rs', 80, 60),
    },
    // README (at that commit): the stage gates the build shot quotes, and the maps figure
    readme: git('show', `${rev}:README.md`),
  };
}
const factsFile = path.join(out, 'graphics-facts.json');
mkdirSync(out, {recursive: true});
if (args.includes('--facts-refresh') || !existsSync(factsFile)) writeFileSync(factsFile, JSON.stringify(computeFacts()));
const facts = JSON.parse(readFileSync(factsFile, 'utf8'));
const readme = facts.readme, docsText = f => readFileSync(path.join(repo, 'docs', f), 'utf8');
delete facts.readme;

// ------------------------------------------------------------------------------------------------- what is typed in
// Each figure below is checked against the document it came from (the check fails loudly if the text has moved).
const ws = s => s.replace(/\s+/g, ' ');
const must = (name, text, re) => { if (!re.test(ws(text))) throw new Error(`source check failed: ${name}: ${re}`); };
const cost = docsText('play-frame-cost.md'), plan = docsText('play-cpu-plan.md'), mac = docsText('mac-pass-2026-11-08.md'), readmeText = readme;
// frame time on UNATCO Island, one step per documented milestone (the line the first shot draws):
must('Sep 28 before', cost, /Frame interval, mean\*\* \| \*\*86 ms \(≈12 fps\)\*\* \| \*\*57 ms \(≈17\.5 fps\)\*\*/);
must('Sep 28 setup', cost, /Running Island, walking, Chromium\/Metal 1440×960/);
must('Oct 3 first', plan, /1\.1 moving lights incremental \| c072cd0 \| 45\.5 → 39\.8/);
must('Oct 3 last', plan, /B6d swimming pawns' performPhysics in Rust \| \(this commit\) \| 27\.33 → 26\.98/);
must('Oct 3 setup', plan, /Island standing at Player start, Linux host, Arch Chromium, 1920×1080/);
must('Oct 27', cost, /worker frame p50 14\.6 → 12\.2 ms/);
must('Nov 5', cost, /\| 01_NYC_UNATCOIsland \| 2\.6 \| 8\.4 \| 8\.7 to 8\.9 \| over \|/);
must('Nov 8', mac, /\| 01_NYC_UNATCOIsland \| 1\.3 \/ 1\.8 \| 4\.0 \/ 7\.1 \| 8\.3 \/ 9\.2 \/ 9\.4 \/ 49\.9 \| 0 \/ 0 \/ 0 \| 118\.9 \| 0 \|/);
must('Nov 8 display', mac, /120 Hz display/);
const STEPS = [
  // ms, how it is printed, date, fps (1000 / ms, except where the document states it), which caption group
  {ms: 86, label: '86', date: 'Sep 28', fps: 12, fpsLabel: '12', group: 0},       // play-frame-cost.md, "September 28 running-Island profile": 86 ms (≈12 fps), frame interval mean, M2 Pro Metal 1440x960
  {ms: 57, label: '57', date: 'Sep 28', fps: 17.5, fpsLabel: '17.5', group: 0},    // the same table, After: 57 ms (≈17.5 fps)
  {ms: 45.5, label: '45.5', date: 'Oct 3', fps: 1000 / 45.5, fpsLabel: '22', group: 1},  // play-cpu-plan.md Progress, 1.1 before (c072cd0): total main-thread ms, Linux host, 1920x1080
  {ms: 27.0, label: '27.0', date: 'Oct 3', fps: 1000 / 26.98, fpsLabel: '37', group: 1}, // the same table, last row, B6d: 27.33 -> 26.98
  {ms: 12.2, label: '12.2', date: 'Oct 27', fps: 1000 / 12.2, fpsLabel: '82', group: 2}, // play-frame-cost.md, "October 27": Island, Chromium worker, frame p50 14.6 -> 12.2 ms (Linux)
  {ms: 8.4, label: '8.4', date: 'Nov 5', fps: 1000 / 8.4, fpsLabel: '119', group: 2},   // play-frame-cost.md, "The frame-time set on 2026-11-05 (Linux)": Island worker p50 8.4
  {ms: 4.0, label: '4.0', date: 'Nov 8', fps: 118.9, fpsLabel: '119', group: 3},        // mac-pass-2026-11-08.md section 1: Island worker p50 4.0 ms, 118.9 fps (headed, 120 Hz display), M2 Pro
];
const GROUPS = [['M2 Pro', 'frame interval'], ['Linux host', 'main-thread work'], ['Linux host', 'worker frame, p50'], ['M2 Pro', 'worker frame, p50']];
// the stage gates and the map count the build shot quotes: README.md, Status table and "all 83 single-player maps start and run"
must('stage 4', readmeText, /\| 4 \| .* \| Done \(2026-10-17\): 70 of 70 criteria \|/);
must('stage 5', readmeText, /\| 5 \| .* \| Done \(2026-10-21\): 50 of 50 scenarios \|/);
must('stage 6', readmeText, /\| 6 \| .* \| Done \(2026-10-26\): 54 of 54 rows \|/);
must('maps', readmeText, /all 83 single-player maps start and run/);
if (facts.maps.length !== 83) throw new Error(`the Maps folder lists ${facts.maps.length} single-player maps, not 83`);
must('three crates', readmeText, /from the three crates in `native\/`/);
if (facts.crates.length !== 3) throw new Error('native/ does not hold three crates');
must('worker', readmeText, /a \*\*Web Worker\*\* keeps the simulation off the page's main thread/);

// ------------------------------------------------------------------------------------------------- cues, as shot frames
const frameOf = t => Math.round(t * FPS) - F0 + 1;
const inShot = list => list.map(frameOf).filter(f => f >= 1 && f <= shot.frames);
const cues = {kick: inShot(score.cues.kick), snare: inShot(score.cues.snare), crash: inShot(score.cues.crash), impact: inShot(score.cues.impact),
  cursor: score.cues.cursor.slice(-4).map(frameOf),
  notes: score.cues.theme.filter(n => n.t >= t0 && n.t < t1).map(n => ({part: n.part, midi: n.midi, f: frameOf(n.t), dur: n.dur}))};

// ------------------------------------------------------------------------------------------------------ the pictures
const b64 = file => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
const sprite = name => { const f = path.join(out, 'sprites', `${name}.png`); if (!existsSync(f)) throw new Error(`missing sprite ${f}: render it with blender/sprite.py`); return b64(f); };
const images = {};
if (id === 'frame-times') for (const n of ['ride-open', 'ride-wide', 'ride-smile']) images[n] = sprite(n);
if (id === 'build') for (const n of ['front-focus', 'front-open', 'front-smile']) images[n] = sprite(n);
if (id === 'title') for (const n of ['front-smile', 'front-blink']) images[n] = sprite(n);
if (id === 'top-note') {
  // the game picture the browser window closes around: the last frame of the walk before this shot (so the cut does not jump, and the
  // crab keeps its glasses); the dock proof still while that shot is not rendered
  const walk = existsSync(path.join(out, 'together')) ? readdirSync(path.join(out, 'together')).filter(f => /^f\d+\.png$/.test(f)).sort().at(-1) : null;
  images.plate = b64(walk ? path.join(out, 'together', walk) : path.join(out, 'plates', 'denton', 'low-comp.png'));
}

// ------------------------------------------------------------------------------------------------------- the render
const dir = path.resolve(opt('--out', path.join(out, id))), only = opt('--only', null)?.split(',').map(Number);
if (!only) rmSync(dir, {recursive: true, force: true});
mkdirSync(dir, {recursive: true});
const browser = await chromium.launch({args: ['--mute-audio']});
const page = await browser.newPage({viewport: {width: Math.min(W, 1920), height: Math.min(H, 1080)}});
await page.setContent('<!doctype html><meta charset="utf-8"><style>@font-face { font-family: vga; src: local("PxPlus IBM VGA8"); } html, body { margin: 0; background: #0c1017; } canvas { display: block; }</style><canvas id="c"></canvas>');
await page.addScriptTag({content: readFileSync(path.join(here, 'graphics-page.js'), 'utf8')});
const state = await page.evaluate(cfg => window.setup(cfg), {id, W, H, frames: shot.frames, F0, fps: FPS, t0, bar: score.bar, beat: score.beat, cues, facts, steps: STEPS, groups: GROUPS, images});
if (state.info && args.includes('--info')) console.log(JSON.stringify(state.info));
if (!state.font) console.warn('the VGA font did not load: the screens fall back to a default font');
const list = only ?? Array.from({length: shot.frames}, (_, i) => i + 1);
for (const f of list) writeFileSync(path.join(dir, `f${String(f).padStart(4, '0')}.png`), Buffer.from(await page.evaluate(n => window.draw(n), f), 'base64'));
await browser.close();
console.log(`${id}: ${list.length} of ${shot.frames} frames ${W}x${H} -> ${path.relative(repo, dir)}`);
