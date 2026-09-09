import { setBasedPawnSize, resetBasedPawnSize, defaultPawnCollisionHeight } from './stance.mjs';
const f = Math.fround;

/** Dry, non-leaning ProcessMove crouch branch. `forceDuck` is its incoming
 * value; returned value becomes bForceDuck only after the original trace. */
export function updateCrouch(pawn, crouching, forceDuck, trace) {
  if (!crouching && !forceDuck) { resetBasedPawnSize(pawn); return false; }
  setBasedPawnSize(pawn, pawn.defaultCollisionRadius, 16);
  const start = pawn.position.map(f), end = start.slice();
  end[2] = f(f(start[2] - f(pawn.height)) + f(2 * defaultPawnCollisionHeight(pawn.defaultCollisionHeight)));
  const hit = trace(end,start,[f(pawn.radius),f(pawn.radius),1]);
  return hit.actor !== null;
}
