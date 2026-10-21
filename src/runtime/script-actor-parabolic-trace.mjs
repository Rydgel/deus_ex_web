/**
 * Engine.Actor.ParabolicTrace (native 722), the original AActor::execParabolicTrace
 * (Engine.dll 0x1036e190) over its worker 0x1036c0a0. Evidence, constants, branch
 * order and what the oracle covers: docs/parabolic-trace.md.
 *
 * Every float is a float32 WORD (uint32) inside this module and every operation is
 * the x87 model of script-vm.mjs (64-bit significand intermediates, one rounding at
 * each FST/FSTP), so a NaN keeps its payload and no JavaScript double stands in for
 * an extended intermediate. The level is reached through two services only, the same
 * two the worker calls:
 *
 *   pointRegion(positionWords)  UModel::PointRegion(LevelInfo, position) ->
 *                               {zone, leaf, zoneNumber}; zone exposes gravity,
 *                               velocity (word triples), terminalVelocity (word)
 *                               and water (bool)
 *   multiLineCheck(query)       ULevel::MultiLineCheck (vtable +0xc8) -> the hit list
 *                               in time order, each {actor, location, normal, time,
 *                               item, primitive} with word fields
 *
 * plus levelInfo (the identity of the world actor), isOwnedBy(actor, owner)
 * (AActor::IsOwnedBy 0x1034c8d0, the Owner chain at +0xc4) and blocksActors(actor)
 * (bit 2 of the word at actor +0x1dc). Scripts see numbers: execParabolicTrace
 * converts at the boundary.
 */
import {
  f32bits, f32num, x87add, x87cmp, x87div, x87double, x87int32, x87load, x87loadWord, x87mul, x87neg,
  x87quiet, x87recip, x87sqrt, x87storeDouble, x87storeWord, x87below1em8,
} from './script-vm.mjs';

const L = x87loadWord, S = x87storeWord;
const mul = x87mul, add = x87add, sub = (a, b) => x87add(a, x87neg(b));

// Constants of the worker (Engine.dll data), as float32 words or embedded doubles.
const F_ZERO = 0, F_ONE = 0x3f800000, F_TWO = 0x40000000, F_MINUS_ONE = 0xbf800000, F_MINUS_TWO = 0xc0000000;
const F_MIN_GRANULARITY = 0x3ba3d70a;             // 0x1042adcc: 0.005f; also the replacement for a smaller granularity
const F_MAX_STEP_SQUARED = 0x4a189680;            // 0x1042adb4: 2500000.0f
const D_ONE = x87double(1), D_ZERO = x87double(0);       // 0x104298a0, 0x10429838
const D_FLOOR_NORMAL = x87double(0.7);            // 0x1042adc0
const D_MIN_MOVE = x87double(0.0001);             // 0x1042ac40
const ZERO = L(F_ZERO);

// FCOMP/FCOM status tests: C0 is 'lt' or unordered (test ah,1), C0|C3 is anything but 'gt' (test ah,0x41).
const c0 = c => c === 'lt' || c === 'un';
const notGreater = c => c !== 'gt';

/** FVector::SizeSquared (Core 0x10117b70): (x*x + y*y) + z*z on the x87 stack, returned in st0. */
const sizeSquared = v => add(add(mul(L(v[0]), L(v[0])), mul(L(v[1]), L(v[1]))), mul(L(v[2]), L(v[2])));

/** appSqrt (Core 0x10123290: fld qword; fsqrt) of the value stored to a double. */
const appSqrt = v => (v.nan !== undefined ? x87quiet(v) : x87sqrt(x87storeDouble(v)));

/** FVector::SafeNormal (Core 0x10144be0) over float32 words: script-vm.mjs x87safeNormalWords without the
 * conversion of its inputs to numbers. */
function safeNormal(v) {
  const x = L(v[0]), y = L(v[1]), z = L(v[2]);
  const s = add(add(mul(x, x), mul(y, y)), mul(z, z));
  if (s.nan !== undefined || x87below1em8(s)) return [0, 0, 0];
  const r = s.inf ? { neg: 0, sig: 0n, exp: 0 } : x87recip(x87sqrt(x87storeDouble(s)));
  return [S(mul(x, r)), S(mul(y, r)), S(mul(z, r))];
}

