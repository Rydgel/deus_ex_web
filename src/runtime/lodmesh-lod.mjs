/** URender::DrawLodMesh's distance LOD (Render.dll 607f1077…; docs/script-lodmesh-lod.md):
 * the selection 0x10b0eb52..0x10b0ed53, the post-frame morph
 * 0x10b0ee34..0x10b0ef6e and the reduced face admission and wedge collapse
 * 0x10b0fc6f..0x10b0fe60 (the full-resolution corners 0x10b10123..0x10b101e8).
 *
 * DrawLodMesh runs inside the render pass at x87 precision control 24
 * (docs/render-pass-precision.md): every FADD, FSUB, FMUL and FDIV rounds to a
 * 24-bit significand with the x87's wide exponent. Values here are doubles
 * holding such 24-bit values: `r24(a op b)` for two of them, `r24prod` and
 * `r24sum` for a double constant operand (the exact result rounded once),
 * `f` (Math.fround) where the original stores a float. Comparisons use the
 * unstored values, as the original's FCOMP does. This is the reference;
 * native/lodmesh-kernel ports it. */
import {r24, r24prod, r24sum} from './x87-pc24.mjs';
import {x87TanFloatCandidates} from './x87-tan.mjs';
import {LodMeshError} from './lodmesh.mjs';

const f = Math.fround;
const bits = new DataView(new ArrayBuffer(4));
export const floatBits = value => { bits.setFloat32(0, value, true); return bits.getUint32(0, true); };
export const bitsFloat = word => { bits.setUint32(0, word >>> 0, true); return bits.getFloat32(0, true); };

/** URender::Init's LOD settings (0x10b134d7..0x10b134ef): +40 the shape LOD
 * distance (console MLOD), +44 its adjustment (no writer), +48 the shape LOD
 * mode (MLMODE; bit 0 allows morphing, 0 uses the fixed scale, 3 and above
 * drop the FOV factor), +4c the fixed scale (MLFIX). No config property
 * overrides them (URender::StaticConstructor is empty). */
export const RENDER_LOD_SETTINGS = Object.freeze({shapeLOD: 0.25, adjust: 1, mode: 1, fix: 1});

const HALF_DEGREE = 0.008726646259971648; // 0x10b2ac48 (PI/360)
const COMPLEXITY = f(0.003); // 0x10b2ac44
const SCREEN = 0.0010937499999999999; // 0x10b2ac38 (double)
const SCREEN_BASE = 0.3; // 0x10b2a750 (double)
const DISTANCE = 430; // 0x10b2ac30

/** FISTP under the round-to-nearest control: nearest-even, or the integer
 * indefinite 0x80000000 for NaN and out-of-range values. */
export function fistp(x) {
  if (!Number.isFinite(x)) return -0x80000000;
  const lo = Math.floor(x), fraction = x - lo;
  const result = fraction < 0.5 ? lo : fraction > 0.5 ? lo + 1 : (lo % 2 === 0 ? lo : lo + 1);
  return result >= -0x80000000 && result <= 0x7fffffff ? result : -0x80000000;
}

/** appTan's argument at 0x10b0ebc1..0x10b0ebcd: the float FOV times the
 * double PI/360 rounded once to 24 bits, stored as a double (exact). */
export const lodMeshTanArgument = fov => r24prod(f(fov), HALF_DEGREE);

/** The float the FSTP m32 at 0x10b0ebe2 stores for Actor.FovAngle `fov`:
 * the extended FPTAN result rounded once (x87TanFloatCandidates, measured on
 * real FPTAN by scripts/validate-x87-tan-hardware.mjs). Throws for a FOV
 * whose tangent the model cannot decide or outside (0, 180). */
export function lodMeshTanFactor(fov) {
  const candidates = x87TanFloatCandidates(lodMeshTanArgument(fov));
  if (!candidates) throw new LodMeshError(`DrawLodMesh FOV ${fov} is outside the measured appTan domain`);
  if (candidates.length !== 1) throw new LodMeshError(`DrawLodMesh FOV ${fov} has an undecided appTan float`);
  return candidates[0];
}

const u16 = (array, label) => {
  if (!array || array.elementSize !== 2) throw new LodMeshError(`Invalid original LOD array ${label}`);
  const view = new DataView(array.data.buffer, array.data.byteOffset, array.data.byteLength), out = new Uint16Array(array.num);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true);
  return out;
};
const u32 = (array, size, label) => {
  if (!array || array.elementSize !== size) throw new LodMeshError(`Invalid original LOD array ${label}`);
  const view = new DataView(array.data.buffer, array.data.byteOffset, array.data.byteLength), out = new Uint32Array(array.num * size / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true);
  return out;
};

/** The ULodMesh fields DrawLodMesh's LOD reads, from a decoded payload
 * (lodmesh-payload.mjs): ModelVerts +180, SpecialVerts +184, MeshScaleMax
 * +188, LODStrength +18c (its raw bits gate the LOD), LODMinVerts +190,
 * LODMorph +194, LODZDisplace +198; CollapsePointThus +12c, FaceLevel +138,
 * Faces +144 (four words each: three wedges, material), CollapseWedgeThus
 * +150 and Wedges +15c (vertex word, U and V bytes, as one dword). */
