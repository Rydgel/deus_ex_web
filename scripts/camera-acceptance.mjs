// Matched captures of the security cameras' views against the original
// (docs/visual-acceptance.md "Security cameras"): the computer-terminal screen
// the player reaches through the real path (frob the ComputerSecurity, type
// the login), in the original DeusEx.exe and in Play, at a held level time.
//
//   node scripts/camera-acceptance.mjs play     --map M --computer C --user U --password P --name n [--state state.json]
//   node scripts/camera-acceptance.mjs original --map M --computer C --user U --password P --name n   (see original())
//     [--cameras A,B,C] [--pawns] [--fly-stop 140] [--fly-tap 70] [--hold-seconds 8] [--after-login-click X,Y]
//
// `original` writes `.work/acceptance/<map>/<name>-original.png` and
// `<name>-state.json` (the level time, the camera actor's and the player's
// poses it measured); `play` reads that state, drives the same terminal path,
// runs its level to the same time, puts the camera actor and the player where
// the original's were and holds the level (bPlayersOnly, TimeDilation 0.001,
// as the original does), then writes `<name>-play.png` and `<name>-play.json`.
// `node scripts/visual-acceptance.mjs compare --maps M --view n:0,0,0:0,0,0 --crop WxH+X+Y`
// measures the window's rectangle.
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, '.work/acceptance');
const option = (name, fallback) => {
  const joined = process.argv.find(arg => arg.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];
};
const verb = process.argv[2];
const [WIDTH, HEIGHT] = option('size', '1280x720').split('x').map(Number);
const map = option('map', '01_NYC_UNATCOIsland'), computer = option('computer', 'ComputerSecurity1'), name = option('name', 'cam1');
const user = option('user', 'NSF001'), password = option('password', 'smashthestate'), cameraName = option('camera-actor', 'SecurityCamera5');
const dir = path.join(out, map);
mkdirSync(dir, {recursive: true});
const statePath = option('state', path.join(dir, `${name}-state.json`));
const HELD_DILATION = 0.001;
// --after-login-click X,Y: a click on the screen after the login, in both programs (the same 1280x720 screen): a terminal with special
// options (Area 51 Final's ComputerSecurity0) opens on ComputerScreenSpecialOptions, whose Security button (520,430) shows the cameras.
const afterLoginClick = option('after-login-click', null)?.split(',').map(Number) ?? null;
// Play's files are `<name>-<suffix>.png/.json` (--suffix, default play): an experiment's frame beside the baseline's.
const PLAY = option('suffix', 'play');

/** The map's placed pawns and carcasses, from its data: every actor whose class is a Pawn and not a PlayerPawn (Engine.Camera viewpoints
 * and the player classes are PlayerPawns), or a Carcass (a placed body falls and settles in each program's own way: Area 51 Final's
 * ScientistMaleCarcass2 lies in Play's radiation-camera view and not in the original's), as {name, className}. */
