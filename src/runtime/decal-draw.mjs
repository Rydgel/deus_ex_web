/** URender::DrawFrame's decal block on the simulation side (docs/decals.md
 * "Drawing"). After the main frame's OccludeBsp, ClipDecal runs in the Rust
 * core over every saved polygon of each drawn surface that holds decals
 * (decal.rs `decal_clip_frame`); each nonempty fragment stamps its actor's
 * LastRenderedTime with Level.TimeSeconds (script-visible: DeusExDecal.Timer
 * destroys decals not drawn for a second) and becomes plain data for the
 * page's modulated fan pass (decal-scene.mjs): view-space triangles and the
 * D3D texture coordinates `tu = U · f(1/f(USize·Scale))`, U the in-plane
 * distance over DrawScale.
 *
 * The fragments keep the decal block's order (decal.rs decal_clip_frame:
 * within a draw item each FDecal in TArray order, then each saved polygon)
 * and travel as runs of one texture, which the page draws one after another:
 * `2·texel·dst` rounds and clamps on the 8-bit target, so two overlapping
 * decals of different textures do not commute.
 *
 * Host choices, noted: the draw items come in the occlusion stream's order,
 * not DrawFrame's three lists (portals reversed, occluding sorted by Key,
 * non-occluding as linked: 0x10b1a404..0x10b1a45f); fragments of different
 * items overlap on screen only where coplanar surfaces overlap. Mirror and
 * sky child frames draw no decals (mirrors never do; sky children are not
 * run). */
import { toView } from '../unreal/geometry.mjs';
import { readTexture } from '../unreal/textures.mjs';
import { identityOfHandle } from './script-object-handles.mjs';
import { followDecalTracker, levelDecals } from './script-decal.mjs';

const f = Math.fround;
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const num = b => (u32[0] = b, f32[0]);

export function createDecalDraw(runtime, kernel) {
  let out = 0, cap = 0;
  const textures = new Map();
  const read = (object, name) => runtime.readNamed(object, name);
  function textureInfo(reference) {
    const key = reference.key ?? `${reference.asset?.name}:${reference.index}`;
    let info = textures.get(key);
    if (!info) {
      const values = readTexture(reference.asset, reference.index).values;
      // UTexture::Lock's UScale at LOD 0 is Scale; SetTexture's UMult and
      // VMult (D3DDrv 0x10008e15) are f(1/f(Size·Scale)).
      const scale = f(values.DrawScale ?? values.Scale ?? 1);
      info = { key, texture: { key: reference.key ?? null, package: reference.asset?.name, index: reference.index },
        uMult: f(1 / f(values.USize * scale)), vMult: f(1 / f(values.VSize * scale)) };
      textures.set(key, info);
    }
    return info;
  }
  return {
    /** Whether `level` has FDecals to draw: Client.Decals and a nonempty
     * store (the occlusion then saves its polygons' points). */
    wanted(level) {
      return Boolean(level?.decals && level.decals.store.count > 0 && level.engine?.client?.decals);
    },
    /** One frame: `stream` the occlusion's output (`{at, words}`), `framePtr`
     * its frame words, `viewer` the viewport actor. Returns the runs of one
     * texture in draw order ({texture, positions, uvs}, view space,
     * triangles). */
    frame(level, viewer, framePtr, stream) {
      // The tracker came after the first AttachDecal: its model now.
      const decals = level.decalSource !== level.decals.source ? levelDecals(level) : level.decals, info = level.actors[0];
      // FDecals on the moving brush tracker's surfaces: their base points
      // where the last Update left them, and their Movers' Rotation now.
      if (decals.source && decals.store.anyFrom(decals.source.firstSurface)) followDecalTracker(decals);
      let words;
      for (;;) {
        if (!cap) { cap = 1 << 14; out = kernel.alloc(4 * cap); }
        words = kernel.clipFrame(decals.model.base, decals.store.address, framePtr, stream.at, stream.words, out, cap);
        if (words !== 0xffffffff) break;
        kernel.free(out); cap *= 2; out = kernel.alloc(4 * cap);
      }
      if (words === 0xfffffffe) throw new Error('ClipDecal fault (decal.rs)');
      if (!words) return [];
      const data = new Uint32Array(kernel.memory.buffer, out, words);
      const time = f(read(info, 'TimeSeconds'));
      const sprite = (() => { try { return read(viewer, 'Sprite'); } catch { return null; } })();
      const defaultTexture = read(info, 'DefaultTexture');
      const runs = [], stamped = new Set();
      let run = null;
      for (let i = 0; i < words;) {
        const handle = data[i], count = data[i + 2];
        const at = i + 3;
        i = at + 5 * count;
        const actor = identityOfHandle(handle);
        if (!actor) continue;
        // 0x10b1b271: LastRenderedTime = Decal->Actor->Level->TimeSeconds.
        if (!stamped.has(actor)) { runtime.writeNamed(actor, 'LastRenderedTime', time); stamped.add(actor); }
        const reference = sprite ?? read(actor, 'Texture') ?? defaultTexture;
        if (!reference) continue;
        const tex = textureInfo(reference), drawScale = f(read(actor, 'DrawScale'));
        if (run?.key !== tex.key) runs.push(run = { key: tex.key, texture: tex.texture, positions: [], uvs: [] });
        const vertex = k => {
          const o = at + 5 * k;
          run.positions.push(...toView([num(data[o]), num(data[o + 1]), num(data[o + 2])]));
          run.uvs.push(f(f(num(data[o + 3]) / drawScale) * tex.uMult), f(f(num(data[o + 4]) / drawScale) * tex.vMult));
        };
        // D3DPT_TRIANGLEFAN of the ClipDecal points in order.
        for (let k = 1; k + 1 < count; k++) { vertex(0); vertex(k); vertex(k + 1); }
      }
      return runs.map(r => ({ texture: r.texture, positions: Float32Array.from(r.positions), uvs: Float32Array.from(r.uvs) }));
    },
    dispose() { if (out) kernel.free(out); out = 0; cap = 0; },
  };
}