export function lodMeshTopology(mesh) {
  const scalar = offset => mesh.scalarBits.get(offset) >>> 0;
  const faces = u16({...mesh.arrays.get(0x144), elementSize: 2, num: mesh.arrays.get(0x144).num * 4}, 'Faces');
  return {
    modelVerts: scalar(0x180) | 0, special: scalar(0x184) | 0, meshScaleMax: bitsFloat(scalar(0x188)),
    lodStrengthBits: scalar(0x18c), lodStrength: bitsFloat(scalar(0x18c)), lodMinVerts: scalar(0x190) | 0,
    lodMorph: bitsFloat(scalar(0x194)), lodZDisplace: bitsFloat(scalar(0x198)),
    collapsePoints: u16(mesh.arrays.get(0x12c), 'CollapsePointThus'), faceLevel: u16(mesh.arrays.get(0x138), 'FaceLevel'),
    faces, faceCount: faces.length / 4, collapseWedges: u16(mesh.arrays.get(0x150), 'CollapseWedgeThus'),
    wedges: u32(mesh.arrays.get(0x15c), 4, 'Wedges'),
  };
}

/** The selection (0x10b0eb52..0x10b0ed53). `topology` from lodMeshTopology
 * (`collapseCount` may override CollapsePointThus.Num), `renderer` the URender
 * settings, `actor` {location, drawScale, lodBias} (Actor +114, +17c, +64),
 * `coords` the caller's FCoords as 12 floats (Origin, X, Y, Z axes),
 * `fx` the frame's float width (FSceneNode +b8) and `tanFactor` the float
 * lodMeshTanFactor stored for the viewport actor's FovAngle. Returns the
 * float `detail`, the `requested` GetFrame count, the `active` (+28) and
 * `morph` (+b4) flags and the transformed Location. */
export function selectLodMesh(topology, renderer, actor, coords, {fx, tanFactor}) {
  const N = topology.modelVerts;
  const collapseCount = topology.collapseCount ?? topology.collapsePoints.length;
  const result = {detail: f(N), requested: N, active: false, morph: false, location: null};
  if (topology.lodStrengthBits === 0 || collapseCount === 0) return result;
  result.active = true;
  // Byte +48 bit 0 and LODMorph > 0 (an unordered compare fails).
  result.morph = Boolean(renderer.mode & 1) && topology.lodMorph > 0;
  const tan = (renderer.mode | 0) >= 3 ? 1 : f(tanFactor);
  const complexity = f(r24(r24prod(N, COMPLEXITY) + 0.25));
  const screen = f(r24sum(r24prod(f(fx), SCREEN), SCREEN_BASE));
  // Actor.Location by the caller's coords: (d.x·A.x + d.y·A.y) + d.z·A.z,
  // the three components stored as floats.
  const c = coords.map(f), l = actor.location.map(f);
  const d = [0, 1, 2].map(i => r24(l[i] - c[i]));
  const axis = row => f(r24(r24(r24(d[0] * c[row]) + r24(d[1] * c[row + 1])) + r24(d[2] * c[row + 2])));
  result.location = [axis(3), axis(6), axis(9)];
  let depth = r24(result.location[2] - f(topology.lodZDisplace));
  if (!(1 < depth) && !Number.isNaN(depth)) depth = 1;
  let denominator = r24(f(renderer.adjust) * f(renderer.shapeLOD));
  denominator = r24(denominator * f(topology.lodStrength));
  denominator = r24(depth * denominator);
  denominator = r24(denominator * complexity);
  denominator = r24(denominator * tan);
  let numerator = r24(f(topology.meshScaleMax) * f(actor.drawScale));
  numerator = r24(numerator * f(actor.lodBias));
  numerator = r24(numerator * screen);
  numerator = r24(numerator * DISTANCE);
  let ratio = r24(numerator / denominator);
  if ((renderer.mode | 0) === 0) {
    const fix = f(renderer.fix);
    ratio = fix === 0 || Number.isNaN(fix) ? 1 : fix;
  }
  const scaled = r24prod(ratio, N), minimum = topology.lodMinVerts;
  // The exact LODMinVerts on the stack against the unstored product.
  result.detail = minimum < scaled || Number.isNaN(scaled) ? f(scaled) : f(minimum);
  const rounded = fistp(result.detail);
  if (rounded === -0x80000000) throw new LodMeshError('DrawLodMesh LOD detail has no integer count');
  result.requested = rounded > N ? N : rounded;
  return result;
}

/** The post-frame range (0x10b0ee34..0x10b0ef6e) after GetFrame returned
 * `count` ordinary vertices: the morph of positions (start, count-1], read
 * and written through `vertex(i)` ([x, y, z] floats of ordinary vertex i)
 * and `setVertex(i, xyz)`, with each vertex's alpha through `setAlpha(i,
 * float)` (FTransTexture +50). Returns the final `active`, `morph` and
 * `start` (+a4, 0 unless morphing began). */
