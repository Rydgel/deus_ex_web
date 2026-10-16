// Third-person conversation frames against the original (docs/conversation-camera.md "Frames", Stage 4 gate rows 4.5.5 to 4.5.8).
//
//   node scripts/conversation-acceptance.mjs timeline [--scene meetpaul] [--frames 1500]
//
// `timeline` is Play only: the scene's start (SCENES) in the default worker mode, the level released with a fixed 1/60 s per page frame, and every
// change of the conversation's state, event or camera logged with its tick (conversationProbe, src/viewer/conversation-probe.mjs). It plans the
// original's capture: which tick each held frame lies on.
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => {
  const joined = process.argv.find(arg => arg.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];
};

/** The scenes: the map, where the player stands (a ghost placed there, then `walk`: the pose is the SET's, `walk` registers the collision) and what it faces.
 * MeetPaul is radius-invoked (radiusDistance 180) from the owner's low-priority tick: the level released with the player inside the radius starts it. */
export const SCENES = {
  meetpaul: {map: '01_NYC_UNATCOIsland', location: [-2385, 8393, -256.2], rotation: [0, 51120, 0], conversation: 'MeetPaul'},
  // 01_NYC_UNATCOHQ: MeetManderley (radius 160, third person, JC and Manderley, cameras 3, 4, 5, audio package Mission01), the campaign's next one after MeetPaul.
  manderley: {map: '01_NYC_UNATCOHQ', location: [310, -164, 305], rotation: [0, 63442, 0], conversation: 'MeetManderley'},
  // 00_Intro: no placement and no ghost (the map's own player, which CameraPoint.Idle paralyses and hides); the shots are CameraPoint's.
  intro: {map: '00_Intro', noGhost: true, conversation: 'Intro'},
};

async function withPlay(body) {
  const {chromium} = await import('@playwright/test');
  const {createServer} = await import('vite');
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  const server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.__fixedDt = 1 / 60; });
    await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
      const response = await route.fetch();
      let body = await response.text();
      for (const original of ['const dt = Math.max(0, (time - (simLastPost ?? time - 1000 / 60)) / 1000);',
        'const dt = Math.max(0, (time - lastTime) / 1000);']) {
        if (!body.includes(original)) throw new Error(`the fixed-step patch no longer matches main.mjs: ${original}`);
        body = body.replace(original, `const dt = window.__fixedDt ?? ${original.slice('const dt = '.length)}`);
      }
      await route.fulfill({response, body});
    });
    await page.goto(`${url}/?hold=1&seed=1&antialias=0&detailTextures=0`);
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
    return await body({page, errors, scene: SCENES[option('scene', 'meetpaul')]});
  } finally { await browser.close(); await server.close(); }
}

