// Matched captures of the interface (HUD, the persona screens, the main menu and a Settings screen, the screens a frob opens) against the
// original (docs/interface-frames.md): the same map, the same held level time, the same camera and the same inputs, in the original DeusEx.exe
// under Wine and in Play, in the same 1280x720 frame.
//
//   node scripts/interface-acceptance.mjs play     [--map 00_Training] [--views a,b] [--suffix play]
//   node scripts/interface-acceptance.mjs original [--map 00_Training] [--views a,b] [--reuse]       (see original())
//   node scripts/interface-acceptance.mjs compare  [--map 00_Training] [--views a,b] [--suffix play]
//
// Both sides run one scenario per view (`VIEWS` below): a list of steps, each of which a player has the means for: a console line (the original
// types it into its console through Talk, Play runs it through the original console command chain), a key, a mouse click or move, a wait,
// and the screenshot. The world under the interface is the map's frozen start view (visual-acceptance.md "Method": `set LevelInfo
// bPlayersOnly True` before the map opens, `ghost`, the start Location and ViewRotation, the clock held by TimeDilation 0.001 at a level time
// the original measures); the HUD stays visible (the world frames hide it with `ShowHud False`).
//
// `original` writes `.work/acceptance/<map>/<view>-original.png` and `<view>-time.txt` (the level time the frame was taken at, which a frame
// must keep beside it: the gate's "Stored originals"); `play` runs its level to that time (the first view's) and writes `<view>-<suffix>.png`.
// A modal screen takes every key but Print Screen (the root window's own `Shot`, visual-acceptance.md "Security cameras" item 3), so every
// shot, HUD or screen, is taken with Print; the Brightness is 2/3, where Shot is the framebuffer (same section, item 6) and Play's display
// ramp is the identity at its Brightness 0.4.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CAMERAS, ORDER, VIEWS, WAIT_CMD} from './interface-views.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, '.work/acceptance');
const option = (name, fallback) => {
  const joined = process.argv.find(arg => arg.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];
};
const verb = process.argv[2];
const [WIDTH, HEIGHT] = option('size', '1280x720').split('x').map(Number);
const map = option('map', '00_Training');
const dir = path.join(out, map);
mkdirSync(dir, {recursive: true});
const PLAY = option('suffix', 'play');
const HELD_DILATION = 0.001;

// The scenario (the views, their steps and their order) is scripts/interface-views.mjs. --adhoc file.json ({name: {modal, steps}}) replaces it with an
// experiment's views, run in order on both sides.
const adhoc = option('adhoc', null) ? JSON.parse(readFileSync(option('adhoc'), 'utf8')) : null;
if (adhoc) Object.assign(VIEWS, adhoc);
const views = (option('views', null)?.split(',') ?? (adhoc ? Object.keys(adhoc) : ORDER)).map(name => {
  if (!VIEWS[name]) throw new Error(`unknown view ${name}; known: ${Object.keys(VIEWS).join(', ')}`);
  return {name, ...VIEWS[name]};
});
const camera = option('camera', null) ? (([x, y, z, pitch, yaw, roll]) => ({location: [x, y, z], rotation: [pitch, yaw, roll]}))(option('camera').split(',').map(Number)) : CAMERAS[map];
if (!camera) throw new Error(`no camera for ${map}: add it to scripts/interface-views.mjs or pass --camera x,y,z,pitch,yaw,roll`);
const timePath = view => path.join(dir, `${view}-time.txt`);

