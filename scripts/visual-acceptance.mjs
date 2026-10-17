// Original-game visual acceptance (docs/visual-acceptance.md): matched-camera
// frames of the original DeusEx.exe (under Wine or CrossOver) and of Play.
// Both sides take the same console inputs: bCheatsEnabled, `ghost`,
// `ShowHud False`, then per view Location, a zero Velocity and ViewRotation
// (the original types them into its console; Play's view-probe.mjs writes the
// same fields and runs ghost/ShowHud through the original console chain on
// the simulation side, worker mode by default).
//
//   node scripts/visual-acceptance.mjs play [--maps a,b] [--size 1280x720] [--query sim=inline] [--detail on]
//       (Play draws without detail textures, ?detailTextures=0, as every stored original frame lacks them; --detail on keeps them,
//       for a capture of the original taken with --poke D3DRenderDevice0:0x78:1; --detail-bias u1,u2 also writes each view at those
//       depth offsets of the detail passes as <view>-play-bias<u>.png)
//       loads each map in Play, writes the plan (views from the player's start
//       Location) and Play's frames
//   node scripts/visual-acceptance.mjs original [--maps a,b]
//       with DeusEx.exe already running in a 1280x720 window (ad/scripts/original-game.mjs
//       launch; DX_WINE/DX_GAME/WINEPREFIX for plain Wine), takes the original's frames
//   node scripts/visual-acceptance.mjs compare [--maps a,b]
//       per-view metrics and side-by-side/difference images
//   All three take --view name:x,y,z:pitch,yaw,roll (repeatable) to use explicit
//   cameras instead of the planned views; the plan itself keeps its views.
//   A view named <name>_s0 or <name>_s1 is taken with Render.dll's Strobe flag held at 0 or 1 (docs/visual-acceptance.md
//   "Strobe, a host input"): the original through `dx-live-win.exe strobe hold` (the flag flips every frame at a new
//   TimeSeconds, so an unheld capture is a coin flip), Play with TimeDilation 0 and the flag written (liveProbe strobe); `original` writes
//   the held state beside the frame (<name>-strobe-held.txt: the hold, a poll after the shot, the level time then).
//   `original --strobe-poll` also records the free-running flag per camera (<name>-strobe.txt), for any view.
//   `--cmd '<console command>'` (repeatable, all three verbs' sides) runs a console command once after ghost and ShowHud False, on the original's
//   console and through Play's viewProbe exec (e.g. `set ScriptedPawn bHidden True`: no pawn mesh lit by the map's Strobe light).
//   `original --cw-probe` attaches tools/dx-fpu-win.c for 6 seconds at each camera: DrawFrame, SetupForSurf (by the frame's Recursion), GlobalLighting,
//   the spatial light bodies and Galaxy's GlobalLighting call, with the x87 control word at each (<name>-cw.txt). `--cw-probe-early` attaches before the
//   camera moves, so the static lights' bodies (spot, Cylinder, NonIncidence: they run once, when a surface is first drawn) are seen.
//   `--unfreeze` (both sides) clears LevelInfo.bPlayersOnly after the clock is held, so actors with a Tick (a TriggerLight that sets
//   its own brightness) run it at the held dilation; the other views of the run are then of that level, not the frozen one.
//   `compare --flash-base <view>`: each view's viewport flash as a per-channel map of levels from the base view (the same camera without the flash)
//   to the view, the original's against Play's (flashMap below; held flash states through --pre-shot-cmd, docs/screen-flash.md).
//   `--decal-state` (both sides): after each shot, the level's Shadow decals and their owners as the frame had them (<view>-decals.json from the
//   running original, <view>-play-decals.json from Play); `compare --decal-state` matches them by owner (decalState below, docs/decals.md).
//   `play --camera-transit` places each camera as the original's console does: Location, frames, then ViewRotation.
//
// Frames are raw: the original's Shot bitmaps are its framebuffer before the
// gamma ramp, and Play is captured at Brightness 0.4, whose display ramp
// (pow(x, 1/(2.5*0.4))) is the identity. Output in .work/acceptance/ (local
// captures stay outside Git).
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, '.work/acceptance');
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const verb = process.argv[2];
const DEFAULT_MAPS = ['00_Training', '01_NYC_UNATCOIsland', '02_NYC_BatteryPark', '03_NYC_AirfieldHeliBase',
  '04_NYC_Street', '05_NYC_UNATCOMJ12lab', '06_HongKong_WanChai_Market', '08_NYC_Bar', '09_NYC_Ship',
  '10_Paris_Club', '11_Paris_Cathedral', '12_Vandenberg_Cmd', '14_OceanLab_Lab', '15_Area51_Bunker'];
const maps = (option('maps', null)?.split(',') ?? DEFAULT_MAPS);
const [WIDTH, HEIGHT] = option('size', '1280x720').split('x').map(Number);
const planPath = path.join(out, 'plan.json');
const freeze = !process.argv.includes('--live');
// --region Zone:leaf:zoneNumber (e.g. ZoneInfo4:380:7): after each view's Location, both sides
// set the player's Region to it (`set DeusEx.JCDentonMale Region (...)` in the
// original). `set Location` leaves the Region of the last move, which is the
// start's under ghost, and Region.iLeaf picks the static lights an actor's
// mesh gets (docs/mesh-lighting.md); a walking player would move through
// MoveActor and SetActorZone, but the original asserts ("moved without proper
// hashing") when a collision-enabled player is placed with `set Location`.
const regionOption = option('region', null);
const region = regionOption ? (([zone, leaf, number]) => ({zone, iLeaf: Number(leaf), zoneNumber: Number(number)}))(regionOption.split(':')) : null;
const onlyViews = option('views', null)?.split(',') ?? null;
// play --settle-frames n: page frames drawn after each view's camera is placed, before its shot (default 45). The animated light maps (Flicker and
// the wavers) draw their noise once per frame, so two runs with different counts show different noise: the pixels that move between them are
// noise-lit (docs/visual-acceptance.md "The darkest pixels").
const settleFrames = Number(option('settle-frames', 45));
// play --time-offset s: Play holds its level at the original's TimeSeconds plus s (default 0). Pixels lit by animated light maps (Pulse, Flicker, the
// wavers and their noise tables change with the level time) move between offsets; the rest do not (docs/visual-acceptance.md "The darkest pixels").
const timeOffset = Number(option('time-offset', 0));
// --cmd '<console command>' (repeatable): a command both sides run once, after ghost and ShowHud False (the original's console, Play's viewProbe
// exec), e.g. `--cmd 'set ScriptedPawn bHidden True'` for a view with no actor mesh lit by the map's Strobe light.
const consoleCommands = process.argv.flatMap((arg, i) => arg === '--cmd' ? [process.argv[i + 1]] : []);
// --pre-shot-cmd '<console command>' (repeatable): typed once per view just before the shot (the original's console after the camera is placed, Play's
// viewProbe exec), for a state the level's slow clock would otherwise let drift or reset: `set DeusEx.JCDentonMale FlashFog (X=...)`.
const preShotCommands = process.argv.flatMap((arg, i) => arg === '--pre-shot-cmd' ? [process.argv[i + 1]] : []);
// --pre-shot-wait ms: how long after them the shot waits (default 300): a state that converges (the viewport flash moves toward its goal by
// 10 * delta each tick, and a held level's actor delta has a floor of 0.005 s, so a flash set directly decays in a second) needs seconds.
const preShotWait = Number(option('pre-shot-wait', 300));
// <name>_s0 / <name>_s1: the Strobe flag the frame is taken with (null: free-running).
const strobeOf = name => { const m = /_s([01])$/.exec(name); return m ? Number(m[1]) : null; };
// --view name:x,y,z:pitch,yaw,roll (repeatable): explicit camera(s) used in
// place of the planned views, for one subject (a mirror, a face) at a known
// spot. Location and rotation are integers (raw rotator units), as the plan's.
const optionAll = name => process.argv.flatMap((a, i) => a === `--${name}` ? [process.argv[i + 1]] : []);
const explicitViews = optionAll('view').map(text => {
  const m = /^([\w.-]+):(-?\d+),(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)$/.exec(text);
  if (!m) throw new Error(`--view ${text}: expected name:x,y,z:pitch,yaw,roll (integers)`);
  const n = m.slice(2).map(Number);
  return {name: m[1], location: n.slice(0, 3), rotation: n.slice(3)};
});
const viewsOf = entry => explicitViews.length ? explicitViews : entry.views;
const loadPlan = () => existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : {};
// The original's level time when its clock was held (`original` writes it,
// `play` runs Play's frozen level to the same TimeSeconds before holding it).
const timesPath = path.join(out, 'times.json');
const loadTimes = () => existsSync(timesPath) ? JSON.parse(readFileSync(timesPath, 'utf8')) : {};
// A frame keeps its own clock beside it: `original` writes <map>/<view>-time.txt (the level time read just before the view's shot, since
// 2026-10-17; the time the level was held at in older stores) next to each frame, and `play` runs to each view's time when each has one. times.json keeps one time per map, overwritten by the next capture of
// the map, so a frame and the clock beside it can come from different captures (docs/stage-4-exit-criteria.md "Stored originals").
const timeFile = (map, view) => path.join(out, map, `${view}-time.txt`);
// An effect's contribution (the pass or the zone the frame is judged for) is the frame with it less the frame without it. A view named
// <name>-base is the original's frame without the effect (taken by `original` after --base-cmd, which turns it off in the live level: the
// same camera and clock as <name>, a different capture); `play --base fog|detail` writes Play's own frame without it, <name>-play-base.png;
// `compare --contribution` compares the two differences (docs/visual-acceptance.md "Effect frames").
const isBase = name => /-base$/.test(name);
const baseCommand = option('base-cmd', null), baseKind = option('base', null);
const BASE_OFF = {fog: () => window.deusExViewer.showFog(false), detail: () => window.deusExViewer.detail({hide: true}), decal: () => window.deusExViewer.decals({hide: true})};
const BASE_ON = {fog: () => window.deusExViewer.showFog(true), detail: () => window.deusExViewer.detail({hide: false}), decal: () => window.deusExViewer.decals({hide: false})};
// A view's stored clock (<view>-time.txt), or null.
const viewTimeOf = (map, view) => existsSync(timeFile(map, view.name)) ? Number(readFileSync(timeFile(map, view.name), 'utf8')) : null;
// The clock Play holds its level at before the first view: the views' own times run forward in the order they were taken (each frame keeps the level
// time read just before its shot, the original's clock running on at the held dilation between them), and Play steps its held clock to each view's
// time before that view's shot; times.json's one time per map is the fallback of older stores.
function heldTimeOf(map, views) {
  const times = views.map(view => viewTimeOf(map, view));
  const stored = times.filter(time => time !== null);
  if (!stored.length) return loadTimes()[map] ?? null;
  if (stored.length !== times.length) throw new Error(`${map}: some views have a stored clock and some do not (${times.join(', ')}): take them in separate runs (--view)`);
  if (times.some((time, i) => i && time < times[i - 1]))
    throw new Error(`${map}: the views' clocks do not run forward in the order given (${times.join(', ')}); Play's clock only moves forward: order the views by their time`);
  return stored[0];
}
const HELD_DILATION = 0.001;
mkdirSync(out, {recursive: true});
// --decal-state: a Shadow's inputs (its owner's Location, the trace's hit as its own Location, DrawScale, Rotation: Shadow.Tick) and its attachment
// (bHasDecal, SurfList.Num), the owner's LastRenderTime (Tick's doDraw) and the level time of the read. The original's offsets are the linked
// properties' (UProperty +0x48, read in Play with liveProbe `offsets`): Shadow.lastLocation +0x32c and bHasDecal +0x338 mask 1 past ADecal's 0x32c.
const DECAL_FIELDS = ['Owner:0x3c:obj', 'Location:0x114:f3', 'Rotation:0x120:i3', 'DrawScale:0x17c:f', 'HasDecal:0x338:bit:0x1', 'LastLocation:0x32c:f3',
  'Surfaces:0x324:u32', 'LastRenderTime:0x34:f', 'LastRenderedTime:0x31c:f', 'LevelTime:0xa8:pf:0x478', 'OwnerX:0x3c:pf:0x114', 'OwnerY:0x3c:pf:0x118',
  'OwnerZ:0x3c:pf:0x11c', 'OwnerVX:0x3c:pf:0x144', 'OwnerVY:0x3c:pf:0x148', 'OwnerVZ:0x3c:pf:0x14c', 'OwnerLastRenderTime:0x3c:pf:0x34'];
