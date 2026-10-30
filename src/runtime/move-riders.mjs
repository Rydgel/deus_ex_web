/**
 * The `ULevel::MoveActor` based-rider section (`0x103998a0`–`0x10399bb0`),
 * recovered from the hash-verified GOTY Engine.dll and documented in
 * docs/script-npc-weapon-startup.md.
 *
 * After the move's committed FinalDelta/NewRotation are known (and only when
 * the moved actor's StandingCount is nonzero — the caller owns that gate),
 * the body walks `Level.Actors` and recursively moves every actor whose
 * `Base` is the mover.  Each rider receives the base's final delta plus a
 * `RotMotion` term that keeps it at its yaw-rotated relative offset, its own
 * `Rotation.Yaw` gains the unmasked yaw difference, and a pawn rider's
 * `ViewRotation.Yaw` gains the same amount.  The recursive `MoveActor` runs
 * with `bTest=0`, `bIgnorePawns=0`, `bIgnoreBases=1`, `bNoFail=0`.
 *
 * `bTest` moves skip this section entirely (`0x103998ae`), so the test-move
 * translation never calls this function.
 *
 * Arithmetic contract: every vector component below is one x87
 * load/operation/store round-trip to float32, exactly as the recovered body
 * stores it; yaw differences are unmasked int32 wraps except the reduced
 * rotation's `& 0xfffc` masking.
 */
import {rotatorSin} from './coords.mjs';
import {x87load, x87add, x87neg, x87mul, x87store} from './script-vm.mjs';
import {baseEpoch, riderEpochOf} from './base-epoch.mjs';
import {existingHandle} from './script-object-handles.mjs';
import {scriptVmKernel} from './script-vm-kernel.mjs';
import {BASE_KEY} from './actor-link-fields.mjs';

const ld = x87load;
const st = x87store;
const sub = (a, b) => x87add(a, x87neg(b));
const sub32 = (a, b) => st(sub(ld(a), ld(b)));
const add32 = (a, b) => st(x87add(ld(a), ld(b)));

/** The `(a+b)+c` x87 grouping of the inline row-form transform
 * (0x103999d0): `t_i = (v.x*A_i.x + v.y*A_i.y) + v.z*A_i.z`. */
const dot3 = (t, r) => st(x87add(
  x87add(x87mul(t[0], ld(r[0])), x87mul(t[1], ld(r[1]))),
  x87mul(t[2], ld(r[2]))));

/**
 * `FCoords::operator*=(FRotator)` (`0x1011ac80`) applied to `GMath.UnitCoords`
 * for the yaw-only reduced rotation `{0, reducedYaw, 0}` the caller builds at
 * `0x10399930`.  The original applies the yaw pass first using the Core
 * 16384-entry sine table (index `(angle >> 2) & 0x3fff`, cosine at
 * `angle + 0x4000`) with temp axes `X=(cos,sin,0)`, `Y=(-sin,cos,0)`,
 * `Z=(0,0,1)`, transforming Origin via TransformPointBy and each axis via
 * TransformVectorBy; the pitch and roll passes then multiply by exact
 * identity matrices (`sin 0 = 0`, `cos 0 = table[0x1000] = 1.0f`) and leave
 * the result unchanged, so they are not reproduced.  A nonzero pitch/roll is
 * therefore outside this slice and stays an explicit error.
 * Returns the four stored fields `[Origin, XAxis, YAxis, ZAxis]`.
 */
function unitCoordsTimesYaw(pitch, yaw, roll) {
  if ((pitch | 0) !== 0 || (roll | 0) !== 0)
    throw new Error('FCoords::operator*= pitch/roll passes are not implemented');
  const s = rotatorSin(yaw), c = rotatorSin((yaw + 0x4000) | 0);
  const axes = [[0, 0, 0], [c, s, 0], [-s, c, 0], [0, 0, 1]];
  // UnitCoords: origin (0,0,0), X (1,0,0), Y (0,1,0), Z (0,0,1).  Field 0 is
  // TransformPointBy: subtract the matrix origin (zero) before the dots.
  return [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v, i) => {
    const t = i === 0 ? v.map((x, j) => sub(ld(x), ld(axes[0][j]))) : v.map(ld);
    return [dot3(t, axes[1]), dot3(t, axes[2]), dot3(t, axes[3])];
  });
}