/**
 * The twoWallAdjust of Engine.dll 0x10323770 (cdecl args desired, &delta, normal, oldNormal, hitTime, all
 * stack words; thunk 0x10301c8a). Mutates and returns `delta`. Branches: Normal . OldNormal <= 0 (or
 * unordered) slides along the crease, else along the new wall; either may flip or zero the result by the sign of
 * Desired . Delta.
 */
export function twoWallAdjustWords(desired, delta, normal, oldNormal, hitTime) {
  const C = normal, D = oldNormal, B = delta;
  const dot = add(add(mul(L(C[1]), L(D[1])), mul(L(D[2]), L(C[2]))), mul(L(C[0]), L(D[0])));
  if (notGreater(x87cmp(dot, ZERO))) {
    const cross = [
      S(sub(mul(L(C[1]), L(D[2])), mul(L(C[2]), L(D[1])))),
      S(sub(mul(L(D[0]), L(C[2])), mul(L(C[0]), L(D[2])))),
      S(sub(mul(L(C[0]), L(D[1])), mul(L(C[1]), L(D[0])))),
    ];
    const n = safeNormal(cross);
    const along = add(add(mul(L(n[2]), L(B[2])), mul(L(n[1]), L(B[1]))), mul(L(n[0]), L(B[0])));
    const scale = mul(along, sub(D_ONE, L(hitTime)));
    B[0] = S(mul(L(n[0]), scale));
    B[1] = S(mul(L(n[1]), scale));
    B[2] = S(mul(L(n[2]), scale));
    const side = add(add(mul(L(desired[2]), L(B[2])), mul(L(desired[1]), L(B[1]))), mul(L(desired[0]), L(B[0])));
    if (c0(x87cmp(side, ZERO))) for (let axis = 0; axis < 3; axis++) B[axis] = S(mul(L(B[axis]), L(F_MINUS_ONE)));
    return B;
  }
  const into = add(add(mul(L(C[1]), L(B[1])), mul(L(B[0]), L(C[0]))), mul(L(B[2]), L(C[2])));
  const tz = S(mul(into, L(C[2]))), ty = S(mul(into, L(C[1])));
  const tx = mul(into, L(C[0]));                  // X's projection stays in the register
  const rz = S(sub(L(B[2]), L(tz))), ry = S(sub(L(B[1]), L(ty))), rx = S(sub(L(B[0]), tx));
  const remaining = S(sub(D_ONE, L(hitTime)));
  B[0] = S(mul(L(rx), L(remaining)));
  B[1] = S(mul(L(ry), L(remaining)));
  B[2] = S(mul(L(rz), L(remaining)));
  const side = add(add(mul(L(desired[2]), L(B[2])), mul(L(desired[1]), L(B[1]))), mul(L(desired[0]), L(B[0])));
  if (notGreater(x87cmp(side, ZERO))) { B[0] = 0; B[1] = 0; B[2] = 0; }
  return B;
}

const freshHit = () => ({ actor: null, location: [0, 0, 0], normal: [0, 0, 0], primitive: 0, time: F_ONE, item: -1 });

/**
 * The per-step trace helper of Engine.dll 0x1036ca90 (thunk 0x1030240f): move `state.pos` by `delta` until the
 * first blocking hit, leave 2 units off a hit, set `state.region` from PointRegion at the new position and
 * fill `state.hit`. Returns the native's int (0 when the hit time is not above 0, else 1).
 *
 * A delta whose components are all below 0.0001 returns 1 at once and touches nothing: not state.hit (the
 * caller keeps the previous hit), not state.region.
 */
