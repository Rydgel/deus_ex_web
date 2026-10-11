const f = Math.fround;
const scale = (a, s) => a.map(v => f(v * s));
const add = (a, b) => a.map((v, i) => f(v + b[i]));
const sub = (a, b) => a.map((v, i) => f(v - b[i]));
// x87 dot/size expressions retain intermediate precision until their result is
// stored. Vector arithmetic operators store each component as float32.
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Original APawn.calcVelocity's single-player, nonfluid, braking path, as called
 * by physWalking (Engine.dll VA 0x103cd7a0 / caller 0x103ca674).
 * Inputs/outputs use Unreal coordinates. The direction is the caller's normalized
 * acceleration; acceleration itself is limited here, as in the original native.
 * Falling uses a different original routine and is deliberately separate.
 * `playerPawn` (IsA(PlayerPawn), default true: the player and the oracles' pawn) and `desiredSpeed` (Pawn.DesiredSpeed) are
 * what the original's class tests read; a script pawn (ScriptedPawn) passes playerPawn false. */
export function groundVelocity({ velocity, acceleration, direction, dt, maxSpeed, accelRate, friction, walking = false, playerPawn = true, desiredSpeed = 1 }) {
  let v = velocity.map(f), a = acceleration.map(f);
  const original = [...v], d = direction.map(f);
  dt = f(dt); maxSpeed = f(maxSpeed); accelRate = f(accelRate); friction = Math.max(0, f(friction));
  // calcVelocity tests the pawn's class twice (the class chain against APlayerPawn, 0x1058c160): bIsWalking counts
  // only for a PlayerPawn (0x103cd7e2..0x103cd815), and any other pawn's MaxSpeed is multiplied by DesiredSpeed
  // (0x103cdf05..0x103cdf30, +0x36c). MaxSpeed is read only by the clamp below, so scaling it here is the same.
  // flying.mjs calcVelocity has both; the walking path lacked them until the live-scene acceptance found it.
  if (!playerPawn) { walking = false; maxSpeed = f(maxSpeed * f(desiredSpeed)); }
  if (!(dt > 0) || dt > f(.4)) throw new Error('Ground velocity requires an original actor timestep in (0, 0.4]');
  if (a.every(value => value === 0)) {
    let remaining = dt, average = [0, 0, 0];
    const brake = step => {
      v = sub(v, scale(scale(scale(v, 2), step), friction));
      if (dot(original, v) > 0) average = add(average, scale(scale(v, step), 1 / dt));
    };
    // The loop compares/subtracts a double 0.03, but the vector operator uses
    // its float32 counterpart. Keep that distinction at the substep boundary.
    while (remaining > .03) { brake(f(.03)); remaining = f(remaining - .03); }
    brake(remaining);
    v = average;
    if (dot(original, v) < 0 || dot(v, v) < 100) v = [0, 0, 0];
  } else {
    const speed = f(Math.sqrt(dot(v, v)));
    const accelLimitSquared = accelRate * accelRate * (walking ? .09 : 1);
    if (dot(a, a) > accelLimitSquared) a = walking ? scale(scale(d, accelRate), f(.3)) : scale(d, accelRate);
    v = sub(v, scale(scale(sub(v, scale(d, speed)), dt), friction));
  }
  v = add(v, scale(a, dt));
  const speedSquared = f(dot(v, v));
  if (walking && speedSquared > maxSpeed * maxSpeed * .09) {
    const speed = f(Math.sqrt(dot(v, v)));
    const limited = f(Math.max(speed * (1 - 2 * friction * dt), f(maxSpeed * f(.3))));
    v = scale(scale(v, 1 / speed), limited);
  } else if (speedSquared > maxSpeed * maxSpeed) {
    // Core.FVector.SafeNormal keeps the reciprocal in x87 precision until
    // multiplying each component (Core.dll 0x10144c34–0x10144c58).
    v = scale(scale(v, 1 / Math.sqrt(dot(v, v))), maxSpeed);
  }
  return { velocity: v, acceleration: a };
}