const SHADOW_PROPS = ['Owner', 'Location', 'Rotation', 'DrawScale', 'bHasDecal', 'lastLocation', 'SurfList', 'LastRenderTime', 'LastRenderedTime'];

// Views from a start Location: the four axis yaws level, and one looking
// down the start yaw. Integers, so both consoles get the same floats.
function viewsFrom(location, yaw) {
  const at = location.map(Math.round), snap = ((Math.round(yaw / 16384) * 16384) % 65536 + 65536) % 65536;
  return [0, 1, 2, 3].map(k => ({name: `y${k}`, location: at, rotation: [0, (snap + 16384 * k) % 65536, 0]}))
    .concat([{name: 'down', location: at, rotation: [65536 - 3000, snap, 0]}]);
}

async function play() {
  const {chromium} = await import('@playwright/test');
  const {createServer} = await import('vite');
  let server = null, url = option('url', null);
  if (!url) {
    const {default: base} = await import('../vite.config.mjs');
    // The tree may itself sit in .work/ or .claude/worktrees/, which the config denies.
    const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
      && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
    server = await createServer({...base, configFile: false, root, logLevel: 'error',
      server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
    await server.listen();
    url = server.resolvedUrls.local[0].replace(/\/$/, '');
  }
  const plan = loadPlan();
  const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
  try {
    for (const map of maps) {
      const page = await browser.newPage({viewport: {width: WIDTH, height: HEIGHT}, deviceScaleFactor: 1});
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      // Frozen frames step at a fixed 1/60 s (the profile script's --fixed-dt
      // patch of the page's frame time), so the hold lands on the same level
      // time in every run. The player's own animation is not held by the
      // level's TimeDilation but follows the page's frames: two captures differ
      // by its phase whatever the mesh path (docs/visual-acceptance.md "CPU and
      // GPU mesh paths"; validate-mesh-path-frames.mjs compares the paths
      // frame for frame). --real-time keeps the page's clock.
      if (freeze && !process.argv.includes('--real-time')) await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
        const response = await route.fetch();
        let body = await response.text();
        for (const original of ['const dt = Math.max(0, (time - (simLastPost ?? time - 1000 / 60)) / 1000);',
          'const dt = Math.max(0, (time - lastTime) / 1000);']) {
          if (!body.includes(original)) throw new Error(`the fixed-step patch no longer matches main.mjs: ${original}`);
          body = body.replace(original, 'const dt = 1 / 60;');
        }
        await route.fulfill({response, body});
      });
      // Frozen (the default): the page holds its frame loop (?hold=1) until
      // LevelInfo.bPlayersOnly is set, as the original's console sets it
      // before `open`; --live lets the level run.
      // Every stored original frame lacks the detail-texture pass (docs/visual-acceptance.md "Detail textures"): Play draws without it
      // (?detailTextures=0) unless --detail on, for a comparison with a capture of the original taken with the pass poked in.
      const query = [freeze ? 'hold=1' : '', option('detail', 'off') === 'on' || /detailTextures=/.test(option('query', '')) ? '' : 'detailTextures=0',
        option('query', '')].filter(Boolean).join('&');
      await page.goto(`${url}/${query ? `?${query}` : ''}`);
      await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
      if (await page.evaluate(() => window.deusExViewer.status().map) !== map) {
        await page.locator('#map').selectOption(map);
        await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, {timeout: 300000});
      }
      await page.addStyleTag({content: `.toolbar, footer, #toast, #play-hint, #npc-preview-label, #panel, #crosshair, #gate { display: none !important; }
#app { height: 100vh !important; } #viewport { position: fixed !important; inset: 0 !important; width: ${WIDTH}px; height: ${HEIGHT}px; }
#scene { position: fixed !important; left: 0 !important; top: 0 !important; margin: 0 !important; border: 0 !important; transform: none !important; width: ${WIDTH}px !important; height: ${HEIGHT}px !important; }`});
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await page.evaluate(() => { const el = document.getElementById('brightness'); el.value = '0.4'; el.dispatchEvent(new Event('input')); });
      const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
      if (freeze) {
        await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: true}));
        await page.evaluate(() => window.deusExViewer.release());
      }
      await frames(30);
      const start = await page.evaluate(() => window.deusExViewer.viewProbe({}));
      const entry = plan[map] ?? (plan[map] = {start: start.location, startRotation: start.viewRotation,
        views: viewsFrom(start.location, start.viewRotation[1])});
      const ghost = await page.evaluate(commands => window.deusExViewer.viewProbe({ghost: true, exec: commands}), consoleCommands);
      // --rng-pin <hex state>: every SetupDynamics run starts from that state of the shared stream (the original's `rngpin`).
      if (option('rng-pin', null)) await page.evaluate(pin => window.deusExViewer.viewProbe({rngPin: pin}), option('rng-pin', null));
      // Level time: run the frozen level to the original's held TimeSeconds
      // (fast, then at normal speed for the last second), then hold it.
      const heldTime = heldTimeOf(map, viewsOf(entry).filter(view => !isBase(view.name) && (!onlyViews || onlyViews.includes(view.name)))), target = heldTime === null ? null : heldTime + timeOffset;
      let held = null;
      if (target !== null) {
        held = await page.evaluate(async ({target, dilation}) => {
          const probe = args => window.deusExViewer.viewProbe(args), frame = () => new Promise(r => requestAnimationFrame(r));
          let state = await probe({timeDilation: 20});
          while (state.timeSeconds < target - 1.5) { await frame(); state = await probe({}); }
          state = await probe({timeDilation: 1});
          while (state.timeSeconds < target - 0.1) { await frame(); state = await probe({}); }
          // The last tenth of a second at a twentieth of the speed: a frame
          // then advances the level by under a millisecond, so the hold lands
          // within that of the original's TimeSeconds whatever the frame time
          // (full-speed frames overshot by up to a frame, 17 ms).
          state = await probe({timeDilation: 0.05});
          while (state.timeSeconds < target) { await frame(); state = await probe({}); }
          state = await probe({timeDilation: dilation});
          return state.timeSeconds;
        }, {target, dilation: HELD_DILATION});
      }
      if (process.argv.includes('--unfreeze')) { await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: false})); await frames(30); }
      const dir = path.join(out, map); mkdirSync(dir, {recursive: true});
      const box = await page.locator('#scene').boundingBox();
      const buffer = await page.evaluate(() => { const c = document.getElementById('scene'); return [c.width, c.height]; });
      if (buffer[0] !== WIDTH || buffer[1] !== HEIGHT || box.x !== 0 || box.y !== 0 || box.width !== WIDTH || box.height !== HEIGHT)
        throw new Error(`the scene canvas is ${box.width}x${box.height} at ${box.x},${box.y} (buffer ${buffer.join('x')}), not ${WIDTH}x${HEIGHT}`);
      const shots = [], viewHeld = new Map();
      for (const view of viewsOf(entry).filter(view => !isBase(view.name))) {
        // --camera-transit: the camera placed as the original's console places it, `set Location` and then, typed lines later, `set ViewRotation`:
        // frames are drawn at the new Location with the previous rotation, and what they draw is stamped LastRenderTime (with the level unfrozen,
        // Shadow.Tick attaches the shadow of a pawn drawn there only: 00_Training's ScientistMale0 from shadow2's Location at the start's rotation).
        if (process.argv.includes('--camera-transit')) {
          await page.evaluate(([v, region]) => window.deusExViewer.viewProbe({location: v.location, region}), [view, region]);
          await frames(6);
        }
        await page.evaluate(([v, region]) => window.deusExViewer.viewProbe({location: v.location, rotation: v.rotation, region}), [view, region]);
        await frames(settleFrames);
        // The view's own clock (heldTimeOf): the held level is run on to it at a twentieth of the speed (under a millisecond a frame), then held again.
        const own = held !== null ? viewTimeOf(map, view) : null;
        if (own !== null) {
          const reached = await page.evaluate(async ({target, dilation}) => {
            const probe = args => window.deusExViewer.viewProbe(args), frame = () => new Promise(r => requestAnimationFrame(r));
            let state = await probe({});
            if (state.timeSeconds >= target) return state.timeSeconds;
            state = await probe({timeDilation: 0.05});
            while (state.timeSeconds < target) { await frame(); state = await probe({}); }
            state = await probe({timeDilation: dilation});
            return state.timeSeconds;
          }, {target: own + timeOffset, dilation: HELD_DILATION});
          viewHeld.set(view.name, reached);
        }
        // --player-pose: the player's animation as `original --player-state` measured it for this view (<view>-state.json); AnimRate 0 because
        // the player's own ticks follow the page's frames, not the held level (the security-camera captures write it the same way).
        if (preShotCommands.length) { await page.evaluate(lines => window.deusExViewer.viewProbe({exec: lines}), preShotCommands); await frames(Math.max(6, Math.round(preShotWait / 1000 * 60))); }
        const stateFile = path.join(dir, `${view.name}-state.json`);
        if (process.argv.includes('--player-pose') && existsSync(stateFile)) {
          const {player} = JSON.parse(readFileSync(stateFile, 'utf8'));
          await page.evaluate(fields => window.deusExViewer.placeProbe({set: {actor: '$player', fields}}), {...player.anim, AnimRate: 0});
          await frames(6);
        }
        const strobe = strobeOf(view.name);
        if (strobe !== null) {
          // Hold the level's clock (no new TimeSeconds, no flip) and write the flag, as the original's frame is taken.
          await page.evaluate(() => window.deusExViewer.viewProbe({timeDilation: 0}));
          await frames(3);
          const seen = await page.evaluate(() => window.deusExViewer.liveProbe({strobe: {}}));
          await page.evaluate(([flag, time]) => window.deusExViewer.liveProbe({strobe: {flag, time}}), [strobe, seen.strobe.time]);
          await frames(3);
        }
        const state = await page.evaluate(() => {
          const s = window.deusExViewer.status();
          return {position: s.position, rotation: s.rotation, runtimeError: s.runtimeError?.message ?? null};
        });
        const probe = await page.evaluate(() => window.deusExViewer.viewProbe({}));
        await page.screenshot({path: path.join(dir, `${view.name}-play.png`),
          clip: {x: 0, y: 0, width: WIDTH, height: HEIGHT}});
        if (process.argv.includes('--decal-state')) {
          const {actors} = await page.evaluate(props => window.deusExViewer.liveProbe({actors: 'deusex.shadow', actorProps: props}), SHADOW_PROPS);
          const owners = [...new Set(actors.map(row => row.Owner).filter(Boolean))];
          const {read} = await page.evaluate(names => window.deusExViewer.liveProbe({read: {names, props: ['Location', 'Velocity', 'LastRenderTime']}}), owners);
          const time = (await page.evaluate(() => window.deusExViewer.viewProbe({}))).timeSeconds;
          writeFileSync(path.join(dir, `${view.name}-play-decals.json`), JSON.stringify({map, view: view.name, shadows: actors.map(row => ({name: row.name, owner: row.Owner,
            location: row.Location, rotation: row.Rotation, drawScale: row.DrawScale, hasDecal: row.bHasDecal, lastLocation: row.lastLocation, surfaces: row.SurfList.length,
            lastRenderTime: row.LastRenderTime, lastRenderedTime: row.LastRenderedTime, time, ownerLocation: read[row.Owner]?.Location ?? null,
            ownerVelocity: read[row.Owner]?.Velocity ?? null, ownerLastRenderTime: read[row.Owner]?.LastRenderTime ?? null}))}, null, 1));
        }
        if (baseKind) {
          // The same view without the effect (--base fog|detail): <view>-play-base.png.
          await page.evaluate(BASE_OFF[baseKind]);
          await frames(6);
          await page.screenshot({path: path.join(dir, `${view.name}-play-base.png`), clip: {x: 0, y: 0, width: WIDTH, height: HEIGHT}});
          await page.evaluate(BASE_ON[baseKind]);
          await frames(3);
        }
        // --detail-bias f:u[:d],... (with --detail on): the same view again at each depth offset of the detail passes (polygon offset
        // slope factor f and units u, constant depth d in steps of 2^-24), as <view>-play-bias<f>_<u>_<d>.png: the measurement of ZBIAS 15
        // against a capture of the original with the pass poked in.
        const biases = option('detail-bias', '').split(',').filter(Boolean).map(spec => spec.split(':').map(Number));
        if (biases.length) {
          // The same frame without the pass (<view>-play-off.png), the reference of each bias' contribution.
          await page.evaluate(() => window.deusExViewer.detail({hide: true}));
          await frames(6);
          await page.screenshot({path: path.join(dir, `${view.name}-play-off.png`), clip: {x: 0, y: 0, width: WIDTH, height: HEIGHT}});
          await page.evaluate(() => window.deusExViewer.detail({hide: false}));
        }
        for (const [factor, units, depth = 0] of biases) {
          await page.evaluate(bias => window.deusExViewer.detail(bias), {factor, units, depth: depth * 2 ** -24});
          await frames(6);
          await page.screenshot({path: path.join(dir, `${view.name}-play-bias${factor}_${units}_${depth}.png`), clip: {x: 0, y: 0, width: WIDTH, height: HEIGHT}});
        }
        if (strobe !== null) await page.evaluate(d => window.deusExViewer.viewProbe({timeDilation: d}), HELD_DILATION);
        shots.push({view: view.name, time: viewHeld.get(view.name) ?? held, camera: state, player: {location: probe.location, region: probe.region, state: probe.state, physics: probe.physics, anim: probe.anim}});
      }
      writeFileSync(path.join(dir, 'play.json'), JSON.stringify({map, freeze, size: [box.width, box.height], ghost, timeTarget: target, timeHeld: held, shots, errors}, null, 1));
      console.log(map, `${shots.length} views`, ghost.state, held !== null ? `time ${held.toFixed(3)} (original ${heldTime.toFixed(3)}${timeOffset ? `, offset ${timeOffset}` : ""})` : '', errors.length ? `errors: ${errors.slice(0, 2).join(' | ')}` : '');
      await page.close();
      writeFileSync(planPath, JSON.stringify(plan, null, 1));
    }
  } finally { await browser.close(); await server?.close(); }
}

