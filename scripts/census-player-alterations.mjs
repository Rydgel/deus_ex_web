#!/usr/bin/env node
/** Census of the player's alterations in Play: what pauses (docs/screen-flash.md "Census").
 *
 * Each scenario gives the player an effect the way the game does and plays it for a few seconds of Level time
 * through Play's own frame (sim-session.mjs: tick, sprite scan, HUD draw), headless, in one session per map with
 * the original Player start (game.reset()) between scenarios:
 *
 *   item        a pickup the map itself holds (or, where the map holds none of the class, one DeusExPlayer.Summon
 *               spawns, the console cheat the original supports) is frobbed, selected with the digit key User.ini binds to
 *               ActivateBelt and used with the left mouse button (ParseLeftClick -> Activate -> state Activated)
 *   throw       a weapon the same way, fired for ten frames: the thrown grenade explodes in Level time and the player
 *               steps into the cloud (fixture placement only)
 *   hit         the damage call every damage source makes into the player (Cloud.Timer, DamageTrigger, a projectile's
 *               Explode): `TakeDamage(Damage, Instigator, HitLocation, Momentum, DamageType)` on the player's own bytecode.
 *               The sources themselves (a Greasel's spit, a flamethrower's flame, a dart) are not simulated here.
 *   zone        the player placed in a map zone with bPainZone, or whose head is in a WaterZone (placement is a fixture
 *               write; the zone's own damage, flash and fog run from there)
 *
 * The outcome per scenario is `plays` or the first pause (the error Play pauses on) with the JS frames that threw.
 * EXPECTED below is the list as of the last run of this census; a scenario whose outcome differs from it fails the
 * check, so a regrown boundary cannot go unnoticed and a fixed one must be recorded.
 *
 *   node scripts/census-player-alterations.mjs [--only id,id] [--json out.json] [--print]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Each map session that paused is built again, and a pause leaves its game behind: run with a 8 GB heap.
if (!process.execArgv.some(arg => arg.startsWith('--max-old-space-size')) && !process.env.CENSUS_CHILD) {
  const child = spawnSync(process.execPath, ['--max-old-space-size=8192', ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, CENSUS_CHILD: '1' } });
  process.exit(child.status ?? 1);
}

let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', { value: () => simulatedMs, configurable: true });

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i < 0 ? null : (args[i + 1] ?? true); };
const only = option('only') ? String(option('only')).split(',') : null;

const { gameDirectory } = await import('./game-directory.mjs');
let root;
try { root = gameDirectory(); } catch { console.log('SKIP census-player-alterations: no installed game data'); process.exit(0); }
const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createGame } = await import('../src/viewer/game.mjs');
const { createSimSession } = await import('../src/viewer/sim-session.mjs');
const { createPlayerInputFixture } = await import('./player-input-fixture.mjs');

/** id: [map, how, kind, argument, seconds]. The map holds the class the scenario needs. */
const SCENARIOS = {
  'drink-wine': ['01_NYC_UNATCOIsland', 'item', 'WineBottle', 6],
  'drink-liquor40oz': ['01_NYC_UNATCOIsland', 'item', 'Liquor40oz', 6],
  'smoke-cigarettes': ['01_NYC_UNATCOIsland', 'item', 'Cigarettes', 6],
  'tear-gas-grenade': ['01_NYC_UNATCOIsland', 'throw', 'WeaponGasGrenade', 8],
  'emp-grenade': ['01_NYC_UNATCOIsland', 'throw', 'WeaponEMPGrenade', 8],
  'hit-poison': ['01_NYC_UNATCOIsland', 'hit', 'Poison,10', 12],
  'hit-poison-gas': ['01_NYC_UNATCOIsland', 'hit', 'PoisonGas,10', 4],
  'hit-tear-gas': ['01_NYC_UNATCOIsland', 'hit', 'TearGas,10', 4],
  'hit-radiation': ['01_NYC_UNATCOIsland', 'hit', 'Radiation,10', 4],
  'hit-halon-gas': ['01_NYC_UNATCOIsland', 'hit', 'HalonGas,10', 4],
  'hit-flamed': ['01_NYC_UNATCOIsland', 'hit', 'Flamed,10', 8],
  'hit-burned': ['01_NYC_UNATCOIsland', 'hit', 'Burned,10', 4],
  'hit-drowned': ['01_NYC_UNATCOIsland', 'hit', 'Drowned,10', 4],
  'hit-emp': ['01_NYC_UNATCOIsland', 'hit', 'EMP,10', 4],
  'hit-shocked': ['01_NYC_UNATCOIsland', 'hit', 'Shocked,10', 4],
  'hit-shot-bleed': ['01_NYC_UNATCOIsland', 'hit', 'Shot,30', 8],
  'drink-liquor-bottle': ['02_NYC_Bar', 'item', 'LiquorBottle', 6],
  'take-zyme': ['02_NYC_Hotel', 'item', 'VialCrack', 6],
  'take-ambrosia': ['09_NYC_Ship', 'item', 'VialAmbrosia', 6],
};