async function timeline() {
  await withPlay(async ({page, errors, scene}) => {
    if (await page.evaluate(() => window.deusExViewer.status().map) !== scene.map) {
      await page.locator('#map').selectOption(scene.map);
      await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, scene.map, {timeout: 300000});
    }
    const probe = args => page.evaluate(args => window.deusExViewer.viewProbe(args), args);
    const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
    await probe({playersOnly: true, timeDilation: 1});
    await page.evaluate(() => window.deusExViewer.release());
    await frames(10);
    let landed = null;
    if (scene.noGhost) await probe({exec: ['ShowHud False']});
    else {
      await probe({ghost: true});
      await frames(5);
      await probe({location: scene.location, rotation: scene.rotation});
      await probe({exec: ['walk']});
      await frames(30);
      landed = await probe({});
      console.log('landed', JSON.stringify({location: landed.location, state: landed.state, physics: landed.physics}));
    }
    await probe({playersOnly: false});
    const log = [];
    let last = '', lastPose = null;
    const total = Number(option('frames', 1500));
    for (let tick = 1; tick <= total; tick++) {
      await frames(1);
      const p = await page.evaluate(() => window.deusExViewer.conversationProbe());
      const c = p.conPlay;
      const key = c ? JSON.stringify([c.con, c.state, c.event?.cls, c.event?.label, c.event?.soundID, c.speaker, c.camera?.position, c.window?.mode]) : 'none';
      const at = p.level.player.location, rot = p.level.player.viewRotation;
      if (scene.noGhost && (!lastPose || Math.hypot(at[0] - lastPose[0], at[1] - lastPose[1], at[2] - lastPose[2]) > 40 || Math.abs(rot[1] - lastPose[4]) > 2000 || Math.abs(rot[0] - lastPose[3]) > 1500)) {
        if (lastPose) console.log(tick, p.level.time.toFixed(3), 'view', JSON.stringify(at.map(Math.round)), JSON.stringify(rot), 'state', p.level.player.state);
        lastPose = [...at, rot[0], rot[1]];
      }
      if (key !== last) {
        last = key;
        const row = {tick, time: p.level.time, player: p.level.player.state, con: c?.con ?? null, state: c?.state ?? null, event: c?.event ?? null, camera: c?.camera ?? null, window: c?.window ?? null};
        log.push(row);
        console.log(tick, p.level.time.toFixed(3), p.level.player.state, c ? `${c.con} ${c.state} ${c.event?.cls ?? ''} ${c.event?.soundID ?? ''} cam ${c.camera?.position} fb=${c.camera?.fallback} win ${c.window?.mode} ${c.event?.text?.slice(0, 40) ?? ''}` : 'no conversation');
      }
      if (c && c.state === 'WaitForInput') { console.log('choice at tick', tick); break; }
    }
    const dir = path.join(root, '.work/acceptance', scene.map); mkdirSync(dir, {recursive: true});
    writeFileSync(path.join(dir, `conversation-${option('scene', 'meetpaul')}-timeline.json`), JSON.stringify({landed, log}, null, 1));
    if (errors.length) console.log('ERRORS', errors.slice(0, 3));
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// compare: visual-acceptance.mjs's metrics (edge recall and precision, outlier blocks, the mean ratio) for the whole frame, the pixel counts
// of the whole frame and of its regions (the letterbox bars, the subtitle line, the 3D band), and the 40x40 blocks that differ most.
export const WIDTH = 1280, HEIGHT = 720;
/** The regions of a third-person conversation frame at 1280x720 (docs/conversation-camera.md "Frames"): ConWindowActive's bars are
 * int(root height * upper/lowerFinalHeightPercent) (72 and 150 px here), the render viewport is the band between them, and the
 * subtitle is drawn in the lower bar. The subtitle box is taken from the frames themselves (the bounding box of the lower bar's pixels
 * that are not black in either frame, padded by 2). */
export const BARS = {top: 73, bottom: 570};
const rgb = file => execFileSync('magick', [file, '-depth', '8', 'rgb:-'], {maxBuffer: 1 << 28});
export function compareFrames(a, b, {stored = null} = {}) {
  const A = rgb(a), B = rgb(b);
  if (A.length !== WIDTH * HEIGHT * 3 || B.length !== WIDTH * HEIGHT * 3) throw new Error(`${a} or ${b} is not ${WIDTH}x${HEIGHT}`);
  // the subtitle box: non-black pixels of the lower bar in either frame
  let x0 = WIDTH, y0 = HEIGHT, x1 = -1, y1 = -1;
  for (let y = BARS.bottom; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const i = (y * WIDTH + x) * 3;
    if (A[i] || A[i + 1] || A[i + 2] || B[i] || B[i + 1] || B[i + 2]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  const box = x1 < 0 ? null : {x: Math.max(0, x0 - 2), y: Math.max(BARS.bottom, y0 - 2), width: Math.min(WIDTH, x1 + 3) - Math.max(0, x0 - 2), height: Math.min(HEIGHT, y1 + 3) - Math.max(BARS.bottom, y0 - 2)};
  const region = (x, y) => y < BARS.top ? 'topBar' : y >= BARS.bottom ? (box && x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height ? 'subtitle' : 'bottomBar') : 'band';
  const names = ['topBar', 'band', 'bottomBar', 'subtitle', 'frame'];
  const stat = Object.fromEntries(names.map(n => [n, {pixels: 0, same: 0, over2: 0, over10: 0, max: 0, sum: 0}]));
  const blocks = new Map();
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const i = (y * WIDTH + x) * 3;
    const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
    const sum = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    for (const n of [region(x, y), 'frame']) { const s = stat[n]; s.pixels++; if (d === 0) s.same++; if (d > 2) s.over2++; if (d > 10) s.over10++; s.max = Math.max(s.max, d); s.sum += sum; }
    if (d > 10) { const key = `${Math.floor(x / 40) * 40},${Math.floor(y / 40) * 40}`; blocks.set(key, (blocks.get(key) ?? 0) + 1); }
  }
  const rows = Object.fromEntries(names.map(n => { const s = stat[n]; return [n, {pixels: s.pixels, identical: s.pixels ? +(s.same / s.pixels).toFixed(5) : null, over2: s.over2, over10: s.over10, max: s.max, mad: s.pixels ? +(s.sum / (3 * s.pixels)).toFixed(3) : null}]; }));
  return {regions: rows, subtitleBox: box, worstBlocks: [...blocks].sort((p, q) => q[1] - p[1]).slice(0, 8).map(([k, n]) => `${k}:${n}`)};
}
function compare() {
  const scene = SCENES[option('scene', 'meetpaul')];
  const dir = path.join(root, '.work/acceptance', scene.map);
  const names = (option('frames', null) ?? '').split(',').filter(Boolean);
  const suffix = option('suffix', 'play');
  const report = {};
  for (const name of names) {
    const a = path.join(dir, `${name}-original.png`), b = path.join(dir, `${name}-${suffix}.png`);
    const args = [path.join(root, 'scripts/visual-acceptance.mjs'), 'compare', '--maps', scene.map, '--view', `${name}:0,0,0:0,0,0`, ...(suffix === 'play' ? [] : ['--play-name', suffix])];
    const text = execFileSync(process.execPath, args, {encoding: 'utf8'});
    const json = /(\{.*\})/.exec(text.trim().split('\n').at(-1))?.[1];
    const metrics = json ? JSON.parse(json) : {error: text.trim().split('\n').at(-1)};
    // visual-acceptance.mjs prints the outlier blocks as a count after the JSON ("<map> <view> {...} 3 outlier blocks")
    const row = {frame: name, ...compareFrames(a, b), mad: metrics.mad, ratio: metrics.ratio, edgeRecall: metrics.edgeRecall, edgePrecision: metrics.edgePrecision,
      outlierBlocks: Number(/\} (\d+) outlier blocks/.exec(text)?.[1] ?? NaN), error: metrics.error};
    report[name] = row;
    console.log(JSON.stringify(row));
  }
  if (names.length) writeFileSync(path.join(dir, `conversation-${option('scene', 'meetpaul')}-${suffix}-report.json`), JSON.stringify(report, null, 1));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// phonemes: the letters the original's audio update wrote into the speakers' nextPhoneme, read back from the trace as the mouth animations they
// started (Pawn.LipSynch: A MouthA, E MouthE, F MouthF, M MouthM, O MouthO, T MouthT, U MouthU, X MouthClosed, each a TweenBlendAnim on blend channel 0
// when the letter changes). The tick a channel-0 sequence changes in the trace is a tick whose entry stood on the new letter. Writes
// .work/live-acceptance/<map>/phonemes-<tag>.json for `live-acceptance.mjs play --phonemes` (a measured host input, docs/lip-sync.md).
const MOUTHS = {MouthA: 'A', MouthE: 'E', MouthF: 'F', MouthM: 'M', MouthO: 'O', MouthT: 'T', MouthU: 'U', MouthClosed: 'X'};
function phonemes() {
  const scene = SCENES[option('scene', 'meetpaul')], tag = option('tag', 'cv');
  const dir = path.join(root, '.work/live-acceptance', scene.map);
  const parse = line => JSON.parse(line.replace(/-?nan\([a-z0-9]+\)|-?nan\b|-?inf\b/gi, 'null'));
  const rows = readFileSync(path.join(dir, `original-trace-${tag}.jsonl`), 'utf8').trim().split('\n').map(parse).filter(row => row.unfrozen >= 1);
  const out = [], last = {};
  for (const row of rows) for (const [name, actor] of Object.entries(row.actors)) {
    if (actor.BSeq0 === undefined) continue;
    const sequence = actor.BSeq0 === 'None' || actor.BSeq0 === null ? null : actor.BSeq0;
    if (sequence !== (last[name] ?? null) && sequence in MOUTHS) out.push({n: row.unfrozen, name, letter: MOUTHS[sequence]});
    last[name] = sequence;
  }
  writeFileSync(path.join(dir, `phonemes-${tag}.json`), JSON.stringify(out));
  const by = {}; for (const e of out) by[e.name] = (by[e.name] ?? 0) + 1;
  console.log(`${out.length} letters`, JSON.stringify(by), '->', path.join(dir, `phonemes-${tag}.json`));
}

const verb = process.argv[2];
if (verb === 'timeline') await timeline();
else if (verb === 'compare') compare();
else if (verb === 'phonemes') phonemes();
else if (process.argv[1] === fileURLToPath(import.meta.url)) console.log('usage: conversation-acceptance.mjs timeline|compare [--scene meetpaul] [--frames a,b]');
