/** Consumed FSceneNode fields from original Engine ComputeRenderCoords/Size.
 * Engine bodies 0x10372580/0x10372980, Core rotation body 0x1011b690.
 * See docs/script-window-scene-frame.md for instructions, hardware tangent
 * evidence, and the deliberately limited frame surface. Camera production is
 * a caller input; this module does not derive it from a browser camera.
 */
import {rotatorSin} from './coords.mjs';
import {x87TanCandidates} from './x87-tan.mjs';
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
// Qword stores of original Core appTan's real-x87 extended return, measured
// first; every other FOV takes x87-tan.mjs, checked against these and against
// 208,181 real FPTAN results (docs/x87-tan.md).
const TANGENTS = new Map([
  [1, '3f81df645e10066f'], [30, '3fd126145e9ecd56'], [60, '3fe279a74590331c'],
  [75, '3fe88df153d6a676'], [90, '3fefffffffffffff'], [120, '3ffbb67ae8584ca8'],
  [170, '4026dc2fd0bfdbe5'],
].map(([fov, bits]) => [fov, doubleFromBits(bits)]));
export const sceneFrameMeasuredFovs = Object.freeze([...TANGENTS.keys()]);

const sub = (a, b) => A(a, N(b));
const dot = (v, axis) => S(A(A(M(v[0], X(axis[0])), M(v[1], X(axis[1]))), M(v[2], X(axis[2]))));

/** Core FCoords::operator/=(FRotator) (0x1011b690): the roll, pitch and yaw
 * passes over [Origin, XAxis, YAxis, ZAxis], each row stored as float32. */
function divideRotator(fields, rotation) {
  const [pitch, yaw, roll] = rotation;
  const s = rotatorSin, c = angle => s((angle + 0x4000) | 0);
  const passes = [
    [[0, 0, 0], [1, 0, 0], [0, c(roll), s(roll)], [0, -s(roll), c(roll)]],
    [[0, 0, 0], [c(pitch), 0, -s(pitch)], [0, 1, 0], [s(pitch), 0, c(pitch)]],
    [[0, 0, 0], [c(yaw), -s(yaw), 0], [s(yaw), c(yaw), 0], [0, 0, 1]],
  ];
  for (const matrix of passes) fields = fields.map((field, i) => {
    const value = i === 0 ? field.map((v, j) => sub(X(v), X(matrix[0][j]))) : field.map(X);
    return [dot(value, matrix[1]), dot(value, matrix[2]), dot(value, matrix[3])];
  });
  return fields;
}

/** GMath.UnitCoords / rotation: {origin, xAxis, yAxis, zAxis}. */
export function coordsDivideRotator(rotation) {
  const [origin, xAxis, yAxis, zAxis] = divideRotator([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], rotation);
  return {origin, xAxis, yAxis, zAxis};
}

function viewCoords(rotation, location) {
  const fields = divideRotator([[0, 0, 0], [0, 1, 0], [0, 0, -1], [1, 0, 0]], rotation);
  fields[0] = fields[0].map((v, i) => S(A(X(v), X(location[i]))));
  return fields.flat();
}

/** Normal perspective input: original camera location/rotation arrays,
 * physical integer viewport dimensions and Actor.FOVAngle. Optional appTan
 * service accepts the original qword argument and returns the original qword
 * result; without it x87TanCandidates gives it. The tangent reaches the frame
 * only through the float32 projectionZ, so when FPTAN could store either of
 * two doubles both are tried and must agree there.
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
  const argument = double(M(X(fov), DEG_HALF));
  const tangents = appTan ? [appTan(argument)] : TANGENTS.has(fov) ? [TANGENTS.get(fov)] : x87TanCandidates(argument);
  if (!tangents || !tangents.every(t => Number.isFinite(t) && t > 0))
    throw new Error(`Scene frame requires the original appTan for FOV ${fov}`);
  const fx = S(I(width)), fy = S(I(height));
  const projections = new Set(tangents.map(t => S(D(M(X(fx), HALF), X64(t)))));
  if (projections.size !== 1)
    throw new Error(`Scene frame FOV ${fov}: FPTAN's last bit decides projectionZ, which is unmeasured`);
  return {coords: viewCoords(rotation, location), width: fx, height: fy,
    center: [S(M(I(width), HALF)), S(M(X(fy), HALF))],
    projectionZ: [...projections][0]};
}

/** Core appTan's qword result for Actor.FOVAngle `fov` as ComputeRenderSize
 * calls it: the measured value, else the first FPTAN candidate (both
 * candidates give the same float32 Proj.Z, the only use; buildWindowSceneFrame
 * checks that). */
export function sceneFrameTangent(fov) {
  fov = Math.fround(fov);
  if (TANGENTS.has(fov)) return TANGENTS.get(fov);
  const tangents = x87TanCandidates(double(M(X(fov), DEG_HALF)));
  if (!tangents?.length) throw new Error(`Scene frame requires the original appTan for FOV ${fov}`);
  return tangents[0];
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