export function morphLodMesh(topology, selection, count, {vertex, setVertex, setAlpha}) {
  const scalars = lodMorphScalars(topology, selection, count), {start, inverse} = scalars;
  if (scalars.morph) {
    const collapse = topology.collapsePoints;
    for (let i = count - 1; i > start; i--) {
      let alpha = r24((i - start) * inverse);
      if (!(1 > alpha)) alpha = 1;
      const target = collapse[i];
      if (!target) { setAlpha(i, 0); continue; }
      const t = vertex(target), v = vertex(i);
      // X keeps its difference and product on the stack; Y and Z store
      // them. At 24 bits these give the same values for floats.
      const dx = r24(t[0] - v[0]), dy = f(r24(t[1] - v[1])), dz = f(r24(t[2] - v[2]));
      const px = r24(dx * alpha), py = f(r24(dy * alpha)), pz = f(r24(dz * alpha));
      setVertex(i, [f(r24(px + v[0])), f(r24(py + v[1])), f(r24(pz + v[2]))]);
      setAlpha(i, f(alpha));
    }
  }
  return {active: scalars.active, morph: scalars.morph, start, count};
}

/** The post-frame range's scalars without its vertex loop (the GPU mesh
 * path runs the loop): the final flags, the start and the 24-bit inverse
 * 1/(detail·LODMorph) the loop multiplies by (0 without a morph). */
export function lodMorphScalars(topology, selection, count) {
  const N = topology.modelVerts, detail = selection.detail;
  let {active, morph} = selection, start = 0, inverse = 0;
  if (morph) {
    const lodMorph = f(topology.lodMorph);
    start = fistp(f(r24(r24(1 - lodMorph) * detail)));
    if (start >= count) morph = false;
    else inverse = r24(1 / r24(detail * lodMorph));
  }
  if (!morph && count >= N) active = false;
  return {active, morph, start, count, inverse};
}

/** The face loop's corner selection. With `state.active` (0x10b0fc6f..
 * 0x10b0fe60): a face whose FaceLevel exceeds the count is not admitted
 * (0x10b10117); each corner's wedge follows CollapseWedgeThus while its
 * vertex is at or above the count, and while morphing, a vertex above
 * `start` with nonzero alpha bits (`alphaBits(vertex)`) moves its U and V
 * bytes toward the next wedge's. The packed vertex/U/V dword is memoized
 * by original wedge in `scratch` (zero-initialized, Wedges.Num dwords).
 * Without it (0x10b10123..0x10b101e8) every face's wedges are copied.
 * Returns per face null (not admitted) or its three ordinary vertices, in
 * face order; `scratch` holds the packed dwords. */
export function lodMeshCorners(topology, state, alphaBits, scratch = new Uint32Array(topology.wedges.length)) {
  const {faces, faceLevel, wedges, collapseWedges, faceCount} = topology, count = state.count;
  const result = new Array(faceCount);
  if (!state.active) {
    for (let i = 0; i < faceCount; i++) {
      const corners = [0, 0, 0];
      for (let j = 0; j < 3; j++) {const w = faces[i * 4 + j], packed = wedges[w]; scratch[w] = packed; corners[j] = packed & 0xffff;}
      result[i] = corners;
    }
    return {faces: result, scratch};
  }
  if (count <= 0) throw new LodMeshError('DrawLodMesh reduced faces need a positive vertex count');
  for (let i = 0; i < faceCount; i++) {
    if (faceLevel[i] > count) {result[i] = null; continue;}
    const corners = [0, 0, 0];
    for (let j = 0; j < 3; j++) {
      const w = faces[i * 4 + j];
      let packed = scratch[w];
      if (!packed) {
        let at = w, steps = 0;
        packed = wedges[at];
        while ((packed & 0xffff) >= count) {
          at = collapseWedges[at];packed = wedges[at];
          if (++steps > wedges.length) throw new LodMeshError('DrawLodMesh wedge collapse does not reach the vertex count');
        }
        const vertex = packed & 0xffff;
        if (state.morph && vertex > state.start) {
          const alpha = alphaBits(vertex) >>> 0, next = collapseWedges[at];
          if (alpha && next !== at) {
            const other = wedges[next], u = (packed >>> 16) & 255, v = packed >>> 24, nu = (other >>> 16) & 255, nv = other >>> 24;
            if (u !== nu || v !== nv) {
              const a = bitsFloat(alpha);
              const lerp = (from, to) => fistp(f(r24(r24((to - from) * a) + from))) & 255;
              packed = (vertex | lerp(u, nu) << 16 | lerp(v, nv) << 24) >>> 0;
            }
          }
        }
        scratch[w] = packed;
      }
      corners[j] = packed & 0xffff;
    }
    result[i] = corners;
  }
  return {faces: result, scratch};
}