export function slideStepWords(services, self, state, delta, cylinder, checkActors) {
  const small = w => {
    const v = L(w);
    const magnitude = c0(x87cmp(v, ZERO)) ? x87neg(v) : v;
    return c0(x87cmp(magnitude, D_MIN_MOVE));
  };
  if (small(delta[0]) && small(delta[1]) && small(delta[2])) return 1;
  const hit = state.hit;
  Object.assign(hit, freshHit(), { location: [0, 0, 0], normal: [0, 0, 0] });
  const az = L(delta[2]), ay = L(delta[1]), ax = L(delta[0]);
  const root = appSqrt(add(add(mul(az, az), mul(ay, ay)), mul(ax, ax)));
  const size = S(root);                               // fst dword [ebp-0x20]
  const inverse = x87div(D_ONE, root);                // fdivr qword 1.0
  const nz = S(mul(az, inverse)), ny = S(mul(ay, inverse));
  const nxExact = mul(ax, inverse), nx = S(nxExact);
  const twoNz = S(add(L(nz), L(nz))), twoNy = S(add(L(ny), L(ny)));
  const twoNx = add(nxExact, nxExact);                // not stored: the X lane stays extended
  const ez = S(add(L(delta[2]), L(twoNz)));
  const ey = S(add(L(delta[1]), L(twoNy)));
  const ex = S(add(twoNx, L(delta[0])));              // delta + 2 * direction, the length asked of the level
  const pos = state.pos;
  const end = [S(add(L(ex), L(pos[0]))), S(add(L(ey), L(pos[1]))), S(add(L(ez), L(pos[2])))];
  const hits = services.multiLineCheck({ end, start: pos.slice(), extent: cylinder.slice(), checkActors, extra: 0 });
  let found = null;
  for (const candidate of hits) {
    if (self && services.isOwnedBy(candidate.actor, self)) continue;
    if (candidate.actor !== services.levelInfo && !services.blocksActors(candidate.actor)) continue;
    found = candidate;
    break;
  }
  if (found) {
    hit.actor = found.actor; hit.location = found.location.slice(); hit.normal = found.normal.slice();
    hit.primitive = found.primitive; hit.time = found.time; hit.item = found.item;
  }
  let move = [delta[0], delta[1], delta[2]];
  if (c0(x87cmp(L(hit.time), D_ONE))) {
    const adjusted = mul(add(L(F_TWO), L(size)), L(hit.time));      // (2 + |delta|) * Time
    const adjustedStored = S(adjusted);
    if (notGreater(x87cmp(adjusted, L(F_TWO)))) {
      move = [0, 0, 0];
      hit.time = 0;
    } else {
      const back = [S(mul(L(nx), L(F_TWO))), S(mul(L(ny), L(F_TWO))), S(mul(L(nz), L(F_TWO)))];
      const time = L(hit.time);
      const toHit = [S(mul(L(ex), time)), S(mul(L(ey), time)), S(mul(L(ez), time))];
      move = [S(sub(L(toHit[0]), L(back[0]))), S(sub(L(toHit[1]), L(back[1]))), S(sub(L(toHit[2]), L(back[2])))];
      hit.time = S(x87div(sub(L(adjustedStored), L(F_TWO)), L(size)));
    }
  }
  // Start += Move (FVector::operator+=: Move + Start), then the zone there.
  for (let axis = 0; axis < 3; axis++) pos[axis] = S(add(L(move[axis]), L(pos[axis])));
  state.region = services.pointRegion(pos.slice());
  return x87cmp(L(hit.time), D_ZERO) === 'gt' ? 1 : 0;
}

/** Granularity clamp of the worker (0x1036c0ef..0x1036c13b): below 0.005 or unordered -> 0.005, 1.0 or more -> 1.0. */
const clampGranularity = g => (c0(x87cmp(L(g), L(F_MIN_GRANULARITY))) ? F_MIN_GRANULARITY
  : !c0(x87cmp(L(g), L(F_ONE))) ? F_ONE : g);

/** Loop guard: the original never ends when maxTime is NaN (the time test is unordered). Refuse such a run. */
const MAX_STEPS = 5_000_000;

/**
 * The worker, Engine.dll 0x1036c0a0..0x1036c84a. `a` holds float32 words: startLocation, startVelocity,
 * cylinder (3 words), maxTime, elasticity, landingSpeed, granularity; and the ints checkActors, bounce.
 * Returns {time, finalLocation}: time is the float32 word the native returns (steps * granularity, 0 on
 * failure) and finalLocation three words.
 */
