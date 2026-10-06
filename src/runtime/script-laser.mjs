// DeusEx LaserIterator beams (docs/lasers.md): ULaserIterator::CurrentItem
// (DeusEx.dll 0x1001a1a0), and the render-iterator protocol that draws a
// LaserEmitter's beam as LaserProxy segments. CurrentItem runs from
// SetupDynamics, inside the render pass, so it and Core's UnsafeNormal and
// FVector::Rotation run at x87 precision control 24
// (docs/render-pass-precision.md): the x87 model here rounds every result to
// 24 bits (x87-pc24.mjs), the double constants included.
import { rotatorToVector } from './script-decoration-primitives.mjs';
import { setScriptRotation } from './script-set-rotation.mjs';
import { x87load, x87double, x87int32, x87neg, x87store, x87storeDouble, x87cmp } from './script-vm.mjs';
import { p24add as x87add, p24mul as x87mul, p24div as x87div, p24sqrt as x87sqrt, r24prod } from './x87-pc24.mjs';

const ld = x87load, st = x87store, sub = (a, b) => x87add(a, x87neg(b));
const ONE = x87double(1), ZERO = x87double(0);
const BEAMS = 8;

// FVector::UnsafeNormal (Core 0x10117dd0): (x*x + y*y) + z*z in 80 bits,
// FSTP to a double, appSqrt's FSQRT, FDIVR by the double 1.0, and each
// component times that unrounded scale stored to float32.
function unsafeNormal([x, y, z]) {
  const X = ld(x), Y = ld(y), Z = ld(z);
  const sum = x87storeDouble(x87add(x87add(x87mul(X, X), x87mul(Y, Y)), x87mul(Z, Z)));
  const scale = x87div(ONE, x87sqrt(sum));
  return [st(x87mul(scale, X)), st(x87mul(scale, Y)), st(x87mul(scale, Z))];
}

const lessOrUnordered = c => c === 'lt' || c === 'un';

/** Core FVector::Rotation (0x10144390) at 24 bits: yaw `ftol(atan2(y, x)·K)`,
 * pitch `ftol(atan2(z, √(y² + x²))·K)` with K the embedded double
 * 10430.219195527361 (0x10178050), the sum and appSqrt's FSQRT at 24 bits and
 * each product rounded once from the exact value. FPATAN (unaffected by
 * precision control) is the host's Math.atan2, as in
 * script-decoration-primitives.mjs vectorToRotator. */
function vectorToRotator24(vector) {
  const [x, y, z] = vector.map(Math.fround), K = 10430.219195527361;
  if (![x, y, z].every(Number.isFinite)) throw new Error('Original nonfinite vector rotation is not implemented');
  const root = st(x87sqrt(x87add(x87mul(ld(y), ld(y)), x87mul(ld(x), ld(x)))));
  return [Math.trunc(r24prod(Math.atan2(z, root), K)) | 0, Math.trunc(r24prod(Math.atan2(y, x), K)) | 0, 0];
}

/** ULaserIterator::CurrentItem on a plain iterator state (mutated in place):
 * {beams: 8 × {active, location, rotation, length, numSegments}, index,
 * maxItems, prevLoc, prevRand, savedLoc, savedRot, nextItem, randomBeam,
 * hasProxy}. `ownerLocation` is the Outer's Location; `frand` is appFrand.
 * Returns the proxy moves in call order — {location} for XLevel FarMoveActor
 * (+0x8c, test 0, noCheck 0) and {rotation} for MoveActor (+0x88, zero
 * Delta and flags) — or null without a proxy, where the base
 * URenderIterator::CurrentItem returns Outer. */
