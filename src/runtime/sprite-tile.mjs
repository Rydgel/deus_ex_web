/** The tile a sprite becomes (docs/frame-projection.md "Sprites"): the CPU
 * reference for src/viewer/sprite-tile-glsl.mjs. One `Math.fround` per x87
 * operation of the render pass (precision control 24, as frame-projection.mjs).
 *
 *   spriteIcon     URender::DrawActorSprite (Render.dll 0x10b25080): the
 *                  rectangle it hands UCanvas::DrawIcon from the sprite's
 *                  FDynamicSprite (Z, ScreenX, ScreenY, Persp, DrawScale)
 *   canvasTile     UCanvas::DrawIcon -> UCanvas::DrawTile (Engine 0x10376640,
 *                  0x10376160): the clip to [0, FX] x [0, FY] and the U/V scale
 *   deviceVertices UD3DRenderDevice::DrawTile (D3DDrv 0x10005ba0): the four
 *                  vertices of the triangle fan
 *
 * validate-sprite-tiles compares each stage with the unchanged original under
 * Unicorn (scripts/native-sprite-draw-oracle.py). */
import { depthConstants } from './frame-projection.mjs';

const f = Math.fround;

/** DrawActorSprite's tile (0x10b253c6..0x10b254b9). `texture` has the
 * UTexture's `usize`/`vsize`; `sprite` the FDynamicSprite's `screenX`,
 * `screenY`, `persp` (Setup's) and `drawScale` (SetupSprite's copy). */
export function spriteIcon(sprite, texture) {
  const xl = f(f(texture.usize * sprite.persp) * sprite.drawScale), yl = f(f(texture.vsize * sprite.persp) * sprite.drawScale);
  return { x: f(sprite.screenX - f(xl * 0.5)), y: f(sprite.screenY - f(yl * 0.5)), xl, yl };
}

/** UCanvas::DrawIcon hands DrawTile the texture's size as the source rectangle
 * (U = V = 0), and DrawTile (0x10376160) clips the rectangle to the frame's
 * [0, FX] x [0, FY] moving the source rectangle with it, then scales it by
 * Texture->Lock's `(Info.USize * Info.UScale) / Texture.USize` (V alike).
 * Returns null where DrawTile returns without calling the device. `frame` has
 * `fx`, `fy` (Frame->FX, FY); `texture` `usize`, `vsize`, `infoUSize`,
 * `infoVSize`, `uScale`, `vScale` (Info.UScale/VScale). */
export function canvasTile(icon, frame, texture) {
  let { x, y, xl, yl } = icon, u = 0, v = 0, ul = f(texture.usize), vl = f(texture.vsize);
  if (!(xl > 0) || !(yl > 0)) return null;
  const x2 = f(x + xl), y2 = f(y + yl);
  if (!(x2 > 0) || !(y2 > 0)) return null;
  if (!(x < frame.fx) || !(y < frame.fy)) return null;
  if (x < 0) {
    const t = f(f(x * ul) / xl);
    x = 0; xl = x2; u = f(u - t); ul = f(t + ul);
  }
  if (y < 0) {
    const t = f(f(y * vl) / yl);
    y = 0; yl = y2; v = f(v - t); vl = f(t + vl);
  }
  const dx = f(frame.fx - x);
  if (xl > dx) { ul = f(f(f(f(dx - xl) * ul) / xl) + ul); xl = dx; }
  const dy = f(frame.fy - y);
  if (yl > dy) { vl = f(f(f(f(dy - yl) * vl) / yl) + vl); yl = dy; }
  const fu = f(f(texture.infoUSize * texture.uScale) / texture.usize), fv = f(f(texture.infoVSize * texture.vScale) / texture.vsize);
  u = f(u * fu); ul = f(ul * fu); v = f(v * fv); vl = f(vl * fv);
  return { x, y, xl, yl, u, v, ul, vl };
}

/** SetTexture's stage multipliers (D3DDrv 0x10008e63..0x10008e94) and the
 * slots U and V land in (0x10008e24..0x10008e49: swapped when the texture is
 * taller than wide: the D3D texture is transposed, the logical coordinates
 * are the same). */
export function stageScale(texture) {
  return { uMult: f(1 / f(texture.infoUSize * texture.uScale)), vMult: f(1 / f(texture.infoVSize * texture.vScale)),
    uSlot: texture.infoUSize < texture.infoVSize ? 1 : 0, vSlot: texture.infoUSize < texture.infoVSize ? 0 : 1 };
}

/** D3DDrv's DrawTile (0x10005ba0): RHW = 1 / Z, depth = RHW * _43 + _33, X = (XB -
 * 0.5) + x, Y = (YB - 0.5) + y, and the fan (X, Y), (X, Y + YL), (X + XL, Y +
 * YL), (X + XL, Y) with the source corners scaled by UMult and VMult.
 * `frame` has `xb`, `yb`; returns `{x, y, z, rhw, u, v}` per vertex, (u, v) the
 * logical texture coordinates. */
export function deviceVertices(tile, z, frame, depth, texture) {
  const { uMult, vMult } = stageScale(texture);
  const rhw = f(1 / z), sz = f(f(rhw * depth.zScale) + depth.zBias);
  const x0 = f(f(frame.xb - 0.5) + tile.x), y0 = f(f(frame.yb - 0.5) + tile.y);
  const x1 = f(x0 + tile.xl), y1 = f(y0 + tile.yl);
  const u0 = f(tile.u * uMult), v0 = f(tile.v * vMult);
  const u1 = f(f(tile.u + tile.ul) * uMult), v1 = f(f(tile.v + tile.vl) * vMult);
  return [{ x: x0, y: y0, z: sz, rhw, u: u0, v: v0 }, { x: x0, y: y1, z: sz, rhw, u: u0, v: v1 },
    { x: x1, y: y1, z: sz, rhw, u: u1, v: v1 }, { x: x1, y: y0, z: sz, rhw, u: u1, v: v0 }];
}

/** From the canvas on: the four vertices of a rectangle handed to UCanvas::DrawIcon
 * at depth `z`, or null where DrawTile draws nothing. A sprite's rectangle is
 * DrawActorSprite's (`spriteIcon`) with the sprite's camera-space Z; a light
 * corona's is DrawFrame's own `{ x, y, xl: size, yl: size }` (coronas.mjs
 * coronaIcon) with Z 1.0 (Render.dll 0x10b1bac7, `push 0x3f800000`), whose
 * depth `1 * _43 + _33` is 0 (docs/coronas.md "On the tile chain"). */
export function iconVertices(icon, z, texture, frame, depth = depthConstants(32)) {
  const tile = canvasTile(icon, frame, texture);
  return tile ? { icon, tile, vertices: deviceVertices(tile, z, frame, depth, texture) } : null;
}

/** The whole chain: a sprite's four vertices, or null where DrawTile draws nothing. */
export function spriteVertices(sprite, texture, frame, depth = depthConstants(32)) {
  return iconVertices(spriteIcon(sprite, texture), sprite.z, texture, frame, depth);
}
