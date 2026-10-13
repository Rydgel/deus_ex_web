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
 * checks that Play reaches them and that the former boundary now completes.
 *
 * Native 708 AIDirectionReachable (exec 0x103c8560, bit-exact in
 * validate-pawn-direction-reach) was the next boundary, at tick 1375: after
 * actorReachable(player) succeeds, PaulDenton0's GetNextVector asks it for a
 * step toward the player. It now runs, Paul follows the player, and his
 * radius conversation MeetPaul starts at tick 1872 (1422 since NPCs walk at
 * GroundSpeed x DesiredSpeed, 2026-10-11). It is third-person, so
 * ConPlay.StartConversation calls Conversation.CreateConCamera (ConSys native
 * 2051), formerly the boundary and now implemented; validate-island-conversation
 * follows MeetPaul to its first choice. Play paints the HUD every frame (the
 * conversation's speech window reads the viewport size through GetCurrentRes),
 * so this run does too. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== 'child') {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`child failed (${child.status}): ${child.stderr.split('\n').filter(l => !/Deprecation|trace-deprecation/.test(l)).slice(-12).join('\n')}`);
  const run = JSON.parse(child.stdout.trim().split('\n').at(-1));
  const paul = run.paul;
  // 1. The former boundary: a GetNextWaypoint actorReachable of PaulDenton0's
  // whose walkReachable ran FindBestJump (tick 1221 before 2026-10-11). Since
  // script pawns walk at GroundSpeed x DesiredSpeed (calcVelocity's class test,
  // docs/walking.md), Paul reaches the player sooner on this workload and no
  // longer needs that jump; the jump bodies stay bit-exact in
  // validate-pawn-jump-reach. When a jumping reach check does occur, it must
  // complete as before.
  const former = paul.calls.find(c => c.index === 520 && c.jumps > 0) ?? null;
  if (former) {
    assert.deepEqual({ fn: former.function, state: former.state }, { fn: 'GetNextWaypoint', state: 'RunningTo' });
    assert.equal(typeof former.result, 'boolean', 'the jumping reach check returned a verdict');
    const trace = former.trace, jump = trace.findIndex(t => t.op === 'FindBestJump');
    assert.ok(jump > 0 && trace.slice(0, jump).some(t => t.op === 'MoveActor'), 'checkMove steps preceded the jump');
  }
  const jumpCalls = paul.calls.filter(c => c.jumps > 0);
  assert.ok(jumpCalls.every(c => typeof c.result === 'boolean'), 'every reach check that jumped completed');
  // 2. The former 708 boundary (tick 1375 before 2026-10-11, 1335 since): PaulDenton0's GetNextVector
  // runs AIDirectionReachable after actorReachable(player) succeeds, every
  // call returns a verdict, and Paul closes on the player.
  const directionCalls = paul.calls.filter(c => c.index === 708);
  const firstDirection = directionCalls[0]?.tick;
  assert.ok(firstDirection > 0, 'PaulDenton0 runs AIDirectionReachable');
  assert.deepEqual(paul.calls.filter(c => c.tick === firstDirection).map(c => [c.index, c.result ?? null]),
    [[520, true], [708, true]], 'actorReachable(player) succeeds, then GetNextVector finds a step');
  assert.ok(directionCalls.every(c => c.function === 'GetNextVector' && c.state === 'RunningTo' &&
    typeof c.result === 'boolean' && c.moves > 0), 'every GetNextVector search completed with test moves');
  // bestDest is GetNextVector's out parameter: the write reaches it, and a
  // found step lies inside the [0, 64] band around Paul's Location.
  assert.ok(directionCalls.every(c => c.outKind === 'lvalue' && c.out?.length === 3),
    'every search wrote bestDest through its reference');
  assert.ok(directionCalls.every(c => !c.result || Math.hypot(...c.out.map((v, i) => v - c.from[i])) <= 64),
    'each found step is within maxDist of Location');
  assert.ok(!run.firstError || run.firstError.tick > firstDirection, 'no boundary at the first AIDirectionReachable');
  const distance = t => Math.hypot(t.location[0] - run.player[0], t.location[1] - run.player[1]);
  const [atFirst, atLast] = [paul.track.find(t => t.tick >= firstDirection + 5), paul.track.at(-1)];
  assert.ok(distance(atLast) < distance(atFirst), 'Paul followed the player');
  // 3. PaulDenton0's radius conversation MeetPaul is third-person, so
  // ConPlay.StartConversation asks Conversation.CreateConCamera (ConSys native
  // 2051, execCreateConCamera 0x100106f0) for its camera, with no boundary.
  assert.equal(run.firstError, null, 'no boundary through the conversation start');
  const camera = run.conversation.find(c => c.index === 2051);
  assert.ok(camera?.tick > firstDirection, 'MeetPaul starts after Paul closes on the player');
  assert.deepEqual({ conName: camera?.conName, owner: camera?.owner, firstPerson: camera?.bFirstPerson },
    { conName: 'MeetPaul', owner: 'PaulDenton', firstPerson: false });
  assert.deepEqual(run.conversation.filter(c => c.tick === camera.tick).map(c => c.index), [2052, 2051],
    'ConPlayBase binds the conversation events before the camera');
  const summary = {
    formerBoundary: former, firstDirection, conversationTick: camera.tick, jumpingCalls: jumpCalls.length,
    paulCalls: paul.calls.map(({ trace, ...c }) => c),
    fbjEntries: jumpCalls.reduce((n, c) => n + c.jumps, 0),
    fbjLog: paul.log,
    reachVerdicts: paul.calls.filter(c => c.index === 520 || c.index === 521)
      .reduce((m, c) => (m[`${c.index}:${c.result}`] = (m[`${c.index}:${c.result}`] ?? 0) + 1, m), {}),
    directionCalls: directionCalls.map(({ trace, ...c }) => c), conversation: run.conversation,
    paulTrack: paul.track, player: run.player, nextBoundary: run.firstError,
    seconds: +(camera.tick / 60).toFixed(3),
    scope: 'Island Play reaches FindBestJump/SuggestJumpVelocity/jumpLanding through actorReachable, ' +
      'AIDirectionReachable through GetNextVector and MeetPaul\'s CreateConCamera' };
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
const calls = [], conversation = [];
let tick = 0, firstError = null, lastNative = null;
const invokeNative = runtime.invokeNative.bind(runtime);
runtime.invokeNative = call => {
  const native = { index: call.index, receiver: call.receiver?.name ?? null, function: call.script?.name ?? null };
  // Conversation.BindEvents (2052) and CreateConCamera (2051): which
  // conversation starts and whether it is third-person.
  if (call.index === 2051 || call.index === 2052)
    conversation.push({ tick, ...native, conName: read(call.receiver, 'conName'),
      owner: read(call.receiver, 'conOwnerName'), bFirstPerson: read(call.receiver, 'bFirstPerson') });
  if ([517, 518, 520, 521, 525, 526, 708, 709].includes(call.index)) lastNative = native;
  if (call.receiver !== paulActor || ![517, 518, 520, 521, 525, 526, 708, 709].includes(call.index)) return invokeNative(call);
  const node = runtime.instance(call.receiver)?.state?.stateNode;
  const record = { tick, index: call.index, function: native.function, state: node?.record?.name ?? node?.name ?? null,
    jumps: 0, moves: 0, trace: [] };
  calls.push(record);
  if (call.index === 708) {
    // Observe AIDirectionReachable's bestDest: the evaluated out argument must
    // be an lvalue whose set() carries the band search's write to useLoc.
    record.from = read(paulActor, 'Location').map(v => +v.toFixed(3));
    const evaluate = call.evaluateArgument;
    call = { ...call, evaluateArgument: i => {
      const value = evaluate(i);
      if (i !== 5) return value;
      record.outKind = typeof value?.set === 'function' ? 'lvalue' : typeof value;
      if (record.outKind !== 'lvalue') return value;
      const observed = Object.create(value);
      observed.set = v => { record.out = Array.from(v, x => +x.toFixed(3)); return value.set(v); };
      return observed;
    } };
  }
  const outer = active; active = record;
  try {
    const result = invokeNative(call);
    record.result = typeof result === 'boolean' || typeof result === 'number' ? result : result?.name ?? null;
    return result;
  } finally { active = outer; }
};
createPlayerInputFixture(game).key('KeyW', true);
const track = [];
while (!firstError && tick < Number(process.env.ISLAND_TICKS ?? 1900)) {
  simulatedMs += 1000 / 60; tick++;
  lastNative = null;
  try { game.tick(1 / 60); game.hud.commands(1440, 960, game.view()); }
  catch (error) {
    firstError = { tick, message: String(error?.message ?? error).split('\n')[0], lastNavNative: lastNative,
      paulState: runtime.instance(paulActor)?.state?.stateNode?.record?.name ?? null };
  }
  if (tick % 30 === 0 || firstError) track.push({ tick, location: read(paulActor, 'Location').map(Math.round),
    physics: read(paulActor, 'Physics') });
}
const summary = calls.filter(c => c.tick >= 1200).map(({ trace, ...c }) => c.jumps ? { ...c, trace } : c);
console.log(JSON.stringify({ firstError, conversation, player: read(game.player.collisionActor, 'Location').map(Math.round),
  paul: { calls: summary, log, track: track.filter(t => t.tick >= 1170) } }));
process.exit(0);
