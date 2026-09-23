/** Original Extension.dll Window.ConvertVectorToCoordinates (native 1489).
 *
 * SHA256 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c:
 * exec 0x10054030 evaluates vector and two out floats, then calls vtable+0x5c.
 * Window body 0x1004faf0 delegates to its parent, subtracts local X/Y and returns
 * the parent's visibility. A parentless ordinary window returns half dimensions
 * and false. Root override 0x10039f10 transforms with frame+0x34 FCoords and
 * tests stored Z > double 1.0 (0x100613e0). For visible points it stores float32
 * frame.Proj.Z/Z, projects each axis, divides by the integer root multiplier,
 * adds root rendering origin, _ftol-truncates, then stores integer -> float32.
 * Behind/near-plane points instead return truncated frame center without root
 * scaling/offset, false. There is no horizontal/vertical viewport containment
 * test. All subtract/product/add intermediates stay x87 until the named stores.
 *
 * Host contract: raw W field access, W.v.convertVectorToCoordinates(parent,v)
 * for the parent virtual. Root+0x740 must point to a real frame image: Coords at
 * +0x34, FX2/FY2 +0xc8/+0xcc, Proj.Z +0xdc. This translation does not construct
 * a FSceneNode or substitute the browser camera projection. XViewportWindow's
 * distinct 0x1004afc0 override is not implemented here.
 *
 * Original reference cases captured before translation under ignored
 * .cache/hud-layout-20260923/native-projection.py: identity/non-identity coords,
 * near/front/behind, unequal integer scale, offset, nested windows, no parent.
 */
import {x87load as X, x87int32 as I, x87add as A, x87neg as N,
  x87mul as M, x87div as D, x87store as S, x87ftol as T} from './script-vm.mjs';
const subtract = (a, b) => A(a, N(b));

export function rootVectorToCoordinates(W, root, vector) {
  const frame = W.ptr(root, 0x740);
  if (!frame) return W.boundary('XRootWindow::ConvertVectorToCoordinates requires its original FSceneNode (0x10039f30)');
  const relative = vector.map((value, axis) => subtract(X(value), X(W.f32(frame, 0x34 + axis * 4))));
  const transformed = [0, 1, 2].map(axis => {
    const products = relative.map((value, component) => M(value, X(W.f32(frame, 0x40 + axis * 12 + component * 4))));
    return S(A(A(products[0], products[1]), products[2]));
  });
  const visible = transformed[2] > 1;
  if (!visible) return {
    visible: false,
    x: S(I(T(X(W.f32(frame, 0xc8))))),
    y: S(I(T(X(W.f32(frame, 0xcc))))),
  };
  const scale = S(D(X(W.f32(frame, 0xdc)), X(transformed[2])));
  const project = axis => {
    const pixel = A(M(X(transformed[axis]), X(scale)), X(W.f32(frame, 0xc8 + axis * 4)));
    const logical = A(D(pixel, I(W.i32(root, 0x730 + axis * 4))), X(W.f32(root, 0x5dc + axis * 4)));
    return S(I(T(logical)));
  };
  return {visible: true, x: project(0), y: project(1)};
}

export function windowVectorToCoordinates(W, win, vector) {
  const parent = W.ptr(win, 0x138);
  if (!parent) return {visible: false,
    x: S(M(X(W.f32(win, 0x80)), X(.5))), y: S(M(X(W.f32(win, 0x84)), X(.5)))};
  const result = W.v.convertVectorToCoordinates(parent, vector.map(Math.fround));
  return {visible: result.visible,
    x: S(subtract(X(result.x), X(W.f32(win, 0x78)))),
    y: S(subtract(X(result.y), X(W.f32(win, 0x7c))))};
}
