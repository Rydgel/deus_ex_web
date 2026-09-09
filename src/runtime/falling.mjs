import { safeNormal, twoWallAdjust } from './steps.mjs';

const f = Math.fround;
const add = (a, b) => a.map((v, i) => f(v + b[i]));
const sub = (a, b) => a.map((v, i) => f(v - b[i]));
const scale = (a, s) => a.map(v => f(v * s));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Dry, non-bouncing player path of AActor.physFalling (Engine.dll 0x103d0a50).
 * World movement/queries and landing/wall events are supplied by the caller;
 * this function does not implement swimming, surface events or landing fitting. */
export function falling(pawn, seconds, iterations = 0) {
  const dt = f(seconds);
  if (!(dt > 0) || dt > f(.4)) throw new Error('Falling requires an original actor timestep in (0, 0.4]');
  // Original Pawn branch 103d0a7d–103d0ac2 calls the same surface/ladder
  // prelude as walking, before reading acceleration or the current zone.
  if (pawn.walkingPrelude?.(dt,iterations)) return;
  const savedAcceleration = pawn.acceleration.map(f);
  const gravity = pawn.gravity.map(f), zoneVelocity = pawn.zoneVelocity.map(f);
  let acceleration = [...savedAcceleration], airControl = f(pawn.airControl), speedLimit = 0;
  pawn.position = pawn.position.map(f); pawn.velocity = pawn.velocity.map(f);
  if (airControl > f(.15)) {
    const direction = safeNormal(acceleration), limit = f(airControl * f(pawn.accelRate));
    const delta = scale(add(pawn.velocity, scale(direction, limit)), dt); delta[2] = 0;
    if (pawn.airControlBlocked(delta)) airControl = f(.05);
  }
  let accelerationLimit = f(airControl * f(pawn.accelRate));
  acceleration[2] = 0;
  const horizontalSpeed = Math.sqrt(pawn.velocity[0] ** 2 + pawn.velocity[1] ** 2);
  if (horizontalSpeed < 10) accelerationLimit = f(accelerationLimit + (10 - horizontalSpeed) / dt);
  else if (horizontalSpeed >= f(pawn.groundSpeed)) {
    if (airControl <= f(.05)) accelerationLimit = 1;
    else speedLimit = f(horizontalSpeed);
  }
  if (dot(acceleration, acceleration) > accelerationLimit * accelerationLimit) acceleration = scale(safeNormal(acceleration), accelerationLimit);
  pawn.acceleration = acceleration;
  let remaining = dt, apexSplit = false;
  while (remaining > 0 && iterations < 8) {
    iterations++;
    let step = remaining > .1 ? f(Math.min(remaining * .5, f(.1))) : remaining;
    const origin = [...pawn.position], oldVelocity = [...pawn.velocity];
    pawn.justTeleported = false;
    remaining = f(remaining - step);
    const integrate = () => add(oldVelocity, scale(scale(add(acceleration, gravity), .5), step));
    pawn.velocity = integrate();
    if (!apexSplit && (oldVelocity[2] > 0) !== (pawn.velocity[2] > 0) && Math.abs(oldVelocity[2]) > 5 && Math.abs(pawn.velocity[2]) > 5) {
      apexSplit = true;
      const ratio = Math.abs(oldVelocity[2]) / (Math.abs(oldVelocity[2]) + Math.abs(pawn.velocity[2]));
      const first = ratio * step, second = (1 - ratio) * step;
      if (first > .015 && second > .015) {
        remaining = f(remaining + second); step = f(first); pawn.velocity = integrate();
      }
    } else apexSplit = false;
    if (speedLimit && pawn.velocity[0] ** 2 + pawn.velocity[1] ** 2 > speedLimit * speedLimit) {
      const limited = scale(safeNormal([pawn.velocity[0], pawn.velocity[1], 0]), speedLimit);
      pawn.velocity = [limited[0], limited[1], pawn.velocity[2]];
    }
    const delta = scale(add(pawn.velocity, zoneVelocity), step);
    let hit = pawn.move(delta);
    if (hit.time < 1) {
      if (hit.normal[2] > .7) {
        remaining = f(remaining + (1 - hit.time) * step);
        if (!pawn.justTeleported && hit.time > .1 && hit.time * step > f(.003)) {
          pawn.velocity = scale(sub(pawn.position, origin), 1 / (hit.time * step));
        }
        pawn.landed(hit, remaining, iterations);
        return;
      }
      pawn.hitWall(hit);
      const oldNormal = [...hit.normal];
      let slide = scale(sub(delta, scale(hit.normal, dot(delta, hit.normal))), 1 - hit.time);
      if (dot(slide, delta) >= 0) {
        hit = pawn.move(slide);
        if (hit.time < 1) {
          if (hit.normal[2] > .7) { pawn.landed(hit, 0, iterations); return; }
          pawn.hitWall(hit);
          slide = twoWallAdjust({ desired: safeNormal(delta), delta: slide, normal: hit.normal, oldNormal, time: hit.time });
          const ditch = oldNormal[2] > 0 && hit.normal[2] > 0 && slide[2] === 0 && dot(oldNormal, hit.normal) < 0;
          hit = pawn.move(slide);
          if (ditch || hit.normal[2] > .7) { pawn.landed(hit, 0, iterations); return; }
        }
      }
      const traveledVelocity = scale(sub(pawn.position, origin), 1 / step);
      oldVelocity[0] = traveledVelocity[0]; oldVelocity[1] = traveledVelocity[1];
    }
    if (!pawn.justTeleported) {
      pawn.velocity = sub(scale(sub(pawn.position, origin), 1 / step), zoneVelocity);
      if (pawn.velocity[2] < oldVelocity[2] || oldVelocity[2] >= 0) pawn.velocity = sub(scale(pawn.velocity, 2), oldVelocity);
      if (f(dot(pawn.velocity, pawn.velocity)) > f(pawn.terminalVelocity) ** 2) pawn.velocity = scale(safeNormal(pawn.velocity), f(pawn.terminalVelocity));
    }
  }
  pawn.acceleration = savedAcceleration;
}