/** A rider's RotMotion (BigInt reference of callers.rs rider_rot_motion). */
export function riderRotMotionReference(actorPos, otherPos, reducedYaw) {
  // 0x10399939: v = Actor->Location - Other->Location, f32 stores.
  const v = [sub32(actorPos[0], otherPos[0]), sub32(actorPos[1], otherPos[1]), sub32(actorPos[2], otherPos[2])];
  // 0x10399978-0x1039999a: coords = UnitCoords *= ReducedRotation.
  const coords = unitCoordsTimesYaw(0, reducedYaw, 0);
  // 0x103999d0: t = v.TransformVectorBy(coords).
  const t = [dot3(v.map(ld), coords[1]), dot3(v.map(ld), coords[2]), dot3(v.map(ld), coords[3])];
  // 0x10399a27: RotMotion = v - t, per-component f32 stores.
  return [sub32(v[0], t[0]), sub32(v[1], t[1]), sub32(v[2], t[2])];
}
/** A rider's delta (BigInt reference of callers.rs rider_delta): FinalDelta + RotMotion, three f32 adds. */
export const riderDeltaReference = (finalDelta, rotMotion) =>
  [add32(finalDelta[0], rotMotion[0]), add32(finalDelta[1], rotMotion[1]), add32(finalDelta[2], rotMotion[2])];

/**
 * Run the rider pass for one MoveActor whose StandingCount is nonzero.
 *
 * `actor` is the mover's identity as stored in each rider's `Base`
 * (the pawn's host identity, not a view).
 * `finalDelta`/`newRotation` are the committed move results.
 * `services`:
 *   actors                 live `Level.Actors` array, scanned by index
 *   baseOf(other)          `Other->Base` (+0xc4)
 *   location(other)        f32 `[x,y,z]` at +0x114
 *   rotation(other)        `[pitch,yaw,roll]` ints at +0x120
 *   isPawn(other)          `Other`'s class chain reaches APawn
 *   addViewRotationYaw(other, dyaw)   `Pawn.ViewRotation.Yaw += dyaw`
 *   moveActor(other, delta, rotation) recursive `Level->MoveActor` (vtable +0x88)
 *   actorLocation()        mover `Location` (+0x114..+0x11c)
 *   actorRotation()        mover `Rotation` (+0x120..+0x128)
 */
// Rider lists from full scans, per scan flavour (services.riderCacheKey,
// whose baseOf reads Base the same way each time) and mover. An entry is
// reused only while baseEpoch() and the mover's own Base-change count
// (riderEpochOf, base-epoch.mjs) equal the values recorded when the full
// scan that produced it started and finished without a change. A Base
// write elsewhere in the level does not touch this mover's list.
const riderCaches = new Map();
// Host development switches (Node only): RIDER_VERIFY=1 compares every cached
// list with a full scan; RIDER_NOCACHE=1 always scans.
const verifyRiders = typeof process !== 'undefined' && process.env?.RIDER_VERIFY === '1';
const disableRiderCache = typeof process !== 'undefined' && process.env?.RIDER_NOCACHE === '1';
// RIDER_STATS=1 (Node): counts calls, cache hits, resumed and full scans,
// actors read and riders visited, printed at exit.
const riderStats = typeof process !== 'undefined' && process.env?.RIDER_STATS === '1'
  ? {calls: 0, hits: 0, resumed: 0, scans: 0, scansEpoch: 0, scansRider: 0, scanned: 0, visited: 0, epochBumpsSeen: 0, lastEpoch: -1, scanMs: 0, visitMs: 0, rotMs: 0} : null;
