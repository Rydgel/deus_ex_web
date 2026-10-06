/** The inputs scripts/native-occlusion-oracle.py and the Rust port share
 * (validate-bsp-occlusion.mjs, validate-sprite-setup.mjs): a decoded map's
 * compiled model as the oracle's fixture request, each surface texture's
 * PolyFlags, and Core appTan's measured results for the frame producer. */
import { readTexture } from '../src/unreal/textures.mjs';
import { buildWindowSceneFrame } from '../src/runtime/script-window-scene-frame.mjs';
import { texturePolyFlags } from '../src/runtime/bsp-occlusion.mjs';

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export const bits = value => (f32[0] = value, u32[0]);

/** Core appTan's measured qword results for FOV 75 and 90 (the table in
 * script-window-scene-frame.mjs), keyed by the double argument the frame
 * producer passes, for the oracle's Engine ComputeRenderSize. */
export function occlusionTangents() {
  const tangents = {}, io = new DataView(new ArrayBuffer(8));
  for (const [fov, result] of [[75, '3fe88df153d6a676'], [90, '3fefffffffffffff']])
    buildWindowSceneFrame({ location: [0, 0, 0], rotation: [0, 0, 0], width: 64, height: 64, fov, appTan: argument => {
      io.setFloat64(0, argument, true);
      tangents[io.getBigUint64(0, true).toString(16).padStart(16, '0')] = result;
      io.setBigUint64(0, BigInt(`0x${result}`), true);
      return io.getFloat64(0, true);
    } });
  return tangents;
}

/** Each surface's texture PolyFlags (0 without a texture). */
export async function surfaceTextureFlags(assets, asset, model) {
  const textureFlags = new Map(), flags = [];
  for (const surface of model.surfaces) {
    if (!surface.texture) { flags.push(0); continue; }
    if (!textureFlags.has(surface.texture)) {
      const object = await assets.resolve(asset, surface.texture);
      textureFlags.set(surface.texture, texturePolyFlags(readTexture(object.asset, object.index).values));
    }
    flags.push(textureFlags.get(surface.texture));
  }
  return flags;
}

/** The oracle request's `model`. */
export function occlusionModelRequest(model, textureFlags) {
  const zoneActors = [...new Set(model.zones.map(z => z.actor).filter(a => a > 0))].map(index => ({ index }));
  return {
    nodes: model.nodes.map(n => ({ planeBits: n.plane.map(bits), zoneMask: n.zoneMask, vertexPool: n.vertexPool,
      surface: n.surface, back: n.back, front: n.front, coplanar: n.coplanar, collisionBound: n.collisionBound,
      renderBound: n.renderBound, zones: n.zones, vertexCount: n.vertexCount, flags: n.flags, leaves: n.leaves })),
    verts: model.vertices.map(v => [v.point, v.side]), pointBits: model.points.map(p => p.map(bits)),
    surfs: model.surfaces.map((s, i) => ({ texture: i, flags: s.flags >>> 0 })),
    textures: textureFlags.map(polyFlags => ({ polyFlags })),
    boundBits: model.renderBounds.map(b => [...b.min.map(bits), ...b.max.map(bits), b.valid ? 1 : 0]),
    zones: model.zones.map(z => ({ actor: z.actor })), zoneActors, rootOutside: model.rootOutside, numZones: model.zones.length,
  };
}