// The game window under Hyprland: floating, WIDTHxHEIGHT and inside the
// screen. Map loads tile it again, so it is checked before every shot.
function hyprlandWindow() {
  // the game's window is the largest client of the class (a hidden log window shares it)
  const find = () => JSON.parse(execFileSync('hyprctl', ['clients', '-j'], {encoding: 'utf8'})).filter(c => c.class.toLowerCase() === 'deusex.exe')
    .sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1])[0];
  const placed = w => w && w.floating && w.size[0] === WIDTH && w.size[1] === HEIGHT && w.at[0] >= 0 && w.at[1] >= 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const window = find();
    if (!window) throw new Error('no deusex.exe window');
    if (placed(window)) return attempt > 0;
    const at = `address:${window.address}`;
    for (const dispatch of [`hl.dsp.window.float({ action = "set", window = "${at}" })`,
      `hl.dsp.window.resize({ x = ${WIDTH}, y = ${HEIGHT}, relative = false, window = "${at}" })`,
      `hl.dsp.window.center({ window = "${at}" })`])
      { execFileSync('hyprctl', ['dispatch', dispatch]); execFileSync('sleep', ['1.5']); } // each takes effect before the next (a resize sent right after the float was ignored)
    execFileSync('sleep', ['1']);
  }
  throw new Error('the deusex.exe window does not stay floating at the capture size');
}