export function laserCurrentItem(state, ownerLocation, frand) {
  if (!state.hasProxy) return null;
  // The beam holding Index: active beams accumulate numSegments (int32).
  // Past the last one (the "render the last one" item) it is beam 0 with the
  // whole total.
  let beam = 0, cumulative = 0;
  for (let i = 0; i < BEAMS; i++) {
    if (!state.beams[i].active) continue;
    cumulative = (cumulative + state.beams[i].numSegments) | 0;
    if (state.index < cumulative) { beam = i; break; }
  }
  const b = state.beams[beam];
  // 1 - (cumulative - Index)/numSegments, clamped to [0, 1] by FCOM against
  // the doubles 0.0 (below or unordered) and 1.0, stored to float32.
  let alpha = sub(ONE, x87div(x87int32((cumulative - state.index) | 0), x87int32(b.numSegments)));
  if (lessOrUnordered(x87cmp(alpha, ZERO))) alpha = ZERO;
  else if (!lessOrUnordered(x87cmp(alpha, ONE))) alpha = ONE;
  const a = ld(st(alpha));
  // XAxis of GMath.UnitCoords / Rotation (FRotator::Vector), times Length:
  // Z and Y end points store to float32, X stays on the stack.
  const axis = rotatorToVector(b.rotation), len = ld(b.length);
  const [lx, ly, lz] = b.location.map(ld);
  const zEnd = st(x87add(ld(st(x87mul(ld(axis[2]), len))), lz));
  const yEnd = st(x87add(ld(st(x87mul(ld(axis[1]), len))), ly));
  let x = st(x87add(x87mul(sub(x87add(x87mul(len, ld(axis[0])), lx), lx), a), lx));
  let y = st(x87add(x87mul(sub(ld(yEnd), ly), a), ly));
  let z = st(x87add(x87mul(sub(ld(zEnd), lz), a), lz));
  let rotation = b.rotation.map(v => v | 0);
  if (state.randomBeam) {
    // Rejection-sample (2·appFrand − 1)³ inside the unit sphere; the Z
    // square multiplies the unrounded value by its float32 store.
    let r;
    for (;;) {
      const component = () => { const v = x87double(frand()); return sub(x87add(v, v), ONE); };
      const rx = st(component()), ry = st(component()), zx = component(), rz = st(zx);
      const lengthSq = x87add(x87add(x87mul(zx, ld(rz)), x87mul(ld(ry), ld(ry))), x87mul(ld(rx), ld(rx)));
      r = [rx, ry, rz];
      if (x87cmp(lengthSq, ONE) !== 'gt') break;
    }
    const n = unsafeNormal(r), [pr, pl] = [state.prevRand, state.prevLoc];
    const jitter = i => x87add(ld(n[i]), ld(pr[i]));
    const jx = jitter(0), jy = jitter(1), jz = jitter(2);
    x = st(x87add(jx, ld(x)));
    y = st(x87add(jy, ld(y)));
    const zExt = x87add(jz, ld(z));
    z = st(zExt);
    // The new prevLoc is 2·pos − prevLoc (Z from the unrounded sum); the
    // segment faces from it back to the old prevLoc.
    const dz = sub(zExt, ld(pl[2]));
    const dy = st(sub(ld(y), ld(pl[1]))), dx = st(sub(ld(x), ld(pl[0])));
    const nzExt = x87add(dz, ld(z)), ny = st(x87add(ld(dy), ld(y))), nx = st(x87add(ld(dx), ld(x)));
    const nz = st(nzExt);
    rotation = vectorToRotator24([st(sub(ld(pl[0]), ld(nx))), st(sub(ld(pl[1]), ld(ny))), st(sub(ld(pl[2]), nzExt))]);
    state.prevLoc = [nx, ny, nz];
    state.prevRand = n;
  }
  const moves = [{ location: [x, y, z] }, { rotation }];
  // While savedLoc is still the Outer's Location (FCOMP C3: equal or
  // unordered), take this item with probability nextItem/MaxItems against a
  // float32 appFrand.
  if (state.savedLoc.every((v, i) => { const c = x87cmp(ld(v), ld(ownerLocation[i])); return c === 'eq' || c === 'un'; })) {
    // FCOMP then `test ah,0x41`: below, equal or unordered keeps savedLoc.
    const r = ld(Math.fround(frand()));
    if (x87cmp(x87div(x87int32(state.nextItem), x87int32(state.maxItems)), r) === 'gt') {
      state.savedLoc = [x, y, z];
      state.savedRot = rotation.slice();
    }
  }
  state.nextItem = (state.nextItem + 1) | 0;
  // The last item leaves the proxy at the saved point.
  if (state.nextItem === state.maxItems) moves.push({ location: state.savedLoc.slice() }, { rotation: state.savedRot.slice() });
  return moves;
}

