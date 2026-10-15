/**
 * The viewport flash: what UGameEngine::Draw hands the render device and what D3DDrv's EndFlash draws
 * (docs/screen-flash.md).
 *
 * viewportFlash is UGameEngine::Draw 0x1038f110, 0x1038f36e..0x1038f54e: unless the gate fails, the player's
 * FlashScale (APlayerPawn+0x610) is halved and its FlashFog (+0x61c) taken, each of the six components clamped to
 * [0, 1] (NaN to 0), the planes' W zero; the gate is `Level.NetMode != 0 || Client.ScreenFlashes` (ALevelInfo+0x518,
 * UClient+0x44, DeusEx.ini WindowsClient ScreenFlashes=True) and the failing branch hands (0.5, 0.5, 0.5, 0) and
 * (0, 0, 0, 0), the neutral flash. The planes go through UViewport::Lock into the render device, which keeps them
 * (this+0xa48 FlashScale, +0xa58 FlashFog).
 *
 * endFlash is UD3DRenderDevice::EndFlash 0x10007c90 (vtable +0xa4, called at Draw 0x1038f714 after the PostRenderFlash
 * event, which paints the HUD windows, and before the PostRender event): compared with the unchanged D3DDrv.dll body by
 * scripts/validate-d3d-endflash.mjs (scripts/native-d3d-endflash-oracle.py).
 */
const f32 = Math.fround;
const clamp01 = v => (!(v >= 0) ? 0 : v < 1 ? v : 1);

export const SCREEN_FLASH = Object.freeze({
  draw: 0x1038f110, derive: 0x1038f36e, endFlashCall: 0x1038f714, endFlashSlot: 0xa4,
  endFlashThunk: 0x10001064, endFlashBody: 0x10007c90, endFlashEnd: 0x100080ab,
  scaleOffset: 0x610, fogOffset: 0x61c,
  // The vertex buffer: the quad's first vertex is index this+0xd0 (then +4); past 0x1f40 the buffer is discarded.
  bufferLimit: 0x1f40, lockFlags: 0x1800, lockFlagsDiscard: 0x2800,
});

/** The planes Draw passes to Lock: `{scale: [x, y, z, 0], fog: [x, y, z, 0]}`. */
export function viewportFlash({flashScale, flashFog, netMode = 0, screenFlashes = true}) {
  if (netMode === 0 && !screenFlashes) return {scale: [0.5, 0.5, 0.5, 0], fog: [0, 0, 0, 0]};
  return {
    scale: [...flashScale.slice(0, 3).map(v => clamp01(f32(f32(v) * 0.5))), 0],
    fog: [...flashFog.slice(0, 3).map(v => clamp01(f32(v))), 0],
  };
}

// fistp rounds to nearest even (the x87 control word the render pass runs under).
function roundEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
// `v * 256 - 0.5` stored as a float and rounded by fistp, clamped to a byte (the appFloor idiom of D3DDrv's colours).
function colourByte(v) {
  const n = roundEven(f32(f32(v) * 256) - 0.5);
  return n < 0 ? 0 : n >= 0xff ? 0xff : n;
}

/** EndFlash's gate: the neutral flash (scale 0.5 in x, y and z by bit pattern, everything else zero) draws nothing. */
export function flashIsNeutral(scale, fog) {
  const half = v => v === 0.5;
  return half(scale[0]) && half(scale[1]) && half(scale[2]) && scale[3] === 0 && fog.every(v => v === 0);
}

/** The D3DCOLOR (A<<24 | R<<16 | G<<8 | B) of the quad: fog RGB, alpha min(2 * scale.x, 1). */
export function flashColour(scale, fog) {
  const doubled = f32(scale[0] * 2);
  const alpha = doubled > 1 ? 1 : doubled;
  const a = colourByte(alpha), r = colourByte(fog[0]), g = colourByte(fog[1]), b = colourByte(fog[2]);
  return {a, r, g, b, d3dColor: ((a << 24) | (r << 16) | (g << 8) | b) >>> 0};
}

/**
 * EndFlash's work for one frame. `device` holds the members the body reads: the vertex-buffer cursor
 * (`index` = this+0xcc, `offset` = this+0xd0), `normalColorOp`/`normalAlphaOp` (this+0xa00/0xa04) and the projection
 * terms `z33`, `z43` (this+0xa30/0xa40). Returns the device calls, the four vertices and the cursor after.
 */
export function endFlash({scale, fog, sizeX, sizeY, device}) {
  if (flashIsNeutral(scale, fog)) return {drawn: false, calls: [], vertices: [], index: device.index, offset: device.offset};
  const {d3dColor, a, r, g, b} = flashColour(scale, fog);
  let index = device.offset, offset = device.offset + 4, flags = SCREEN_FLASH.lockFlags;
  if (offset > SCREEN_FLASH.bufferLimit) { index = 0; offset = 4; flags = SCREEN_FLASH.lockFlagsDiscard; }
  const z = f32(f32(f32(device.z43) * 0.5) + f32(device.z33));
  const corner = (x, y) => ({x, y, z, rhw: 0.5, color: d3dColor});
  return {
    drawn: true, colour: {a, r, g, b}, index, offset,
    vertices: [corner(0, 0), corner(0, sizeY), corner(sizeX, sizeY), corner(sizeX, 0)],
    calls: [
      ['Lock', flags], ['SetBlending', 0x47],
      // ALPHABLENDENABLE on, SRCBLEND ONE, DESTBLEND SRCALPHA; texture stage 0 colour op DISABLE, alpha op SELECTARG2; ZFUNC ALWAYS.
      ['SetRenderState', 27, 1], ['SetRenderState', 19, 2], ['SetRenderState', 20, 5],
      ['SetTextureStageState', 0, 1, 1], ['SetTextureStageState', 0, 4, 3], ['SetRenderState', 23, 8],
      ['Unlock'], ['DrawPrimitiveVB', 6, 'VB', index, 4, 0],
      ['SetTextureStageState', 0, 1, device.normalColorOp], ['SetTextureStageState', 0, 4, device.normalAlphaOp],
      ['SetRenderState', 23, 4], ['SetBlending', 0],
    ],
  };
}