// The breakpoints of --cw-probe (tools/dx-fpu-win.c): DrawFrame and SetupForSurf by the frame's Recursion, the pass, GlobalLighting, Galaxy's call and
// the spatial bodies (normal, spot, NonIncidence, Cylinder, Searchlight, SlowWave, FastWave, CloudCast, Shock, Disco, Interference, Rotor, Shell).
// --cw-spec label=Module.dll:0xADDR[:n=N][:ret] (repeatable) adds breakpoints to --cw-probe's; --cw-only drops the default ones (a count at an address
// in the running original, e.g. D3DDrv's detail-texture pass, docs/frame-projection.md "Detail textures").
const cwSpecs = () => [...(process.argv.includes('--cw-only') ? [] : defaultCwSpecs()), ...optionAll('cw-spec')];
const defaultCwSpecs = () => ['frame=Engine.dll:0x1038f110', 'drawframe=Render.dll:0x10b1a2d0:n=10:rec', 'setupforsurf=Render.dll:0x10b06c90:n=2000:rec',
  'pass-open=Render.dll:0x10b1462f:ret', 'pass-close=Render.dll:0x10b14732:ret', 'galaxy-lighting-call=Galaxy.dll:0x1060992e:ret:n=10', 'globallighting=Render.dll:0x10b05e90:n=40',
  'tick=Engine.dll:0x103a51a0:n=2', 'light-noise=Render.dll:0x10b13080:n=2', 'setupdynamics=Render.dll:0x10b22d90:n=2', 'dyn-filter=Render.dll:0x10b24a10:n=4',
  'computefromactor=Render.dll:0x10b05fa0:n=12', 'fghsv=Engine.dll:0x103ec8d0:n=8', 'setupforactor=Render.dll:0x10b08c70:n=12', 'light-mesh=Render.dll:0x10b027f0:n=12',
  'leafvolumetric=Render.dll:0x10b170e0:n=4', 'merge=Render.dll:0x10b03040:n=3',
  ...[['normal', 0x10b03360], ['spot', 0x10b04f80], ['nonincidence', 0x10b054e0], ['cylinder', 0x10b04a80], ['searchlight', 0x10b03770],
    ['slowwave', 0x10b03de0], ['fastwave', 0x10b040b0], ['cloudcast', 0x10b04380], ['shock', 0x10b043a0], ['disco', 0x10b046f0],
    ['interference', 0x10b04c80], ['rotor', 0x10b03ae0], ['shell', 0x10b05740]].map(([name, at]) => `body-${name}=Render.dll:0x${at.toString(16)}:n=3`)];

