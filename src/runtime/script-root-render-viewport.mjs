// Extension XRootWindow's render viewport (PreRender 0x1003a760, the frame
// edit at 0x1003a7dd..0x1003a8c5). Evidence: docs/conversation-camera.md
// "3D view clip"; validator: scripts/validate-root-render-viewport.mjs.
//
// The frame is the scene node's XB/YB (+0xb0/+0xb4) and X/Y (+0xa8/+0xac)
// in physical pixels before ComputeRenderSize. Without bRender (+0x5d8 bit
// 0) the size becomes 0 x 0 and the origin stays. With bClipRender (bit 1)
// the root's float renderX/Y/Width/Height (+0x5dc..+0x5e8) are scaled by the
// integer h/vMultiplier (+0x730/+0x734) and truncated by MSVCRT _ftol:
//   x0 = ftol(hm*renderX + XB)      y0 = ftol(vm*renderY + YB)
//   x1 = ftol(hm*renderWidth + x0)  y1 = ftol(vm*renderHeight + y0)
// with each product and sum on the x87 stack (FILD/FMUL m32/FIADD), then
// x0/y0 raised to XB/YB and x1/y1 lowered to X+XB/Y+YB (int32 sums, signed
// compares). vMultiplier passes through a float32 store first (FSTP/FLD m32
// at 0x1003a833).
//
// PreRender runs from the PreRender event, after URender::PreRender set x87
// precision control 24 (docs/render-pass-precision.md): the FILDs are exact,
// each FMUL and FIADD rounds to 24 bits with the register's wide exponent
// (x87-pc24.mjs), and _ftol truncates that value.
import { x87ftol, x87int32, x87load } from './script-vm.mjs';
import { p24add, p24mul } from './x87-pc24.mjs';

const f32 = Math.fround;
const scaled = (multiplier, value, base) => x87ftol(p24add(p24mul(multiplier, x87load(value)), x87int32(base)));

/** The frame after PreRender's edit: {render, x, y, width, height} with the
 * incoming frame {x, y, width, height} (XB, YB, X, Y). */
export function rootRenderViewport(W, root, frame) {
  const flags = W.u32(root, 0x5d8);
  if (!(flags & 1)) return { render: false, x: frame.x, y: frame.y, width: 0, height: 0 };
  if (!(flags & 2)) return { render: true, ...frame };
  const hm = x87int32(W.i32(root, 0x730)), vm = x87load(f32(W.i32(root, 0x734)));
  const xb = frame.x | 0, yb = frame.y | 0;
  let x0 = scaled(hm, W.f32(root, 0x5dc), xb);
  let y0 = scaled(vm, W.f32(root, 0x5e0), yb);
  let x1 = scaled(hm, W.f32(root, 0x5e4), x0);
  let y1 = scaled(vm, W.f32(root, 0x5e8), y0);
  if (x0 < xb) x0 = xb;
  if (y0 < yb) y0 = yb;
  const right = (frame.width + xb) | 0, bottom = (frame.height + yb) | 0;
  if (x1 > right) x1 = right;
  if (y1 > bottom) y1 = bottom;
  return { render: true, x: x0, y: y0, width: (x1 - x0) | 0, height: (y1 - y0) | 0 };
}
