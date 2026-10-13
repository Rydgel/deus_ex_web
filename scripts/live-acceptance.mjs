// Live-scene acceptance against the original (docs/visual-acceptance.md "Live
// scenes"): a level that runs (NPCs walking, dancing, animation, lights),
// compared tick for tick with the original DeusEx.exe under Wine.
//
// The original is observed as a debugger (tools/dx-live-win.c `trace`):
// breakpoints at ULevel::Tick's entry and return give, for every tick, the
// input delta and the CRT rand state it ran on and the watched actors' fields
// after it. Play then replays those ticks on its own live level: the same
// delta and the same stream state per tick (a measured host input, as the
// render draws between ticks are not modelled by the replay), and records the
// same fields. The first differing tick of each field is the divergence.
//
//   node scripts/live-acceptance.mjs original --map 10_Paris_Club [--ticks 600] [--release 3] [--delta 0.0166666675]
//        [--watch auto|A,B,..] [--no-open] [--load-wait 25000] [--hold]
//   node scripts/live-acceptance.mjs play --map 10_Paris_Club
//   node scripts/live-acceptance.mjs compare --map 10_Paris_Club
//
// `original` needs the game running under Wine (ad/scripts/original-game.mjs
// launch; WINEPREFIX, DX_WINE, DX_GAME as in visual-acceptance.mjs). Output
// in .work/live-acceptance/<map>/ (local captures stay outside Git).
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = name => process.argv.includes(`--${name}`);
const verb = process.argv[2];
const map = option('map', '10_Paris_Club');
const dir = path.join(root, '.work/live-acceptance', map);
mkdirSync(dir, {recursive: true});
const tracePath = path.join(dir, 'original-trace.jsonl');
const watchPath = path.join(dir, 'watch.json');
const playPath = path.join(dir, 'play-rows.json');


// The fields watched on every actor: label (the trace's key), Unreal property
// (Play reads it by name), linked offset in the retail Actor/Pawn layout (the
// SDK's, confirmed by Play's slotOf for Hooker0) and the tool's type.
const FIELDS = [
  ['Loc', 'Location', 0x114, 'f3'], ['Rot', 'Rotation', 0x120, 'i3'], ['Vel', 'Velocity', 0x144, 'f3'], ['Acc', 'Acceleration', 0x150, 'f3'],
  ['Phys', 'Physics', 0x30, 'u8'], ['Anim', 'AnimSequence', 0x54, 'name'], ['Frame', 'AnimFrame', 0x58, 'f'], ['Rate', 'AnimRate', 0x5c, 'f'],
  ['Tween', 'TweenRate', 0x60, 'f'], ['Life', 'LifeSpan', 0x50, 'f'], ['State', '$state', 0x0c, 'state'],
  ['LRT', 'LastRenderTime', 0x34, 'f'], ['Dist', 'DistanceFromPlayer', 0x38, 'f'],
  ['Dest', 'Destination', 0x354, 'f3'], ['MoveT', 'MoveTimer', 0x348, 'f'], ['Order', 'Orders', 0x674, 'name'], ['Health', 'Health', 0x428, 'i32'],
  // Walking: what scales a pawn's acceleration (Play's slotOf offsets and bit masks, SecurityBot0).
  ['WalkSp', 'WalkingSpeed', 0x68c, 'f'], ['GSpeed', 'GroundSpeed', 0x378, 'f'], ['AccelR', 'AccelRate', 0x384, 'f'],
  ['IsWalk', 'bIsWalking', 0x318, 'bit', 0x10], ['Sprint', 'bSprint', 0x6e8, 'bit', 0x800], ['Pausing', 'bPausing', 0x910, 'bit', 0x2],
  ['Staring', 'bStaring', 0x910, 'bit', 0x4], ['Sitting', 'bSitting', 0x910, 'bit', 0x40], ['Dancing', 'bDancing', 0x910, 'bit', 0x80],
  ['Crouching', 'bCrouching', 0x910, 'bit', 0x100], ['InWorld', 'bInWorld', 0x910, 'bit', 0x800], ['WalkAround', 'bWalkAround', 0x974, 'bit', 0x4],
  ['MoveTgt', 'MoveTarget', 0x34c, 'obj'], ['Enemy', 'Enemy', 0x3cc, 'obj'], ['Focus', 'Focus', 0x360, 'f3'], ['DesRot', 'DesiredRotation', 0x208, 'i3'],
  ['NextAnim', 'NextAnim', 0x688, 'name'],
  ['DesSp', 'DesiredSpeed', 0x36c, 'f'], ['MaxDes', 'MaxDesiredSpeed', 0x370, 'f'], ['Reduced', 'bReducedSpeed', 0x318, 'bit', 0x800],
];
// The player's pose, read back from the original (the placement of Play's replay): view rotation and Region.
const PLAYER_FIELDS = FIELDS.slice(0, 10).concat([FIELDS[10]],
  [['VRot', 'ViewRotation', 0x3dc, 'i3'], ['RegZone', '$regionZone', 0xc8, 'obj'], ['RegLeaf', '$regionLeaf', 0xcc, 'i32'], ['RegNum', '$regionNum', 0xd0, 'u8']]);

