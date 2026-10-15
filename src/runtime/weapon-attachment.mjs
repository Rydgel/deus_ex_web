/** Render.dll's third-person weapon attachment (docs/weapon-attachment.md).
 *
 * DrawLodMesh (0x10b0f1c9..0x10b0f44f) turns the three camera-space special
 * vertices of a pawn's mesh (its first special face) into the hand's
 * coordinate frame, and DrawActorSprite (0x10b256e8..0x10b257a2) hands that
 * frame, with the weapon's Location added, to DrawMesh as the Coords the
 * weapon's ThirdPersonMesh is posed with. Everything runs inside the render
 * pass, at x87 precision control 24 (docs/render-pass-precision.md): each
 * operation is one binary32 operation (`f(a op b)`; sqrt and the reciprocal
 * are correctly rounded to 24 bits after a double, which is innocuous for
 * 53 >= 2*24+2).
 *
 * Plain functions over plain arrays, the reference the Play wiring and the
 * Unicorn oracle (scripts/native-weapon-attach-oracle.py) are compared with. */
import {composeCoords} from './lodmesh-frame.mjs';
import {rotationSineTable} from './coords.mjs';
const f = Math.fround;

/** Core FVector::SafeNormal 0x10144be0: the zero vector under 1e-8 (compared
 * as the double the sum was stored to), else the vector times 1.0 / sqrt(sum). */
export const SMALL_NUMBER = 1e-8;
export function safeNormal(v) {
  const sum = f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]));
  if (sum < SMALL_NUMBER) return [0, 0, 0];
  const inverse = f(1 / f(Math.sqrt(sum)));
  return [f(inverse * v[0]), f(inverse * v[1]), f(inverse * v[2])];
}

/** The outcode DrawLodMesh gives one camera-space vertex (0x10b0efd3..0x10b0f073):
 * the sign bits of Z*PrjXM + X (4), Z*PrjXP - X (8), Z*PrjYM + Y (0x10) and
 * Z*PrjYP - Y (0x20), each term stored as binary32 (a negative zero counts).
 * `prj` is the frame's PrjXM, PrjYM, PrjXP, PrjYP (Frame +0xec, +0xf0, +0xf4, +0xf8). */
const negative = value => value < 0 || Object.is(value, -0);
export function specialOutcode(vertex, prj) {
  const [x, y, z] = vertex;
  return (negative(f(f(z * prj[0]) + x)) ? 4 : 0) | (negative(f(f(z * prj[2]) - x)) ? 8 : 0)
    | (negative(f(f(z * prj[1]) + y)) ? 0x10 : 0) | (negative(f(f(z * prj[3]) - y)) ? 0x20 : 0);
}

/** The hand coordinates (the 12 floats stored at 0x10b4ea08: Origin, X, Y, Z)
 * from the special face's three vertices A, B, C (camera space, floats), or
 * null when the three outcodes share a bit (the face is outside one plane of
 * the frame; no hand is stored and the pawn's weapon is not drawn).
 *   X  = (B - A).SafeNormal()
 *   Y  = (X x (A - C)).SafeNormal()
 *   Z  = Y x X
 *   M  = (A + C) * 0.5
 *   hand = UnitCoords(origin -M) *= FCoords(0, X, Y, Z)
 * the camera frame in the hand's coordinates, which is what GetFrame, called
 * with it, turns the weapon mesh's vertices into camera space with. */
export function handCoords([a, b, c], outcodes = [0, 0, 0]) {
  if (outcodes[0] & outcodes[1] & outcodes[2]) return null;
  const x = safeNormal([f(b[0] - a[0]), f(b[1] - a[1]), f(b[2] - a[2])]);
  const dx = f(a[0] - c[0]), dy = f(a[1] - c[1]), dz = f(a[2] - c[2]);
  // 0x10b0f2ad..0x10b0f2e9: each component is one product less another.
  const normal = [f(f(dz * x[1]) - f(dy * x[2])), f(f(dx * x[2]) - f(x[0] * dz)), f(f(x[0] * dy) - f(dx * x[1]))];
  const y = safeNormal(normal);
  // 0x10b0f31c..0x10b0f379
  const z = [f(f(y[1] * x[2]) - f(y[2] * x[1])), f(f(x[0] * y[2]) - f(y[0] * x[2])), f(f(y[0] * x[1]) - f(x[0] * y[1]))];
  const middle = [f(f(a[0] + c[0]) * 0.5), f(f(a[1] + c[1]) * 0.5), f(f(a[2] + c[2]) * 0.5)];
  const unit = [[f(0 - middle[0]), f(0 - middle[1]), f(0 - middle[2])], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  return composeCoords(unit, [[0, 0, 0], x, y, z]).flat();
}

/** The Coords DrawMesh receives for the weapon (and, the same way, for its
 * muzzle flash): the hand coordinates divided by the weapon's Rotation, which
 * the draw first sets to zero (0x10b25702..0x10b2570c), then the weapon's
 * Location added to the origin (0x10b25757..0x10b25787), each sum stored as
 * binary32. A zero rotation divides three times by an identity matrix:
 * the coordinates, but for the sign of a zero. */
export function weaponCoords(hand, location) {
  const rows = [0, 1, 2, 3].map(i => hand.slice(i * 3, i * 3 + 3));
  const identity = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let coords = rows;
  for (let pass = 0; pass < 3; pass++) coords = composeCoords(coords, identity);
  coords[0] = coords[0].map((v, i) => f(v + f(location[i])));
  return coords.flat();
}

/** The Coords DrawMesh receives for a pawn's SelectedItem when it has no Weapon (a held tool: DrawActorSprite
 * 0x10b25cdc..0x10b261a3): the same hand coordinates, but the item's Rotation (zeroed first, 0x10b25d6f..0x10b25d94) goes through
 * three rotation FCoords built inline from the sine table, in the order Roll (+0x128: TransformPointBy of the origin and
 * TransformVectorBy of the axes), Pitch (+0x120) and Yaw (+0x124) (`FCoords *= FCoords`), before the item's Location is
 * added to the origin (0x10b260cc..0x10b2610c). At angle 0 each matrix is an identity with the table's sin 0 and cos 1,
 * but for the negative zeros the construction carries (fchs of sin, the constants 0x80000000), so the words of a zero
 * component can differ from weaponCoords'. */
export function selectedCoords(hand, location) {
  const table = rotationSineTable(), sin = table[0], cos = table[0x1000];
  const rows = [0, 1, 2, 3].map(i => hand.slice(i * 3, i * 3 + 3));
  const negate = value => f(-value);
  const roll = [[-0, -0, -0], [1, -0, -0], [-0, cos, sin], [-0, negate(sin), cos]];
  const pitch = [[0, 0, 0], [cos, 0, negate(sin)], [-0, 1, -0], [sin, -0, cos]];
  const yaw = [[0, 0, 0], [cos, negate(sin), 0], [sin, cos, 0], [0, 0, 1]];
  let coords = composeCoords(rows, roll);
  coords = composeCoords(coords, pitch);
  coords = composeCoords(coords, yaw);
  coords[0] = coords[0].map((v, i) => f(v + f(location[i])));
  return coords.flat();
}