async function original() {
  const game = await import('../ad/scripts/original-game.mjs');
  const plan = loadPlan(), scratch = path.join(out, 'steps');
  mkdirSync(scratch, {recursive: true});
  let step = 0;
  const post = (lines, timeout) => {
    const file = path.join(scratch, `step-${String(step++).padStart(3, '0')}.txt`);
    writeFileSync(file, lines.join('\n') + '\n');
    game.run(file, timeout);
  };
  const loadWait = Number(option('load-wait', 25000));
  let current = option('current', null);
  for (const map of maps) {
    const entry = plan[map];
    if (!entry) { console.log(map, 'not in the plan (run `play` first)'); continue; }
    const dir = path.join(out, map); mkdirSync(dir, {recursive: true});
    // --reuse: the map is already loaded and ghosted (a retake).
    if (!process.argv.includes('--reuse')) {
      // A map visited before in this mission loads its travel state from
      // Save\\Current (LoadMap ..\\Save\\Current\\<map>.dxs), not the map file:
      // move that state aside (reversibly) so every capture starts fresh, as Play does.
      // Leaving a map saves it there, so the map loaded now (--current, then
      // the last one opened) is left for another first.
      const travel = path.join(game.GAME, 'Save', 'Current', `${map}.dxs`);
      if (current === map) {
        const other = map === '00_Training' ? '01_NYC_UNATCOIsland' : '00_Training';
        post([`cmd open ${other}`, `sleep ${loadWait}`], loadWait + 60000);
      }
      if (existsSync(travel)) {
        const aside = path.join(out, 'save-current'); mkdirSync(aside, {recursive: true});
        renameSync(travel, path.join(aside, `${map}-${Date.now()}.dxs`));
      }
      post([...(freeze ? ['cmd set LevelInfo bPlayersOnly True', 'sleep 300'] : []), 'cmd set LevelInfo TimeDilation 1', 'sleep 300',
        `cmd open ${map}`, `sleep ${loadWait}`], loadWait + 60000);
      current = map;
      // Hyprland tiles the window again when a map opens: float it back to
      // the WIDTHxHEIGHT client area (DX_HYPRLAND=1), as before the first map.
      // It must lie inside the screen: Shot locks the primary surface for the
      // window's rectangle, and a rectangle past the edge fails
      // (DDERR_INVALIDPARAMS) and writes a black frame.
      if (process.env.DX_HYPRLAND === '1') hyprlandWindow();
      // --brightness b: the original's Brightness setting. Shot bakes a ramp of it into the bitmap (the framebuffer to the 1/(1.5 b));
      // 0.666667 makes the Shot the framebuffer (docs/visual-acceptance.md "Security cameras", item 6). Not set by default.
      post([...(option('brightness', null) ? [`cmd set WinDrv.WindowsClient Brightness ${option('brightness')}`, 'sleep 600'] : []),
        'cmd set DeusEx.JCDentonMale bCheatsEnabled True', 'sleep 200', 'cmd ghost', 'sleep 200', 'cmd ShowHud False', 'sleep 300',
        ...consoleCommands.flatMap(command => [`cmd ${command}`, 'sleep 300']),
        `cmd set LevelInfo TimeDilation ${HELD_DILATION}`, 'sleep 500']);
      // The held level time, through the live player's Level (old levels'
      // LevelInfo objects can linger until garbage collection).
      const readLive = () => execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'JCDentonMale',
        'Player:0x5d4:u32', 'LevelTime:0xa8:pf:0x478', 'Dilation:0xa8:pf:0x474'], {encoding: 'utf8', env: process.env})
        .split('\n').map(line => /^JCDentonMale \S+ Player=0x([0-9a-f]+) LevelTime=(\S+) Dilation=(\S+)/.exec(line)).filter(m => m && m[1] !== '0');
      // The game can drop a typed character (the line then fails as an unknown command or property, silently): the held dilation is read back and
      // its line typed again, and a level that was not frozen before the load is refused (its actors have ticked: a TriggerLight is at its own
      // brightness, no longer the map's). bPlayersOnly is LevelInfo +0x4f0 & 4 (tools/dx-live-win.c); the live LevelInfo is the one at the player's time.
      // --brightness, read back: a dropped line leaves the Shot at the ini's ramp (0.6 on the Mac: about 1.3 times darker at every pixel). UClient's
      // Brightness is WindowsClient0 +0x6c in Deus Ex's build, WindowedViewportX +0x54 the layout check (scripts/camera-acceptance.mjs, the same read).
      if (option('brightness', null)) {
        const want = Number(option('brightness')), readClient = () => {
          const text = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'WindowsClient', 'Brightness:0x6c:f', 'X:0x54:u32'], {encoding: 'utf8', env: process.env});
          // the instance's row (the class default object's comes first, "Class WindowsClient"); u32 fields print in hex
          const m = text.split(/\r?\n/).map(line => /^WindowsClient WindowsClient\d+ Brightness=(\S+) X=(0x[0-9a-f]+|\d+)/.exec(line)).find(Boolean);
          if (!m || Number(m[2]) !== WIDTH) throw new Error(`${map}: the WindowsClient layout does not read back (${text.trim().slice(0, 120)})`);
          return Number(m[1]);
        };
        for (let retry = 0, value = readClient(); Math.abs(value - want) >= 1e-4; retry++, value = readClient()) {
          if (retry === 3) throw new Error(`${map}: the console did not take the Brightness line (reads ${value})`);
          console.log(map, `Brightness reads ${value}: the line again`);
          post([`cmd set WinDrv.WindowsClient Brightness ${option('brightness')}`, 'sleep 800']);
        }
      }
      let live = readLive();
      for (let retry = 0; retry < 3 && live.length === 1 && Math.abs(Number(live[0][3]) - HELD_DILATION) > 1e-6; retry++) {
        console.log(map, `dilation ${live[0][3]}: the dilation line again`);
        post([`cmd set LevelInfo TimeDilation ${HELD_DILATION}`, 'sleep 500']);
        live = readLive();
      }
      // --cmd-check '<object> <field:offset:type[:mask]> <value>' (repeatable): a field the --cmd lines set, read back from the running original
      // (dump-actor-win.exe); the --cmd lines are typed again while one reads otherwise, e.g. 'Hooker0 bHidden:0x28:bit:0x2 1' for `set ScriptedPawn bHidden True`.
      const cmdChecks = optionAll('cmd-check').map(text => text.split(' '));
      const checkCmds = () => cmdChecks.filter(([object, field, value]) => {
        const row = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), object, field], {encoding: 'utf8', env: process.env})
          .split('\n').map(line => line.trim().split(' ')).find(parts => parts[1] === object);
        return row?.[2] !== `${field.split(':')[0]}=${value}`;
      });
      for (let retry = 0, off = checkCmds(); off.length; retry++, off = checkCmds()) {
        if (retry === 3) throw new Error(`${map}: the --cmd lines did not take (${off.map(c => c.join(' ')).join(', ')})`);
        console.log(map, `${off.map(c => c.join(' ')).join(', ')} reads otherwise: the --cmd lines again`);
        post(consoleCommands.flatMap(command => [`cmd ${command}`, 'sleep 300']));
      }
      if (live.length !== 1) throw new Error(`${map}: ${live.length} live players in the original`);
      if (Math.abs(Number(live[0][3]) - HELD_DILATION) > 1e-6) throw new Error(`${map}: the original's dilation is ${live[0][3]}, not ${HELD_DILATION}`);
      if (freeze) {
        const levels = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'LevelInfo', 'Time:0x478:f', 'PlayersOnly:0x4f0:bit:0x4'],
          {encoding: 'utf8', env: process.env}).split('\n').map(line => /^LevelInfo \S+ Time=(\S+) PlayersOnly=(\d)/.exec(line)).filter(Boolean)
          .sort((a, b) => Math.abs(Number(a[1]) - Number(live[0][2])) - Math.abs(Number(b[1]) - Number(live[0][2])));
        if (levels[0]?.[2] !== '1') throw new Error(`${map}: the original's level is not frozen (LevelInfo bPlayersOnly ${levels[0]?.[2]}): the line before the load was dropped; take the capture again`);
      }
      const times = loadTimes(); times[map] = Number(live[0][2]);
      writeFileSync(timesPath, JSON.stringify(times, null, 1));
      console.log(map, 'held at TimeSeconds', times[map], 'dilation', live[0][3]);
    }
    if (process.argv.includes('--unfreeze')) post(['cmd set LevelInfo bPlayersOnly False', 'sleep 1500']);
    // The level time at a shot: the live player's LevelInfo (its address read once: the walk over the object array takes seconds) and its TimeSeconds
    // (+0x478) through dx-live-win's poll, which reads it without the walk. null when either read fails (the frame then keeps the load's held time).
    let levelAddress = null;
    const shotClock = () => {
      try {
        if (levelAddress === null) {
          const m = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'JCDentonMale', 'Player:0x5d4:u32', 'Level:0xa8:u32'], {encoding: 'utf8', env: process.env})
            .split('\n').map(line => /^JCDentonMale \S+ Player=0x([0-9a-f]+) Level=0x([0-9a-f]+)/.exec(line.trim())).find(m => m && m[1] !== '0');
          levelAddress = m ? m[2] : '';
        }
        if (!levelAddress) return null;
        const level = /level=(\S+)/.exec(execFileSync(game.WINE, [path.join(root, 'ad/build/dx-live-win.exe'), 'strobe', 'poll', '1', '0', levelAddress], {encoding: 'utf8', env: process.env}))?.[1];
        return level === undefined || !Number.isFinite(Number(level)) ? null : Number(level);
      } catch { return null; }
    };
    // The views without the effect (<name>-base) come last: --base-cmd turns the effect off once, in this same level and at the same held clock.
    const ordered = [...viewsOf(entry).filter(view => !isBase(view.name)), ...viewsOf(entry).filter(view => isBase(view.name))];
    let baseDone = false;
    // --rng-pin <hex state>: tools/dx-live-win.c `rngpin` stays attached for the views and starts every SetupDynamics run of the original from that CRT
    // rand state, so the render iterators' draws (a laser's last item) are the same in every frame, as Play's with the same --rng-pin.
    let pinDone = null;
    if (option('rng-pin', null)) {
      const child = spawn(game.WINE, [path.join(root, 'ad/build/dx-live-win.exe'), 'rngpin', String(30 + 16 * ordered.length), option('rng-pin', null)], {env: process.env, stdio: ['ignore', 'inherit', 'inherit']});
      pinDone = new Promise(resolve => child.on('close', resolve));
      execFileSync('sleep', ['6']);   // the debugger attaches before the camera moves
    }
    for (const view of ordered) {
      if (onlyViews && !onlyViews.includes(view.name)) continue;
      if (isBase(view.name) && !baseDone) {
        if (!baseCommand && !optionAll('base-poke').length) throw new Error(`${view.name} needs --base-cmd '<console command that turns the effect off>' or --base-poke`);
        if (baseCommand) post([`cmd ${baseCommand}`, 'sleep 800']);
        baseDone = true;
      }
      const [x, y, z] = view.location, [pitch, yaw, roll] = view.rotation;
      let taken = [];
      for (let attempt = 0; attempt < 3 && !(taken.length && taken[0].width === WIDTH && taken[0].height === HEIGHT); attempt++) {
        // A window just placed again shows a stale frame first: let the
        // device settle and take a throwaway shot.
        if (process.env.DX_HYPRLAND === '1' && hyprlandWindow()) {
          const before = game.shots();
          post(['sleep 3000', 'shot', 'sleep 900']);
          for (const shot of game.shots().filter(shot => !before.includes(shot))) renameSync(path.join(game.SYSTEM, shot), path.join(scratch, shot));
        }
        const before = game.shots();
        const strobe = strobeOf(view.name);
        let frameTime = null;
        let earlyProbe = null;
        if (process.argv.includes('--cw-probe-early') && attempt === 0) {
          const child = spawn(game.WINE, [path.join(root, 'ad/build/dx-fpu-win.exe'), 'cw', 'attach', '11', ...cwSpecs()], {env: process.env, stdio: ['ignore', 'pipe', 'ignore']});
          const chunks = [];
          child.stdout.on('data', chunk => chunks.push(chunk));
          earlyProbe = new Promise(resolve => child.on('close', () => resolve(Buffer.concat(chunks).toString())));
          execFileSync('sleep', ['4']);   // the debugger attaches before the camera moves
        }
        // --poke Object:offset:value (repeatable): a 32-bit field of a live object of the original, written before each camera
        // (tools/poke-object-win.c), e.g. D3DRenderDevice0:0x78:1 sets the device's DetailTextures that Wine's ddraw caps made 0.
        // --base-poke (repeatable): the pokes of the -base views, in place of --poke's (the detail pass off: D3DRenderDevice0:0x78:0).
        for (const spec of isBase(view.name) && optionAll('base-poke').length ? optionAll('base-poke') : optionAll('poke')) {
          const [object, offset, value] = spec.split(':');
          console.log(execFileSync(game.WINE, [path.join(root, 'ad/build/poke-object-win.exe'), object, offset, value], {encoding: 'utf8', env: process.env}).trim());
        }
        post([`cmd set DeusEx.JCDentonMale Location (X=${x},Y=${y},Z=${z})`, 'cmd set DeusEx.JCDentonMale Velocity (X=0,Y=0,Z=0)',
          `cmd set DeusEx.JCDentonMale ViewRotation (Pitch=${pitch},Yaw=${yaw},Roll=${roll})`,
          ...(region ? [`cmd set DeusEx.JCDentonMale Region (Zone=ZoneInfo'${map}.${region.zone}',iLeaf=${region.iLeaf},ZoneNumber=${region.zoneNumber})`] : []),
          'sleep 1500', ...(process.argv.includes('--freeze-player') ? ['cmd set DeusEx.JCDentonMale AnimRate 0', 'sleep 400'] : []),
          ...preShotCommands.flatMap(line => [`cmd ${line}`, 'sleep 300']), ...(preShotCommands.length && preShotWait > 300 ? [`sleep ${preShotWait - 300}`] : [])]);
        // A free-running view's own clock: the held level runs on at TimeDilation 0.001 while the read-backs and the earlier views take their seconds
        // (a minute on a loaded host), and an animated light follows it (an LT_Pulse of period 8 turns 4.4 times a second of level time), so the level time
        // is read just before the shot (dx-live-win's poll of the live LevelInfo, as for a held-Strobe view) and kept as the frame's clock; `play` steps
        // its held clock to each view's own time. The held time of the load stays the fallback when the read fails.
        if (strobe === null) {
          frameTime = shotClock();
          post(['shot', 'sleep 900']);
        }
        // --strobe-poll on a view with no _s0/_s1 suffix: the free-running flag at this camera, 120 samples 5 ms apart (<name>-strobe.txt).
        if (strobe === null && process.argv.includes('--strobe-poll')) {
          const tool = args => execFileSync(game.WINE, [path.join(root, 'ad/build/dx-live-win.exe'), 'strobe', ...args], {encoding: 'utf8', env: process.env});
          tool(['release']);
          post(['sleep 400']);
          writeFileSync(path.join(dir, `${view.name}-strobe.txt`), tool(['poll', '120', '5']));
        }
        // --cw-probe: attach tools/dx-fpu-win.c for a few seconds at this camera: DrawFrame and SetupForSurf by the frame's Recursion (<name>-cw.txt).
        // --cw-probe-early attached before the camera was placed (below), so the static lights' bodies, which run once when a surface is first drawn, are seen.
        if (process.argv.includes('--cw-probe') && !process.argv.includes('--cw-probe-early')) {
          const specs = cwSpecs();
          writeFileSync(path.join(dir, `${view.name}-cw.txt`), execFileSync(game.WINE, [path.join(root, 'ad/build/dx-fpu-win.exe'), 'cw', 'attach', '6', ...specs],
            {encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'ignore']}));
        }
        if (earlyProbe) {
          const out = await earlyProbe;
          writeFileSync(path.join(dir, `${view.name}-cw.txt`), out);
        }
        if (strobe !== null) {
          const tool = args => execFileSync(game.WINE, [path.join(root, 'ad/build/dx-live-win.exe'), 'strobe', ...args], {encoding: 'utf8', env: process.env});
          // the free-running flag at this camera (a hold left by an earlier view is released first, and the flag needs a frame to move)
          if (process.argv.includes('--strobe-poll') && strobe === 0) {
            tool(['release']);
            post(['sleep 400']);
            writeFileSync(path.join(dir, `${view.name.replace(/_s0$/, '')}-strobe.txt`), tool(['poll', '120', '5']));
          }
          const hold = tool(['hold', String(strobe)]).trim();
          console.log(map, view.name, hold);
          // The live player's camera and its LevelInfo (its row: the class object JCDentonMale is listed too, with class Class). The walk over the
          // object array takes seconds, a minute on a loaded host, so the clock around the shot is read through the LevelInfo's address instead.
          const live = () => execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'JCDentonMale', 'Player:0x5d4:u32', 'Level:0xa8:u32',
            'Location:0x114:f3', 'ViewRotation:0x3dc:i3'], {encoding: 'utf8', env: process.env}).split('\n')
            .map(line => /^JCDentonMale \S+ Player=0x([0-9a-f]+) Level=0x([0-9a-f]+) Location=(\S+) ViewRotation=(\S+)/.exec(line.trim())).find(m => m && m[1] !== '0');
          const camera = live();
          const clock = () => camera ? /level=(\S+)/.exec(tool(['poll', '1', '0', camera[2]]))?.[1] ?? null : null;
          // The clock runs on at the held dilation while the views are taken (the poll's waits and the hold make it tenths of a second of level time over a
          // run), and an animated light in view follows it: the frame keeps the level time read just before its shot as its own clock (<view>-time.txt).
          const t0 = clock();
          if (t0 !== null) frameTime = Number(t0);
          post(['shot', 'sleep 900']);
          const t1 = clock();
          // The held state beside the frame (<view>-strobe-held.txt): the hold (the patched byte, the flag written, Render.dll's kept time), a poll
          // after the shot (still the held flag and kept time: no flip was drawn in between), the level time just before and just after the shot, and the
          // camera before and after (a console line the game dropped would leave the previous view's camera).
          const after = tool(['poll', '1']).trim(), then = live();
          const row = (t, m) => `level time ${t ?? 'unread'} ${m ? `Location=${m[3]} ViewRotation=${m[4]}` : 'camera unread'}`;
          writeFileSync(path.join(dir, `${view.name}-strobe-held.txt`), `${hold}\npoll after shot: ${after}\nbefore shot: ${row(t0, camera)}\nafter shot: ${row(t1, then)}\n`);
        }
        const fresh = game.shots().filter(shot => !before.includes(shot));
        taken = fresh.map(shot => {
          const png = path.join(dir, `${view.name}-original.png`), size = game.bmpToPng(path.join(game.SYSTEM, shot), png);
          renameSync(path.join(game.SYSTEM, shot), path.join(dir, `${view.name}-original.bmp`));
          return size;
        });
        // The frame's own clock, beside it (the level time the clock was held at, read from the running original; a held-Strobe view's, the time at its shot).
        if (taken.length) writeFileSync(timeFile(map, view.name), `${frameTime ?? loadTimes()[map]}\n`);
        // --player-state: the player's animation as the frame had it (a mirror or a camera window shows his mesh). Under `ghost` the original's
        // JC stands in `Still` at frame 0 with rate 0 (measured, constant over seconds); Play's, which has run its CheatFlying state far longer in
        // level time than the original's held clock allowed, loops `Tread`: the pose is an input of the held state, so Play writes the original's.
        if (taken.length && process.argv.includes('--player-state')) {
          const text = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'JCDentonMale', 'Player:0x5d4:u32', 'Location:0x114:f3', 'Rotation:0x120:i3',
            'ViewRotation:0x3dc:i3', 'AnimSequence:0x54:name', 'AnimFrame:0x58:f', 'AnimRate:0x5c:f', 'TweenRate:0x60:f', 'AnimLast:0x220:f', 'AnimMinRate:0x224:f', 'OldAnimRate:0x228:f',
            'B0:0x68:name', 'B1:0x6c:name', 'B2:0x70:name', 'B3:0x74:name', 'F0:0x78:f', 'F1:0x7c:f', 'F2:0x80:f', 'F3:0x84:f', 'R0:0x88:f', 'R1:0x8c:f', 'R2:0x90:f', 'R3:0x94:f',
            'T0:0x98:f', 'T1:0x9c:f', 'T2:0xa0:f', 'T3:0xa4:f', 'L0:0x23c:f', 'L1:0x240:f', 'L2:0x244:f', 'L3:0x248:f', 'M0:0x24c:f', 'M1:0x250:f', 'M2:0x254:f', 'M3:0x258:f',
            'FlashScale:0x610:f3', 'FlashFog:0x61c:f3'], {encoding: 'utf8', env: process.env});
          const row = {};
          for (const line of text.split(/\r?\n/)) {
            const m = /^JCDentonMale (\S+) (.*)$/.exec(line);
            if (!m || /Player=0x0\b/.test(m[2])) continue;
            for (const part of m[2].matchAll(/(\w+)=(\([^)]*\)|\S+)/g)) row[part[1]] = part[2].startsWith('(') ? part[2].slice(1, -1).split(',').map(Number) : Number.isNaN(Number(part[2])) ? part[2] : Number(part[2]);
          }
          const four = key => [0, 1, 2, 3].map(k => row[`${key}${k}`]);
          writeFileSync(path.join(dir, `${view.name}-state.json`), JSON.stringify({map, view: view.name, timeSeconds: loadTimes()[map], player: {location: row.Location, rotation: row.Rotation, viewRotation: row.ViewRotation,
            anim: {AnimSequence: row.AnimSequence, AnimFrame: row.AnimFrame, AnimRate: row.AnimRate, TweenRate: row.TweenRate, AnimLast: row.AnimLast, AnimMinRate: row.AnimMinRate, OldAnimRate: row.OldAnimRate,
              BlendAnimSequence: four('B'), BlendAnimFrame: four('F'), BlendAnimRate: four('R'), BlendTweenRate: four('T'), BlendAnimLast: four('L'), BlendAnimMinRate: four('M')}, flash: {FlashScale: row.FlashScale, FlashFog: row.FlashFog}}}, null, 1));
        }
        // --decal-state: the level's Shadow actors as the frame had them (rows of class Shadow: the name also matches properties and states).
        if (taken.length && process.argv.includes('--decal-state')) {
          const text = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'Shadow', ...DECAL_FIELDS], {encoding: 'utf8', env: process.env});
          const shadows = [];
          for (const line of text.split(/\r?\n/)) {
            const m = /^Shadow (\S+) (.*)$/.exec(line);
            if (!m) continue;
            const row = {};
            for (const part of m[2].matchAll(/(\w+)=(\([^)]*\)|\S+)/g)) row[part[1]] = part[2].startsWith('(') ? part[2].slice(1, -1).split(',').map(Number) : Number.isNaN(Number(part[2])) ? part[2] : Number(part[2]);
            const owned = row.Owner !== 'None';
            shadows.push({name: m[1], owner: owned ? row.Owner : null, location: row.Location, rotation: row.Rotation, drawScale: row.DrawScale, hasDecal: row.HasDecal,
              lastLocation: row.LastLocation, surfaces: row.Surfaces, lastRenderTime: row.LastRenderTime, lastRenderedTime: row.LastRenderedTime, time: row.LevelTime,
              ownerLocation: owned ? [row.OwnerX, row.OwnerY, row.OwnerZ] : null, ownerVelocity: owned ? [row.OwnerVX, row.OwnerVY, row.OwnerVZ] : null,
              ownerLastRenderTime: owned ? row.OwnerLastRenderTime : null});
          }
          writeFileSync(path.join(dir, `${view.name}-decals.json`), JSON.stringify({map, view: view.name, timeSeconds: loadTimes()[map], shadows}, null, 1));
        }
      }
      console.log(map, view.name, taken.length ? `${taken[0].width}x${taken[0].height} at ${readFileSync(timeFile(map, view.name), 'utf8').trim()}` : 'NO SHOT');
      if (taken.length && (taken[0].width !== WIDTH || taken[0].height !== HEIGHT)) throw new Error(`${map} ${view.name}: the original's frame is ${taken[0].width}x${taken[0].height}, not ${WIDTH}x${HEIGHT}`);
    }
    if (pinDone) await pinDone;
  }
}