export function parabolicTraceWords(services, self, a) {
  const granularity = clampGranularity(a.granularity);
  const start = a.startLocation.slice();
  const state = { pos: start.slice(), hit: freshHit(), region: null };
  let velocity = a.startVelocity.slice();
  state.region = services.pointRegion(state.pos.slice());
  let steps = 0, finished = false, delta = [0, 0, 0];
  const bounce = Boolean(a.bounce), g = L(granularity);
  const landingSquared = () => mul(L(a.landingSpeed), L(a.landingSpeed));
  for (let guard = 0; !finished; guard++) {
    if (guard > MAX_STEPS) throw new Error('ParabolicTrace did not terminate (the original loops forever on this input)');
    let zone = state.region.zone;
    // Velocity += Gravity * Granularity; Delta = (Velocity + ZoneVelocity) * Granularity. Z keeps its product
    // and sum in the register (0x1036c1f6..0x1036c2c6).
    const gravity = zone.gravity, flow = zone.velocity;
    const gravityZ = mul(g, L(gravity[2]));
    const gravityY = S(mul(g, L(gravity[1]))), gravityX = S(mul(g, L(gravity[0])));
    const newZ = add(gravityZ, L(velocity[2]));
    const nx = S(add(L(velocity[0]), L(gravityX))), ny = S(add(L(velocity[1]), L(gravityY))), nz = S(newZ);
    velocity = [nx, ny, nz];
    const sx = S(add(L(nx), L(flow[0]))), sy = S(add(L(ny), L(flow[1]))), sz = add(newZ, L(flow[2]));
    delta = [S(mul(L(sx), g)), S(mul(L(sy), g)), S(mul(sz, g))];
    slideStepWords(services, self, state, delta, a.cylinder, a.checkActors);
    zone = state.region.zone;
    const hit = state.hit;
    let hitThisStep = false;
    if (zone.water) {
      steps = 0;
      state.pos = start.slice();
      finished = true;
    } else if (c0(x87cmp(L(hit.time), D_ONE))) {
      hitThisStep = true;
      let bounceOff = true;
      if (x87cmp(L(hit.normal[2]), D_FLOOR_NORMAL) === 'gt') {
        if (!bounce) { finished = true; bounceOff = false; }
        else {
          const speedSquared = add(add(mul(L(velocity[2]), L(velocity[2])), mul(L(velocity[1]), L(velocity[1]))),
            mul(L(velocity[0]), L(velocity[0])));
          if (x87cmp(landingSquared(), speedSquared) === 'gt') { finished = true; bounceOff = false; }
        }
      }
      if (bounceOff) {
        // Velocity = (Velocity - 2 (Velocity . N) N) * Elasticity
        const N = hit.normal.slice();
        const elasticity = L(a.elasticity);
        const along = add(add(mul(L(N[1]), L(velocity[1])), mul(L(velocity[2]), L(N[2]))), mul(L(velocity[0]), L(N[0])));
        const tz = S(mul(L(N[2]), along)), ty = S(mul(L(N[1]), along));
        const tx = mul(along, L(N[0]));
        const twiceZ = S(mul(L(tz), L(F_MINUS_TWO))), twiceY = S(mul(L(ty), L(F_MINUS_TWO)));
        const twiceX = mul(tx, L(F_MINUS_TWO));
        const mirrored = [S(add(twiceX, L(velocity[0]))), S(add(L(velocity[1]), L(twiceY))), S(add(L(velocity[2]), L(twiceZ)))];
        velocity = [S(mul(L(mirrored[0]), elasticity)), S(mul(L(mirrored[1]), elasticity)), S(mul(L(mirrored[2]), elasticity))];
        // Remaining = (Delta - N (Delta . N)) * (1 - HitTime), sliding the rest of the step along the wall
        const into = add(add(mul(L(delta[1]), L(N[1])), mul(L(delta[2]), L(N[2]))), mul(L(delta[0]), L(N[0])));
        const projected = [S(mul(L(N[0]), into)), S(mul(L(N[1]), into)), S(mul(L(N[2]), into))];
        const alongWall = [S(sub(L(delta[0]), L(projected[0]))), S(sub(L(delta[1]), L(projected[1]))), S(sub(L(delta[2]), L(projected[2])))];
        const left = sub(D_ONE, L(hit.time));
        const remainder = [S(mul(L(alongWall[0]), left)), S(mul(L(alongWall[1]), left)), S(mul(L(alongWall[2]), left))];
        const forward = add(add(mul(L(remainder[2]), L(delta[2])), mul(L(remainder[1]), L(delta[1]))), mul(L(remainder[0]), L(delta[0])));
        if (!c0(x87cmp(forward, ZERO))) {
          slideStepWords(services, self, state, remainder, a.cylinder, a.checkActors);
          if (c0(x87cmp(L(hit.time), D_ONE))) {
            const M = hit.normal.slice();
            const second = add(add(mul(L(M[1]), L(velocity[1])), mul(L(velocity[2]), L(M[2]))), mul(L(velocity[0]), L(M[0])));
            const projectedVelocity = [S(mul(L(M[0]), second)), S(mul(L(M[1]), second)), S(mul(L(M[2]), second))];
            const twice = projectedVelocity.map(w => S(mul(L(w), L(F_MINUS_TWO))));
            const reflected = [S(add(L(twice[0]), L(velocity[0]))), S(add(L(twice[1]), L(velocity[1]))), S(add(L(twice[2]), L(velocity[2])))];
            velocity = reflected.map(w => S(mul(L(w), elasticity)));
            if (x87cmp(L(M[2]), D_FLOOR_NORMAL) === 'gt') {
              if (!bounce) finished = true;
              else if (x87cmp(landingSquared(), L(S(sizeSquared(velocity)))) === 'gt') finished = true;
            }
            const desired = safeNormal(delta);
            twoWallAdjustWords(desired, remainder, M, N, hit.time);
            slideStepWords(services, self, state, remainder, a.cylinder, a.checkActors);
            if (!finished && c0(x87cmp(L(hit.time), D_ONE)) && x87cmp(L(hit.normal[2]), D_FLOOR_NORMAL) === 'gt') {
              if (!bounce) finished = true;
              else if (x87cmp(landingSquared(), L(S(sizeSquared(remainder)))) === 'gt') finished = true;
            }
          }
        }
      }
    }
    // 0x1036c74a: terminal velocity unless a bouncing step just struck something
    if (!(bounce && hitThisStep)) {
      const speed = S(sizeSquared(velocity));
      const terminal = L(state.region.zone.terminalVelocity);
      if (x87cmp(L(speed), mul(terminal, terminal)) === 'gt') {
        const direction = safeNormal(velocity);
        velocity = direction.map(w => S(mul(terminal, L(w))));
      }
    }
    steps++;
    let failed = false;
    if ((state.region.zoneNumber & 0xff) === 0) failed = true;
    else if (x87cmp(mul(x87int32(steps), g), L(a.maxTime)) === 'gt') failed = true;
    else if (x87cmp(sizeSquared(delta), L(F_MAX_STEP_SQUARED)) === 'gt') failed = true;
    if (failed) { steps = 0; finished = true; state.pos = start.slice(); }
  }
  return { time: S(mul(x87int32(steps), g)), finalLocation: state.pos.slice() };
}