const now = riderStats ? () => Number(process.hrtime.bigint()) / 1e6 : null;
if (riderStats) process.on('exit', () => process.stderr.write(`rider stats: ${JSON.stringify(riderStats)}\n`));

/** The rider indices a full scan of `actors` would visit now, read-only. */
function scanRiders(actor, actors, baseOf) {
  const riders = [];
  for (let i = 0; i < actors.length; i++) {
    const other = actors[i];
    if (other && baseOf(other) === actor) riders.push(i);
  }
  return riders;
}

// The full scan's Base reads, straight from the object image (docs/first-frames.md "Riders"): `baseOf(other)` was a chain of
// host accessor, link state, released check, cell read and handle lookup for each of the level's ~2,500 actors, and an actor's
// first move scans them all (45 movers, 112,000 reads, about 35 ms in the Island's first tick). A slot that qualifies
// (services.baseInstance(other): `other.base` is a plain read of one image cell) is compared as the cell's handle word with the
// mover's handle: the identity a handle names is the one object that has it, so the word equals the mover's handle exactly when
// the read would give the mover. Every other slot takes the reads it took. A slot is filled for the actor in it (checked at each
// read) and the table is dropped when baseEpoch() changes: a Base binding, an installer, any move of the array, and each point
// where an instance gets poison or is released (copyStorage, poisonField and the freeObject sites bump it), the two states in
// which a read of the cell would not be the plain read.
const baseTables = new WeakMap();
const disableDirectBase = typeof process !== 'undefined' && process.env?.RIDER_NODIRECT === '1';
function baseTableFor(actors) {
  let table = baseTables.get(actors);
  if (table === undefined) baseTables.set(actors, table = {epoch: -1, arena: null, hosts: [], ats: []});
  const epoch = baseEpoch();
  if (table.epoch !== epoch) { table.epoch = epoch; table.hosts.length = 0; table.ats.length = 0; }
  return table;
}
/** Fill slot `i` for the actor in it: the arena address of its Base word, or 0 for a slot that takes the plain reads. */
function fillSlot(table, i, other, services) {
  const instance = services.baseInstance(other);
  table.hosts[i] = other;
  if (instance === null || instance.imageToken?.released === true || instance.nativeObject?.released === true) { table.ats[i] = 0; return; }
  table.arena ??= instance.arena;
  table.ats[i] = instance.arena === table.arena ? instance.base + instance.cells.get(BASE_KEY).offset : 0;
}

/** The first index at or after `from` (the actors' length when there is none) whose slot is filled for its actor and either reads a Base
 * word equal to `handle` or takes the plain reads; null slots and slots whose Base word differs are passed. A function of its own, small
 * and hot, so it is compiled early and runs at the speed of the loop. `handle` is -1 when no image can name the mover. */
function nextCandidate(hosts, ats, actors, from, handle, view) {
  const length = actors.length;
  for (let i = from; i < length; i++) {
    const other = actors[i];
    if (!other) continue;
    if (hosts[i] !== other) return i;
    const at = ats[i];
    if (at === 0 || view.getUint32(at, true) === handle) return i;
  }
  return length;
}

const entryCurrent = (entry, actor) => entry.epoch === baseEpoch() && entry.riderEpoch === riderEpochOf(actor);
const NO_MOTION = [0, 0, 0];