// Raw RGB through ImageMagick (no image library in the tree).
function readRgb(file) {
  const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', file], {encoding: 'utf8'}).split(' ').map(Number);
  return {w, h, data: execFileSync('magick', [file, '-depth', '8', 'rgb:-'], {maxBuffer: 1 << 28})};
}
function writeRgb(file, w, h, data) {
  execFileSync('magick', ['-size', `${w}x${h}`, '-depth', '8', 'rgb:-', file], {input: data});
}
const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
// Sobel edges: each frame's strongest 5% of gradient magnitudes (at least
// 4 luma steps), so the threshold follows the frame. A fixed threshold
// counted the uniform raw brightness gap as extra or missing edges in dark
// views.
function edges(img) {
  const {w, h, data} = img, L = new Float32Array(w * h), G = new Float32Array(w * h), E = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = luma(data, 3 * i);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = (dx, dy) => L[(y + dy) * w + x + dx];
    const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
    const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
    G[y * w + x] = Math.hypot(gx, gy);
  }
  const threshold = Math.max(4, Float32Array.from(G).sort()[Math.floor(0.95 * G.length)]);
  for (let i = 0; i < w * h; i++) E[i] = G[i] >= threshold ? 1 : 0;
  return E;
}
// Share of `a`'s edge pixels with an edge of `b` within `r` pixels.
function edgeRecall(a, b, w, h, r = 2) {
  let n = 0, hit = 0;
  for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
    if (!a[y * w + x]) continue;
    n++;
    search: for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (b[(y + dy) * w + x + dx]) { hit++; break search; }
  }
  return n ? hit / n : 1;
}
// The sub-pixel offset of Play's frame against the original's: the shift
// (1/8-pixel steps, ±1.5 px) of Play's luma, bilinearly resampled and scaled
// to the original's mean, that best matches the original at its strong
// gradients. It measured (−0.5, −0.5) before Play took the original's pixel
// centres (play-camera.mjs setPixelCentre). Null with too few gradients.
function subpixelOffset(A, B) {
  const {w, h} = A, la = new Float32Array(w * h), lb = new Float32Array(w * h);
  let ma = 0, mb = 0;
  for (let i = 0; i < w * h; i++) { la[i] = luma(A.data, 3 * i); lb[i] = luma(B.data, 3 * i); ma += la[i]; mb += lb[i]; }
  const gain = ma / Math.max(mb, 1), points = [];
  for (let y = 40; y < h - 40; y += 2) for (let x = 40; x < w - 40; x += 2)
    if (Math.hypot(la[y * w + x + 1] - la[y * w + x - 1], la[(y + 1) * w + x] - la[(y - 1) * w + x]) > 12) points.push(y * w + x);
  if (points.length < 1500) return null;
  const at = (x, y) => { const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (lb[i] * (1 - fx) + lb[i + 1] * fx) * (1 - fy) + (lb[i + w] * (1 - fx) + lb[i + w + 1] * fx) * fy; };
  let best = null;
  for (let dy = -1.5; dy <= 1.5; dy += 0.125) for (let dx = -1.5; dx <= 1.5; dx += 0.125) {
    let e = 0;
    for (const i of points) { const v = la[i] - gain * at(i % w + dx, Math.floor(i / w) + dy); e += v * v; }
    if (!best || e < best.e) best = {dx, dy, e};
  }
  return [best.dx, best.dy];
}

