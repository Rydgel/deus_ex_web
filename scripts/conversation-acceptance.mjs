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
import { debugUrl } from './page-url.mjs';

export const root = fileURLToPath(new URL('..', import.meta.url));
const flag = name => process.argv.includes(`--${name}`);
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
  // At 1280x720 the force-played conversation's window is 16:9 of the width, the whole frame: no bars and no subtitle (the whole frame is the 3D band).
  intro: {map: '00_Intro', noGhost: true, conversation: 'Intro', bars: {top: 0, bottom: 720}},
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
      // (the lines as they are since 7525ca4d and 82482dcb: the worker's first post carries dt 0, the level's first tick having run during the load)
      for (const [original, fixed] of [['const dt = first ? 0 : Math.max(0, (time - (simLastPost ?? time - 1000 / 60)) / 1000);',
        'const dt = first ? 0 : (window.__fixedDt ?? Math.max(0, (time - (simLastPost ?? time - 1000 / 60)) / 1000));'],
        ['const previousTime = lastTime, dt = Math.max(0, (time - lastTime) / 1000);', 'const previousTime = lastTime, dt = window.__fixedDt ?? Math.max(0, (time - lastTime) / 1000);']]) {
        if (!body.includes(original)) throw new Error(`the fixed-step patch no longer matches main.mjs: ${original}`);
        body = body.replace(original, fixed);
      }
      await route.fulfill({response, body});
    });
    await page.goto(debugUrl(`${url}/?hold=1&seed=1&antialias=0&detailTextures=0`));
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
export function compareFrames(a, b, {bars = BARS} = {}) {
  const A = rgb(a), B = rgb(b);
  if (A.length !== WIDTH * HEIGHT * 3 || B.length !== WIDTH * HEIGHT * 3) throw new Error(`${a} or ${b} is not ${WIDTH}x${HEIGHT}`);
  // the subtitle box: non-black pixels of the lower bar in either frame
  let x0 = WIDTH, y0 = HEIGHT, x1 = -1, y1 = -1;
  for (let y = bars.bottom; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const i = (y * WIDTH + x) * 3;
    if (A[i] || A[i + 1] || A[i + 2] || B[i] || B[i + 1] || B[i + 2]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  const box = x1 < 0 ? null : {x: Math.max(0, x0 - 2), y: Math.max(bars.bottom, y0 - 2), width: Math.min(WIDTH, x1 + 3) - Math.max(0, x0 - 2), height: Math.min(HEIGHT, y1 + 3) - Math.max(bars.bottom, y0 - 2)};
  const region = (x, y) => y < bars.top ? 'topBar' : y >= bars.bottom ? (box && x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height ? 'subtitle' : 'bottomBar') : 'band';
  const names = ['topBar', 'band', 'bottomBar', 'subtitle', 'frame'];
  const stat = Object.fromEntries(names.map(n => [n, {pixels: 0, same: 0, over2: 0, over10: 0, max: 0, sum: 0}]));
  const blocks = new Map();
  // Where the two rasterizers can differ: a pixel within 1 px of a hard step (more than 24 of 255 to a right, lower or diagonal neighbour, in either frame): the
  // silhouettes, mesh triangle edges, brush edges and glints. A pixel off by more than 10 away from every step is a difference of shading, texture or colour.
  const step = (I, i, j) => Math.max(Math.abs(I[i] - I[j]), Math.abs(I[i + 1] - I[j + 1]), Math.abs(I[i + 2] - I[j + 2])) > 24;
  const edge = new Uint8Array(WIDTH * HEIGHT), near = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT - 1; y++) for (let x = 1; x < WIDTH - 1; x++) for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
    const i = (y * WIDTH + x) * 3, j = ((y + dy) * WIDTH + x + dx) * 3;
    if (step(A, i, j) || step(B, i, j)) { edge[y * WIDTH + x] = 1; edge[(y + dy) * WIDTH + x + dx] = 1; }
  }
  for (let y = 1; y < HEIGHT - 1; y++) for (let x = 1; x < WIDTH - 1; x++) if (edge[y * WIDTH + x]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near[(y + dy) * WIDTH + x + dx] = 1;
  let awayOver10 = 0, awayMax = 0;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const i = (y * WIDTH + x) * 3;
    const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
    const sum = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    for (const n of [region(x, y), 'frame']) { const s = stat[n]; s.pixels++; if (d === 0) s.same++; if (d > 2) s.over2++; if (d > 10) s.over10++; s.max = Math.max(s.max, d); s.sum += sum; }
    if (d > 10) { const key = `${Math.floor(x / 40) * 40},${Math.floor(y / 40) * 40}`; blocks.set(key, (blocks.get(key) ?? 0) + 1); if (!near[y * WIDTH + x]) { awayOver10++; awayMax = Math.max(awayMax, d); } }
  }
  const rows = Object.fromEntries(names.map(n => { const s = stat[n]; return [n, {pixels: s.pixels, identical: s.pixels ? +(s.same / s.pixels).toFixed(5) : null, over2: s.over2, over10: s.over10, max: s.max, mad: s.pixels ? +(s.sum / (3 * s.pixels)).toFixed(3) : null}]; }));
  return {regions: rows, awayFromEdges: {over10: awayOver10, max: awayMax}, subtitleBox: box, worstBlocks: [...blocks].sort((p, q) => q[1] - p[1]).slice(0, 8).map(([k, n]) => `${k}:${n}`)};
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
    const row = {frame: name, ...compareFrames(a, b, {bars: scene.bars}), mad: metrics.mad, ratio: metrics.ratio, edgeRecall: metrics.edgeRecall, edgePrecision: metrics.edgePrecision,
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
  // (--map: a live scene's map without a SCENES entry, the Stage 5 conversation scenes of scripts/validate-stage5-live.mjs)
  const scene = SCENES[option('scene', 'meetpaul')], tag = option('tag', 'cv');
  const dir = path.join(root, '.work/live-acceptance', option('map', scene.map));
  const parse = line => JSON.parse(line.replace(/-?nan\([a-z0-9]+\)|-?nan\b|-?inf\b/gi, 'null'));
  const rows = readFileSync(path.join(dir, `original-trace-${tag}.jsonl`), 'utf8').trim().split('\n').map(parse).filter(row => row.unfrozen >= 1);
  const out = [], last = {}, lastFrame = {};
  let jumps = 0, restarts = 0;
  // A trace with the speakers' nextPhoneme (live-acceptance.mjs --inventory: `NextPh`, the FString the audio update writes) gives the letters themselves:
  // the value a row holds is the one LipSynch read during that tick (written by the update after the previous one), fed before that tick.
  const measured = new Set(), heldLetter = {};
  for (const row of rows) for (const [name, actor] of Object.entries(row.actors)) {
    if (actor.NextPh === undefined) continue;
    measured.add(name);
    if (actor.NextPh !== (heldLetter[name] ?? '')) out.push({n: row.unfrozen, name, letter: actor.NextPh});
    heldLetter[name] = actor.NextPh;
  }
  for (const row of rows) for (const [name, actor] of Object.entries(row.actors)) {
    if (actor.BSeq0 === undefined || measured.has(name)) continue;
    const sequence = actor.BSeq0 === 'None' || actor.BSeq0 === null ? null : actor.BSeq0;
    if (sequence !== (last[name] ?? null) && sequence in MOUTHS) {
      // Pawn.LipSynch's end of speech (`else if (bWasSpeaking)`) tweens MouthClosed with `tweentime`, a local that only the speaking branch assigns: 0.
      // The blend channel jumps (BlendAnimFrame 0, BlendTweenRate 0) and no letter was written (Galaxy analyses only while bIsSpeaking). A letter
      // tween starts at BlendAnimFrame -1 with BlendTweenRate 10 (0.1 s), or, with a slow frame rate, jumps the same way: that case is not told apart
      // (only a jump to the closed mouth is taken for the end of speech). The left-in stale letter made the intro's Bob Page tween MouthClosed
      // at the first LipSynch of his next speech, one tick before the original's (docs/conversation-camera.md, the intro).
      if (sequence === 'MouthClosed' && actor.BFrame0 === 0 && actor.BTween0 === 0) jumps++;
      else out.push({n: row.unfrozen, name, letter: MOUTHS[sequence]});
    } else if (sequence === (last[name] ?? null) && sequence in MOUTHS && actor.BFrame0 === -1 && lastFrame[name] !== -1 && actor.BTween0 === 10) {
      // The same sequence tweened again: a letter whose sequence is the one already blended, after a letter that blended nothing (an animation the
      // mesh lacks, or none yet): Pawn.LipSynch moved lastPhoneme, the channel did not change name.
      out.push({n: row.unfrozen, name, letter: MOUTHS[sequence]}); restarts++;
    }
    last[name] = sequence; lastFrame[name] = actor.BFrame0;
  }
  out.sort((a, b) => a.n - b.n);
  if (measured.size) console.log(`${measured.size} speakers' letters read from their nextPhoneme`);
  writeFileSync(path.join(dir, `phonemes-${option('out', tag)}.json`), JSON.stringify(out));
  if (jumps || restarts) console.log(`${jumps} end-of-speech jumps to MouthClosed left out, ${restarts} restarts of the blended sequence taken as letters`);
  const by = {}; for (const e of out) by[e.name] = (by[e.name] ?? 0) + 1;
  console.log(`${out.length} letters`, JSON.stringify(by), '->', path.join(dir, `phonemes-${option('out', tag)}.json`));
}

const verb = process.argv[2];
if (verb === 'timeline') await timeline();
else if (verb === 'compare') compare();
else if (verb === 'phonemes') phonemes();
else if (process.argv[1] === fileURLToPath(import.meta.url)) console.log('usage: conversation-acceptance.mjs timeline|compare [--scene meetpaul] [--frames a,b]');
