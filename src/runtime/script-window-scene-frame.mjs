/** Consumed FSceneNode fields from original Engine ComputeRenderCoords/Size.
 * Engine bodies 0x10372580/0x10372980, Core rotation body 0x1011b690.
 * See docs/script-window-scene-frame.md for instructions, hardware tangent
 * evidence, and the deliberately limited frame surface. Camera production is
 * a caller input; this module does not derive it from a browser camera.
 */
import {rotatorSin} from './coords.mjs';
import {x87load as X, x87int32 as I, x87add as A, x87neg as N,
  x87mul as M, x87div as D, x87store as S, x87storeDouble as Q} from './script-vm.mjs';

const io = new DataView(new ArrayBuffer(8));
const doubleFromBits = bits => {
  io.setBigUint64(0, BigInt(`0x${bits}`), true);
  return io.getFloat64(0, true);
};
const X64 = value => {
  io.setFloat64(0, value, true);
  const bits = io.getBigUint64(0, true), exponent = Number((bits >> 52n) & 0x7ffn);
  if (exponent === 0x7ff) throw new Error('Scene frame requires a finite double operand');
  const fraction = bits & ((1n << 52n) - 1n);
  return {neg: Number(bits >> 63n), sig: exponent ? fraction | (1n << 52n) : fraction,
    exp: exponent ? exponent - 1075 : -1074};
};
const double = value => {
  const rounded = Q(value);
  return (rounded.neg ? -1 : 1) * Number(rounded.sig) * 2 ** rounded.exp;
};
const HALF = X64(.5), DEG_HALF = X64(0.008726646259971648);
// Qword stores of original Core appTan's real-x87 extended return. These
// values are admitted measurements, not a replacement transcendental model.
const TANGENTS = new Map([
  [1, '3f81df645e10066f'], [30, '3fd126145e9ecd56'], [60, '3fe279a74590331c'],
  [75, '3fe88df153d6a676'], [90, '3fefffffffffffff'], [120, '3ffbb67ae8584ca8'],
  [170, '4026dc2fd0bfdbe5'],
].map(([fov, bits]) => [fov, doubleFromBits(bits)]));
export const sceneFrameMeasuredFovs = Object.freeze([...TANGENTS.keys()]);

const sub = (a, b) => A(a, N(b));
const dot = (v, axis) => S(A(A(M(v[0], X(axis[0])), M(v[1], X(axis[1]))), M(v[2], X(axis[2]))));

function viewCoords(rotation, location) {
  const [pitch, yaw, roll] = rotation;
  const s = rotatorSin, c = angle => s((angle + 0x4000) | 0);
  const passes = [
    [[0, 0, 0], [1, 0, 0], [0, c(roll), s(roll)], [0, -s(roll), c(roll)]],
    [[0, 0, 0], [c(pitch), 0, -s(pitch)], [0, 1, 0], [s(pitch), 0, c(pitch)]],
    [[0, 0, 0], [c(yaw), -s(yaw), 0], [s(yaw), c(yaw), 0], [0, 0, 1]],
  ];
  let fields = [[0, 0, 0], [0, 1, 0], [0, 0, -1], [1, 0, 0]];
  for (const matrix of passes) fields = fields.map((field, i) => {
    const value = i === 0 ? field.map((v, j) => sub(X(v), X(matrix[0][j]))) : field.map(X);
    return [dot(value, matrix[1]), dot(value, matrix[2]), dot(value, matrix[3])];
  });
  fields[0] = fields[0].map((v, i) => S(A(X(v), X(location[i]))));
  return fields.flat();
}

/** Normal perspective input: original camera location/rotation arrays,
 * physical integer viewport dimensions and Actor.FOVAngle. Optional appTan
 * service accepts the original qword argument and returns the original qword
 * result; without it only sceneFrameMeasuredFovs are admitted.
 */
export function buildWindowSceneFrame({location, rotation, width, height, fov, renderMode = 5, appTan}) {
  if (!Array.isArray(location) || location.length !== 3 || !location.every(v => Number.isFinite(Math.fround(v))))
    throw new Error('Scene frame requires three finite camera-location components');
  if (!Array.isArray(rotation) || rotation.length !== 3 || !rotation.every(v => Number.isInteger(v) && (v | 0) === v))
    throw new Error('Scene frame requires three int32 camera-rotation components');
  if (![width, height].every(v => Number.isInteger(v) && v > 0 && (v | 0) === v))
    throw new Error('Scene frame requires positive int32 physical dimensions');
  if (!Number.isInteger(renderMode) || [13, 14, 15].includes(renderMode))
    throw new Error('Orthographic scene-frame production is unsupported');
  fov = Math.fround(fov);
  let tangent = TANGENTS.get(fov);
  if (appTan) tangent = appTan(double(M(X(fov), DEG_HALF)));
  if (!Number.isFinite(tangent) || tangent <= 0)
    throw new Error(`Scene frame requires measured original appTan for FOV ${fov}`);
  const fx = S(I(width)), fy = S(I(height));
  return {coords: viewCoords(rotation, location), width: fx, height: fy,
    center: [S(M(I(width), HALF)), S(M(X(fy), HALF))],
    projectionZ: S(D(M(X(fx), HALF), X64(tangent)))};
}

/** Writes only the recovered fields consumed by native HUD projection. */
export function writeWindowSceneFrame(W, frame, input) {
  const value = buildWindowSceneFrame(input);
  W.setI32(frame, 0xa8, input.width); W.setI32(frame, 0xac, input.height);
  for (let i = 0; i < 12; i++) W.setF32(frame, 0x34 + i * 4, value.coords[i]);
  W.setF32(frame, 0xb8, value.width); W.setF32(frame, 0xbc, value.height);
  W.setF32(frame, 0xc8, value.center[0]); W.setF32(frame, 0xcc, value.center[1]);
  W.setF32(frame, 0xdc, value.projectionZ);
  return value;
}