function compareOne(a, b, prefix) {
  const A = readRgb(a), B = readRgb(b);
  if (A.w !== B.w || A.h !== B.h) return {error: `size ${A.w}x${A.h} vs ${B.w}x${B.h}`};
  const {w, h} = A, n = w * h, mean = [[0, 0, 0], [0, 0, 0]];
  let mad = 0;
  const diff = Buffer.alloc(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
    const x = A.data[3 * i + c], y = B.data[3 * i + c];
    mean[0][c] += x; mean[1][c] += y; mad += Math.abs(x - y);
  }
  // Difference image: red where Play is brighter, blue where darker (luma), x4.
  for (let i = 0; i < n; i++) {
    const d = luma(B.data, 3 * i) - luma(A.data, 3 * i);
    diff[3 * i] = Math.min(255, Math.max(0, 4 * d)); diff[3 * i + 2] = Math.min(255, Math.max(0, -4 * d));
    diff[3 * i + 1] = Math.min(255, luma(A.data, 3 * i) / 3);
  }
  const EA = edges(A), EB = edges(B);
  // 16x9 blocks: Play/original mean-luma ratio, to localize missing or extra content.
  const GX = 16, GY = 9, blocks = [];
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
    let la = 0, lb = 0, k = 0;
    for (let y = Math.floor(gy * h / GY); y < Math.floor((gy + 1) * h / GY); y++)
      for (let x = Math.floor(gx * w / GX); x < Math.floor((gx + 1) * w / GX); x++) { la += luma(A.data, 3 * (y * w + x)); lb += luma(B.data, 3 * (y * w + x)); k++; }
    blocks.push(+((lb / k + 1) / (la / k + 1)).toFixed(3));
  }
  writeRgb(`${prefix}-diff.png`, w, h, diff);
  execFileSync('magick', [a, b, `${prefix}-diff.png`, '+append', '-resize', '50%', `${prefix}-side.png`]);
  const m = mean.map(v => v.map(x => x / n));
  const sorted = [...blocks].sort((x, y) => x - y);
  return {
    meanOriginal: m[0].map(x => +x.toFixed(2)), meanPlay: m[1].map(x => +x.toFixed(2)),
    ratio: +((m[1][0] + m[1][1] + m[1][2] + 3) / (m[0][0] + m[0][1] + m[0][2] + 3)).toFixed(3),
    mad: +(mad / (3 * n)).toFixed(2),
    edgeRecall: +edgeRecall(EA, EB, w, h).toFixed(3), edgePrecision: +edgeRecall(EB, EA, w, h).toFixed(3),
    subpixel: subpixelOffset(A, B),
    blockRatio: {min: sorted[0], median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1]},
    outlierBlocks: blocks.map((r, i) => [i % GX, Math.floor(i / GX), r]).filter(([, , r]) => Math.abs(Math.log(r / sorted[sorted.length >> 1])) > Math.log(1.6)),
  };
}

// The contribution of an effect: (frame with it) - (frame without it), the original's against Play's, per channel in 8-bit levels. The two
// programs' brightness differs by a uniform factor (the Wine gamma issue, not judged), so what is compared is the pattern: the sum of Play's
// difference over the original's (the gap's order), the Pearson correlation of the two luma differences over the frame, the mean absolute
// residual after the best scale (k = sum(P O) / sum(O^2)) as a share of the mean absolute original difference, and, over the pixels where
// the original's difference is at least 1 level (the effect's own pixels), the share where Play's has the same sign and at least a
// quarter of the scaled value. An effect that darkens (a modulated decal, `2 tex dst`) has a negative sum: its own pixels are those at least
// 1 level darker and the gap is Play's sum over the original's as signed sums (`sign`; the haze, which brightens, reads as before).
function contribution(dir, name) {
  const files = [`${name}-original.png`, `${name}-base-original.png`, `${name}-play.png`, `${name}-play-base.png`].map(f => path.join(dir, f));
  if (!files.every(f => existsSync(f))) return null;
  const [ow, o0, pw, p0] = files.map(readRgb), n = ow.w * ow.h;
  const lum = (a, b) => { const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = luma(a.data, 3 * i) - luma(b.data, 3 * i); return d; };
  const O = lum(ow, o0), P = lum(pw, p0);
  let so = 0, sp = 0, soo = 0, spp = 0, sop = 0, absO = 0, absP = 0, sumO = 0, sumP = 0;
  for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) { sumO += ow.data[3 * i + c] - o0.data[3 * i + c]; sumP += pw.data[3 * i + c] - p0.data[3 * i + c]; }
  for (let i = 0; i < n; i++) { so += O[i]; sp += P[i]; soo += O[i] * O[i]; spp += P[i] * P[i]; sop += O[i] * P[i]; absO += Math.abs(O[i]); absP += Math.abs(P[i]); }
  const k = soo ? sop / soo : 0, corr = (sop - so * sp / n) / Math.sqrt(Math.max(1e-9, (soo - so * so / n) * (spp - sp * sp / n)));
  const sign = sumO < 0 ? -1 : 1;
  let resid = 0, own = 0, agree = 0;
  for (let i = 0; i < n; i++) {
    resid += Math.abs(P[i] - k * O[i]);
    if (sign * O[i] >= 1) { own++; if (sign * P[i] >= 0.25 * k * sign * O[i]) agree++; }
  }
  return {originalSum: sumO, playSum: sumP, sign, gap: +(sumP / (sign * Math.max(1, sign * sumO))).toFixed(3), meanAbsOriginal: +(absO / n).toFixed(4), meanAbsPlay: +(absP / n).toFixed(4),
    correlation: +corr.toFixed(4), scale: +k.toFixed(3), residual: +(resid / Math.max(1e-9, absO)).toFixed(3), effectPixels: own, agreement: own ? +(agree / own).toFixed(3) : null};
}

// compare --flash-base <view>: the viewport flash as a map of levels. EndFlash makes each channel `fog + frame * alpha` on the 8-bit back buffer
// (docs/screen-flash.md), so a program's frame with the flash is a function of its own frame without it at the same camera (<view>-original.png and
// <view>-play.png of the base view): per channel, the level each input level goes to (the majority output; a pixel off it is a stray: the flash is not
// one map, or the scene moved between the two frames). The original's map and Play's are compared at every (channel, level) both base frames hold, so
// what the scene draws differently (judged by the frame rows) drops out and the pass's own arithmetic and rounding remain.
function flashMap(dir, base, name) {
  const files = [`${base}-original.png`, `${name}-original.png`, `${base}-play.png`, `${name}-play.png`].map(f => path.join(dir, f));
  if (!files.every(f => existsSync(f))) return null;
  const [o0, o1, p0, p1] = files.map(readRgb);
  const levels = (a, b) => {
    const counts = new Uint32Array(3 * 256 * 256);
    for (let i = 0; i < a.data.length; i++) counts[((i % 3) * 256 + a.data[i]) * 256 + b.data[i]]++;
    const out = new Int16Array(3 * 256).fill(-1);
    let strays = 0;
    for (let k = 0; k < 3 * 256; k++) {
      let best = -1, total = 0;
      for (let u = 0; u < 256; u++) { const n = counts[k * 256 + u]; total += n; if (n && (best < 0 || n > counts[k * 256 + best])) best = u; }
      if (best >= 0) { out[k] = best; strays += total - counts[k * 256 + best]; }
    }
    return {out, strays};
  };
  const O = levels(o0, o1), P = levels(p0, p1), differing = [];
  let shared = 0;
  for (let k = 0; k < 3 * 256; k++) if (O.out[k] >= 0 && P.out[k] >= 0) { shared++; if (O.out[k] !== P.out[k]) differing.push(`${'RGB'[k >> 8]}${k & 255}:${O.out[k]}/${P.out[k]}`); }
  return {levels: shared, differing: differing.length, firstDiffering: differing.slice(0, 6), straysOriginal: O.strays, straysPlay: P.strays,
    // what level 0 and the base's brightest level go to in the original, per channel (the fog bytes, and the scale or the saturation)
    zero: [0, 1, 2].map(c => O.out[c * 256]), top: [0, 1, 2].map(c => { let v = 255; while (v > 0 && O.out[c * 256 + v] < 0) v--; return [v, O.out[c * 256 + v]]; })};
}

