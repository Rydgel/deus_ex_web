/** UnrealScript in the render pass (docs/render-pass-precision.md
 * "UnrealScript in the render pass"). URender::PreRender sets x87 precision
 * control 24 (appEnableFastMath(1), 0x10b14629) and URender::PostRender
 * restores 64 (0x10b1472c); every script UGameEngine::Draw runs in between
 * (the PreRender, PostRenderFlash and PostRender events and the window
 * paint they drive, DrawWorld's RenderOverlays event and the render
 * iterators' Init) runs its float operators at 24 bits. The host runs those
 * calls inside `inRenderPass`, which sets the x87 model's precision control
 * in the JavaScript VM (script-vm.mjs), the Rust operator kernel the
 * JavaScript VM calls (script-vm-kernel.mjs) and the runtime's Rust
 * interpreter (interp.rs), and restores all three afterwards. The game
 * thread (ticks, physics, PlayerCalcView, Galaxy's Update) stays at 64. */
import { setX87Precision } from './script-vm.mjs';
import { scriptVmKernel } from './script-vm-kernel.mjs';

let depth = 0;
/** Measurement only (interleaved A/B of the precision's cost): `enabled`
 * false runs the wrapped calls at the game thread's 64 bits. */
export const renderPassControl = { enabled: true };

/** Run `fn()` at precision control 24 for `runtime`'s script engines. */
export function inRenderPass(runtime, fn) {
  if (depth++ || !renderPassControl.enabled) { try { return fn(); } finally { depth--; } }
  const interp = runtime?.scriptVm?.exports?.set_x87_precision ?? null;
  const kernel = scriptVmKernel?.setPrecision ?? null;
  setX87Precision(24); kernel?.(24); interp?.(24);
  try { return fn(); } finally { setX87Precision(64); kernel?.(64); interp?.(64); depth--; }
}

/** Whether a call is inside `inRenderPass` (validation and diagnostics). */
export const inRenderPassNow = () => depth > 0;
