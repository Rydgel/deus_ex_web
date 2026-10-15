/**
 * FCollisionHash::ActorRadiusCheck (Engine.dll 0x103589e0, vtable +0x18 of the hash at 0x1042a044), the query under
 * the VisibleCollidingActors iterator (native 312, exec 0x103e55b0) and so every HurtRadius.
 *
 * The cell box: for each axis `(v -/+ Radius + 32768.0f) * 0.00390625f` stored as a float32 and rounded by FISTP
 * (nearest even), clamped to [0, 0x3fff]. X stays on the x87 stack until that store; for Y and Z the bound
 * `v -/+ Radius` is stored as a float32 first (0x10358a0c..0x10358abb), as in the line query. The cells are visited X
 * outer, Y, Z inner with the same bucket/tag walk as the other queries (the hash's cellCandidates), and an actor
 * (visited once) is a hit when `dx*dx + dy*dy + dz*dz < Radius*Radius`, the sum on the x87 stack from the actor's
 * Location (+0x114) float32 differences, compared with the float32 `Radius*Radius` stored at 0x10358b63: strictly
 * less (C0 of FCOMP). Each hit takes a 0x2c-byte FCheckResult from GMem and is prepended, so the list is the reverse
 * of the visiting order. docs/screen-flash.md "Iterator 312".
 */
import { x87load, x87add, x87neg, x87mul, x87store, x87fistp, x87cmp } from './script-vm.mjs';

const f32 = Math.fround;
const OFFSET = x87load(32768), SCALE = x87load(0.00390625);
const clampCell = n => (n < 0 ? 0 : n > 0x3fff ? 0x3fff : n);
// `fstps tmp; flds tmp; fistpl`: the float32 store, then the integer conversion.
const cellOf = extended => clampCell(x87fistp(x87load(x87store(extended))));
const scaled = value => x87mul(x87add(value, OFFSET), SCALE);

/** The cell box ActorRadiusCheck computes: `{min: [x, y, z], max: [x, y, z]}`. */
export function radiusCells(location, radius) {
  const r = x87load(f32(radius)), [x, y, z] = location.map(f32);
  const lower = v => x87add(x87load(v), x87neg(r)), upper = v => x87add(x87load(v), r);
  // Y and Z: the expanded bound is stored to float32 before the scaling.
  const stored = value => x87load(x87store(value));
  return {
    min: [cellOf(scaled(lower(x))), cellOf(scaled(stored(lower(y)))), cellOf(scaled(stored(lower(z))))],
    max: [cellOf(scaled(upper(x))), cellOf(scaled(stored(upper(y)))), cellOf(scaled(stored(upper(z))))],
  };
}

/** Whether an actor at `location` lies inside the radius: the strict x87 comparison of the hash body. */
export function insideRadius(actorLocation, location, radius) {
  const r2 = x87load(x87store(x87mul(x87load(f32(radius)), x87load(f32(radius)))));
  const d = axis => x87add(x87load(f32(actorLocation[axis])), x87neg(x87load(f32(location[axis]))));
  const dx = d(0), dy = d(1), dz = d(2);
  const sum = x87add(x87add(x87mul(dx, dx), x87mul(dy, dy)), x87mul(dz, dz));
  return x87cmp(sum, r2) === 'lt';
}

/**
 * The actors ActorRadiusCheck returns, in its list order. `hash` is a collision hash (collision-hash.mjs),
 * `locationOf(actor)` the actor's Location.
 */
export function actorRadiusCheck(hash, { location, radius }, locationOf) {
  const cells = radiusCells(location, radius), hits = [];
  for (const actor of hash.cellCandidates(cells)) if (insideRadius(locationOf(actor), location, radius)) hits.push(actor);
  return hits.reverse();
}