const BEAM = name => `deusex.laseriterator.sbeam.${name}`;

function readLaserState(runtime, iterator, proxy) {
  const read = name => runtime.readNamed(iterator, name);
  return {
    beams: read('Beams').map(b => ({ active: Boolean(b[BEAM('bactive')]), location: [...b[BEAM('location')]].map(Math.fround),
      rotation: [...b[BEAM('rotation')]].map(v => v | 0), length: Math.fround(b[BEAM('length')]), numSegments: b[BEAM('numsegments')] | 0 })),
    index: read('Index') | 0, maxItems: read('MaxItems') | 0,
    prevLoc: [...read('prevLoc')].map(Math.fround), prevRand: [...read('prevRand')].map(Math.fround),
    savedLoc: [...read('savedLoc')].map(Math.fround), savedRot: [...read('savedRot')].map(v => v | 0),
    nextItem: read('nextItem') | 0, randomBeam: Boolean(read('bRandomBeam')), hasProxy: Boolean(proxy),
  };
}

function writeLaserState(runtime, iterator, state) {
  for (const name of ['prevLoc', 'prevRand', 'savedLoc', 'savedRot', 'nextItem']) runtime.writeNamed(iterator, name, state[name]);
}

/** One frame of the render-iterator protocol for a LaserIterator
 * (SetupDynamics 0x10b22fee-0x10b2307c): Init(Camera) runs the script Init
 * and stores Observer, Index runs from 0 while below MaxItems, and each
 * CurrentItem moves the proxy. SetupSprite (0x10b23910) then snapshots the
 * item's ScaleGlow, DrawScale, Location and Rotation for the deferred draw
 * (DrawActorSprite reads FDynamicSprite +0xbc..+0xd8, not the actor), so
 * every segment draws where CurrentItem put it. Returns those snapshots. */
export function laserIteratorItems(runtime, iterator, owner, camera, { processEvent, frand }) {
  processEvent(iterator, 'Init', [camera]);
  runtime.writeNamed(iterator, 'Observer', camera);
  const max = runtime.readNamed(iterator, 'MaxItems') | 0, proxy = runtime.readNamed(iterator, 'proxy');
  const read = (actor, name) => runtime.readNamed(actor, name);
  const snapshot = actor => ({ actor, location: read(actor, 'Location').map(Math.fround), rotation: read(actor, 'Rotation').map(v => v | 0),
    drawScale: Math.fround(read(actor, 'DrawScale')), scaleGlow: Math.fround(read(actor, 'ScaleGlow')) });
  const items = [];
  const state = readLaserState(runtime, iterator, proxy);
  for (let index = 0; index < max; index++) {
    runtime.writeNamed(iterator, 'Index', index);
    state.index = index;
    const moves = laserCurrentItem(state, read(owner, 'Location').map(Math.fround), frand);
    if (!moves) { items.push(snapshot(owner)); continue; }
    for (const move of moves) {
      if (move.location) runtime.farMoveActor(proxy, move.location, 0, 0);
      else setScriptRotation(proxy, move.rotation, { levelFor: runtime.levelFor, read, write: (a, n, v) => runtime.writeNamed(a, n, v) });
    }
    writeLaserState(runtime, iterator, state);
    items.push(snapshot(proxy));
  }
  runtime.writeNamed(iterator, 'Index', max);
  return items;
}