// ---------------------------------------------------------------------------------------------------------------
// The exec (Engine.dll 0x1036e190): argument evaluation and defaults, then the worker.

const wordsOf = vector => Array.from({ length: 3 }, (_, axis) => f32bits(vector[axis]));
const numbersOf = words => words.map(f32num);

/**
 * AActor::execParabolicTrace. `call` is invokeNative's call (receiver, argumentCount, evaluateArgument); `host`
 * supplies read(actor, name) for script fields, services(actor) -> the level services above (null when the actor
 * has no live level), refValue and writeSlot as script-runtime.mjs defines them.
 *
 * Order, as the exec runs it: GPropAddr cleared; Step(finalLocation); then for each optional parameter its default
 * is stored from the actor and only then the argument expression is evaluated (EX_Nothing leaves the default):
 * startVelocity = Velocity (+0x144), startLocation = Location (+0x114), bCheckActors = bCollideActors (+0x1dc & 1),
 * cylinder = (CollisionRadius, CollisionRadius, CollisionHeight) (+0x1d4, +0x1d4, +0x1d8), maxTime 5.0,
 * elasticity 0.9 (0x3f666666), bBounce = bBounce (+0x1ec >> 4 & 1), landingSpeed 60.0, granularity 0.025
 * (0x3ccccccd). Then EX_EndFunctionParms, the worker and the float32 store of its result.
 */
