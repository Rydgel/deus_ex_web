const f = Math.fround;
const identity = () => [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
let sineTable;

/** Core FGlobalMath 0x1014431e: `fild i; fmul qword [0x10178040]` (2 pi / 16384), the
 * angle stored as a double, appSin's `fsin` (thunk 0x101033a0) and a float32 store.
 * FSIN reduces its operand with a 66-bit pi, so at entry 8192 (the double nearest pi)
 * it returns pi66 - pi = 1.2246063538223773e-16 where the correctly rounded sine is
 * 1.2246467991473532e-16: float word 0x250d3000, not Math.sin's 0x250d3132. Measured on
 * the real x87 through Rosetta 2 (tools/x87-sintable-probe.c under CrossOver, the
 * constructor's sequence for all 16384 entries at precision control 53 and 64: this is
 * the only entry that differs from Math.sin) and in the original's own play (Stage 5
 * capture cmb5: Tantalus's momentum, Vector(ViewRotation) at Yaw 32768, gives the
 * Terrorist a Velocity.Y that only this entry reproduces). The Unicorn oracles compute
 * FSIN through a host double, as Math.sin does, and are patched to the measured word
 * (native-collision-oracle.py HARDWARE_TRIG). The entry is the sine of yaw 32768..32771
 * and the cosine of 16384..16387. */
export const HARDWARE_SINE_WORDS = Object.freeze({ 8192: 0x250d3000 });
export function rotationSineTable() {
  if (!sineTable) {
    sineTable = Float32Array.from({ length: 0x4000 }, (_, i) => Math.sin(i * 0.0003834951969714103));
    const words = new Uint32Array(sineTable.buffer);
    for (const [index, word] of Object.entries(HARDWARE_SINE_WORDS)) words[index] = word;
  }
  return sineTable.slice();
}

export function rotatorSin(angle) {
  if (!sineTable) rotationSineTable();
  return sineTable[(angle >> 2) & 0x3fff];
}

const transformVector = (v, rows) => rows.map(row => f(v[0] * row[0] + v[1] * row[1] + v[2] * row[2]));
function compose(a, b) {
  const rows = b.slice(1);
  // TransformPointBy retains the subtraction intermediates until each output
  // component is stored. The three axes use TransformVectorBy instead.
  return [transformVector(a[0].map((v, i) => v - b[0][i]), rows),
    ...a.slice(1).map(v => transformVector(v, rows))];
}

/** Original ShearSnap, Engine 0x1030f240 / Core inline at 0x1011c0b5. */
export function shearSnap(rate) {
  rate = f(rate);
  return f(rate < -.65 ? rate + .15 : rate > .65 ? rate - .15
    : rate < -.55 ? -.5 : rate > .55 ? .5 : rate < -.05 ? rate + .05 : rate > .05 ? rate - .05 : 0);
}

function applyScale(coords, value = {}) {
  const scale = (value.scale ?? [1, 1, 1]).map(f), shear = identity();
  if (scale.some(v => !Number.isFinite(v) || v === 0)) throw new Error('Zero or nonfinite brush scale is unsupported');
  const entry = [[1, 1], [1, 2], [2, 0], [2, 2], [3, 0], [3, 1]][(value.shearAxis ?? 0) - 1];
  if (entry) shear[entry[0]][entry[1]] = shearSnap(value.shearRate ?? 0);
  const result = compose(coords, shear);
  return [result[0].map((v, i) => f(v / scale[i])),
    ...result.slice(1).map(row => row.map((v, i) => f(v * scale[i])))];
}

/** Original ABrush.ToWorld, Engine.dll 0x1030f310. Return origin then X/Y/Z
 * axes, preserving the original scale/rotation order and float32 stores.
 * Derivation and native corpus: docs/fitting.md.
 */
export function brushToWorld(values) {
  let coords = identity();
  coords[0] = (values.Location ?? [0, 0, 0]).map(v => f(0 - f(v)));
  coords = applyScale(coords, values.PostScale);
  const [pitch, yaw, roll] = values.Rotation ?? [0, 0, 0];
  const sy = rotatorSin(yaw), cy = rotatorSin((yaw + 0x4000) | 0);
  const sp = rotatorSin(pitch), cp = rotatorSin((pitch + 0x4000) | 0);
  const sr = rotatorSin(roll), cr = rotatorSin((roll + 0x4000) | 0);
  coords = compose(coords, [[0, 0, 0], [cy, sy, 0], [-sy, cy, 0], [0, 0, 1]]);
  coords = compose(coords, [[0, 0, 0], [cp, 0, sp], [0, 1, 0], [-sp, 0, cp]]);
  coords = compose(coords, [[0, 0, 0], [1, 0, 0], [0, cr, -sr], [0, sr, cr]]);
  coords = applyScale(coords, values.MainScale);
  const prePivot = (values.PrePivot ?? [0, 0, 0]).map(f);
  coords[0] = coords[0].map((v, i) => f(v - -prePivot[i]));
  return coords.flat();
}