async function mapPawns(mapName) {
  const {readdir, readFile} = await import('node:fs/promises');
  const {AssetStore} = await import('../src/unreal/assets.mjs'), {decodeMap} = await import('../src/unreal/map.mjs');
  const {ClassDefaults} = await import('../src/unreal/classes.mjs'), {gameDirectory} = await import('./game-directory.mjs');
  const game = gameDirectory(), files = [];
  for (const d of ['Maps', 'System']) for (const n of await readdir(path.join(game, d))) files.push({path: `${d}/${n}`, read: () => readFile(path.join(game, d, n))});
  const assets = new AssetStore(files), defaults = new ClassDefaults(assets), asset = await assets.get(mapName), out = [];
  for (const actor of decodeMap(asset.bytes).actors) {
    let lineage; try { lineage = await defaults.lineage(asset, asset.pkg.exports[actor.index - 1].classIndex); } catch { continue; }
    if ((lineage.includes('engine.pawn') && !lineage.includes('engine.playerpawn')) || lineage.includes('engine.carcass'))
      out.push({name: actor.name, className: actor.className});
  }
  return out;
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
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
  try {
    const page = await browser.newPage({viewport: {width: WIDTH, height: HEIGHT}, deviceScaleFactor: 1});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // The original's device has no multisampling (D3D7, no AA setting in DeusEx.ini), so its frames have none: Play's canvas
    // is multisampled by default (main.mjs), which anti-aliases every polygon edge and every sub-4-pixel mesh. The comparison
    // runs with ?antialias=0 unless --antialias on.
    // The original's frames lack the detail-texture pass (docs/visual-acceptance.md "Detail textures"): Play draws without it unless --detail on.
    const query = [option('antialias', 'off') === 'on' ? '' : 'antialias=0',
      option('detail', 'off') === 'on' || /detailTextures=/.test(option('query', '')) ? '' : 'detailTextures=0', option('query', '')].filter(Boolean).join('&');
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
    const settled = async () => { await frames(6); await page.evaluate(() => Promise.race([window.deusExViewer.settled(), new Promise(resolve => setTimeout(resolve, 2000))])); };
    const probe = args => page.evaluate(args => window.deusExViewer.terminalProbe(args), {cameraName, ...args});
    const view = args => page.evaluate(args => window.deusExViewer.viewProbe(args), args);
    const top = async () => (await page.evaluate(() => window.deusExViewer.windowProbe())).top;
    await frames(30);
    // The real path: approach the computer, let its activation animation settle, frob it with the page's right click, type the login.
    await probe({front: computer}); await frames(60);
    await probe({front: computer}); await settled();
    for (let attempt = 0; attempt < 3 && await top() !== 'deusex.networkterminalsecurity'; attempt++) {
      if (attempt) { await probe({front: computer}); await settled(); }
      await page.mouse.click(WIDTH / 2, HEIGHT / 2, {button: 'right'});
      for (let i = 0; i < 20 && await top() !== 'deusex.networkterminalsecurity'; i++) await settled();
    }
    if (await top() !== 'deusex.networkterminalsecurity') throw new Error(`the right click did not frob ${computer} (top window ${await top()})`);
    await page.keyboard.type(user); await page.keyboard.press('Tab');
    await page.keyboard.type(password); await page.keyboard.press('Enter');
    if (afterLoginClick) {
      for (let i = 0; i < 6; i++) await settled();
      await page.mouse.click(afterLoginClick[0], afterLoginClick[1]);
      await page.mouse.move(1270, 710);
    }
    let plan = null;
    for (let i = 0; i < 30; i++) { await settled(); plan = await probe({}); if (plan.viewports.length && plan.page.length) break; }
    if (!plan?.viewports.length) throw new Error('no camera window after the login');
    // JC takes no damage in either program (the original's run sets the same).
    await view({exec: ['set DeusEx.JCDentonMale ReducedDamageType All']});
    // Level time: run to the original's held TimeSeconds, then hold the level as the original does.
    let held = await view({});
    if (state) {
      const target = state.timeSeconds;
      if (held.timeSeconds > target) throw new Error(`Play reached the terminal at ${held.timeSeconds}, after the original's held ${target}`);
      held = await page.evaluate(async ({target}) => {
        const probe = args => window.deusExViewer.viewProbe(args), frame = () => new Promise(r => requestAnimationFrame(r));
        // The sim worker runs ahead of the page's reads (a live level, three camera windows: several frames), so each speed stops a
        // margin short of the target that covers the frames in flight, and the last tenth of a second runs at a tenth of the speed.
        let s = await probe({});
        for (const [speed, margin] of [[20, 9], [4, 1.8], [1, 0.3], [0.1, 0.02]]) {
          s = await probe({timeDilation: speed});
          while (s.timeSeconds < target - margin) { await frame(); s = await probe({}); }
        }
        s = await probe({});
        while (s.timeSeconds < target) { await frame(); s = await probe({}); }
        return await probe({playersOnly: true, timeDilation: 0.001});
      }, {target});
    }
    // The camera actor and the player where the original's were (the camera swings and the player walked: both are inputs of the state).
    for (const camera of state?.cameras ?? []) await probe({cameraName: camera.name, placeCamera: {location: camera.location, rotation: camera.rotation}});
    if (state?.player) await probe({playerPose: {location: state.player.location, rotation: state.player.rotation, viewRotation: state.player.viewRotation,
      // The original's level is held, JC's animation with it; Play's player keeps ticking in a players-only level and the page's frames advance his
      // animation whatever the level's dilation: the frame is written with a rate of 0 so the pose drawn is the measured one.
      anim: {...state.player.anim, AnimRate: 0}}});
    // The level's pawns where the original's stood, facing and posed as they were (`original --pawns`): an input of the held state.
    if (state?.pawns?.length && option('pawns', 'on') !== 'off') {
      const result = (await probe({pawnPoses: state.pawns})).pawns;
      console.log(`pawns written from the original's state: ${result.written.length}${result.missing.length ? `; not in Play's level: ${result.missing.join(' ')}` : ''}`);
    }
    // The level's movers where the original's were (`original` reads them at the hold). A door an NPC opened stands open in the original's frame and
    // the NPCs' routes are each program's own, so a mover's pose is an input of the held state like the cameras' and the player's. Only the movers
    // whose Rotation or Location differ are written (Rotation through the actor, Location through the collision model: view-probe's moverProbe).
    if (state?.movers?.length && option('movers', 'on') !== 'off') {
      const written = await page.evaluate(async movers => {
        const now = (await window.deusExViewer.liveProbe({actors: 'deusex.deusexmover', actorProps: ['Rotation', 'KeyNum']})).actors;
        const byName = new Map(now.map(row => [row.name, row]));
        const differs = (a, b) => a.length !== b.length || a.some((v, i) => Math.abs(v - b[i]) > 1e-3);
        const sets = movers.filter(m => { const p = byName.get(m.name); return p && (differs(m.Rotation, p.Rotation) || differs(m.Location, p.location)); })
          .map(m => ({name: m.name, location: m.Location, rotation: m.Rotation}));
        if (sets.length) await window.deusExViewer.moverProbe({set: sets});
        return sets.map(s => s.name);
      }, state.movers);
      console.log(`movers written from the original's state: ${written.length}${written.length ? ` (${written.join(' ')})` : ''}`);
    }
    held = await view({playersOnly: true, timeDilation: HELD_DILATION});
    await settled(); await frames(45);
    held = await view({});
    plan = await probe({});
    const box = await page.locator('#scene').boundingBox();
    const buffer = await page.evaluate(() => { const c = document.getElementById('scene'); return [c.width, c.height]; });
    if (buffer[0] !== WIDTH || buffer[1] !== HEIGHT || box.x !== 0 || box.y !== 0 || box.width !== WIDTH || box.height !== HEIGHT)
      throw new Error(`the scene canvas is ${box.width}x${box.height} at ${box.x},${box.y} (buffer ${buffer.join('x')}), not ${WIDTH}x${HEIGHT}`);
    await page.screenshot({path: path.join(dir, `${name}-${PLAY}.png`), clip: {x: 0, y: 0, width: WIDTH, height: HEIGHT}});
    if (option('debug-eval', null)) console.log('DEBUG', JSON.stringify(await page.evaluate(`(async () => (${option('debug-eval')}))()`)).slice(0, 12000));
    const status = await page.evaluate(() => window.deusExViewer.status());
    const summary = value => Array.isArray(value) ? `array(${value.length})` : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).slice(0, 14).map(([k, v]) => [k, Array.isArray(v) ? `array(${v.length})` : (v && typeof v === 'object') ? Object.keys(v).slice(0, 6) : v])) : value;
    const report = {map, computer, camera: plan.camera, rects: plan.page.map(p => p.rect), planDetail: plan.viewports.map(v => Object.fromEntries(Object.entries(v).map(([k, val]) => [k, summary(val)]))), pagePasses: plan.page.map(p => Object.fromEntries(Object.entries(p).map(([k, val]) => [k, summary(val)]))), plans: plan.viewports.map(v => ({location: v.location, rotation: v.rotation, fov: v.fov, nodes: v.nodes, actors: v.actors, decals: v.decals, frames: v.frames?.map(f => f.kind)})),
      player: {location: held.location, viewRotation: held.viewRotation, region: held.region, anim: held.anim}, timeSeconds: held.timeSeconds, timeDilation: held.timeDilation,
      runtimeError: status.runtimeError?.message ?? null, errors,
      // each window's mover draw items in the fog pass: the map's largest texel, or why the item has none (fog-pass.mjs moverMaps)
      fogMoverItems: plan.page.map(p => p.fog?.moverItems ?? null)};
    writeFileSync(path.join(dir, `${name}-${PLAY}.json`), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); await server?.close(); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The original. The game is running (scripts/camera-original.sh launches it under the Wine lock) with a 1280x720 window.
//
// The route is the real one, with the input a player has: the map is opened from the console, `ghost` lets JC fly in a straight line to
// the computer's front (a held W key through the Wine input queue: `shold`, dxinput.c; a posted WM_KEYDOWN does not hold), `walk` puts
// him down on the floor with his collision again, the view is aimed with ViewRotation (the only field the console may write in a level
// that ticks, docs/visual-acceptance.md "Placement constraint"), and the right click frobs the computer: Computers.Frob, state On
// (Activate, FinishAnim), TryInvoke, InvokeComputerScreen, the NetworkTerminal's login typed on the keyboard. The level is never
// moved with `set Location`.
//
// A modal screen grabs every key and mouse button (XModalWindow::VisibilityChanged), so no binding runs under it; the screenshot is the
// root window's own: DeusExRootWindow.VirtualKeyPressed calls ConsoleCommand("SHOT") for Print Screen (and Ctrl+F9).
//
// The level is held by the tracer (tools/dx-live-win.c: max-seconds, the level's Tick returns at its entry) a few seconds after the
// frob, with the screen open: the camera actors, the clock and the lights stand as they are while the UI goes on. The tracer's last
// row and dump-actor-win give the state Play is put in.
async function original() {
  const game = await import('../ad/scripts/original-game.mjs');
  const scratch = path.join(out, 'steps'); mkdirSync(scratch, {recursive: true});
  const holdDir = path.join(dir, 'hold'); mkdirSync(holdDir, {recursive: true});
  let step = 0;
  const post = (lines, timeout) => {
    const file = path.join(scratch, `cam-${String(step++).padStart(3, '0')}.txt`);
    writeFileSync(file, lines.join('\n') + '\n');
    return game.run(file, timeout);
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const dumpTool = path.join(root, 'ad/build/dump-actor-win.exe');
  const dump = (actor, ...fields) => {
    const text = execFileSync(game.WINE, [dumpTool, actor, ...fields], {encoding: 'utf8', env: process.env});
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^(\S+) (\S+) (.*)$/.exec(line);
      if (!m) continue;
      const row = {class: m[1], name: m[2]};
      for (const part of m[3].matchAll(/(\w+)=(\([^)]*\)|\S+)/g)) {
        const v = part[2];
        row[part[1]] = v.startsWith('(') ? v.slice(1, -1).split(',').map(Number) : Number.isNaN(Number(v)) ? v : Number(v);
      }
      rows.push(row);
    }
    return rows;
  };
  const live = (actor, ...fields) => dump(actor, 'Player:0x5d4:u32', ...fields).filter(row => row.name === actor || row.name.startsWith(actor)).filter(row => row.Player !== 0 && !/Carcass$/.test(row.class)).at(-1);
  const player = (...fields) => dump('JCDentonMale', 'Player:0x5d4:u32', ...fields).filter(row => row.Player > 0 && row.class === 'JCDentonMale').at(-1);
  const actorRow = (name, ...fields) => dump(name, ...fields).find(row => row.name === name);
  const units = r => ((Math.round(r * 65536 / (2 * Math.PI)) % 65536) + 65536) % 65536;
  const aim = (from, to) => { const d = to.map((v, i) => v - from[i]); return [units(Math.atan2(d[2], Math.hypot(d[0], d[1]))), units(Math.atan2(d[1], d[0]))]; };
  const hypr = () => {
    const find = () => JSON.parse(execFileSync('hyprctl', ['clients', '-j'], {encoding: 'utf8'})).find(c => c.class.toLowerCase() === 'deusex.exe');
    const placed = w => w && w.floating && w.size[0] === WIDTH && w.size[1] === HEIGHT && w.at[0] >= 0 && w.at[1] >= 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const window = find();
      if (!window) throw new Error('no deusex.exe window');
      if (placed(window)) return;
      const at = `address:${window.address}`;
      for (const dispatch of [`hl.dsp.window.float({ action = "set", window = "${at}" })`,
        `hl.dsp.window.resize({ x = ${WIDTH}, y = ${HEIGHT}, relative = false, window = "${at}" })`, `hl.dsp.window.center({ window = "${at}" })`])
        execFileSync('hyprctl', ['dispatch', dispatch]);
      execFileSync('sleep', ['2']);
    }
    throw new Error('the deusex.exe window does not stay floating at the capture size');
  };
  const loadWait = Number(option('load-wait', 35000));
  if (!process.argv.includes('--reuse')) {
    const travel = path.join(game.GAME, 'Save', 'Current', `${map}.dxs`);
    if (existsSync(travel)) {
      const aside = path.join(out, 'save-current'); mkdirSync(aside, {recursive: true});
      renameSync(travel, path.join(aside, `${map}-${Date.now()}.dxs`));
    }
    post([`cmd open ${map}`, `sleep ${loadWait}`], loadWait + 60000);
    if (process.env.DX_HYPRLAND === '1') hypr();
    post(['sleep 1500']);
  }
  if (process.env.DX_HYPRLAND === '1') hypr();
  // Shot bakes the display ramp of the original's Brightness setting into its bitmap (measured against the compositor's capture of the
  // window, which is the framebuffer as drawn: Shot = framebuffer^(1/(1.5 * Brightness)), so 0.6, the ini's default, darkens by
  // x^1.11); at 2/3 the Shot is the framebuffer (0.08% of the pixels differ from the compositor's, the moving ones). The setting is
  // the original's; Play's ramp is untouched (docs/visual-acceptance.md "Security cameras").
  post([`cmd set WinDrv.WindowsClient Brightness ${option('brightness', '0.666667')}`, 'sleep 600',
    'cmd set DeusEx.JCDentonMale bCheatsEnabled True', 'sleep 300',
    // A computer inside an enemy's rooms (Island's holding cell: a turret, guards): JC takes no damage (TakeDamage returns for
    // ReducedDamageType 'All'), as in Play's run to the same level time; nothing else about him changes.
    'cmd set DeusEx.JCDentonMale ReducedDamageType All', 'sleep 300', 'cmd ghost', 'sleep 300']);
  // A loaded Mac's console drops typed characters (docs/visual-acceptance.md): a dropped `bCheatsEnabled` or `ghost` line leaves JC walking
  // (Physics 1), and the flight then stalls against the first wall. Read Physics back and type the cheat lines again until JC flies
  // (PHYS_Flying, 4).
  for (let attempt = 0; attempt < 4 && player('Physics:0x30:u8').Physics !== 4; attempt++) {
    console.log(`ghost not taken (attempt ${attempt + 1}): typing the cheat lines again`);
    post(['sleep 500', 'cmd set DeusEx.JCDentonMale bCheatsEnabled True', 'sleep 400', 'cmd set DeusEx.JCDentonMale ReducedDamageType All', 'sleep 400',
      'cmd ghost', 'sleep 500']);
  }
  if (player('Physics:0x30:u8').Physics !== 4) throw new Error('JC does not fly after `ghost`: the console did not take the cheat lines');
  // The Brightness line too: a dropped one leaves the Shot at the ini's 0.6, about 1.3 times darker than Play's frame at every pixel
  // (Battery Park's first Mac capture, ratio 1.28 to 1.33). UClient's fields follow the SDK's UnCamera.h order with five more dwords before the
  // viewport ints in Deus Ex's build; read from the running game (WindowsClient0): WindowedViewportX +0x54 (1280), WindowedViewportY +0x58
  // (720), WindowedColorBits +0x5c, the fullscreen three, Brightness +0x6c, MipFactor +0x70. WindowedViewportX reading the window's width
  // checks the layout.
  const brightness = Number(option('brightness', '0.666667'));
  const client = () => dump('WindowsClient', 'Brightness:0x6c:f', 'WindowedViewportX:0x54:u32').find(row => /^WindowsClient\d+$/.test(row.name));
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = client();
    if (!row || row.WindowedViewportX !== WIDTH) throw new Error(`the WindowsClient layout does not read back (${JSON.stringify(row)})`);
    if (Math.abs(row.Brightness - brightness) < 1e-4) break;
    console.log(`Brightness reads ${row.Brightness} (attempt ${attempt + 1}): typing it again`);
    post([`cmd set WinDrv.WindowsClient Brightness ${option('brightness', '0.666667')}`, 'sleep 800']);
  }
  if (Math.abs(client().Brightness - brightness) >= 1e-4) throw new Error('the console did not take the Brightness line');
  // The computer and the cameras the screen shows: their poses are read from the live level.
  const comp = actorRow(computer, 'Location:0x114:f3', 'Rotation:0x120:i3');
  if (!comp) throw new Error(`no ${computer} in the live level`);
  const facing = comp.Rotation[1] * Math.PI / 32768;
  const front = Number(option('front', 56));
  const stand = [comp.Location[0] + Math.cos(facing) * front, comp.Location[1] + Math.sin(facing) * front, comp.Location[2]];
  // Fly to the computer's front: aim (ViewRotation), hold W through the input queue for the time the distance needs (about 800 units/s
  // after a quarter second of start-up), measure, repeat.
  // The ghost coasts after a key is released: a tap of 70 ms moves it about 130 units, so it flies to within 140 units of the point
  // (stopping when a hop no longer gets nearer) and the last of the way is walked.
  // --fly-stop: where the flight hands over to the walk. A computer on a raised platform (Area 51 Final's ComputerSecurity0) needs the
  // flight to end above the platform: `walk` drops JC to the floor below him, and he cannot climb back.
  // --fly-tap: the shortest held W of a hop (ms), for a last approach shorter than a 70 ms tap's coast.
  const flyStop = Number(option('fly-stop', 140)), flyTap = Number(option('fly-tap', 70));
  // Under CrossOver the held keys move the ghost only once the window has the Wine focus: take it before the first hop.
  post(['focus', 'sleep 300']);
  let still = 0, lastDistance = Infinity, best = Infinity;
  for (let hop = 0; hop < 40; hop++) {
    const at = player('Location:0x114:f3').Location, d = stand.map((v, i) => v - at[i]), distance = Math.hypot(...d);
    console.log(`hop ${hop}: at ${at.map(v => v.toFixed(1))} distance ${distance.toFixed(1)}`);
    if (distance < flyStop || (distance > best + 20 && best < 400)) break;
    best = Math.min(best, distance);
    // A held key moves the ghost only while the game's window is the one Wine gives the input to (the compositor can tile it
    // again, a conversation can restrict the input): after two hops that moved nothing, place the window again and take the focus.
    still = Math.abs(lastDistance - distance) < 1 ? still + 1 : 0; lastDistance = distance;
    if (still >= 2) {
      if (still >= 8) throw new Error(`the flight does not move (at ${at.map(v => v.toFixed(1))}): the game does not take the held keys`);
      if (process.env.DX_HYPRLAND === '1') hypr();
      post(['focus', 'sleep 300']);
    }
    const [pitch, yaw] = aim(at, stand);
    const hold = Math.max(flyTap, Math.min(2400, Math.round(((distance - 60) * 0.8 / 800) * 1000)));
    post([`cmd set DeusEx.JCDentonMale ViewRotation (Pitch=${pitch},Yaw=${yaw},Roll=0)`, 'sleep 450', `shold W ${hold}`, 'sleep 350']);
  }
  post(['cmd walk', 'sleep 2500']);
  // Walking, JC stops when the key is released: the last of the way is walked in taps sized by the speed measured so far.
  let speed = 200, blocked = 0;
  for (let step = 0; step < 14; step++) {
    const at = player('Location:0x114:f3').Location, d = [stand[0] - at[0], stand[1] - at[1]], distance = Math.hypot(...d);
    console.log(`walk ${step}: at ${at.map(v => v.toFixed(1))} distance ${distance.toFixed(1)} speed ${speed.toFixed(0)}`);
    if (distance < 12 || blocked >= 2) break;
    const hold = Math.max(60, Math.min(900, Math.round(distance / speed * 1000 * 0.8)));
    post([`cmd set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=${aim([0, 0, 0], [d[0], d[1], 0])[1]},Roll=0)`, 'sleep 500', `shold W ${hold}`, 'sleep 700']);
    const after = player('Location:0x114:f3').Location, moved = Math.hypot(after[0] - at[0], after[1] - at[1]);
    blocked = moved < 3 ? blocked + 1 : 0;
    if (moved > 5) speed = Math.max(60, Math.min(400, moved / hold * 1000 * (0.5 + 0.5 * speed / Math.max(speed, 1))));
  }
  const jc = player('Location:0x114:f3', 'Physics:0x30:u8', 'BaseEyeHeight:0x3f4:f');
  console.log(`walking at ${jc.Location.map(v => v.toFixed(2))} physics ${jc.Physics}`);
  let frobbed = null;
  for (let attempt = 0; attempt < 4 && frobbed !== computer; attempt++) {
    const here = player('Location:0x114:f3', 'BaseEyeHeight:0x3f4:f');
    const eye = [here.Location[0], here.Location[1], here.Location[2] + here.BaseEyeHeight];
    const [pitch, yaw] = aim(eye, comp.Location);
    post([`cmd set DeusEx.JCDentonMale ViewRotation (Pitch=${pitch},Yaw=${yaw},Roll=0)`, 'sleep 2500']);
    frobbed = player('FrobTarget:0x9e8:obj').FrobTarget;
  }
  if (frobbed !== computer) throw new Error(`the view does not select ${computer} (FrobTarget ${frobbed})`);
  // Hold the level a few seconds after the frob with the tracer; the screen opens in the first two.
  const holdSeconds = Number(option('hold-seconds', 8));
  const tracePath = path.join(holdDir, 'trace.jsonl'), cfg = path.join(holdDir, 'trace.cfg');
  const cameras = (option('cameras', cameraName)).split(',');
  writeFileSync(cfg, [`out ${tracePath}`, 'player JCDentonMale', 'release 1', 'ticks 100000000', `max-seconds ${holdSeconds}`, 'kill-on-crash 0',
    `watch ${cameras.join(',')} Location:0x114:f3 Rotation:0x120:i3`].join('\n') + '\n');
  rmSync(`${tracePath}.resume`, {force: true});
  const child = spawn(game.WINE, [path.join(root, 'ad/build/dx-live-win.exe'), 'trace', cfg], {env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
  let log = ''; child.stderr.on('data', chunk => { log += chunk; });
  const finished = new Promise(resolve => child.on('exit', resolve));
  for (let i = 0; i < 100 && !/rand state block/.test(log); i++) await sleep(100);
  // The frob, the login (typed on the keyboard), then wait for the hold.
  post(['rclick 640 360', 'sleep 2800', `type ${user}`, 'sleep 300', 'key Tab', 'sleep 300', `type ${password}`, 'sleep 300', 'key Enter', 'sleep 1500',
    ...(afterLoginClick ? [`click ${afterLoginClick.join(' ')}`, 'sleep 1500', 'move 1270 710', 'sleep 300'] : [])]);
  for (let i = 0; i < 300 && !/paused after/.test(log); i++) await sleep(100);
  if (!/paused after/.test(log)) throw new Error(`the level was not held:\n${log}`);
  console.log(log.trim().split('\n').pop().slice(0, 140));
  const screen = actorRow(computer, 'termwindow:0x470:obj');
  if (!screen || screen.termwindow === 'None') throw new Error('the terminal is not open when the level was held');
  // Print Screen: the root window's own SHOT.
  let taken = null;
  for (let attempt = 0; attempt < 3 && !taken; attempt++) {
    const before = game.shots();
    post(['sleep 1500', 'key PRINT 60', 'sleep 1500']);
    const fresh = game.shots().filter(shot => !before.includes(shot));
    if (fresh.length) {
      const png = path.join(dir, `${name}-original.png`), size = game.bmpToPng(path.join(game.SYSTEM, fresh[0]), png);
      renameSync(path.join(game.SYSTEM, fresh[0]), path.join(dir, `${name}-original.bmp`));
      if (size.width === WIDTH && size.height === HEIGHT) taken = png;
    }
  }
  // The state at the hold.
  const rows = readFileSync(tracePath, 'utf8').trim().split('\n'), last = JSON.parse(rows.at(-1));
  const time = dump('JCDentonMale', 'Player:0x5d4:u32', 'LevelTime:0xa8:pf:0x478', 'Dilation:0xa8:pf:0x474').filter(row => row.Player > 0 && row.class === 'JCDentonMale').at(-1);
  const jcState = player('Location:0x114:f3', 'Rotation:0x120:i3', 'ViewRotation:0x3dc:i3', 'Physics:0x30:u8', 'Region:0xc8:u32',
    'AnimSequence:0x54:name', 'AnimFrame:0x58:f', 'AnimRate:0x5c:f', 'TweenRate:0x60:f', 'AnimLast:0x220:f', 'AnimMinRate:0x224:f', 'OldAnimRate:0x228:f',
    'B0:0x68:name', 'B1:0x6c:name', 'B2:0x70:name', 'B3:0x74:name', 'F0:0x78:f', 'F1:0x7c:f', 'F2:0x80:f', 'F3:0x84:f', 'R0:0x88:f', 'R1:0x8c:f', 'R2:0x90:f', 'R3:0x94:f',
    'T0:0x98:f', 'T1:0x9c:f', 'T2:0xa0:f', 'T3:0xa4:f', 'L0:0x23c:f', 'L1:0x240:f', 'L2:0x244:f', 'L3:0x248:f', 'M0:0x24c:f', 'M1:0x250:f', 'M2:0x254:f', 'M3:0x258:f');
  const anim = {AnimSequence: jcState.AnimSequence, AnimFrame: jcState.AnimFrame, AnimRate: jcState.AnimRate, TweenRate: jcState.TweenRate, AnimLast: jcState.AnimLast,
    AnimMinRate: jcState.AnimMinRate, OldAnimRate: jcState.OldAnimRate, BlendAnimSequence: [0, 1, 2, 3].map(k => jcState[`B${k}`]), BlendAnimFrame: [0, 1, 2, 3].map(k => jcState[`F${k}`]),
    BlendAnimRate: [0, 1, 2, 3].map(k => jcState[`R${k}`]), BlendTweenRate: [0, 1, 2, 3].map(k => jcState[`T${k}`]), BlendAnimLast: [0, 1, 2, 3].map(k => jcState[`L${k}`]),
    BlendAnimMinRate: [0, 1, 2, 3].map(k => jcState[`M${k}`])};
  // The level's pre-placed movers at the hold (a door standing half open in a frame is a state of the original's world: KeyNum, the interpolation
  // alpha and rate, Location). Memory reads of Mover's linked offsets (Play's slotOf: Location 0x114, PhysAlpha 0x214, PhysRate 0x218, bInterpolating
  // 0x1ec bit 0x80, KeyNum 0x377, PrevKeyNum 0x378, NumKeys 0x379); the tracer holds the level, so the rows are one instant.
  const movers = dump('DeusExMover', 'Location:0x114:f3', 'Rotation:0x120:i3', 'Physics:0x30:u8', 'Interp:0x1ec:bit:0x80', 'PhysAlpha:0x214:f', 'PhysRate:0x218:f',
    'KeyNum:0x377:u8', 'PrevKeyNum:0x378:u8', 'NumKeys:0x379:u8', 'Tag:0xb0:name', 'State:0xc:obj').filter(row => /^DeusExMover\d+$/.test(row.name))
    .map(({class: cls, ...row}) => row);
  // --pawns: the level's placed pawns at the hold (an NPC's route is each program's own: Ship's window 2 has a sailor in the doorway in Play
  // and not in the original). Their names come from the map's data (every actor whose class is a Pawn and not a PlayerPawn); dump-actor-win
  // matches a name substring, so the pawns are read one name prefix at a time (the name without its number) and kept by exact name. Location, Rotation, Physics, bHidden
  // (+0x28 bit 0x2) and the animation fields GetFrame reads, at the linked offsets the player's are read with.
  let pawns;
  if (process.argv.includes('--pawns')) {
    const placed = await mapPawns(map), names = new Set(placed.map(p => p.name));
    const anims = ['AnimSequence:0x54:name', 'AnimFrame:0x58:f', 'AnimRate:0x5c:f', 'TweenRate:0x60:f', 'AnimLast:0x220:f', 'AnimMinRate:0x224:f', 'OldAnimRate:0x228:f',
      'B0:0x68:name', 'B1:0x6c:name', 'B2:0x70:name', 'B3:0x74:name', 'F0:0x78:f', 'F1:0x7c:f', 'F2:0x80:f', 'F3:0x84:f', 'R0:0x88:f', 'R1:0x8c:f', 'R2:0x90:f', 'R3:0x94:f',
      'T0:0x98:f', 'T1:0x9c:f', 'T2:0xa0:f', 'T3:0xa4:f', 'L0:0x23c:f', 'L1:0x240:f', 'L2:0x244:f', 'L3:0x248:f', 'M0:0x24c:f', 'M1:0x250:f', 'M2:0x254:f', 'M3:0x258:f'];
    const rows = new Map();
    // by name prefix: an actor's name is its class's at placement, but a class's children keep the parent's prefix (SecurityBot0 is a SecurityBot2)
    for (const cls of new Set(placed.map(p => p.name.replace(/\d+$/, '')))) {
      for (const row of dump(cls, 'Location:0x114:f3', 'Rotation:0x120:i3', 'Physics:0x30:u8', 'Hidden:0x28:bit:0x2', ...anims))
        if (names.has(row.name) && Array.isArray(row.Location)) rows.set(row.name, row);
    }
    pawns = [...rows.values()].map(r => ({name: r.name, location: r.Location, rotation: r.Rotation, physics: r.Physics, hidden: Boolean(r.Hidden),
      anim: {AnimSequence: r.AnimSequence, AnimFrame: r.AnimFrame, AnimRate: r.AnimRate, TweenRate: r.TweenRate, AnimLast: r.AnimLast, AnimMinRate: r.AnimMinRate,
        OldAnimRate: r.OldAnimRate, BlendAnimSequence: [0, 1, 2, 3].map(k => r[`B${k}`]), BlendAnimFrame: [0, 1, 2, 3].map(k => r[`F${k}`]),
        BlendAnimRate: [0, 1, 2, 3].map(k => r[`R${k}`]), BlendTweenRate: [0, 1, 2, 3].map(k => r[`T${k}`]), BlendAnimLast: [0, 1, 2, 3].map(k => r[`L${k}`]),
        BlendAnimMinRate: [0, 1, 2, 3].map(k => r[`M${k}`])}}));
    console.log(`pawns at the hold: ${pawns.length} of the map's ${placed.length} (absent: ${placed.filter(p => !rows.has(p.name)).map(p => p.name).join(' ') || 'none'})`);
  }
  const camState = cameras.map(cam => ({name: cam, location: last.actors[cam].Location, rotation: last.actors[cam].Rotation}));
  const state = {map, computer, user, timeSeconds: time.LevelTime, tsTrace: last.tsIn, dilation: time.Dilation, tick: last.tick, cameras: camState, movers, ...(pawns ? {pawns} : {}),
    player: {location: jcState.Location, rotation: jcState.Rotation, viewRotation: jcState.ViewRotation, physics: jcState.Physics, anim}};
  writeFileSync(statePath, JSON.stringify(state, null, 1));
  console.log(taken ? `frame ${taken}` : 'NO FRAME', JSON.stringify(state));
  writeFileSync(`${tracePath}.resume`, '');
  await finished; rmSync(`${tracePath}.resume`, {force: true});
}

// ---------------------------------------------------------------------------------------------------------------------------------
// compare: the metrics of each camera window (the rectangles Play drew them in, which are the original's: the same screen) between
// `<name>-original.png` and `<name>-<suffix>.png` (--play-name, default play), with a montage per window (original | Play |
// difference x6, enlarged x3) at `<name>-w<k>-montage.png`; one JSON row per window on stdout and `<name>-<suffix>-metrics.json`.
function compareWindows() {
  const suffix = PLAY;
  const rects = JSON.parse(readFileSync(path.join(dir, `${name}-${PLAY}.json`), 'utf8')).rects;
  const rows = [];
  rects.forEach((rect, k) => {
    const [x, y, w, h] = rect, crop = `${w}x${h}+${x}+${y}`;
    const text = execFileSync(process.execPath, [path.join(root, 'scripts/visual-acceptance.mjs'), 'compare', '--maps', map, '--view', `${name}:0,0,0:0,0,0`,
      '--crop', crop, ...(suffix === 'play' ? [] : ['--play-name', suffix])], {encoding: 'utf8'});
    const line = text.trim().split('\n').at(-1), json = /(\{.*\})/.exec(line)?.[1];
    const metrics = json ? JSON.parse(json) : {error: line};
    rows.push({window: k + 1, rect, ...metrics});
    const prefix = suffix === 'play' ? name : `${name}-${suffix}`;
    const a = path.join(dir, `${prefix}-crop-original.png`), b = path.join(dir, `${prefix}-crop-${suffix}.png`);
    const outFile = path.join(dir, `${name}-w${k + 1}-${suffix}-montage.png`);
    if (existsSync(a) && existsSync(b)) execFileSync('magick', [a, b, '(', a, b, '-compose', 'difference', '-composite', '-evaluate', 'Multiply', '6', ')', '+append', '-scale', '300%', outFile]);
  });
  writeFileSync(path.join(dir, `${name}-${suffix}-metrics.json`), JSON.stringify(rows, null, 1));
  for (const row of rows) console.log(JSON.stringify({window: row.window, ratio: row.ratio, mad: row.mad, edgeRecall: row.edgeRecall, edgePrecision: row.edgePrecision, blocks: row.blockRatio}));
}

// chrome: the terminal's screen outside the camera windows (title bar, buttons, text, window frames: the interface the original draws around the views) against the
// original's frame: the pixels off by more than 2 and by more than 10 of 255 over everything the camera windows' rectangles (from `<name>-<suffix>.json`) do not
// cover. One JSON row on stdout and `<name>-<suffix>-chrome.json` (docs/interface-frames.md "Computer screens").
function chrome() {
  const rects = JSON.parse(readFileSync(path.join(dir, `${name}-${PLAY}.json`), 'utf8')).rects;
  const rgb = file => execFileSync('magick', [file, '-depth', '8', 'rgb:-'], {maxBuffer: 1 << 28});
  const A = rgb(path.join(dir, `${name}-original.png`)), B = rgb(path.join(dir, `${name}-${PLAY}.png`));
  let over2 = 0, over10 = 0, outside = 0, max = 0;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    if (rects.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh)) continue;
    outside++;
    const i = 3 * (y * WIDTH + x), d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
    if (d > 2) over2++; if (d > 10) over10++; max = Math.max(max, d);
  }
  const row = {map, name, suffix: PLAY, rects, outsidePixels: outside, over2, over10, maxDifference: max};
  writeFileSync(path.join(dir, `${name}-${PLAY}-chrome.json`), JSON.stringify(row, null, 1));
  console.log(JSON.stringify(row));
}

if (verb === 'play') await play();
else if (verb === 'original') await original();
else if (verb === 'compare') compareWindows();
else if (verb === 'chrome') chrome();
else console.log('usage: camera-acceptance.mjs play|original|compare|chrome --map M --computer C --user U --password P --name n');