// ---------------------------------------------------------------------------------------------------------------------------------
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
  const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
  try {
    const page = await browser.newPage({viewport: {width: WIDTH, height: HEIGHT}, deviceScaleFactor: 1});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // The hold step runs at a fixed 1/60 s per page frame (visual-acceptance.mjs: the page's frame time patched), so the level time is reached the same way in
    // every run; once the level is held the interface's timers (the log's three seconds, the mission text) are on real time, as the original's are
    // (`window.__fixedDt` is cleared), and Play's waits are wall-clock waits.
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
    // The original's frames have no multisampling and no detail pass (visual-acceptance.md "Detail textures"): Play's defaults stay, the comparison turns both off.
    const query = ['hold=1', option('antialias', 'off') === 'on' ? '' : 'antialias=0',
      option('detail', 'off') === 'on' || /detailTextures=/.test(option('query', '')) ? '' : 'detailTextures=0', option('query', '')].filter(Boolean).join('&');
    await page.goto(`${url}/?${query}`);
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
    const probe = args => page.evaluate(args => window.deusExViewer.viewProbe(args), args);
    await probe({playersOnly: true});
    await page.evaluate(() => window.deusExViewer.release());
    await frames(30);
    // The original's input is a console line typed in a ghosted player: bCheatsEnabled, then `ghost`, as visual-acceptance.mjs does (the HUD stays on).
    // Both sides set the client's Brightness: the original's 2/3 makes Shot the framebuffer, Play's 0.4 makes its display ramp the identity; a menu's
    // `FLUSH` (ShowMainMenu) re-reads it from the config on both sides (D3DDrv Flush), so the setting must be the matched one in the config too.
    await probe({exec: ['ghost', 'set WinDrv.WindowsClient Brightness 0.4']});
    // The frame's level time less what the settle frames below add at the held dilation (the original's frame is taken after the same wait).
    const timeFile = timePath(views[0].name);
    const settle = Number(option('settle', 12000));
    const target = existsSync(timeFile) ? Number(readFileSync(timeFile, 'utf8')) - settle / 1000 * HELD_DILATION : null;
    let held = null;
    if (target !== null) {
      held = await page.evaluate(async ({target, dilation}) => {
        const run = args => window.deusExViewer.viewProbe(args), frame = () => new Promise(r => requestAnimationFrame(r));
        let state = await run({timeDilation: 20});
        while (state.timeSeconds < target - 1.5) { await frame(); state = await run({}); }
        state = await run({timeDilation: 1});
        while (state.timeSeconds < target - 0.1) { await frame(); state = await run({}); }
        state = await run({timeDilation: 0.05});
        while (state.timeSeconds < target) { await frame(); state = await run({}); }
        state = await run({timeDilation: dilation});
        return state.timeSeconds;
      }, {target, dilation: HELD_DILATION});
    }
    await probe({location: camera.location, rotation: camera.rotation});
    // The interface's own timers (the mission text, the log's timeout) run on real time from here: let the start text finish, as the original's
    // seconds of loading and typing do.
    await page.evaluate(() => { window.__fixedDt = undefined; });
    await page.waitForTimeout(settle);
    const keyName = {ESC: 'Escape', ENTER: 'Enter', TAB: 'Tab', PRINT: 'PrintScreen', SPACE: ' '};
    const box = await page.locator('#scene').boundingBox();
    const buffer = await page.evaluate(() => { const c = document.getElementById('scene'); return [c.width, c.height]; });
    if (buffer[0] !== WIDTH || buffer[1] !== HEIGHT || box.x !== 0 || box.y !== 0 || box.width !== WIDTH || box.height !== HEIGHT)
      throw new Error(`the scene canvas is ${box.width}x${box.height} at ${box.x},${box.y} (buffer ${buffer.join('x')}), not ${WIDTH}x${HEIGHT}`);
    const report = {map, camera, timeTarget: target, timeHeld: held, views: {}};
    for (const view of views) {
      const trace = [];
      for (const [op, a, b] of view.steps) {
        if (op === 'cmd') { trace.push(await probe({exec: [a]})); await frames(3); }
        else if (op === 'key') { await page.keyboard.press(keyName[a] ?? a); await frames(3); }
        else if (op === 'click') { await page.mouse.click(a, b); await frames(3); }
        else if (op === 'move') { await page.mouse.move(a, b); await frames(3); }
        else if (op === 'rclick') { await page.mouse.click(a, b, {button: 'right'}); await frames(3); }
        else if (op === 'pose') { await probe({location: a, rotation: b}); await frames(3); }
        else if (op === 'wait') await page.waitForTimeout(a);
        else if (op === 'shot') {
          await frames(6);
          await page.screenshot({path: path.join(dir, `${view.name}-${PLAY}.png`), clip: {x: 0, y: 0, width: WIDTH, height: HEIGHT}});
        } else throw new Error(`step ${op}`);
      }
      const state = await probe({}), window = await page.evaluate(() => window.deusExViewer.windowProbe());
      report.views[view.name] = {timeSeconds: state.timeSeconds, top: window.top, console: trace.map(t => t.output)};
      console.log(view.name, `level time ${state.timeSeconds.toFixed(3)}`, `top ${window.top}`);
    }
    const status = await page.evaluate(() => window.deusExViewer.status());
    report.runtimeError = status.runtimeError?.message ?? null; report.errors = errors;
    writeFileSync(path.join(dir, `interface-${PLAY}.json`), JSON.stringify(report, null, 1));
    if (report.runtimeError || errors.length) console.log('ERRORS', report.runtimeError, errors.slice(0, 3));
  } finally { await browser.close(); await server?.close(); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The original. The game is running (scripts/original-run.sh <map> launches it under the Wine lock) with a 1280x720 window.
async function original() {
  const game = await import('../ad/scripts/original-game.mjs');
  const scratch = path.join(out, 'steps'); mkdirSync(scratch, {recursive: true});
  let step = 0;
  const post = (lines, timeout) => {
    const file = path.join(scratch, `ui-${String(step++).padStart(3, '0')}.txt`);
    writeFileSync(file, lines.join('\n') + '\n');
    return game.run(file, timeout);
  };
  const hypr = () => {
    const find = () => JSON.parse(execFileSync('hyprctl', ['clients', '-j'], {encoding: 'utf8'})).filter(c => c.class.toLowerCase() === 'deusex.exe')
      .sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1])[0];
    const placed = w => w && w.floating && w.size[0] === WIDTH && w.size[1] === HEIGHT && w.at[0] >= 0 && w.at[1] >= 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const window = find();
      if (!window) throw new Error('no deusex.exe window');
      if (placed(window)) return attempt > 0;
      const at = `address:${window.address}`;
      for (const dispatch of [`hl.dsp.window.float({ action = "set", window = "${at}" })`,
        `hl.dsp.window.resize({ x = ${WIDTH}, y = ${HEIGHT}, relative = false, window = "${at}" })`, `hl.dsp.window.center({ window = "${at}" })`])
        { execFileSync('hyprctl', ['dispatch', dispatch]); execFileSync('sleep', ['1.5']); }
      execFileSync('sleep', ['1']);
    }
    throw new Error('the deusex.exe window does not stay floating at the capture size');
  };
  // The live player's row (the class object JCDentonMale is listed too, with class Class): the level time, the dilation, the pose and Physics.
  const levelTime = () => {
    const text = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'JCDentonMale', 'Player:0x5d4:u32', 'LevelTime:0xa8:pf:0x478', 'Dilation:0xa8:pf:0x474',
      'Location:0x114:f3', 'ViewRotation:0x3dc:i3', 'Physics:0x30:u8'], {encoding: 'utf8', env: process.env});
    const live = text.split('\n').map(line => /^JCDentonMale \S+ Player=0x([0-9a-f]+) LevelTime=(\S+) Dilation=(\S+) Location=\((\S+)\) ViewRotation=\((\S+)\) Physics=(\d+)/.exec(line.trim()))
      .filter(m => m && m[1] !== '0');
    if (live.length !== 1) throw new Error(`${live.length} live players in the original`);
    return {time: Number(live[0][2]), dilation: Number(live[0][3]), location: live[0][4].split(',').map(Number), viewRotation: live[0][5].split(',').map(Number), physics: Number(live[0][6])};
  };
  // UClient's Brightness (WindowsClient0 +0x6c in Deus Ex's build, WindowedViewportX +0x54 the layout check; visual-acceptance.mjs reads the same).
  const brightness = () => {
    const text = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'WindowsClient', 'Brightness:0x6c:f', 'X:0x54:u32'], {encoding: 'utf8', env: process.env});
    const m = text.split(/\r?\n/).map(line => /^WindowsClient WindowsClient\d+ Brightness=(\S+) X=(0x[0-9a-f]+|\d+)/.exec(line)).find(Boolean);
    if (!m || Number(m[2]) !== WIDTH) throw new Error(`the WindowsClient layout does not read back (${text.trim().slice(0, 120)})`);
    return Number(m[1]);
  };
  const loadWait = Number(option('load-wait', 35000));
  if (!process.argv.includes('--reuse')) {
    const travel = path.join(game.GAME, 'Save', 'Current', `${map}.dxs`);
    if (existsSync(travel)) {
      const aside = path.join(out, 'save-current'); mkdirSync(aside, {recursive: true});
      renameSync(travel, path.join(aside, `${map}-${Date.now()}.dxs`));
    }
    post(['cmd set LevelInfo bPlayersOnly True', 'sleep 300', 'cmd set LevelInfo TimeDilation 1', 'sleep 300', `cmd open ${map}`, `sleep ${loadWait}`], loadWait + 60000);
    if (process.env.DX_HYPRLAND === '1') hypr();
    post(['sleep 1500']);
    if (process.env.DX_HYPRLAND === '1') hypr();
    post([`cmd set WinDrv.WindowsClient Brightness ${option('brightness', '0.666667')}`, 'sleep 600',
      'cmd set DeusEx.JCDentonMale bCheatsEnabled True', 'sleep 300', 'cmd ghost', 'sleep 300',
      `cmd set LevelInfo TimeDilation ${HELD_DILATION}`, 'sleep 500',
      `cmd set DeusEx.JCDentonMale Location (X=${camera.location[0]},Y=${camera.location[1]},Z=${camera.location[2]})`, 'cmd set DeusEx.JCDentonMale Velocity (X=0,Y=0,Z=0)',
      `cmd set DeusEx.JCDentonMale ViewRotation (Pitch=${camera.rotation[0]},Yaw=${camera.rotation[1]},Roll=${camera.rotation[2]})`, `sleep ${option('settle', 12000)}`]);
    // A loaded host drops typed characters (the line then fails silently, docs/visual-acceptance.md "06_HongKong_WanChai_Underworld's mirrored panes"): each setup
    // line's effect is read back and the line typed again, and a level that was not frozen before the load is refused (LevelInfo bPlayersOnly +0x4f0 & 4).
    const want = Number(option('brightness', '0.666667'));
    const checks = [
      ['Brightness', () => Math.abs(brightness() - want) < 1e-4, [`cmd set WinDrv.WindowsClient Brightness ${option('brightness', '0.666667')}`, 'sleep 800']],
      ['ghost', () => levelTime().physics === 4, ['cmd set DeusEx.JCDentonMale bCheatsEnabled True', 'sleep 300', 'cmd ghost', 'sleep 300']],
      ['dilation', () => Math.abs(levelTime().dilation - HELD_DILATION) < 1e-6, [`cmd set LevelInfo TimeDilation ${HELD_DILATION}`, 'sleep 500']],
      ['camera', () => { const p = levelTime(); return p.location.every((v, k) => v === camera.location[k]) && p.viewRotation.every((v, k) => v === camera.rotation[k]); },
        [`cmd set DeusEx.JCDentonMale Location (X=${camera.location[0]},Y=${camera.location[1]},Z=${camera.location[2]})`, 'cmd set DeusEx.JCDentonMale Velocity (X=0,Y=0,Z=0)',
          `cmd set DeusEx.JCDentonMale ViewRotation (Pitch=${camera.rotation[0]},Yaw=${camera.rotation[1]},Roll=${camera.rotation[2]})`, 'sleep 1500']]];
    for (const [label, ok, again] of checks) for (let retry = 0; !ok(); retry++) {
      if (retry === 3) throw new Error(`the console did not take the ${label} line`);
      console.log(`${label} reads otherwise: the line again`);
      post(again);
    }
    const levels = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'LevelInfo', 'Time:0x478:f', 'PlayersOnly:0x4f0:bit:0x4'], {encoding: 'utf8', env: process.env})
      .split('\n').map(line => /^LevelInfo \S+ Time=(\S+) PlayersOnly=(\d)/.exec(line)).filter(Boolean);
    const now = levelTime().time;
    levels.sort((a, b) => Math.abs(Number(a[1]) - now) - Math.abs(Number(b[1]) - now));
    if (levels[0]?.[2] !== '1') throw new Error(`the original's level is not frozen (LevelInfo bPlayersOnly ${levels[0]?.[2]}): the line before the load was dropped; take the capture again`);
  }
  const first = levelTime();
  console.log(`held at level time ${first.time} dilation ${first.dilation}`);
  const lines = {cmd: a => [`cmd ${a}`, `sleep ${WAIT_CMD}`], key: a => [`key ${a} 60`], click: (a, b) => [`click ${a} ${b}`], rclick: (a, b) => [`rclick ${a} ${b}`],
    pose: (a, b) => [`cmd set DeusEx.JCDentonMale Location (X=${a[0]},Y=${a[1]},Z=${a[2]})`, 'cmd set DeusEx.JCDentonMale Velocity (X=0,Y=0,Z=0)',
      `cmd set DeusEx.JCDentonMale ViewRotation (Pitch=${b[0]},Yaw=${b[1]},Roll=${b[2]})`, 'sleep 600'], move: (a, b) => [`move ${a} ${b}`], wait: a => [`sleep ${a}`]};
  for (const view of views) {
    let taken = null;
    for (let attempt = 0; attempt < 3 && !taken; attempt++) {
      if (process.env.DX_HYPRLAND === '1') hypr();
      const before = game.shots();
      // One script per view: every step of a view runs in one dxinput run, so the interface's real-time timers (the log's three seconds) see the
      // same spacing in the capture as in Play's counted frames, and the Wine start of a second run does not eat them. A screen is modal and takes
      // every key but Print Screen; with the HUD up Print reaches no binding and the numpad * (GreyStar=Shot) does.
      const script = view.steps.flatMap(([op, a, b]) => op === 'shot' ? [view.modal ? 'key PRINT 60' : (attempt % 2 ? 'key PRINT 60' : 'shot'), 'sleep 1500'] : lines[op](a, b));
      post(script, 180000);
      const time = levelTime();
      const fresh = game.shots().filter(shot => !before.includes(shot));
      if (fresh.length) {
        const png = path.join(dir, `${view.name}-original.png`), size = game.bmpToPng(path.join(game.SYSTEM, fresh[0]), png);
        renameSync(path.join(game.SYSTEM, fresh[0]), path.join(dir, `${view.name}-original.bmp`));
        for (const extra of fresh.slice(1)) renameSync(path.join(game.SYSTEM, extra), path.join(scratch, extra));
        if (size.width === WIDTH && size.height === HEIGHT) {
          taken = png; writeFileSync(timePath(view.name), `${time.time}\n`);
          // the player and the client after the view (unread by the gate): a pose or ghost/walk line the game dropped shows here, a Brightness the menu's
          // FLUSH re-read too
          const state = {time: time.time, dilation: time.dilation, location: time.location, viewRotation: time.viewRotation, physics: time.physics, brightness: brightness()};
          writeFileSync(path.join(dir, `${view.name}-capture.json`), JSON.stringify(state) + '\n');
          console.log(view.name, `${size.width}x${size.height}`, JSON.stringify(state));
        }
      }
    }
    if (!taken) throw new Error(`${view.name}: no ${WIDTH}x${HEIGHT} shot`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// compare: visual-acceptance.mjs's metrics per view, whole frame (and --crop WxH+X+Y for a region).
function compare() {
  const crop = option('crop', null), report = {};
  for (const view of views) {
    const args = [path.join(root, 'scripts/visual-acceptance.mjs'), 'compare', '--maps', map, '--view', `${view.name}:0,0,0:0,0,0`, ...(PLAY === 'play' ? [] : ['--play-name', PLAY]), ...(crop ? ['--crop', crop] : [])];
    const text = execFileSync(process.execPath, args, {encoding: 'utf8'});
    const json = /(\{.*\})/.exec(text.trim().split('\n').at(-1))?.[1];
    const metrics = json ? JSON.parse(json) : {error: text.trim().split('\n').at(-1)};
    // Pixel counts over the same region: identical pixels, and pixels off by more than 2 and by more than 10 (of 255) in any channel.
    const prefix = PLAY === 'play' ? view.name : `${view.name}-${PLAY}`;
    const a = path.join(dir, crop ? `${prefix}-crop-original.png` : `${view.name}-original.png`), b = path.join(dir, crop ? `${prefix}-crop-${PLAY}.png` : `${view.name}-${PLAY}.png`);
    const rgb = file => execFileSync('magick', [file, '-depth', '8', 'rgb:-'], {maxBuffer: 1 << 28});
    const A = rgb(a), B = rgb(b);
    let same = 0, over2 = 0, over10 = 0;
    for (let i = 0; i < A.length; i += 3) {
      const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
      if (d === 0) same++; if (d > 2) over2++; if (d > 10) over10++;
    }
    const n = A.length / 3;
    const row = {view: view.name, crop, pixels: n, identical: +(same / n).toFixed(5), over2, over10, mad: metrics.mad, ratio: metrics.ratio,
      edgeRecall: metrics.edgeRecall, edgePrecision: metrics.edgePrecision, outlierBlocks: metrics.outlierBlocks?.length, error: metrics.error};
    report[view.name] = row;
    console.log(JSON.stringify(row));
  }
  // The gate reads this (a crop's numbers are an experiment's and stay out of it).
  if (!crop) writeFileSync(path.join(dir, `interface-${PLAY}-report.json`), JSON.stringify(report, null, 1));
}

if (verb === 'play') await play();
else if (verb === 'original') await original();
else if (verb === 'compare') compare();
else if (process.argv[1] === fileURLToPath(import.meta.url)) console.log('usage: interface-acceptance.mjs play|original|compare [--map M] [--views a,b]');