// Load-time random state of the PawnGenerators (PigeonGenerator, SeagullGenerator, ...): PostBeginPlay draws TryTimer
// (0.25 + FRand()*0.75) and, with bRandomCount, PoolCount from the load's stream, which the two sides do not share
// (the original seeds the CRT with time(NULL), docs/rng.md). A generator first spawns when its TryTimer runs out,
// so Play's own draws moved those ticks (and the draws they make) by several ticks. Like the player's pose, the
// original's values are a measured input: read at the release (the last frozen row), written into Play before its first tick.
const GENERATOR_FIELDS = [['TryTimer', 'TryTimer', 0x540, 'f'], ['PoolCount', 'PoolCount', 0x3b4, 'i32']];

const spec = ([label, , off, type, mask]) => `${label}:0x${off.toString(16)}:${type}${mask ? `:0x${mask.toString(16)}` : ''}`;

// --- the original ---------------------------------------------------------
async function original() {
  const game = await import('../ad/scripts/original-game.mjs');
  const scratch = path.join(dir, 'steps'); mkdirSync(scratch, {recursive: true});
  let step = 0;
  const post = (lines, timeout) => {
    const file = path.join(scratch, `step-${String(step++).padStart(3, '0')}.txt`);
    writeFileSync(file, lines.join('\n') + '\n');
    game.run(file, timeout);
  };
  const tool = path.join(root, 'ad/build/dx-live-win.exe');
  const wine = (...args) => execFileSync(game.WINE, [tool, ...args], {encoding: 'utf8', env: process.env, maxBuffer: 1 << 26});
  const loadWait = Number(option('load-wait', 25000));
  if (!flag('no-open')) {
    // Leaving a map saves its travel state, and a map visited before loads from it
    // (visual-acceptance.mjs "Fresh maps"): hop to another map first when the game
    // has this one loaded, then move the saved state aside.
    const lastPath = path.join(root, '.work/live-acceptance/last-map.txt');
    const current = option('current', existsSync(lastPath) ? readFileSync(lastPath, 'utf8').trim() : null);
    if (current === map) post([`cmd open ${map === '00_Training' ? '01_NYC_UNATCOIsland' : '00_Training'}`, `sleep ${loadWait}`], loadWait + 60000);
    const travel = path.join(game.GAME, 'Save', 'Current', `${map}.dxs`);
    if (existsSync(travel)) {
      const aside = path.join(root, '.work/live-acceptance/save-current'); mkdirSync(aside, {recursive: true});
      renameSync(travel, path.join(aside, `${map}-${Date.now()}.dxs`));
    }
    writeFileSync(lastPath, map);
    post(['cmd set LevelInfo bPlayersOnly True', 'sleep 300', 'cmd set LevelInfo TimeDilation 1', 'sleep 300',
      `cmd open ${map}`, `sleep ${loadWait}`], loadWait + 60000);
    post(['cmd set DeusEx.JCDentonMale bCheatsEnabled True', 'sleep 200', 'cmd ghost', 'sleep 200', 'cmd ShowHud False', 'sleep 500']);
    // Placement. The original is never moved with `set Location` or `set Region` in a level that
    // then ticks: the collision hash is not updated, and the live level crashed (a General
    // protection fault in TickLevel, 2026-10-11). The player stays at the map's start pose, or
    // flies as a ghost through input (MoveActor keeps the hash) after a `set ViewRotation`,
    // which does not touch it: --fly yaw:ms (e.g. 32768:3000). Play is placed from what the
    // original ends up in (the trace's first row).
    const fly = option('fly', null);
    if (fly) {
      const [yaw, ms] = fly.split(':').map(Number);
      post([`cmd set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=${yaw},Roll=0)`, 'sleep 300', 'down W', `sleep ${ms}`, 'up W', 'sleep 1500']);
    }
  }
  const generators = flag('no-generators') ? [] : wine('list', 'PawnGenerator').split('\n').map(line => /^\S+ (\S+) slot=/.exec(line)?.[1]).filter(Boolean);
  const watchOption = option('watch', 'auto');
  let names;
  if (watchOption === 'auto') {
    names = wine('list', 'ScriptedPawn').split('\n').map(line => /^\S+ (\S+) slot=/.exec(line)?.[1]).filter(Boolean);
  } else names = watchOption.split(',');
  const config = [`out ${tracePath}`, 'player JCDentonMale', `release ${option('release', 3)}`, `ticks ${option('ticks', 600)}`,
    ...(option('delta', null) ? [`delta ${option('delta')}`] : []), ...(option('monitor', null) ? [`monitor ${option('monitor')}`] : []), ...(option('actor-trace', null) ? [`actor-trace ${option('actor-trace').replace(':', ' ')}`] : []),
    // --extra-config <file>: more trace.cfg lines (tools/dx-live-win.c `call` breakpoints, call-ticks, call-pawn).
    ...(option('extra-config', null) ? readFileSync(option('extra-config'), 'utf8').split('\n').filter(line => line.trim()) : []),
    ...(generators.length ? [`watch ${generators.join(',')} ${GENERATOR_FIELDS.map(spec).join(' ')}`] : []),
    `watch @player ${PLAYER_FIELDS.map(spec).join(' ')}`,
    `watch ${names.join(',')} ${FIELDS.map(spec).join(' ')}`];
  const configPath = path.join(dir, 'trace.cfg');
  writeFileSync(configPath, config.join('\n') + '\n');
  writeFileSync(watchPath, JSON.stringify({map, pawns: names, generators}, null, 1));
  // The actors the original's level holds (a load removes some at random: OddsOfAppearing).
  const everything = wine('list', 'Actor').split('\n').map(line => /^\S+ (\S+) slot=\d+ .* odds=(\S+)/.exec(line)).filter(Boolean).map(m => ({name: m[1], odds: Number(m[2])}));
  writeFileSync(path.join(dir, 'population.json'), JSON.stringify(everything));
  console.log(`${everything.length} actors in the original's level, ${everything.filter(e => e.odds < 1).length} with OddsOfAppearing < 1`);
  // The original's load decided some map actors by chance (FlyGenerator, OddsOfAppearing): Play's replay destroys the
  // ones only Play holds, but cannot create the ones only the original holds. Reload until it holds none (the
  // driver's exit code 3 asks for a retry); `--no-population-check` runs on regardless.
  const reference = path.join(dir, 'play-population.json');
  if (existsSync(reference) && !flag('no-population-check')) {
    const played = new Set(JSON.parse(readFileSync(reference, 'utf8')).names);
    const spawned = /^(Skill|Aug|NanoKey|ColorTheme|Shadow|ParticleProxy|Laser|Flare|Cigarettes|Candybar|Weapon|Mission|GameReplicationInfo|PlayerReplicationInfo|JCDenton|Mutator|DeusExGameInfo|PickupDistributor|AutoTurretGun|BarkManager|ParticleGenerator|DataVault|Credits|Ammo|BioelectricCell|Medkit|Binoculars|Lockpick|Multitool|LAM|Liquor|Soda|Sodacan|Fruit|Vice)/;
    const only = everything.filter(e => !played.has(e.name) && !spawned.test(e.name)).map(e => e.name);
    if (only.length) { console.log(`POPULATION: the original holds ${only.length} actors Play's seed ${option('seed', 1)} load lacks: ${only.slice(0, 20).join(' ')}`); process.exitCode = 3; return; }
    console.log('population: the original holds nothing Play lacks');
  }
  rmSync(`${tracePath}.resume`, {force: true});
  const child = spawn(game.WINE, [tool, 'trace', configPath], {env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
  console.log('tracer pid', child.pid, `${names.length} pawns watched`);
  let log = '';
  child.stderr.on('data', chunk => { log += chunk; });
  const finished = new Promise(resolve => child.on('exit', resolve));
  const started = Date.now();
  while (!/paused after/.test(log) && child.exitCode === null && Date.now() - started < 600000) await new Promise(r => setTimeout(r, 500));
  console.log(log.trim());
  if (!flag('hold')) {
    writeFileSync(`${tracePath}.resume`, '');
    await finished;
    rmSync(`${tracePath}.resume`, {force: true});
    console.log('tracer finished');
    const crash = `${tracePath}.crash.txt`;
    if (existsSync(crash)) console.log('CRASH CAPTURED\n' + readFileSync(crash, 'utf8'));
  } else console.log(`level held by the tracer (pid ${child.pid}); create ${tracePath}.resume to resume`);
}

// --- Play -----------------------------------------------------------------
async function withPlay(body) {
  const {chromium} = await import('@playwright/test');
  const {createServer} = await import('vite');
  let server = null, url = option('url', null);
  if (!url) {
    const {default: base} = await import('../vite.config.mjs');
    const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
      && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
    server = await createServer({...base, configFile: false, root, logLevel: 'error',
      server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
    await server.listen();
    url = server.resolvedUrls.local[0].replace(/\/$/, '');
  }
  const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${url}/?hold=1&seed=${option('seed', 1)}`);
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
    if (await page.evaluate(() => window.deusExViewer.status().map) !== map) {
      await page.locator('#map').selectOption(map);
      await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, {timeout: 300000});
    }
    const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
    // The frozen start of the original's capture: bPlayersOnly from the first tick, then ghost / ShowHud False.
    await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: true, timeDilation: 1}));
    await page.evaluate(() => window.deusExViewer.release());
    await frames(10);
    const ghost = await page.evaluate(() => window.deusExViewer.viewProbe({ghost: true}));
    await frames(5);
    await body({page, frames, errors, ghost});
    await page.close();
  } finally { await browser.close(); await server?.close(); }
}

// snap --at x,y,z [--pitch p --yaw y]: a Play frame from that place, to choose a camera.
async function snap() {
  const location = option('at', null)?.split(',').map(Number);
  const rotation = [Number(option('pitch', 0)), Number(option('yaw', 0)), 0];
  await withPlay(async ({page, frames}) => {
    await page.addStyleTag({content: `.toolbar, footer, #toast, #play-hint, #npc-preview-label, #panel, #crosshair, #gate { display: none !important; }
#app { height: 100vh !important; } #viewport { position: fixed !important; inset: 0 !important; width: 1280px; height: 720px; }
#scene { position: fixed !important; left: 0 !important; top: 0 !important; margin: 0 !important; border: 0 !important; transform: none !important; width: 1280px !important; height: 720px !important; }`});
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.evaluate(() => { const el = document.getElementById('brightness'); el.value = '0.4'; el.dispatchEvent(new Event('input')); });
    const region = (await page.evaluate(at => window.deusExViewer.liveProbe({pointRegion: at}), location)).pointRegion;  // Play only: a camera for looking
    await page.evaluate(([at, rot, reg]) => window.deusExViewer.viewProbe({location: at, rotation: rot, region: {zone: reg.zone, iLeaf: reg.iLeaf, zoneNumber: reg.zoneNumber}}), [location, rotation, region]);
    await frames(45);
    const file = path.join(dir, option('name', 'snap.png'));
    await page.screenshot({path: file, clip: {x: 0, y: 0, width: 1280, height: 720}});
    console.log(file, JSON.stringify(region));
  });
}

// population: which OddsOfAppearing < 1 actors Play's seeded load keeps (compared with the original's before a trace).
async function population() {
  await withPlay(async ({page}) => {
    const {actors} = await page.evaluate(() => window.deusExViewer.liveProbe({actors: 'engine.actor'}));
    writeFileSync(path.join(dir, 'play-population.json'), JSON.stringify({seed: Number(option('seed', 1)), names: actors.map(a => a.name)}));
    console.log(map, `seed ${option('seed', 1)}:`, actors.length, 'actors');
  });
}

async function play() {
  // --ticks N replays only the first N unfrozen ticks; --nav-trace A,B [--nav-ticks first:last] also records those pawns'
  // reach and path natives' boundary calls (src/runtime/nav-trace.mjs) to nav-play.json, to compare with the original's
  // (tools/dx-live-win.c `call`, original --extra-config).
  const limit = Number(option('ticks', 0)) || undefined;
  const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.unfrozen >= 1).slice(0, limit);
  const {pawns, generators = []} = JSON.parse(readFileSync(watchPath, 'utf8'));
  // Play is placed where the original's player stood when the replay begins: the last frozen tick's exit.
  const frozen = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.unfrozen === 0);
  const pose = frozen[frozen.length - 1].actors['@player'];
  await withPlay(async ({page, frames, errors, ghost}) => {
    // The original's pose, exactly (the frozen-phase history of the ghost differs: its landing, its Tread loop).
    await page.evaluate(a => window.deusExViewer.viewProbe({location: a.Loc, rotation: a.VRot,
      region: {zone: a.RegZone, iLeaf: a.RegLeaf, zoneNumber: a.RegNum}}), pose);
    const population = existsSync(path.join(dir, 'population.json')) ? JSON.parse(readFileSync(path.join(dir, 'population.json'), 'utf8')) : null;
    if (population) {
      const result = (await page.evaluate(names => window.deusExViewer.liveProbe({population: names}), population)).population;
      console.log(`population: ${result.removed.length} actors only Play had destroyed (${result.removed.slice(0, 12).join(' ')}${result.removed.length > 12 ? ' ...' : ''}); ${result.missing.length} only the original has (${result.missing.slice(0, 12).join(' ')})`);
      writeFileSync(path.join(dir, 'population-result.json'), JSON.stringify(result));
    }
    await frames(5);
    const props = [...new Set(FIELDS.map(f => f[1]))], playerProps = [...new Set(PLAYER_FIELDS.map(f => f[1]))];
    // the player's animation too, in the call that arms the replay: no frozen tick runs between (a looping ghost
    // animation reaching its end can call script that draws)
    const navPawns = option('nav-trace', null), [navFirst, navLast] = option('nav-ticks', `1:${trace.length}`).split(':').map(Number);
    // The generators' load-time draws (GENERATOR_FIELDS), as the original's frozen phase left them.
    const generatorWrites = Object.fromEntries(generators.filter(name => frozen[frozen.length - 1].actors[name])
      .map(name => [name, Object.fromEntries(GENERATOR_FIELDS.map(([label, prop]) => [prop, frozen[frozen.length - 1].actors[name][label]]))]));
    const request = {write: {'@player': {AnimSequence: pose.Anim, AnimFrame: pose.Frame, AnimRate: pose.Rate, TweenRate: pose.Tween}, ...generatorWrites},
      ...(navPawns ? {navTrace: {pawns: navPawns.split(','), first: navFirst, last: navLast}} : {}), replay: {ticks: trace, release: true, hold: true, drawTrace: flag('draw-trace'), watch: [
      {names: ['@player'], props: playerProps}, {names: pawns, props}]}};
    const started = await page.evaluate(r => window.deusExViewer.liveProbe(r), request);
    const rows = [], nav = [];
    let stalls = 0;
    while (rows.length < trace.length) {
      await frames(20);
      const taken = await page.evaluate(() => window.deusExViewer.liveProbe({take: true}));
      nav.push(...(taken.nav ?? []));
      if (taken.rows.length) { rows.push(...taken.rows); stalls = 0; } else if (++stalls > 40) throw new Error(`the replay stopped at tick ${rows.length}`);
    }
    writeFileSync(playPath, JSON.stringify({map, ghost, initial: started.initial, rows, errors}));
    if (navPawns) writeFileSync(path.join(dir, 'nav-play.json'), JSON.stringify({pawns: navPawns.split(','), events: nav}));
    console.log(map, `${rows.length} ticks replayed`, errors.length ? `errors: ${errors.slice(0, 2).join(' | ')}` : '');
  });
}

