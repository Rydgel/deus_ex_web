/** Play integration of APawn::FindBestJump on UNATCO Island (docs/script-pawn-nav.md
 * "Jumping contract").
 *
 * Original Play, no bypass, bench-sim's workload (the forward key held from the
 * first tick), deterministic 60 Hz clock, one child process. Before the jump
 * bodies were translated this run stopped at tick 1221: PaulDenton0's
 * GetNextWaypoint asked actorReachable (native 520), whose walkReachable
 * reached checkMove's -1 for a bCanJump pawn and needed FindBestJump
 * (0x103c2f50). This validator records every navigation native PaulDenton0
 * enters, the FindBestJump entries inside each (FindBestJump is the only nav
 * body that reads JumpZ), its test moves and GLog lines, and the first runtime
 * boundary, which it reports but does not implement.
 *
 * The bodies are bit-exact against Engine.dll in validate-pawn-jump-reach; this
 * checks that Play reaches them and that the former boundary now completes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== 'child') {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`child failed (${child.status}): ${child.stderr.split('\n').filter(l => !/Deprecation|trace-deprecation/.test(l)).slice(-12).join('\n')}`);
  const run = JSON.parse(child.stdout.trim().split('\n').at(-1));
  const paul = run.paul;
  // 1. The former boundary: PaulDenton0's GetNextWaypoint actorReachable at
  // tick 1221 now completes, and its walkReachable ran FindBestJump.
  const former = paul.calls.find(c => c.tick === 1221 && c.index === 520);
  assert.ok(former, 'PaulDenton0 calls actorReachable at tick 1221');
  assert.deepEqual({ fn: former.function, state: former.state }, { fn: 'GetNextWaypoint', state: 'RunningTo' });
  assert.ok(former.jumps > 0, 'the tick-1221 reach check entered FindBestJump');
  assert.equal(typeof former.result, 'boolean', 'the tick-1221 reach check returned a verdict');
  assert.ok(!run.firstError || run.firstError.tick > 1221, 'no boundary at the former jump tick');
  const jumpCalls = paul.calls.filter(c => c.jumps > 0);
  assert.ok(jumpCalls.every(c => typeof c.result === 'boolean'), 'every reach check that jumped completed');
  // The jump lands in water (jumpLanding stops on the water zone) and
  // swimReachable cannot climb out toward the player: GetNextWaypoint falls
  // back to FindPathToward in the same tick and gets a PatrolPoint.
  const trace = former.trace, jump = trace.findIndex(t => t.op === 'FindBestJump');
  assert.ok(jump > 0 && trace.slice(0, jump).some(t => t.op === 'MoveActor'), 'checkMove steps preceded the jump');
  const path = paul.calls.find(c => c.tick === 1221 && c.index === 517);
  assert.match(path?.result ?? '', /^PatrolPoint\d+$/, 'FindPathToward answers the failed reach check');
  // 2. The next runtime boundary without any bypass (reported, not implemented):
  // native 708 AIDirectionReachable from ScriptedPawn.GetNextVector, after a
  // later actorReachable(player) succeeds.
  assert.ok(run.firstError, 'a later boundary is reached within the window');
  const { index, receiver, function: caller } = run.firstError.lastNavNative ?? {};
  assert.deepEqual({ index, receiver, caller }, { index: 708, receiver: 'PaulDenton0', caller: 'GetNextVector' });
  assert.match(run.firstError.message, /native 708/);
  const before = paul.calls.filter(c => c.tick === run.firstError.tick);
  assert.deepEqual(before.map(c => [c.index, c.result ?? null]), [[520, true], [708, null]],
    'actorReachable(player) succeeds before GetNextVector');
  const summary = {
    formerBoundary: former, jumpingCalls: jumpCalls.length,
    paulCalls: paul.calls.map(({ trace, ...c }) => c),
    fbjEntries: jumpCalls.reduce((n, c) => n + c.jumps, 0),
    fbjLog: paul.log,
    reachVerdicts: paul.calls.filter(c => c.index === 520 || c.index === 521)
      .reduce((m, c) => (m[`${c.index}:${c.result}`] = (m[`${c.index}:${c.result}`] ?? 0) + 1, m), {}),
    paulTrack: paul.track, nextBoundary: run.firstError, seconds: run.firstError && +(run.firstError.tick / 60).toFixed(3),
    scope: 'Island Play reaches FindBestJump/SuggestJumpVelocity/jumpLanding through actorReachable; first boundary reported' };
  console.log(JSON.stringify(summary, null, 1));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The child. Deterministic simulated clock, as bench-sim.
let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', { value: () => simulatedMs, configurable: true });

const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createGame } = await import('../src/viewer/game.mjs');
const { gameDirectory } = await import('./game-directory.mjs');
const { createPlayerInputFixture } = await import('./player-input-fixture.mjs');

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('01_NYC_UNATCOIsland');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const runtime = game.doors.scriptRuntime.runtime;
const level = runtime.levelFor(game.player.collisionActor);
const read = (actor, name) => runtime.readNamed(actor, name);
const paulActor = level.actors.find(a => a?.name === 'PaulDenton0');
assert.ok(paulActor, 'PaulDenton0 exists');

// PaulDenton0's navigation services, observed without changing them: a JumpZ
// read marks a FindBestJump entry; moves and GLog lines are counted.
let active = null;
const log = [];
const navServices = runtime.pawnNavServices.bind(runtime);
runtime.pawnNavServices = receiver => {
  const services = navServices(receiver);
  if (receiver !== paulActor) return services;
  return { ...services,
    read: (actor, name) => {
      if (active && actor === paulActor && name === 'JumpZ') {
        active.jumps++;
        active.trace.push({ op: 'FindBestJump', from: read(paulActor, 'Location').map(v => +v.toFixed(2)) });
      }
      return services.read(actor, name);
    },
    moveActor: (actor, delta, ...rest) => {
      const hit = services.moveActor(actor, delta, ...rest);
      if (active) {
        active.moves++;
        active.trace.push({ op: 'MoveActor', delta: delta.map(v => +v.toFixed(2)), time: +hit.time.toFixed(4),
          normalZ: +(hit.normal?.[2] ?? 0).toFixed(3), to: read(paulActor, 'Location').map(v => +v.toFixed(2)) });
      }
      return hit;
    },
    farMoveActor: (actor, dest, ...rest) => {
      if (active) active.trace.push({ op: 'FarMoveActor', dest: dest.map(v => +v.toFixed(2)) });
      return services.farMoveActor(actor, dest, ...rest);
    },
    logf: event => { log.push({ tick, format: event.format, args: event.args }); return services.logf(event); } };
};
const calls = [];
let tick = 0, firstError = null, lastNative = null;
const invokeNative = runtime.invokeNative.bind(runtime);
runtime.invokeNative = call => {
  const native = { index: call.index, receiver: call.receiver?.name ?? null, function: call.script?.name ?? null };
  if ([517, 518, 520, 521, 525, 526, 708, 709].includes(call.index)) lastNative = native;
  if (call.receiver !== paulActor || ![517, 518, 520, 521, 525, 526, 708, 709].includes(call.index)) return invokeNative(call);
  const node = runtime.instance(call.receiver)?.state?.stateNode;
  const record = { tick, index: call.index, function: native.function, state: node?.record?.name ?? node?.name ?? null,
    jumps: 0, moves: 0, trace: [] };
  calls.push(record);
  const outer = active; active = record;
  try {
    const result = invokeNative(call);
    record.result = typeof result === 'boolean' || typeof result === 'number' ? result : result?.name ?? null;
    return result;
  } finally { active = outer; }
};
createPlayerInputFixture(game).key('KeyW', true);
const track = [];
while (!firstError && tick < Number(process.env.ISLAND_TICKS ?? 3000)) {
  simulatedMs += 1000 / 60; tick++;
  lastNative = null;
  try { game.tick(1 / 60); }
  catch (error) {
    firstError = { tick, message: String(error?.message ?? error).split('\n')[0], lastNavNative: lastNative,
      paulState: runtime.instance(paulActor)?.state?.stateNode?.record?.name ?? null };
  }
  if (tick % 30 === 0 || firstError) track.push({ tick, location: read(paulActor, 'Location').map(Math.round),
    physics: read(paulActor, 'Physics') });
}
const summary = calls.filter(c => c.tick >= 1200).map(({ trace, ...c }) => c.jumps ? { ...c, trace } : c);
console.log(JSON.stringify({ firstError, paul: { calls: summary, log, track: track.filter(t => t.tick >= 1170) } }));
process.exit(0);
