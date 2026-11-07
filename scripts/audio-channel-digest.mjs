#!/usr/bin/env node
/** Galaxy's channel table after each frame of a fixed headless roam, hashed with its numbers' exact bits (host representation check).
 *
 * Boots a map through Play's createGame and a simulation session, holds the forward key and turns on a fixed schedule (the roam of
 * hud-stream-digest.mjs), and after every frame hashes what Galaxy's Update left in its channel table: each channel's id, sound, volume,
 * radius, pitch, priority, play time, occlusion, location and whether it holds a voice, in channel order. The AMBIENT_SCAN switch
 * (render.rs ambient_scan) changes how Update finds the ambient actors in reach; it must leave every per-frame hash alone:
 *
 *   AMBIENT_SCAN=js     node scripts/audio-channel-digest.mjs --map M --out ref.json
 *   AMBIENT_SCAN=rust   node scripts/audio-channel-digest.mjs --map M --compare ref.json
 *   AMBIENT_SCAN=verify node scripts/audio-channel-digest.mjs --map M --compare ref.json
 *
 *   [--map 01_NYC_UNATCOIsland] [--frames 600] [--warm 60] [--size 1440x960] [--out FILE] [--compare FILE]
 *
 * Prints the digest, the channels' use and the ambient scan's counters (scans, entries, those Rust decided in reach, those verify
 * compared). The clocks are pinned to the simulated tick as hud-stream-digest.mjs pins them. Host measurement only. */
import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const map = flag('map', '01_NYC_UNATCOIsland'), frames = Number(flag('frames', 600)), warm = Number(flag('warm', 60));
const [width, height] = flag('size', '1440x960').split('x').map(Number);
const outPath = flag('out', null), comparePath = flag('compare', null);

let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', {value: () => simulatedMs, configurable: true});

const {AssetStore} = await import('../src/unreal/assets.mjs');
const {decodeMap} = await import('../src/unreal/map.mjs');
const {createGame} = await import('../src/viewer/game.mjs');
const {createSimSession} = await import('../src/viewer/sim-session.mjs');
const {gameDirectory} = await import('./game-directory.mjs');
const {createPlayerInputFixture} = await import('./player-input-fixture.mjs');

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(map);
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const session = createSimSession(game, {assets});
const fixture = createPlayerInputFixture(game);
const audio = game.doors.scriptRuntime.runtime.audio;
if (!audio?.galaxy) throw new Error('the map has no live audio');

const bits = new DataView(new ArrayBuffer(8));
const num = value => { bits.setFloat64(0, value); return bits.getBigUint64(0).toString(16); };
const channelsOf = () => audio.galaxy.state.channels.map(channel => [channel.id, channel.sound?.key ?? null, num(channel.volume), num(channel.radius),
  num(channel.pitch), num(channel.priority), num(channel.time), num(channel.occlusion), channel.location ? Array.from(channel.location, num) : null,
  channel.voice ? 1 : 0]);

const FORWARD = 'KeyW', TURN_EVERY = 90, JUMP_EVERY = 150;
let tick = 0;
const step = () => {
  simulatedMs += 1000 / 60;
  if (tick === 0) fixture.key(FORWARD, true);
  if (tick > 0 && tick % TURN_EVERY === 0) fixture.axis('MouseX', (tick / TURN_EVERY) % 3 === 0 ? -40 : 40);
  if (tick > 0 && tick % JUMP_EVERY === 0) { fixture.key('Space', true); }
  else if (tick > 0 && tick % JUMP_EVERY === 1) { fixture.key('Space', false); }
  tick++;
  game.tick(1 / 60);
  const sprites = session.sprites();
  const view = game.view();
  const hud = session.hud({width, height, view});
  const errors = [...sprites.errors, ...hud.errors];
  if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
};
for (let i = 0; i < warm; i++) step();

const hashes = [], total = createHash('sha256');
let busy = 0, peak = 0;
for (let i = 0; i < frames; i++) {
  step();
  const channels = channelsOf(), used = channels.filter(channel => channel[0]).length;
  busy += used; peak = Math.max(peak, used);
  const h = createHash('sha256').update(JSON.stringify(channels)).digest('hex').slice(0, 16);
  hashes.push(h); total.update(h);
}
const digest = total.digest('hex').slice(0, 16);
console.log(JSON.stringify({map, frames, digest, mode: process.env.AMBIENT_SCAN ?? 'rust', channelsBusy: +(busy / frames).toFixed(2), peak,
  ambientScan: audio.nearStats, ambientActors: game.doors.scriptRuntime.runtime.levelFor?.(game.player.collisionActor)?.actors?.filter?.(Boolean).length ?? null}));
if (outPath) await writeFile(outPath, JSON.stringify({map, frames, digest, hashes}));
if (comparePath) {
  const ref = JSON.parse(await readFile(comparePath, 'utf8'));
  const first = hashes.findIndex((h, i) => h !== ref.hashes[i]);
  if (first >= 0 || ref.frames !== frames) { console.error(`DIFFERS at frame ${first}`); process.exit(1); }
  console.log(`equal to ${comparePath} over ${frames} frames`);
}