// --- comparison -----------------------------------------------------------
const f32 = Math.fround;
let rotationCompare = false;
function same(a, b) {
  if (a === null || a === undefined) a = 'None';
  if (b === null || b === undefined) b = 'None';
  if (rotationCompare && Array.isArray(a) && Array.isArray(b)) { const wrap = v => ((v % 65536) + 65536) % 65536; a = a.map(wrap); b = b.map(wrap); }
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (typeof a === 'number' && typeof b === 'number') return Object.is(f32(a), f32(b)) || (a === b);
  return a === b;
}
const fmt = v => Array.isArray(v) ? `(${v.map(fmt).join(', ')})` : typeof v === 'number' ? String(+v.toPrecision(9)) : String(v);
function compare() {
  const original = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const rows = original.filter(row => row.unfrozen >= 1);
  const played = JSON.parse(readFileSync(playPath, 'utf8'));
  const labelOf = new Map(FIELDS.map(f => [f[1] === '$state' ? 'State' : f[1], f[0]]));
  const report = {map, ticks: rows.length, tickChecks: {}, actors: {}};
  // Per tick: stream and clocks.
  let firstRng = null, firstClock = null;
  const tickDraws = [];
  rows.forEach((row, i) => {
    const p = played.rows[i];
    if (!p) return;
    const draws = (a, b) => { const step = s => (Math.imul(s, 214013) + 2531011) >>> 0; let x = parseInt(a, 16) >>> 0, k = 0; const t = parseInt(b, 16) >>> 0; while (x !== t && k < 100000) { x = step(x); k++; } return x === t ? k : null; };
    const po = draws(row.rngIn, row.rngOut), pp = draws(p.rngIn, p.rngOut);
    if (po !== pp && firstRng === null) firstRng = {tick: i + 1, original: po, play: pp, originalState: row.rngOut, playState: p.rngOut};
    if (po) tickDraws.push([i + 1, po, pp]);
    if (!Object.is(row.clockOut, p.clockOut) && firstClock === null) firstClock = {tick: i + 1, original: row.clockOut, play: p.clockOut};
  });
  report.rng = {firstTickWithDifferentDrawCount: firstRng, ticksWithDraws: tickDraws.length, tickDraws: tickDraws.slice(0, 40)};
  report.clock = {firstDifference: firstClock};
  const names = Object.keys(rows[0]?.actors ?? {});
  for (const name of names) {
    const entry = report.actors[name] = {firstDifference: null, fields: {}};
    for (let i = 0; i < rows.length; i++) {
      const o = rows[i].actors[name], p = played.rows[i]?.actors[name];
      if (!o || !p) continue;
      for (const [label, prop] of [...FIELDS, ...PLAYER_FIELDS.slice(11)].map(f => [f[0], f[1] === '$state' ? 'State' : f[1]])) {
        if (!(label in o)) continue;
        let ov = o[label], pv = p[prop];
        if (label === 'State') { ov = String(ov).split('|')[0]; pv = String(pv).split('|')[0]; }
        rotationCompare = label === 'Rot';
        if (same(ov, pv)) continue;
        const field = entry.fields[label] ??= {tick: i + 1, original: ov, play: pv, count: 0};
        field.count++;
        if (entry.firstDifference === null || i + 1 < entry.firstDifference) entry.firstDifference = i + 1;
      }
    }
  }
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`${map}: ${rows.length} ticks; clock ${firstClock ? `differs from tick ${firstClock.tick}` : 'equal'}; stream draws per tick ${firstRng ? `differ at tick ${firstRng.tick} (original ${firstRng.original}, Play ${firstRng.play})` : 'equal'}`);
  for (const [name, entry] of Object.entries(report.actors)) {
    const fields = Object.entries(entry.fields).sort((a, b) => a[1].tick - b[1].tick).slice(0, 4)
      .map(([label, f]) => `${label}@${f.tick}: ${fmt(f.original)} vs ${fmt(f.play)}`).join(' | ');
    console.log(`${name.padEnd(18)} ${entry.firstDifference === null ? `equal for ${rows.length} ticks` : `first difference at tick ${entry.firstDifference}`}  ${fields}`);
  }
}

if (verb === 'original') await original();
else if (verb === 'snap') await snap();
else if (verb === 'population') await population();
else if (verb === 'play') await play();
else if (verb === 'compare') compare();
else console.log('usage: live-acceptance.mjs original|play|compare|snap --map <map>');