export function execParabolicTrace(call, host) {
  const { read, services, refValue, writeSlot } = host;
  const actor = call.receiver;
  if (call.argumentCount < 1 || call.argumentCount > 10)
    throw new Error('ParabolicTrace takes one required out vector and up to nine optional arguments');
  const argument = (index, fallback) => {
    if (index >= call.argumentCount) return fallback;
    const value = refValue(call.evaluateArgument(index));
    return value === undefined || value === null ? fallback : value;
  };
  const out = call.evaluateArgument(0);
  // The default of each parameter is read from the actor just before its expression runs (a JavaScript argument
  // is evaluated before the call, so `argument(i, read(...))` has the exec's order).
  const velocity = wordsOf(argument(1, read(actor, 'Velocity')));
  const location = wordsOf(argument(2, read(actor, 'Location')));
  const checkActors = argument(3, Boolean(read(actor, 'bCollideActors')));
  const radius = read(actor, 'CollisionRadius'), height = read(actor, 'CollisionHeight');
  const cylinder = wordsOf(argument(4, [radius, radius, height]));
  const word = (index, fallback) => f32bits(argument(index, fallback));
  const maxTime = word(5, 5), elasticity = word(6, f32num(0x3f666666));
  const bounce = argument(7, Boolean(read(actor, 'bBounce')));
  const landingSpeed = word(8, 60), granularity = word(9, f32num(0x3ccccccd));
  const level = services(actor);
  if (!level) throw new Error('ParabolicTrace requires the live level collision and zone services');
  const result = parabolicTraceWords(level, actor, {
    startLocation: location, startVelocity: velocity, cylinder, checkActors: checkActors ? 1 : 0,
    maxTime, elasticity, bounce: bounce ? 1 : 0, landingSpeed, granularity,
  });
  writeSlot(out).set(numbersOf(result.finalLocation));
  return f32num(result.time);
}

/**
 * The two level services of the worker over Play's level: the collision hash (multiLineCheck, levelInfo) and
 * level.pointRegion, with zone fields read through readNamed. Hit actors are the collision-view actors the hash
 * returns: `owner` and `collisionBits` (the word at +0x1dc) are the members line-filter.mjs reads.
 */
export function levelParabolicServices(level, readNamed) {
  const hash = level.hash;
  const zoneView = zone => ({
    get gravity() { return wordsOf(readNamed(zone, 'ZoneGravity')); },
    get velocity() { return wordsOf(readNamed(zone, 'ZoneVelocity')); },
    get terminalVelocity() { return f32bits(readNamed(zone, 'ZoneTerminalVelocity')); },
    get water() { return Boolean(readNamed(zone, 'bWaterZone')); },
  });
  return {
    levelInfo: hash.levelInfo,
    pointRegion(position) {
      const region = level.pointRegion(numbersOf(position));
      return { zone: zoneView(region.zone), leaf: region.leaf, zoneNumber: region.zoneNumber };
    },
    multiLineCheck({ end, start, extent, checkActors, extra }) {
      const hits = hash.multiLineCheck({ end: numbersOf(end), start: numbersOf(start), extent: numbersOf(extent),
        checkActors: checkActors ? 1 : 0, worldActor: hash.levelInfo, extra });
      return hits.map(h => ({ actor: h.actor, location: wordsOf(h.location), normal: wordsOf(h.normal),
        time: f32bits(h.time), item: h.item ?? -1, primitive: h.primitive ? 1 : 0 }));
    },
    isOwnedBy(actor, owner) {
      for (let a = actor; a; a = a.owner) if (a === owner) return true;
      return false;
    },
    blocksActors: actor => ((actor.collisionBits ?? 0) & 4) !== 0,
  };
}