/** The rider pass's visit of one rider (0x10399a27-0x10399b57), with the pass's inputs. */
function visitRider(pass, other) {
  const t0 = riderStats ? now() : 0;
  const { services, finalDelta, actorPos, dyaw, rotationChanged, reducedYaw } = pass;
  const { location, rotation, isPawn, addViewRotationYaw, moveActor } = services;
  const kernel = scriptVmKernel?.riders;
  // The Rust core's callers.rs does the arithmetic once the script VM kernel is loaded (docs/live-heap.md "Cut: x87 math in
  // Rust"); the BigInt expressions are the reference it is compared with (scripts/validate-x87-callers-kernel.mjs).
  let rotMotion = NO_MOTION;
  if (rotationChanged) {
    const otherPos = location(other);
    rotMotion = kernel ? kernel.rotMotion(actorPos, otherPos, reducedYaw) : riderRotMotionReference(actorPos, otherPos, reducedYaw);
    if (riderStats) riderStats.rotMs += now() - t0;
  }
  const otherRot = rotation(other);
  // 0x10399ad1: delta = FinalDelta + RotMotion, three f32 adds.
  const delta = kernel ? kernel.delta(finalDelta, rotMotion) : riderDeltaReference(finalDelta, rotMotion);
  // 0x10399aa4: rot = FRotator(Other.Pitch, Other.Yaw + [ebp+0x2c], Other.Roll).
  const newRot = [otherRot[0] | 0, ((otherRot[1] | 0) + dyaw) | 0, otherRot[2] | 0];
  // 0x10399b51: MoveActor(Other, delta, rot, Hit, 0, 0, 1, 0).
  moveActor(other, delta, newRot);
  // 0x10399b57: pawn riders keep their ViewRotation aligned with the yaw.
  if (isPawn(other)) addViewRotationYaw(other, dyaw);
  if (riderStats) riderStats.visitMs += now() - t0;
}