/** The outcome each scenario had at the last run: `plays`, or `pause` with the text its error message holds. */
const EXPECTED = {
  'drink-wine': { status: 'plays' },
  'drink-liquor40oz': { status: 'plays' },
  'smoke-cigarettes': { status: 'plays' },
  'tear-gas-grenade': { status: 'plays' },
  'emp-grenade': { status: 'plays' },
  'hit-poison': { status: 'plays' },
  'hit-poison-gas': { status: 'plays' },
  'hit-tear-gas': { status: 'plays' },
  'hit-radiation': { status: 'plays' },
  'hit-halon-gas': { status: 'plays' },
  'hit-flamed': { status: 'plays' },
  'hit-burned': { status: 'plays' },
  'hit-drowned': { status: 'plays' },
  'hit-emp': { status: 'plays' },
  'hit-shocked': { status: 'plays' },
  'hit-shot-bleed': { status: 'plays' },
  'drink-liquor-bottle': { status: 'plays' },
  'take-zyme': { status: 'plays' },
  'take-ambrosia': { status: 'plays' },
};

const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);

const results = {};
const ids = Object.keys(SCENARIOS).filter(id => !only || only.includes(id));
/** One loaded map; a scenario that paused leaves it unusable (Play's Player start is the way out of a pause, and the
 * session is simply built again here). */
