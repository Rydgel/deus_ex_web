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
import {baseEpoch} from './base-epoch.mjs';

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
// reused only while baseEpoch() equals the value recorded when the full scan
// that produced it started and finished without a bump (base-epoch.mjs).
const riderCaches = new Map();
// Host development switches (Node only): RIDER_VERIFY=1 compares every cached
// list with a full scan; RIDER_NOCACHE=1 always scans.
const verifyRiders = typeof process !== 'undefined' && process.env?.RIDER_VERIFY === '1';
const disableRiderCache = typeof process !== 'undefined' && process.env?.RIDER_NOCACHE === '1';

/** The rider indices a full scan of `actors` would visit now, read-only. */
function scanRiders(actor, actors, baseOf) {
  const riders = [];
  for (let i = 0; i < actors.length; i++) {
    const other = actors[i];
    if (other && baseOf(other) === actor) riders.push(i);
  }
  return riders;
}

export function moveActorRiders(actor, finalDelta, newRotation, services) {
  const {actors, baseOf, location, rotation, isPawn, addViewRotationYaw,
    moveActor, actorLocation, actorRotation} = services;
  if (typeof moveActor !== 'function')
    throw new Error('MoveActor based passengers require the recovered rider MoveActor service');
  const actorPos = actorLocation();
  const actorRot = actorRotation().map(v => v | 0);
  const rot = newRotation.map(v => v | 0);
  // [ebp+0x2c]: unmasked int32 yaw difference (overwrites bIgnorePawns).
  const dyaw = (rot[1] - actorRot[1]) | 0;
  // 0x10399904: all three ints equal skips the rotation-math block.
  const rotationChanged = rot[0] !== actorRot[0] || rot[1] !== actorRot[1] || rot[2] !== actorRot[2];
  // 0x10399930: the reduced rotation keeps only the &0xfffc-masked yaw.
  const reducedYaw = ((rot[1] & 0xfffc) - (actorRot[1] & 0xfffc)) | 0;
  const visit = other => {
    let rotMotion = [0, 0, 0];
    if (rotationChanged) {
      // 0x10399939: v = Actor->Location - Other->Location, f32 stores.
      const otherPos = location(other);
      const v = [sub32(actorPos[0], otherPos[0]), sub32(actorPos[1], otherPos[1]),
        sub32(actorPos[2], otherPos[2])];
      // 0x10399978-0x1039999a: coords = UnitCoords *= ReducedRotation.
      const coords = unitCoordsTimesYaw(0, reducedYaw, 0);
      // 0x103999d0: t = v.TransformVectorBy(coords).
      const t = [dot3(v.map(ld), coords[1]), dot3(v.map(ld), coords[2]), dot3(v.map(ld), coords[3])];
      // 0x10399a27: RotMotion = v - t, per-component f32 stores.
      rotMotion = [sub32(v[0], t[0]), sub32(v[1], t[1]), sub32(v[2], t[2])];
    }
    const otherRot = rotation(other).map(vv => vv | 0);
    // 0x10399ad1: delta = FinalDelta + RotMotion, three f32 adds.
    const delta = [add32(finalDelta[0], rotMotion[0]), add32(finalDelta[1], rotMotion[1]),
      add32(finalDelta[2], rotMotion[2])];
    // 0x10399aa4: rot = FRotator(Other.Pitch, Other.Yaw + [ebp+0x2c], Other.Roll).
    const newRot = [otherRot[0], (otherRot[1] + dyaw) | 0, otherRot[2]];
    // 0x10399b51: MoveActor(Other, delta, rot, Hit, 0, 0, 1, 0).
    moveActor(other, delta, newRot);
    // 0x10399b57: pawn riders keep their ViewRotation aligned with the yaw.
    if (isPawn(other)) addViewRotationYaw(other, dyaw);
  };
  // The original loop (0x103998a0..): every Level.Actors index in order, each
  // Base read at that point. A cached list replaces the reads only while no
  // Base or array change can have happened; after any change (a rider's move
  // may run events) the loop continues by reading, from the next index.
  const cacheKey = disableRiderCache ? undefined : services.riderCacheKey;
  let byMover = null, start = 0;
  if (cacheKey !== undefined) {
    byMover = riderCaches.get(cacheKey);
    if (!byMover) riderCaches.set(cacheKey, byMover = new WeakMap());
    const entry = byMover.get(actor);
    if (entry && entry.epoch === baseEpoch() && entry.actors === actors) {
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
      for (const index of entry.riders) {
        if (entry.epoch !== baseEpoch()) break;
        last = index;
        visit(actors[index]);
      }
      if (entry.epoch === baseEpoch()) return;
      // A visited rider's move changed a Base or the array: resume the
      // original reads after the last visited index.
      start = last + 1;
    }
  }
  const epoch = baseEpoch(), found = [];
  for (let i = start; i < actors.length; i++) {
    const other = actors[i];
    if (!other || baseOf(other) !== actor) continue;
    found.push(i);
    visit(other);
  }
  // Record a complete, undisturbed scan only.
  if (byMover && start === 0 && epoch === baseEpoch()) byMover.set(actor, {epoch, actors, riders: found});
}
