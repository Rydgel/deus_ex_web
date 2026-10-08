/** The x87 precision control the host's x87 models round to (a leaf
 * module, so that modules the script VM imports can read it): 64 bits on
 * the game thread, 24 inside URender::PreRender..PostRender, where the host
 * runs the render events' UnrealScript (docs/render-pass-precision.md
 * "UnrealScript in the render pass", render-precision.mjs). script-vm.mjs's
 * FADD, FSUB, FMUL, FDIV and FSQRT round their exact result once to this
 * width; loads, stores, compares and FTOL are unaffected. */
export let x87Precision = 64;
export const x87PrecisionControl = () => x87Precision;
/** Set the precision control (24 or 64); returns the previous one. */
export const setX87Precision = bits => { const previous = x87Precision; x87Precision = bits === 24 ? 24 : 64; return previous; };