async function openSession(map) {
  const asset = await assets.get(map);
  const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
  const sim = createSimSession(game, { assets });
  const runtime = game.doors.scriptRuntime.runtime;
  const read = (object, name) => runtime.readNamed(object, name);
  const player = () => game.player.collisionActor;
  const level = () => runtime.levelFor(player());
  const fixture = createPlayerInputFixture(game, {});
  const peak = {};
  const track = () => {
    const p = player();
    const v = { damage: -read(p, 'Health'), drugEffectTimer: read(p, 'drugEffectTimer'), bleedRate: read(p, 'bleedRate'),
      poisonCounter: read(p, 'poisonCounter'), desiredFlashScale: read(p, 'DesiredFlashScale'), flashFog: Math.max(...read(p, 'FlashFog')),
      flashScaleDeviation: Math.abs(read(p, 'FlashScale')[0] - 1), fovDeviation: Math.abs(read(p, 'FOVAngle') - 75),
      onFire: +read(p, 'bOnFire'), energyDrain: read(p, 'EnergyDrain') };
    for (const k in v) if (!(k in peak) || v[k] > peak[k]) peak[k] = v[k];
  };
  const frame = () => {
    simulatedMs += 1000 / 60;
    game.tick(1 / 60);
    const sprites = sim.sprites();
    const hud = sim.hud({ width: 1440, height: 960, view: game.view() });
    const errors = [...sprites.errors, ...hud.errors];
    if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
    track();
  };
  const frames = n => { for (let i = 0; i < n; i++) frame(); };
  const exec = command => game.hud.scoped(() => runtime.scriptConsoleExec(player(), command));
  const actors = () => level().actors.filter(Boolean);
  const classOf = a => { const out = []; for (let c = runtime.instance(a).cls; c; c = c.base) out.push(c.record.key); return out; };
  const byClass = cls => actors().filter(a => a.name.replace(/\d+$/, '') === cls);
  const free = cls => byClass(cls).filter(a => !read(a, 'Owner') && !read(a, 'bHidden'));
  const take = async target => {
    const taken = () => read(target, 'Owner') === player();
    await fixture.frob(target, undefined);
    frames(10);
    return taken();
  };
  /** The class's pickup from the map, else one Summon spawns. */
  async function acquire(cls) {
    for (const candidate of free(cls)) if (await take(candidate)) return { item: candidate, how: 'map pickup' };
    exec(`summon ${cls}`);
    frames(5);
    const summoned = byClass(cls).at(-1);
    if (summoned && await take(summoned)) return { item: summoned, how: 'summon' };
    throw new Error(`no ${cls} could be picked up`);
  }
  const select = async item => { await game.activateBelt(read(item, 'beltPos')); frames(60); };
  const click = hold => { game.inputButton('LeftMouse', true); frames(hold); game.inputButton('LeftMouse', false); };
  const run = {
    async item(cls, seconds) {
      const { item, how } = await acquire(cls);
      await select(item);
      const held = read(player(), 'inHand') === item;
      click(2);
      frames(Math.round(seconds * 60));
      return { how, item: item.name, held, consumed: Boolean(read(item, 'bDeleteMe')) || !read(item, 'Owner') };
    },
    async throw(cls, seconds) {
      const { item, how } = await acquire(cls);
      await select(item);
      click(10);
      frames(Math.round(seconds * 60 / 2));
      const cloud = actors().filter(a => /^(TearGas|EMPGrenade)/.test(a.name) && read(a, 'Owner') !== player()).at(-1);
      if (cloud) {
        const at = read(cloud, 'Location');
        fixture.place([at[0], at[1], at[2] - 20], { yaw: 0 });
      }
      frames(Math.round(seconds * 60 / 2));
      return { how };
    },
    async hit(arg, seconds) {
      const [type, damage] = arg.split(',');
      game.hud.scoped(() => runtime.processEvent(player(), 'TakeDamage', [Number(damage), player(), read(player(), 'Location'), [0, 0, 0], type]));
      frames(Math.round(seconds * 60));
      return { how: 'TakeDamage injected' };
    },
  };
  let used = false;
  return async id => {
    const [, kind, argument, seconds] = SCENARIOS[id];
    if (used) { game.reset(); frames(2); }
    used = true;
    for (const k in peak) delete peak[k];
    frames(30);
    runtime.writeNamed(player(), 'bCheatsEnabled', true);
    let outcome;
    try {
      const info = await run[kind](argument, seconds);
      outcome = { status: 'plays', ...info };
    } catch (error) {
      const jsFrames = error.stack.split('\n').slice(1, 4).map(line => line.trim().replace(/^at /, '').replace(/\(?file:\/\/.*\/(src\/[^)]*)\)?/, '$1'));
      outcome = { status: 'pause', message: error.message, frames: jsFrames };
    }
    outcome.peak = { ...peak };
    return outcome;
  };
}
for (const map of [...new Set(ids.map(id => SCENARIOS[id][0]))]) {
  let session = null;
  for (const id of ids.filter(id => SCENARIOS[id][0] === map)) {
    session ??= await openSession(map);
    const outcome = results[id] = await session(id);
    console.log(`${id.padEnd(22)} ${outcome.status === 'plays' ? 'plays' : `PAUSE ${outcome.message}`}`);
    if (outcome.status === 'pause') session = null;
  }
}

if (option('json')) await writeFile(String(option('json')), JSON.stringify(results, null, 1));
if (option('print')) for (const [id, outcome] of Object.entries(results)) console.log(id, JSON.stringify(outcome));
const mismatches = [];
for (const [id, outcome] of Object.entries(results)) {
  const expected = EXPECTED[id];
  if (!expected) { mismatches.push(`${id}: no expectation recorded (${outcome.status}${outcome.message ? ` ${outcome.message}` : ''})`); continue; }
  if (expected.status !== outcome.status || (expected.status === 'pause' && !outcome.message.includes(expected.message)))
    mismatches.push(`${id}: expected ${expected.status}${expected.message ? ` "${expected.message}"` : ''}, got ${outcome.status}${outcome.message ? ` "${outcome.message}"` : ''}`);
}
if (!only) for (const id of Object.keys(EXPECTED)) if (!(id in SCENARIOS)) mismatches.push(`${id}: expectation without a scenario`);
assert.equal(mismatches.join('\n'), '', 'the census changed');
console.log(`PASS census-player-alterations: ${ids.length} scenarios, ${ids.filter(id => results[id].status === 'plays').length} play, ${ids.filter(id => results[id].status === 'pause').length} pause`);
process.exit(0);