export function moveActorRiders(actor, finalDelta, newRotation, services) {
  const {actors, baseOf, moveActor, actorLocation, actorRotation} = services;
  if (typeof moveActor !== 'function')
    throw new Error('MoveActor based passengers require the recovered rider MoveActor service');
  if (riderStats) { riderStats.calls++; const e = baseEpoch(); if (e !== riderStats.lastEpoch) { riderStats.epochBumpsSeen++; riderStats.lastEpoch = e; } }
  const actorPos = actorLocation();
  const actorRotValue = actorRotation();
  const actorRot0 = actorRotValue[0] | 0, actorRot1 = actorRotValue[1] | 0, actorRot2 = actorRotValue[2] | 0;
  const rot0 = newRotation[0] | 0, rot1 = newRotation[1] | 0, rot2 = newRotation[2] | 0;
  // [ebp+0x2c]: unmasked int32 yaw difference (overwrites bIgnorePawns).
  const dyaw = (rot1 - actorRot1) | 0;
  // 0x10399904: all three ints equal skips the rotation-math block.
  const rotationChanged = rot0 !== actorRot0 || rot1 !== actorRot1 || rot2 !== actorRot2;
  // 0x10399930: the reduced rotation keeps only the &0xfffc-masked yaw.
  const reducedYaw = ((rot1 & 0xfffc) - (actorRot1 & 0xfffc)) | 0;
  // The Rust core's callers.rs does the arithmetic once the script VM kernel is loaded (docs/live-heap.md "Cut: x87 math in
  // Rust"); the BigInt expressions are the reference it is compared with (scripts/validate-x87-callers-kernel.mjs).
  // (the pass's inputs in one object for visitRider, and the entry test a function of its own: closures here would make a context
  // object at every call, whichever path the call takes)
  const pass = {services, finalDelta, actorPos, dyaw, rotationChanged, reducedYaw};
  // The original loop (0x103998a0..): every Level.Actors index in order, each
  // Base read at that point. A cached list replaces the reads only while no
  // array change, and no Base change to or from this mover, can have
  // happened; after one (a rider's move may run events) the loop continues
  // by reading, from the next index.
  const cacheKey = disableRiderCache ? undefined : services.riderCacheKey;
  let byMover = null, start = 0;
  if (cacheKey !== undefined) {
    byMover = riderCaches.get(cacheKey);
    if (!byMover) riderCaches.set(cacheKey, byMover = new WeakMap());
    const entry = byMover.get(actor);
    if (riderStats && entry && !entryCurrent(entry, actor)) { if (entry.epoch !== baseEpoch()) riderStats.scansEpoch++; else riderStats.scansRider++; }
    if (entry && entryCurrent(entry, actor) && entry.actors === actors) {
      if (verifyRiders) {
        const expected = scanRiders(actor, actors, baseOf);
        if (expected.join() !== entry.riders.join()) {
          const verify = globalThis.__riderVerify ??= {mismatches: 0, first: []};
          verify.mismatches++;
          if (verify.first.length < 5) verify.first.push(`${actor?.name} [${cacheKey}] cached ${entry.riders} expected ${expected} ` +
            `(${expected.map(i => actors[i]?.name).join()} vs ${entry.riders.map(i => actors[i]?.name).join()})`);
        }
      }
      let last = -1;
      if (riderStats) riderStats.hits++;
      for (let k = 0; k < entry.riders.length; k++) {
        const index = entry.riders[k];
        if (!entryCurrent(entry, actor)) break;
        last = index;
        // A slot DestroyActor nulled since the scan: skipped, as the scan
        // skips it (its Base changes were counted when they happened).
        const other = actors[index];
        if (!other) continue;
        if (riderStats) riderStats.visited++;
        visitRider(pass, other);
      }
      if (entryCurrent(entry, actor)) return;
      if (riderStats) riderStats.resumed++;
      // A visited rider's move changed a Base or the array: resume the
      // original reads after the last visited index.
      start = last + 1;
    }
  }
  const epoch = baseEpoch(), riderEpoch = riderEpochOf(actor), found = [];
  if (riderStats) { riderStats.scans++; riderStats.scanned += actors.length - start; }
  const tScan = riderStats ? now() : 0;
  // The table of direct Base reads, while the scan is undisturbed (it is left for the plain reads once the epoch changes).
  let table = typeof services.baseInstance === 'function' && !disableDirectBase ? baseTableFor(actors) : null;
  let handle = table === null ? 0 : existingHandle(actor);
  let view = table?.arena?.view;
  for (let i = start; i < actors.length; i++) {
    // The table's tight loop runs to the next slot that is a rider by its Base word or that it cannot decide (not filled for the actor in
    // it, or one that takes the plain reads); the rest of the body is that slot's.
    if (table !== null && view !== undefined) { i = nextCandidate(table.hosts, table.ats, actors, i, handle === 0 ? -1 : handle, view); if (i >= actors.length) break; }
    const other = actors[i];
    if (!other) continue;
    let based;
    if (table !== null) {
      if (table.hosts[i] !== other) { fillSlot(table, i, other, services); view = table.arena?.view; }
      const at = table.ats[i];
      based = at !== 0 ? handle !== 0 && view.getUint32(at, true) === handle : baseOf(other) === actor;
    } else based = baseOf(other) === actor;
    if (!based) continue;
    found.push(i);
    if (riderStats) { riderStats.visited++; riderStats.scanMs += now() - tScan; }
    visitRider(pass, other);
    if (table !== null) {
      // (a rider's move runs events: the mover may have been given a handle, or lost it, by a pointer stored since, and the arena
      // may have grown)
      if (table.epoch !== baseEpoch()) table = null;
      else { handle = existingHandle(actor); view = table.arena?.view; }
    }
    if (riderStats) riderStats.scanMs -= now() - tScan;
  }
  if (riderStats) riderStats.scanMs += now() - tScan;
  // Record a complete, undisturbed scan only.
  if (byMover && start === 0 && epoch === baseEpoch() && riderEpoch === riderEpochOf(actor)) {
    if (verifyRiders) {
      // (the plain reads' list for the same state)
      const expected = scanRiders(actor, actors, baseOf);
      if (expected.join() !== found.join()) {
        const verify = globalThis.__riderVerify ??= {mismatches: 0, first: []};
        verify.mismatches++;
        if (verify.first.length < 5) verify.first.push(`${actor?.name} [${cacheKey}] direct ${found} plain ${expected}`);
      }
    }
    byMover.set(actor, {epoch, riderEpoch, actors, riders: found});
  }
}