// compare --decal-state: each view's Shadow decals, the original's (<view>-decals.json) against Play's (<view>-play-decals.json), matched by owner
// (names compare without case: the programs spell some map actors differently, the original's `mib1` is Play's `MIB1`). Per shadow: bHasDecal and the
// number of surfaces it is attached to, and for one attached in both its Location (Shadow.Tick's trace hit), Rotation (Rotator(HitNormal)) and DrawScale
// (from the owner's collision size and the hit's distance); the owner's Location over all of them (a pawn that walked moves its shadow).
// The player is matched as the player (Play's start reloads the map, so its JC is JCDentonMale1 where the original's is JCDentonMale2). A shadow the
// frame drew is one whose LastRenderedTime (stamped by the decal block for a nonempty fragment) is within DRAWN_WITHIN of the read's level time: at
// the held dilation a frame advances the clock by microseconds, and a shadow last drawn at the previous camera is 1e-3 s (Play) to 2e-2 s older.
const DRAWN_WITHIN = 2e-4;
function decalState(dir, name) {
  const files = [`${name}-decals.json`, `${name}-play-decals.json`].map(f => path.join(dir, f));
  if (!files.every(f => existsSync(f))) return null;
  const key = s => /^jcdentonmale\d*$/i.test(s.owner) ? '(player)' : s.owner.toLowerCase();
  const [O, P] = files.map(f => JSON.parse(readFileSync(f, 'utf8')).shadows.filter(s => s.owner));
  const byOwner = new Map(P.map(s => [key(s), s]));
  const drawn = list => list.filter(s => s.lastRenderedTime > 0 && s.time - s.lastRenderedTime < DRAWN_WITHIN).map(key).sort();
  // The fields are float32 in both programs (the original's printed with %.9g, which gives a float32 back exactly): compared as float32, bit for bit.
  const gap = (a, b) => a && b ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : Infinity;
  const same32 = (a, b) => a && b && a.length === b.length && a.every((v, i) => Math.fround(v) === Math.fround(b[i]));
  const differing = [], unmatched = [...O.filter(s => !byOwner.has(key(s))).map(s => s.owner),
    ...P.filter(s => !O.some(o => key(o) === key(s))).map(s => `${s.owner} (Play)`)];
  let matched = 0, maxLocation = 0, maxDrawScale = 0, maxOwnerLocation = 0;
  for (const o of O) {
    const p = byOwner.get(key(o));
    if (!p) continue;
    matched++;
    const off = [];
    if (o.hasDecal !== p.hasDecal) off.push(`bHasDecal ${o.hasDecal}/${p.hasDecal}`);
    if (o.surfaces !== p.surfaces) off.push(`surfaces ${o.surfaces}/${p.surfaces}`);
    // attached in either: where its owner stands; attached in both: where the decal is, turned how and how large
    if (o.surfaces || p.surfaces) {
      maxOwnerLocation = Math.max(maxOwnerLocation, gap(o.ownerLocation, p.ownerLocation));
      if (!same32(o.ownerLocation, p.ownerLocation)) off.push(`owner at ${o.ownerLocation.join(',')}/${p.ownerLocation?.join(',')}`);
    }
    if (o.surfaces && p.surfaces) {
      maxLocation = Math.max(maxLocation, gap(o.location, p.location));
      maxDrawScale = Math.max(maxDrawScale, Math.abs(o.drawScale - p.drawScale));
      if (!same32(o.location, p.location)) off.push(`Location ${o.location.join(',')}/${p.location.join(',')}`);
      if (!same32([o.drawScale], [p.drawScale])) off.push(`DrawScale ${o.drawScale}/${p.drawScale}`);
      if (o.rotation.some((v, i) => v !== p.rotation[i])) off.push(`Rotation ${o.rotation.join(',')}/${p.rotation.join(',')}`);
    }
    if (off.length) differing.push(`${o.owner}: ${off.join(', ')}`);
  }
  return {shadows: O.length, matched, unmatched, attached: [O.filter(s => s.surfaces).length, P.filter(s => s.surfaces).length], drawn: [drawn(O), drawn(P)], differing,
    maxLocation: +maxLocation.toPrecision(3), maxDrawScale: +maxDrawScale.toPrecision(3), maxOwnerLocation: +maxOwnerLocation.toPrecision(3)};
}

// compare --beams: the laser beams' geometry. A beam is the only strongly red thing in the Island doorways, so a pixel's beam energy is its red excess
// `R - max(G, B)` (floored at 0, ignored under 2 levels; Play's divided by the frame's brightness ratio, the Wine gap this document does not judge).
// The beams' texture, LaserBeam1, is a FireTexture whose sparks the original draws from a process-seeded stream and Play from a host-seeded one, and it
// ticks every frame, so two frames of the original itself differ in the bright dashes of every beam (pinning the stream at SetupDynamics, which fixes the
// items' own draws, does not change that): the pixels cannot be matched and the comparison is of what the texture does not move, in 64 x 64 blocks:
// where there is beam energy (blocks with energy in both, of those with it in either), how much of it (Play's total over the original's) and where in
// the block (the centroid's offset in y and x, rms over the blocks that hold energy in both), and the Pearson correlation of the block energies.
// The same numbers between two frames of the original (a second capture of the view, <view>b-original.png) are the floor, `beamsFloor`.
function beamMetrics(a, b, block = 64) {
  const A = readRgb(a), B = readRgb(b), {w, h} = A, n = w * h;
  let sa = 0, sb = 0;
  for (let i = 0; i < 3 * n; i++) { sa += A.data[i]; sb += B.data[i]; }
  const ratio = (sb + 3) / (sa + 3), gx = Math.ceil(w / block), gy = Math.ceil(h / block);
  const blocks = (img, scale) => {
    const e = new Float64Array(gx * gy), cx = new Float64Array(gx * gy), cy = new Float64Array(gx * gy);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, v = Math.max(0, (img.data[3 * i] - Math.max(img.data[3 * i + 1], img.data[3 * i + 2])) / scale);
      if (v < 2) continue;
      const k = Math.floor(y / block) * gx + Math.floor(x / block);
      e[k] += v; cx[k] += v * x; cy[k] += v * y;
    }
    for (let k = 0; k < e.length; k++) if (e[k]) { cx[k] /= e[k]; cy[k] /= e[k]; }
    return {e, cx, cy};
  };
  const P = blocks(A, 1), Q = blocks(B, ratio), BLOCK_ENERGY = 200;   // red-excess levels summed over a block: below it the block holds no beam
  let m = gx * gy, sp = 0, sq = 0, spp = 0, sqq = 0, spq = 0, both = 0, either = 0;
  const dx = [], dy = [];
  for (let k = 0; k < m; k++) {
    const p = P.e[k], q = Q.e[k];
    sp += p; sq += q; spp += p * p; sqq += q * q; spq += p * q;
    if (p > BLOCK_ENERGY || q > BLOCK_ENERGY) { either++; if (p > BLOCK_ENERGY && q > BLOCK_ENERGY) { both++; dx.push(Q.cx[k] - P.cx[k]); dy.push(Q.cy[k] - P.cy[k]); } }
  }
  const rms = list => Math.sqrt(list.reduce((s, v) => s + v * v, 0) / Math.max(1, list.length)), mean = list => list.reduce((s, v) => s + v, 0) / Math.max(1, list.length);
  const correlation = (spq - sp * sq / m) / Math.sqrt(Math.max(1e-9, (spp - sp * sp / m) * (sqq - sq * sq / m)));
  return {ratio: +ratio.toFixed(3), block, energy: +(sq / Math.max(1e-9, sp)).toFixed(3), correlation: +correlation.toFixed(4),
    coverage: either ? +(both / either).toFixed(3) : null, blocks: either, yMean: +mean(dy).toFixed(2), yRms: +rms(dy).toFixed(2), xMean: +mean(dx).toFixed(2), xRms: +rms(dx).toFixed(2)};
}

// compare --crop WxH+X+Y: the metrics over that region only (the crops are
// kept as <view>-crop-original.png / -play.png); --play-name <suffix>: compare
// <view>-<suffix>.png of Play (an experiment's frame) instead of <view>-play.png.
function compare() {
  const report = {}, plan = loadPlan(), crop = option('crop', null), playName = option('play-name', 'play');
  for (const map of maps) {
    const dir = path.join(out, map);
    for (const view of viewsOf(plan[map] ?? {views: []}).filter(view => !isBase(view.name))) {
      let a = path.join(dir, `${view.name}-original.png`), b = path.join(dir, `${view.name}-${playName}.png`);
      if (!existsSync(a) || !existsSync(b)) continue;
      let prefix = path.join(dir, playName === 'play' ? view.name : `${view.name}-${playName}`);
      if (crop) {
        const cropped = (file, name) => { const to = `${prefix}-crop-${name}.png`; execFileSync('magick', [file, '-crop', crop, '+repage', to]); return to; };
        a = cropped(a, 'original'); b = cropped(b, playName); prefix = `${prefix}-crop`;
      }
      const result = compareOne(a, b, prefix);
      if (process.argv.includes('--beams') && !crop && playName === 'play') {
        result.beams = beamMetrics(a, b);
        const twin = path.join(dir, `${view.name}b-original.png`);
        if (existsSync(twin)) result.beamsFloor = beamMetrics(a, twin);   // a second frame of the original's own view: its frame-to-frame variation
      }
      if (process.argv.includes('--contribution') && !crop && playName === 'play') { const c = contribution(dir, view.name); if (c) result.contribution = c; }
      if (process.argv.includes('--decal-state') && !crop && playName === 'play') { const d = decalState(dir, view.name); if (d) result.decalState = d; }
      const flashBase = option('flash-base', null);
      if (flashBase && view.name !== flashBase && !crop && playName === 'play') { const f = flashMap(dir, flashBase, view.name); if (f) result.flashMap = f; }
      (report[map] ??= {})[view.name] = result;
      const {outlierBlocks, ...brief} = result;
      console.log(map, view.name, JSON.stringify(brief), `${outlierBlocks?.length ?? 0} outlier blocks`);
    }
  }
  if (!crop && playName === 'play') writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
}

if (verb === 'play') await play();
else if (verb === 'original') await original();
else if (verb === 'compare') compare();
else console.log('usage: visual-acceptance.mjs play|original|compare [--maps a,b]');
