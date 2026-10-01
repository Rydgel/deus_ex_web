import { x87load, x87int32, x87mul, x87add, x87neg, x87div, x87cmp, x87store, x87ftol, x87double } from './script-vm.mjs';

/** AActor::physPathing, Engine.dll 0x103dd8a0–0x103de3af: PHYS_Interpolating
 * along an InterpolationPoint path (docs/pathing.md). performPhysics brackets
 * it with OldLocation and Velocity (actor-physics.mjs, APawn's 0x103c9a70).
 *
 * Services: `read(object, name)` / `write(object, name, value)` script fields;
 * `isA(object, key)` class ancestry ('engine.interpolationpoint',
 * 'engine.playerpawn', 'engine.pawn'); `defaultFovAngle(actor)` the class
 * default object's FovAngle; `moveActor(actor, delta, rotation)` ULevel
 * MoveActor with all flags clear (its result is ignored); and
 * `interpolateEnd(receiver, other)` the InterpolateEnd ProcessEvent. Every
 * x87 step follows the instruction sequence: FST/FSTP float32 stores where
 * the body stores, extended intermediates where it keeps them on the stack,
 * and _ftol of exact FILD*float products for rotators. */
const ZERO = x87double(0), ONE = x87double(1), TWO = x87double(2);
const SIXTEENTH = x87double(0.0625), HALF = x87double(0.5);
const X = x87load;
const sub = (a, b) => x87add(a, x87neg(b));
// FCHS flips the sign of a NaN too (FSUB's x87neg leaves a NaN subtrahend).
const fchs = v => v.nan !== undefined ? { nan: (v.nan ^ 0x80000000) >>> 0 } : x87neg(v);
const f32 = v => x87store(v);
const rotatorTimes = (rotator, weight) => rotator.map(component => x87ftol(x87mul(x87int32(component), X(weight))));
const addRotators = (a, b) => a.map((v, i) => (v + b[i]) | 0);
// (1 + x^4/16) - x^2/2, i.e. (1 - x^2/4)^2: 0x103ddb85 and its three copies.
const kernel = x => {
  const square = x87mul(x, x);
  return f32(x87add(sub(x87mul(x87mul(square, square), SIXTEENTH), x87mul(square, HALF)), ONE));
};

