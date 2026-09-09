const f = Math.fround;
const scale = (a, s) => a.map(v => f(v * s));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Core.dll FVector.SafeNormal, VA 0x10144be0. The reciprocal remains in
// extended precision until each component is stored.
export function safeNormal(vector) {
  const v = vector.map(f), squared = dot(v, v);
  return squared < 1e-8 ? [0, 0, 0] : scale(v, 1 / Math.sqrt(squared));
}

/** AActor.TwoWallAdjust, Engine.dll VA 0x10323770. This is the original
 * corner response, independent of collision queries and physics event dispatch. */
export function twoWallAdjust({ desired, delta, normal, oldNormal, time }) {
  const d = desired.map(f), v = delta.map(f), n = normal.map(f), old = oldNormal.map(f);
  time = f(time);
  if (dot(n, old) <= 0) {
    const crease = safeNormal([
      f(n[1] * old[2] - n[2] * old[1]),
      f(n[2] * old[0] - n[0] * old[2]),
      f(n[0] * old[1] - n[1] * old[0]),
    ]);
    const result = scale(crease, dot(v, crease) * (1 - time));
    return dot(d, result) < 0 ? scale(result, -1) : result;
  }
  const into = dot(v, n), remaining = f(1 - time);
  // In this native expression X's projection is held in x87; Y/Z projections
  // are stored before subtraction. All three differences are then stored.
  const result = scale(v.map((value, axis) => f(value - (axis ? f(n[axis] * into) : n[axis] * into))), remaining);
  return dot(d, result) <= 0 ? [0, 0, 0] : result;
}

function stepProjection(delta, normal, time) {
  const into = dot(delta, normal), remaining = 1 - time;
  const x = (delta[0] - normal[0] * into) * remaining;
  const y = f(f(delta[1] - f(normal[1] * into)) * remaining);
  const z = f(f(delta[2] - f(normal[2] * into)) * remaining);
  // stepUp retains X in x87 for its forward-progress comparison.
  return { delta: [f(x), y, z], progress: delta[0] * x + delta[1] * y + delta[2] * z };
}

/** Original APawn.stepUp, Engine.dll VA 0x103ce4a0.
 * The caller has already moved to the first impact; delta is the remainder.
 * pawn.move returns {time, normal, actor}; pawn.hitWall supplies event behavior.
 * A pushable Decoration is explicitly identified by actor.pushableDecoration.
 * This primitive does not establish fidelity of its supplied world/events. */
export function stepUp(pawn, gravityDirection, desiredDirection, delta) {
  const gravity = gravityDirection.map(f), desired = desiredDirection.map(f);
  const down = scale(gravity, f(pawn.maxStepHeight));
  let calls = 0;
  function step(remaining) {
    if (++calls > 1024) throw new Error('Original stepUp recursion budget exceeded');
    pawn.move(scale(down, -1));
    let hit = pawn.move(remaining);
    if (hit.time < 1) {
      if (pawn.isPlayer && hit.actor?.pushableDecoration && dot(desired, hit.normal) < -.9) {
        pawn.justTeleported = true;
        const mass = f(pawn.mass), otherMass = f(hit.actor.mass);
        pawn.velocity = scale(pawn.velocity.map(f), mass / (otherMass + mass));
        pawn.hitWall(hit);
        if (pawn.physics === 2) return hit;
      } else if (Math.abs(hit.normal[2]) < .2 && dot(remaining, remaining) * hit.time > 144) {
        hit = step(scale(remaining, f(1 - hit.time)));
        if (pawn.physics === 2) return hit;
      } else {
        pawn.hitWall(hit);
        const oldNormal = [...hit.normal];
        const projected = stepProjection(remaining, hit.normal, hit.time);
        if (projected.progress >= 0) {
          remaining = projected.delta;
          hit = pawn.move(remaining);
          if (hit.time < 1) {
            pawn.hitWall(hit);
            if (pawn.physics === 2) return hit;
            remaining = twoWallAdjust({ desired, delta: remaining, normal: hit.normal, oldNormal, time: hit.time });
            hit = pawn.move(remaining);
          }
        }
      }
    }
    hit = pawn.move(down);
    if (hit.time < 1 && hit.normal[2] < .5) {
      const projected = stepProjection(down, hit.normal, hit.time);
      if (projected.progress >= 0) hit = pawn.move(projected.delta);
    }
    return hit;
  }
  return step(delta.map(f));
}
