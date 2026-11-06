// DeusEx LaserIterator beams (docs/lasers.md): ULaserIterator::CurrentItem
// (DeusEx.dll 0x1001a1a0), and the render-iterator protocol that draws a
// LaserEmitter's beam as LaserProxy segments. CurrentItem runs from
// SetupDynamics, inside the render pass, so it and Core's UnsafeNormal and
// FVector::Rotation run at x87 precision control 24
// (docs/render-pass-precision.md): the x87 model here rounds every result to
// 24 bits (x87-pc24.mjs), the double constants included.
import { rotatorToVector, vectorToRotator24 } from './script-decoration-primitives.mjs';
import { setScriptRotation } from './script-set-rotation.mjs';
import { inRenderPass } from './render-precision.mjs';
import { x87load, x87double, x87int32, x87neg, x87store, x87storeDouble, x87cmp } from './script-vm.mjs';
import { p24add as x87add, p24mul as x87mul, p24div as x87div, p24sqrt as x87sqrt, r24prod } from './x87-pc24.mjs';
import { scriptVmKernel } from './script-vm-kernel.mjs';
import { laserMode } from './laser-kernel.mjs';

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
// (the beam keys made once: a template string for each of five fields of each beam of each iterator each frame)
const BEAM_ACTIVE = BEAM('bactive'), BEAM_LOCATION = BEAM('location'), BEAM_ROTATION = BEAM('rotation'), BEAM_LENGTH = BEAM('length'),
  BEAM_NUMSEGMENTS = BEAM('numsegments');
const float3 = v => [Math.fround(v[0]), Math.fround(v[1]), Math.fround(v[2])];
const int3 = v => [v[0] | 0, v[1] | 0, v[2] | 0];

function readLaserState(runtime, iterator, proxy) {
  const raw = runtime.readNamed(iterator, 'Beams'), beams = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    beams[i] = { active: Boolean(b[BEAM_ACTIVE]), location: float3(b[BEAM_LOCATION]), rotation: int3(b[BEAM_ROTATION]),
      length: Math.fround(b[BEAM_LENGTH]), numSegments: b[BEAM_NUMSEGMENTS] | 0 };
  }
  return {
    beams,
    index: runtime.readNamed(iterator, 'Index') | 0, maxItems: runtime.readNamed(iterator, 'MaxItems') | 0,
    prevLoc: float3(runtime.readNamed(iterator, 'prevLoc')), prevRand: float3(runtime.readNamed(iterator, 'prevRand')),
    savedLoc: float3(runtime.readNamed(iterator, 'savedLoc')), savedRot: int3(runtime.readNamed(iterator, 'savedRot')),
    nextItem: runtime.readNamed(iterator, 'nextItem') | 0, randomBeam: Boolean(runtime.readNamed(iterator, 'bRandomBeam')), hasProxy: Boolean(proxy),
  };
}

/** CurrentItem in Rust (laser.rs, laser-kernel.mjs) once the kernel is loaded, else laserCurrentItem (LASER=js keeps it). Under
 * LASER=verify the JavaScript body also runs, on a copy of the state with the appFrand values the Rust body drew, and a
 * difference in the moves, the state or the draws throws. */
function currentItem(state, ownerLocation, frand) {
  const mode = laserMode(), kernel = mode === 'js' ? null : scriptVmKernel?.laser;
  if (!kernel) return laserCurrentItem(state, ownerLocation, frand);
  if (mode !== 'verify') return kernel.currentItem(state, ownerLocation, frand);
  const copy = { ...state, prevLoc: state.prevLoc.slice(), prevRand: state.prevRand.slice(), savedLoc: state.savedLoc.slice(),
    savedRot: state.savedRot.slice() }, draws = [];
  const moves = kernel.currentItem(state, ownerLocation, () => { const v = frand(); draws.push(v); return v; });
  let extra = 0;
  const want = laserCurrentItem(copy, ownerLocation, () => draws.length ? draws.shift() : (extra++, 0));
  const same = (a, b) => Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]))
    : a && typeof a === 'object' ? Boolean(b) && Object.keys(a).every(key => same(a[key], b[key])) : Object.is(a, b);
  for (const key of ['prevLoc', 'prevRand', 'savedLoc', 'savedRot', 'nextItem'])
    if (!same(state[key], copy[key])) throw new Error(`LASER=verify: CurrentItem's ${key} differs in Rust`);
  if (!same(moves, want) || draws.length || extra) throw new Error('LASER=verify: CurrentItem\'s moves or appFrand draws differ in Rust');
  return moves;
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
  // SetupDynamics runs Init(Camera) inside the render pass (render-precision.mjs).
  initIterator(runtime, iterator, camera, processEvent);
  runtime.writeNamed(iterator, 'Observer', camera);
  const max = runtime.readNamed(iterator, 'MaxItems') | 0, proxy = runtime.readNamed(iterator, 'proxy');
  // (no closure in this function: it would make a context object at every call; the helpers below take what they use)
  const items = [];
  const state = readLaserState(runtime, iterator, proxy);
  for (let index = 0; index < max; index++) {
    runtime.writeNamed(iterator, 'Index', index);
    state.index = index;
    const moves = currentItem(state, floatLocation(runtime, owner), frand);
    if (!moves) { items.push(snapshotOf(runtime, owner)); continue; }
    for (let m = 0; m < moves.length; m++) {
      const move = moves[m];
      if (move.location) runtime.farMoveActor(proxy, move.location, 0, 0);
      else setScriptRotation(proxy, move.rotation, rotationServices(runtime));
    }
    writeLaserState(runtime, iterator, state);
    items.push(snapshotOf(runtime, proxy));
  }
  runtime.writeNamed(iterator, 'Index', max);
  return items;
}
function initIterator(runtime, iterator, camera, processEvent) {
  inRenderPass(runtime, () => processEvent(iterator, 'Init', [camera]));
}
function floatLocation(runtime, actor) {
  const location = runtime.readNamed(actor, 'Location');
  return [Math.fround(location[0]), Math.fround(location[1]), Math.fround(location[2])];
}
/** What FDynamicSprite::Setup (0x10b23910) copies from `actor` into its sprite: ScaleGlow, DrawScale, Location and Rotation, as a
 * laser item's snapshot. A LaserProxy is drawn twice by SetupDynamics, as its iterator's items (above) and as the level actor it is, whose
 * sprite takes the fields as the iterator's last CurrentItem left them. */
export function laserProxySnapshot(runtime, actor) { return snapshotOf(runtime, actor); }
// An item's snapshot: SetupSprite's ScaleGlow, DrawScale, Location and Rotation (above).
function snapshotOf(runtime, actor) {
  const rotation = runtime.readNamed(actor, 'Rotation');
  return { actor, location: floatLocation(runtime, actor), rotation: [rotation[0] | 0, rotation[1] | 0, rotation[2] | 0],
    drawScale: Math.fround(runtime.readNamed(actor, 'DrawScale')), scaleGlow: Math.fround(runtime.readNamed(actor, 'ScaleGlow')) };
}
// setScriptRotation's services for a runtime, made once.
const rotationServicesOf = new WeakMap();
function rotationServices(runtime) {
  let services = rotationServicesOf.get(runtime);
  if (services === undefined || services.levelFor !== runtime.levelFor) rotationServicesOf.set(runtime, services = { levelFor: runtime.levelFor,
    read: (actor, name) => runtime.readNamed(actor, name), write: (actor, name, value) => runtime.writeNamed(actor, name, value) });
  return services;
}