export function physPathing(actor, seconds, services) {
  const { read, write, isA, moveActor, interpolateEnd } = services;
  // 0x103de287 / 0x103de328: Target steps along Next (Prev) while the point
  // it reaches is an InterpolationPoint with bSkipNextPath. A closed path
  // whose every point skips never leaves this loop in the original; the
  // translation stops there with an explicit error instead of hanging.
  const skipWalk = (from, link) => {
    const seen = new Set();
    for (let point = from; ;) {
      point = read(point, link);
      write(actor, 'Target', point);
      if (!point || !isA(point, 'engine.interpolationpoint') || !read(point, 'bSkipNextPath')) return;
      if (seen.has(point)) throw new Error('physPathing: every point on the path is bSkipNextPath (the original never leaves its skip loop)');
      seen.add(point);
    }
  };
  let dt = Math.fround(seconds);
  for (;;) {
    // 0x103dd8cd: PhysRate == 0 (or unordered), !bInterpolating, dt <= 0 return.
    const rateCmp = x87cmp(X(read(actor, 'PhysRate')), ZERO);
    if (rateCmp === 'eq' || rateCmp === 'un') return;
    if (!read(actor, 'bInterpolating')) return;
    if (x87cmp(X(dt), ZERO) !== 'gt') return;
    const target = read(actor, 'Target');
    const dest = target && isA(target, 'engine.interpolationpoint') ? target : null;
    // The body dereferences Dest and Dest.Next without a test (0x103dd966,
    // 0x103dd978): the original faults. Keep that boundary explicit.
    if (!dest) throw new Error('physPathing: Target is not an InterpolationPoint (original null dereference at 0x103dd966)');
    const next = read(dest, 'Next');
    if (!next) throw new Error('physPathing: Target.Next is None (original null dereference at 0x103dd978)');
    const alpha = f32(X(read(actor, 'PhysAlpha')));
    const blend = (name, scale = null) => {
      const inverse = sub(ONE, X(alpha));
      const sum = x87add(x87mul(inverse, X(read(dest, name))), x87mul(X(read(next, name)), X(alpha)));
      return scale === null ? sum : x87mul(sum, X(scale));
    };
    const rateModifier = f32(blend('RateModifier'));
    write(read(actor, 'Level'), 'TimeDilation', f32(blend('GameSpeedModifier')));
    if (isA(actor, 'engine.playerpawn')) {
      const inverse = sub(ONE, X(alpha));
      const flash = f32(x87add(x87mul(X(read(next, 'ScreenFlashScale')), X(alpha)),
        x87mul(X(read(dest, 'ScreenFlashScale')), inverse)));
      write(actor, 'DesiredFlashScale', flash);
      write(actor, 'FlashScale', [flash, flash, flash]);
      const nextFog = read(next, 'ScreenFlashFog'), destFog = read(dest, 'ScreenFlashFog');
      const fog = [0, 1, 2].map(i => f32(x87add(X(f32(x87mul(inverse, X(destFog[i])))), X(f32(x87mul(X(alpha), X(nextFog[i])))))));
      write(actor, 'DesiredFlashFog', fog);
      write(actor, 'FlashFog', [...fog]);
      write(actor, 'FovAngle', f32(blend('FovModifier', services.defaultFovAngle(actor))));
    }
    // 0x103ddaff: PhysAlpha += RateModifier*PhysRate*dt, clamped to [0,1].
    const oldAlpha = alpha;
    const advanced = x87add(x87mul(x87mul(X(rateModifier), X(read(actor, 'PhysRate'))), X(dt)), X(oldAlpha));
    const unclamped = f32(advanced);
    const below = x87cmp(advanced, ZERO);
    const above = x87cmp(X(unclamped), ONE);
    const t = below === 'lt' || below === 'un' ? 0 : above === 'lt' || above === 'un' ? unclamped : 1;
    write(actor, 'PhysAlpha', t);
    const location = read(actor, 'Location');
    let position, rotation;
    const prev = read(dest, 'Prev'), nextNext = read(next, 'Next');
    if (prev && nextNext) {
      // Cubic: the kernel at t+1, t, t-1, t-2 over Prev, Dest, Next, NextNext.
      const T = X(t);
      const w0 = kernel(x87add(T, ONE)), w1 = kernel(T), w2 = kernel(sub(T, ONE)), w3 = kernel(sub(T, TWO));
      const norm = f32(x87div(ONE, x87add(x87add(x87add(X(w3), X(w2)), X(w1)), X(w0))));
      const [p0, p1, p2, p3] = [prev, dest, next, nextNext].map(point => read(point, 'Location'));
      const product = (w, p) => x87mul(X(w), X(p));
      const stored = (w, p) => X(f32(product(w, p)));
      // X and Y store every product; Z keeps the first three extended.
      const xy = i => f32(x87add(X(f32(x87add(X(f32(x87add(stored(w0, p0[i]), stored(w1, p1[i])))), stored(w2, p2[i])))), stored(w3, p3[i])));
      const z = f32(x87add(X(f32(x87add(x87add(product(w1, p1[2]), product(w0, p0[2])), product(w2, p2[2])))), stored(w3, p3[2])));
      position = [xy(0), xy(1), z].map(v => f32(x87mul(X(v), X(norm))));
      const [r0, r1, r2, r3] = [prev, dest, next, nextNext].map(point => read(point, 'Rotation').map(v => v | 0));
      const sum = addRotators(addRotators(addRotators(rotatorTimes(r1, w1), rotatorTimes(r0, w0)), rotatorTimes(r2, w2)), rotatorTimes(r3, w3));
      rotation = rotatorTimes(sum, norm);
    } else {
      // Linear between Dest and Next (0x103ddf81).
      const inverse = f32(sub(ONE, X(t)));
      const a = read(next, 'Location'), b = read(dest, 'Location');
      position = [0, 1, 2].map(i => f32(x87add(X(f32(x87mul(X(t), X(a[i])))), X(f32(x87mul(X(inverse), X(b[i])))))));
      rotation = addRotators(rotatorTimes(read(next, 'Rotation').map(v => v | 0), t), rotatorTimes(read(dest, 'Rotation').map(v => v | 0), inverse));
    }
    moveActor(actor, position.map((v, i) => f32(sub(X(v), X(location[i])))), rotation);
    if (isA(actor, 'engine.pawn')) write(actor, 'ViewRotation', read(actor, 'Rotation').map(v => v | 0));
    // 0x103de1dc: crossing a segment end.
    const rate = X(read(actor, 'PhysRate'));
    const rateSign = x87cmp(rate, ZERO), past = x87cmp(X(unclamped), ONE);
    if (rateSign === 'gt' && past === 'gt') {
      dt = f32(x87mul(x87div(sub(X(unclamped), ONE), sub(X(unclamped), X(oldAlpha))), X(dt)));
      write(actor, 'PhysAlpha', 0);
      const current = read(actor, 'Target');
      if (!current) continue;
      interpolateEnd(current, actor);
      interpolateEnd(actor, read(actor, 'Target'));
      // Advance from Dest along Next, skipping bSkipNextPath points.
      skipWalk(dest, 'Next');
      continue;
    }
    const beforeStart = x87cmp(X(unclamped), ZERO);
    if ((rateSign === 'lt' || rateSign === 'un') && (beforeStart === 'lt' || beforeStart === 'un')) {
      dt = f32(x87mul(x87div(fchs(X(unclamped)), sub(X(oldAlpha), X(unclamped))), X(dt)));
      write(actor, 'PhysAlpha', 1);
      const current = read(actor, 'Target');
      if (current) {
        interpolateEnd(current, actor);
        interpolateEnd(actor, read(actor, 'Target'));
        skipWalk(dest, 'Prev');
      }
      interpolateEnd(actor, null);
      continue;
    }
    dt = 0;
  }
}
