/** Render.dll moving-light lightmap path: the SetupDynamics candidate gate,
 * FDynamicLight::Filter over the level BSP, FLightManager::AddLight's light
 * class, ComputeFromActor's per-light constants and texel rectangle, the
 * normal/NonIncidence spatial functions and the colour table merge. Evidence,
 * precision and remaining limits: docs/dynamic-lighting.md.
 *
 * All of it runs inside the render pass, under x87 precision control 24
 * (docs/render-pass-precision.md): every add, subtract, multiply, divide and
 * square root rounds to a 24-bit significand. Float operands make that a
 * binary32 operation (`f(a op b)` on doubles: the double result rounds
 * innocuously); a double constant takes x87-pc24.mjs's exact rounding. The
 * light-manager tables are built at init, on the game thread's 64-bit
 * precision. */
import { x87load, x87double, x87int32, x87mul, x87add, x87neg, x87div, x87sqrt, x87store,
  x87cmp } from './script-vm.mjs';
import { p24mul, p24add, p24div, p24sqrt, r24sum, r24prod } from './x87-pc24.mjs';

const f = Math.fround;
const scratch = new DataView(new ArrayBuffer(4));
const bitsOf = value => { scratch.setFloat32(0, value, true); return scratch.getUint32(0, true); };
const floatOf = bits => { scratch.setUint32(0, bits >>> 0, true); return scratch.getFloat32(0, true); };

/** FISTP under the original round-to-nearest-even control word. */
export function fistp(value) {
  const floor = Math.floor(value), fraction = value - floor;
  if (fraction !== .5) return fraction > .5 ? floor + 1 : floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// Light manager init 0x10b0225b-0x10b022d0: entry i of 0x10b3e1b8 holds
// sqrt(1+i/1024)*sqrt(2)*2^-64 and the adjacent 0x10b3f1b8 twice the unscaled
// root, both stored as floats.
const SQUARE_ROOTS = (() => {
  const table = new Uint32Array(2048), root2 = Math.sqrt(2);
  for (let i = 0; i < 1024; i++) {
    const scaled = floatOf(bitsOf(f(Math.sqrt(floatOf(0x3f800000 + (i << 13))))) - 0x20000000);
    table[i] = bitsOf(f(scaled * root2));
    table[i + 1024] = bitsOf(f(scaled + scaled));
  }
  return table;
})();

/** A copy of the table's float bit patterns, for native comparison. */
export const squareRootTable = () => SQUARE_ROOTS.slice();

/** The table square root used for light distances (0x10b05666 and the three
 * rectangle roots in ComputeFromActor): ten mantissa bits and the low
 * exponent bit select the entry, the remaining exponent bits are halved. */
export function tableSqrt(value) {
  const bits = bitsOf(value);
  return floatOf(SQUARE_ROOTS[(bits >>> 13) & 0x7ff] + ((bits & 0x7f000000) >>> 1));
}

/** SetupDynamics 0x10b230e8-0x10b2311c: the per-frame moving-light gate. */
export function isMovingLightCandidate(values) {
  if (!values.LightType) return false;
  if ((values.bStatic || values.bNoDelete) && !values.bDynamicLight) return false;
  return Boolean(values.LightBrightness) && Boolean(values.LightRadius);
}

// Rows of the effect table 0x10b2a0f0 whose second or third word is set.
const ANIMATED_EFFECTS = new Set([1, 2, 3, 4, 5, 6, 7, 9, 10, 16, 18]);

/** FLightManager::AddLight 0x10b08b30 for a surface (no owner): 0 joins the
 * static cache, 1 is recomputed per frame with shadows, 2 per frame without
 * shadows and 3 is the bump-map class; null rejects the light. */
export function surfaceLightClass(values, { noDynamicLights = false } = {}) {
  if (!values.LightType || !values.LightBrightness) return null;
  if (values.LightEffect === 15) return 3;
  if (!values.bDynamicLight && (values.bStatic || values.bNoDelete)) {
    if (values.bStatic && values.LightType === 1 && !ANIMATED_EFFECTS.has(values.LightEffect ?? 0)) return 0;
    return noDynamicLights ? 0 : 1;
  }
  return noDynamicLights ? null : 2;
}

/** Engine.dll AActor::WorldLightRadius 0x1030d6a0. */
export const worldLightRadius = values => 25 * ((values.LightRadius & 255) + 1);

/** FDynamicLight::Filter's plane distance (0x10b24a30-0x10b24a66):
 * `((L.z·P.z + L.y·P.y) + P.x·L.x) − W` at 24 bits, stored. */
const filterDistance = (px, py, pz, pw, lx, ly, lz) => f(f(f(f(lz * pz) + f(ly * py)) + f(px * lx)) - pw);

/** FDynamicLight::Filter 0x10b24a10 at every BSP node the light reaches:
 * the item moves to the front child when -R < Dist, to the back child when
 * Dist < R, and joins every coplanar surface with a light map and matching
 * PF_SpecialLit when both hold. Returns those surface indices. */
export function filterMovingLight(model, location, radius, specialLit = false) {
  const surfaces = new Set();
  if (!model.nodes.length) return surfaces;
  const [lx, ly, lz] = location.map(f), stack = [0];
  for (let visited = 0; stack.length; visited++) {
    if (visited > model.nodes.length) throw new Error('Cyclic BSP moving-light filter');
    const index = stack.pop(), node = model.nodes[index];
    if (!node) throw new Error(`Invalid BSP node ${index}`);
    const [px, py, pz, pw] = node.plane;
    const distance = filterDistance(px, py, pz, pw, lx, ly, lz);
    if (-radius < distance) {
      if (node.front >= 0) stack.push(node.front);
      if (distance < radius) {
        for (let coplanar = index; coplanar >= 0; coplanar = model.nodes[coplanar].coplanar) {
          const surfaceIndex = model.nodes[coplanar].surface, surface = model.surfaces[surfaceIndex];
          if (!surface || !(surface.lightMap >= 0) || !model.lightMaps.length) continue;
          if (Boolean(surface.flags & 0x100000) !== Boolean(specialLit)) continue;
          surfaces.add(surfaceIndex);
        }
      }
    }
    if (distance < radius && node.back >= 0) stack.push(node.back);
  }
  return surfaces;
}

/** The same Filter walk's leaf part (0x10b24a8d-0x10b24bcb, 0x10b24e04-
 * 0x10b24f6b): a side the light reaches whose child is a leaf
 * (FBspNode.iLeaf[side] ≠ -1) puts the light on URender::LeafLights[leaf],
 * which DrawActorSprite hands to SetupForActor for actors in that leaf. Root
 * items start with HitLeaf clear, so every such leaf is taken. Returns the
 * leaf indices in first-hit order of this depth-first walk. */
export function movingLightLeaves(model, location, radius) {
  const leaves = [], seen = new Set();
  if (!model.nodes.length) return leaves;
  const [lx, ly, lz] = location.map(f), stack = [0];
  const add = leaf => { if (leaf >= 0 && !seen.has(leaf)) { seen.add(leaf); leaves.push(leaf); } };
  for (let visited = 0; stack.length; visited++) {
    if (visited > model.nodes.length) throw new Error('Cyclic BSP moving-light filter');
    const node = model.nodes[stack.pop()];
    const [px, py, pz, pw] = node.plane;
    const distance = filterDistance(px, py, pz, pw, lx, ly, lz);
    if (-radius < distance) {
      add(node.leaves[1]);
      if (node.front >= 0) stack.push(node.front);
    }
    if (distance < radius) {
      add(node.leaves[0]);
      if (node.back >= 0) stack.push(node.back);
    }
  }
  return leaves;
}

const PLANE_WORDS = new Uint32Array(16), PLANE_FLOATS = new Float32Array(PLANE_WORDS.buffer);
/** The frame's four ViewPlanes (FSceneNode +0x12c) from their 16 words (the
 * master frame's `planes`, bsp-occlusion.mjs master().fields[41..57]) as
 * [nx, ny, nz, w] each. */
export function viewPlanesOf(words) {
  PLANE_WORDS.set(words);
  return [0, 1, 2, 3].map(k => [...PLANE_FLOATS.subarray(4 * k, 4 * k + 4)]);
}

/** SetupDynamics' ViewPlanes test of a moving-light candidate (0x10b2311c-
 * 0x10b2319f): R is the larger of WorldLightRadius and 25*(VolumeRadius+1)
 * (the float of `fild` times the double 25, 0x10b2a8b8), and the light is
 * skipped when its sphere lies wholly outside one of the frame's four
 * ViewPlanes (FSceneNode +0x12c, [nx, ny, nz, w] each): `-R > d` with
 * `d = ((z*nz + y*ny) + x*nx) - w` on the 24-bit stack (an unordered
 * compare keeps the light). `values` need LightRadius and VolumeRadius. */
export function movingLightInView(location, values, planes) {
  const volume = f(((values.VolumeRadius & 255) + 1) * 25), light = f(worldLightRadius(values));
  const radius = light < volume ? volume : light;
  // Indexed reads: a destructuring or a for-of makes an iterator below TurboFan, and `map(f)` an array.
  const lx = f(location[0]), ly = f(location[1]), lz = f(location[2]);
  for (let k = 0; k < planes.length; k++) {
    const plane = planes[k];
    if (-radius > filterDistance(plane[0], plane[1], plane[2], plane[3], lx, ly, lz)) return false;
  }
  return true;
}

/** URender::LeafLights after OccludeBsp's Filter walk (0x10b24a10; leaf lists
 * at 0x10b24ab9-0x10b24bbd and 0x10b24e31-0x10b24f6b): `lights` are the
 * candidates ({location, radius: WorldLightRadius}) in SetupDynamics order,
 * which prepends each to node 0's list (HitLeaf clear). A node's first visit
 * filters its list from the head; for each item the front side, then the back
 * side, the sphere reaches (`-R < Dist`, `Dist < R`): unless the item has
 * already hit a leaf, a leaf there (FBspNode.iLeaf[side]) takes the item at
 * the head of its list and the copy for that side's child carries HitLeaf;
 * a child node gets the copy prepended to its list. The order flips at every
 * hop, so a leaf's list is in candidate order below an even number of nodes
 * and reversed below an odd number. Every node is taken as visited (the
 * ancestors of the viewer's leaf are, which is where the corona pass reads).
 * Returns Map(leaf -> light indices, head first). */
export function movingLightLeafLists(model, lights) {
  const lists = new Map();
  if (!model.nodes.length || !lights.length) return lists;
  const locations = lights.map(light => light.location.map(f));
  const pending = new Map([[0, lights.map((_, i) => ({ i, hit: false })).reverse()]]), stack = [0];
  const take = (leaf, i) => { const list = lists.get(leaf); if (list) list.unshift(i); else lists.set(leaf, [i]); };
  for (let visited = 0; stack.length; visited++) {
    if (visited > model.nodes.length) throw new Error('Cyclic BSP moving-light filter');
    const index = stack.pop(), items = pending.get(index);
    pending.delete(index);
    if (!items) continue;
    const node = model.nodes[index], [px, py, pz, pw] = node.plane;
    const front = [], back = [];
    for (const { i, hit } of items) {
      const [lx, ly, lz] = locations[i], radius = lights[i].radius;
      const distance = filterDistance(px, py, pz, pw, lx, ly, lz);
      if (-radius < distance) {
        let hits = hit;
        if (!hit && node.leaves[1] >= 0) { take(node.leaves[1], i); hits = true; }
        if (node.front >= 0) front.unshift({ i, hit: hits });
      }
      if (distance < radius) {
        let hits = hit;
        if (!hit && node.leaves[0] >= 0) { take(node.leaves[0], i); hits = true; }
        if (node.back >= 0) back.unshift({ i, hit: hits });
      }
    }
    if (front.length) { pending.set(node.front, front); stack.push(node.front); }
    if (back.length) { pending.set(node.back, back); stack.push(node.back); }
  }
  return lists;
}

// The BSP's parent links and leaf owners, per model: which node and side a
// leaf hangs off. `regular` is false when a node has two parents or a child
// is the root (the single-leaf walk then asks the full one).
const bspTopologies = new WeakMap();
function bspTopology(model) {
  const nodes = model.nodes;
  let topology = bspTopologies.get(model);
  if (topology && topology.nodes === nodes && topology.count === nodes.length) return topology;
  const parent = new Int32Array(nodes.length).fill(-1), side = new Uint8Array(nodes.length), owner = new Map();
  let regular = nodes.length > 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    for (let s = 0; s < 2; s++) {
      const child = s ? node.front : node.back;
      if (child >= 0) {
        if (child === 0 || child >= nodes.length || parent[child] !== -1) regular = false;
        else { parent[child] = i; side[child] = s; }
      }
      const leaf = node.leaves[s];
      if (leaf >= 0) owner.set(leaf, owner.has(leaf) ? -1 : i * 2 + s);
    }
  }
  topology = { nodes, count: nodes.length, parent, side, owner, regular };
  bspTopologies.set(model, topology);
  return topology;
}

/** One leaf's list of movingLightLeafLists(model, lights), light indices head
 * first, or undefined when no light reaches it: the same decisions in the
 * same order, but only along the path from the root to the node the leaf
 * hangs off, since the Filter walk's lists on a node depend on its ancestors
 * alone. Play reads a few leaves a frame (the viewer's for the coronas, the
 * drawn actors' for mesh lighting); the full walk builds every leaf's list
 * and allocated most of the worker's garbage (docs/hitch-log.md). A leaf with
 * two owners, or a BSP that is not a tree, goes through the full walk.
 * `locations` are the lights' float32 locations (computed when omitted). */
export function movingLightLeafList(model, lights, leaf, locations = lights.map(light => light.location.map(f))) {
  if (!lights.length || !model.nodes.length) return undefined;
  if (globalThis.DEUS_EX_LEAF_LISTS === 'full') return movingLightLeafLists(model, lights).get(leaf);
  const topology = bspTopology(model), owner = topology.owner.get(leaf);
  if (owner === undefined) return undefined;
  if (!topology.regular || owner < 0) return movingLightLeafLists(model, lights).get(leaf);
  // The path from the leaf's node up to the root, in scratch arrays that are kept (the lists of a walk are as long as the
  // candidates, a few at most; a typed array per level was most of what this function allocated).
  let depth = 0;
  for (let n = owner >> 1; n !== -1; n = topology.parent[n]) {
    if (depth === walkPath.length) { const grown = new Int32Array(2 * depth); grown.set(walkPath); walkPath = grown; }
    walkPath[depth++] = n;
  }
  if (walkPath[depth - 1] !== 0) return undefined;
  let count = lights.length;
  if (walkIds.length < count) {
    const size = Math.max(count, 2 * walkIds.length);
    walkIds = new Int32Array(size); walkNextIds = new Int32Array(size); walkTaken = new Int32Array(size);
    walkHits = new Uint8Array(size); walkNextHits = new Uint8Array(size);
  }
  let ids = walkIds, hits = walkHits, nextIds = walkNextIds, nextHits = walkNextHits;
  // Node 0's list holds the candidates prepended one by one: last first.
  for (let j = 0; j < count; j++) { ids[j] = count - 1 - j; hits[j] = 0; }
  for (let k = depth - 1; k >= 0; k--) {
    const node = model.nodes[walkPath[k]], plane = node.plane, px = plane[0], py = plane[1], pz = plane[2], pw = plane[3];
    if (k === 0) {
      // The leaf's node: an item that has not hit a leaf yet and reaches the
      // leaf's side is prepended to the leaf's list.
      const s = owner & 1, taken = walkTaken;
      let found = 0;
      for (let j = 0; j < count; j++) {
        if (hits[j]) continue;
        const i = ids[j], at = locations[i], radius = lights[i].radius, distance = filterDistance(px, py, pz, pw, at[0], at[1], at[2]);
        if (s ? -radius < distance : distance < radius) taken[found++] = i;
      }
      if (found === 0) return undefined;
      const list = new Array(found);
      for (let t = 0; t < found; t++) list[t] = taken[found - 1 - t];
      return list;
    }
    // An ancestor: the items reaching the side the path takes go to that
    // child, prepended (the order flips), carrying HitLeaf once this side has
    // a leaf of its own.
    const s = topology.side[walkPath[k - 1]], leafHere = node.leaves[s] >= 0;
    let n = 0;
    for (let j = 0; j < count; j++) {
      const i = ids[j], at = locations[i], radius = lights[i].radius, distance = filterDistance(px, py, pz, pw, at[0], at[1], at[2]);
      if (!(s ? -radius < distance : distance < radius)) continue;
      nextIds[n] = i; nextHits[n] = hits[j] || leafHere ? 1 : 0; n++;
    }
    if (!n) return undefined;
    for (let lo = 0, hi = n - 1; lo < hi; lo++, hi--) {
      const id = nextIds[lo]; nextIds[lo] = nextIds[hi]; nextIds[hi] = id;
      const hit = nextHits[lo]; nextHits[lo] = nextHits[hi]; nextHits[hi] = hit;
    }
    const swapIds = ids, swapHits = hits;
    ids = nextIds; hits = nextHits; nextIds = swapIds; nextHits = swapHits; count = n;
  }
  return undefined;
}
// movingLightLeafList's scratch: the path, the item lists of two levels, the leaf's taken list.
let walkPath = new Int32Array(64), walkIds = new Int32Array(0), walkNextIds = walkIds, walkTaken = walkIds;
let walkHits = new Uint8Array(0), walkNextHits = walkHits;

/** `get(leaf)` of movingLightLeafLists(model, lights), computed per leaf on
 * demand (movingLightLeafList) and kept for the frame; iteration, `size` and
 * `keys()` build the full walk once. */
export function lazyLeafLists(model, lights) {
  const locations = lights.map(light => light.location.map(f)), cache = new Map();
  let full = null;
  const all = () => (full ??= movingLightLeafLists(model, lights));
  const get = leaf => {
    if (cache.has(leaf)) return cache.get(leaf);
    // ?leafLists=full keeps the full walk, once per frame (A/B and verification).
    const list = globalThis.DEUS_EX_LEAF_LISTS === 'full' ? all().get(leaf) : movingLightLeafList(model, lights, leaf, locations);
    cache.set(leaf, list);
    return list;
  };
  return { get, has: leaf => get(leaf) !== undefined, keys: () => all().keys(), entries: () => all().entries(),
    get size() { return all().size; }, [Symbol.iterator]: () => all()[Symbol.iterator]() };
}

const K85 = x87load(f(1 / 85)), K84 = x87load(f(1 / 84)), ZERO = x87load(0), ONE = x87load(1);

/** Engine.dll FGetHSV 0x103ec8d0, as the render pass runs it (GlobalLighting
 * 0x10b05ee8, SetupForSurf's ambient 0x10b07fcc, SetupForActor 0x10b08dee):
 * `b = value·(1.4/255)` (fild, fmul qword) stored and passed to appSqrt as
 * a double (`fld qword; fsqrt`), `0.7/(√b + 0.01)·b` on the stack and
 * clamped to [0, 1]; hue components `n·(1/85)` (`1/84` for the last blue
 * term) stored; `1 − c` per channel, X's kept on the stack, Y's and Z's
 * stored; saturation `s·(1/255)` (a double) stored; red `(1−x)·s + x` on the
 * stack, green and blue stored; each channel times the brightness. Every
 * operation rounds to 24 bits (x87-pc24.mjs, exact for the double
 * constants). */
export function fgetHsv(hue, saturation, value) {
  hue &= 255; saturation &= 255;
  const scaled = p24mul(x87int32(value & 255), x87double(0.005490196078431372));
  let brightness = p24mul(p24div(x87double(0.7), p24add(p24sqrt(scaled), x87double(0.01))), x87load(x87store(scaled)));
  if (x87cmp(brightness, ZERO) === 'lt') brightness = ZERO;
  else if (x87cmp(brightness, ONE) !== 'lt') brightness = ONE;
  const product = (n, k) => x87store(p24mul(x87int32(n), k));
  const [x, y, z] = hue < 86 ? [product(85 - hue, K85), product(hue, K85), 0]
    : hue < 171 ? [0, product(170 - hue, K85), product(hue - 85, K85)]
      : [product(hue - 170, K85), 0, product(255 - hue, K84)];
  const complement = component => p24add(ONE, x87neg(x87load(component)));
  const s = x87load(x87store(p24mul(x87int32(saturation), x87double(0.00392156862745098))));
  const red = p24add(p24mul(complement(x), s), x87load(x));
  const green = x87store(p24add(x87load(x87store(p24mul(x87load(x87store(complement(y))), s))), x87load(y)));
  const blue = x87store(p24add(x87load(x87store(p24mul(x87load(x87store(complement(z))), s))), x87load(z)));
  return [x87store(p24mul(red, brightness)), x87store(p24mul(x87load(green), brightness)),
    x87store(p24mul(x87load(blue), brightness))];
}

/** ComputeFromActor's per-light constants at 24 bits: radius (WorldLightRadius,
 * at least 1), `1/R` (`fdivr` of the double 1.0) stored and kept,
 * `rr2 = (1/R)²·4093` (0x10b05fd9-0x10b06027), brightness
 * `LightBrightness·(1/255)` (0x10b060b3), colour
 * `(Level.Brightness·brightness)·hsv` (0x10b0612f-0x10b06148) and the
 * colour-table steps `fistp(c·65536 − 0.5f)` (0x10b064ff-0x10b0656d). `hsv`
 * is FGetHSV(hue, saturation, 255); steady lights keep it unchanged. */
export function movingLightConstants(values, levelBrightness, hsv, typeBrightness = null) {
  const radius = f(worldLightRadius(values)), clamped = radius > 1 ? radius : 1;
  const rradius = f(1 / clamped), brightness = typeBrightness ?? f((values.LightBrightness & 255) * f(1 / 255));
  const scale = f(f(levelBrightness) * f(brightness));
  const color = hsv.map(channel => f(scale * f(channel)));
  return { radius, rradius, rr2: f(f(rradius * rradius) * 4093), color,
    steps: color.map(channel => fistp(f(f(channel * 65536) - .5))) };
}

/** Colour table entry for a spatial byte (0x10b06570-0x10b065e0). */
export const colorTableEntry = (step, spatial) => Math.min(127, (spatial * step) >> 16);

/** ComputeFromActor 0x10b0660e-0x10b06865 at 24 bits: the texel rectangle a
 * light can reach on a facet (origin, texture U/V axes, normal) and its light
 * map. The plane distance `((dy·Ny + dz·Nz) + dx·Nx)` is stored; the disk
 * `R²·1.05 − d²` (the double 1.05 rounded exactly) is clamped at 0 and
 * stored; the projected centre keeps Z on the stack and stores X and Y; the
 * bounds `(u ∓ ru)/scale` are stored before FISTP. */
export function movingLightRect(location, radius, facet) {
  const { origin: o, axisU: x, axisV: y, normal: z, pan, scale, clamp } = facet;
  const [lx, ly, lz] = location.map(f);
  const dx = f(lx - o[0]), dy = f(ly - o[1]), dz = f(lz - o[2]);
  const plane = f(f(f(dy * z[1]) + f(dz * z[2])) + f(dx * z[0]));
  let disk = f(r24prod(f(radius * radius), 1.05) - f(plane * plane));
  if (disk < 0) disk = 0;
  const r = tableSqrt(disk);
  const pz = f(lz - f(plane * z[2])), py = f(ly - f(plane * z[1])), px = f(lx - f(plane * z[0]));
  const ex = f(px - o[0]), ey = f(py - o[1]), ez = f(pz - o[2]);
  const u = f(f(f(f(ey * x[1]) + f(ez * x[2])) + f(ex * x[0])) - pan[0]);
  const v = f(f(f(f(ey * y[1]) + f(ez * y[2])) + f(ex * y[0])) - pan[1]);
  const length = a => tableSqrt(f(f(f(a[0] * a[0]) + f(a[1] * a[1])) + f(a[2] * a[2])));
  const ru = f(length(x) * r), rv = f(length(y) * r);
  return {
    minU: Math.max(0, fistp(f(f(u - ru) / scale[0]))), minV: Math.max(0, fistp(f(f(v - rv) / scale[1]))),
    maxU: Math.min(clamp[0], fistp(f(f(ru + u) / scale[0]))), maxV: Math.min(clamp[1], fistp(f(f(rv + v) / scale[1]))),
  };
}

/** A spatial function's illumination: one byte for every texel (0x7f for
 * an unshadowed moving light) or a static light's bytes from
 * static-lighting.mjs shadowIllumination, `{bytes, stride}` with rows
 * padded to whole shadow bytes. */
function illuminationAt(illumination) {
  if (typeof illumination === 'number') return () => illumination;
  const {bytes, stride} = illumination;
  return (u, v) => bytes[v * stride + u];
}

/** NonIncidence spatial function 0x10b054e0. `grid` is the float texel grid
 * (start 0x10b38a90, U step 0x10b49e10, V step 0x10b3d378); an unshadowed
 * moving light has illumination 0x7f everywhere (0x10b02660). Calls
 * `write(u, v, byte)` for each texel of the rectangle. */
export function nonIncidenceSpatial(rect, grid, location, constants, write, illumination = 0x7f) {
  const { minU, maxU, minV, maxV } = rect, { rradius, rr2 } = constants, illum = illuminationAt(illumination);
  const [sx, sy, sz] = grid.start, [ux, uy, uz] = grid.stepU, [vx, vy, vz] = grid.stepV;
  const [lx, ly, lz] = location;
  // Row start (0x10b05509-0x10b0559e): X and Y from stored products and
  // sums, Z's two sums on the stack, all at 24 bits.
  let rowX = f(f(sx + f(vx * minV)) + f(ux * minU));
  let rowY = f(f(sy + f(vy * minV)) + f(uy * minU));
  let rowZ = f(f(f(vz * minV) + sz) + f(uz * minU));
  for (let v = minV; v < maxV; v++) {
    let dx = f(rowX - lx), dy = f(rowY - ly), dz = f(rowZ - lz);
    for (let u = minU; u < maxU; u++) {
      let spatial = 0;
      const light = illum(u, v);
      if (light) {
        // (dy² + dz²) + dx², stored; then the table index, the root times
        // 1/R, `1.02 −` it (the double constant, exactly rounded), times
        // the illumination, stored, less 0.5f (0x10b05632-0x10b056ab).
        const distanceSquared = f(f(f(dy * dy) + f(dz * dz)) + f(dx * dx));
        if (fistp(f(distanceSquared * rr2)) >>> 0 < 0x1000) {
          const falloff = r24sum(1.02, -f(tableSqrt(distanceSquared) * rradius));
          spatial = fistp(f(f(falloff * light) - .5)) & 0xff;
        }
      }
      write(u, v, spatial);
      dx = f(dx + ux); dy = f(dy + uy); dz = f(dz + uz);
    }
    rowX = f(rowX + vx); rowY = f(rowY + vy); rowZ = f(rowZ + vz);
  }
}

let NORMAL_TABLE;
function getNormalTable() {
  if (!NORMAL_TABLE) {
    NORMAL_TABLE = new Float32Array(4096);
    // Init 0x10b022fe: sqrt returns on the x87 stack. Its double spill is
    // not reloaded; retain that extended root through the cubic and divide.
    for (let i = 0; i < NORMAL_TABLE.length; i++) {
      const d = x87sqrt(x87double((i + 1) / 4096)), squared = x87mul(d, d);
      const cubed = x87mul(squared, d);
      const numerator = x87add(x87add(x87add(cubed, cubed), x87neg(x87mul(squared, x87load(3)))), ONE);
      NORMAL_TABLE[i] = x87store(x87div(numerator, d));
    }
  }
  return NORMAL_TABLE;
}

/** Init 0x10b022fe..0x10b02352: a copy of the 4096 normal falloff floats. */
export const normalLightTable = () => getNormalTable().slice();

/** ComputeFromActor 0x10b06325..0x10b0639e, info +0x24, at 24 bits: the
 * displacement components are stored before the Z/Y/X dot and reciprocal
 * multiply; FCOM with 0 then FCHS when below, so a negative zero stays
 * negative. */
export function normalLightIncidence(location, facet, rradius) {
  const [dx, dy, dz] = location.map((v, i) => f(f(v) - f(facet.origin[i]))), n = facet.normal;
  const dot = f(f(f(dz * f(n[2])) + f(dy * f(n[1]))) + f(dx * f(n[0])));
  const incidence = f(dot * f(rradius));
  return incidence < 0 ? -incidence : incidence;
}

/** Normal spatial function 0x10b03360. Integer forward differences select
 * the falloff table; the output byte is the low float byte after adding
 * 2^23, not a floor/clamp. See docs/moving-normal-lighting.md. */
export function normalLightSpatial(rect, grid, location, constants, write, illumination = 0x7f) {
  const { minU, maxU, minV, maxV } = rect, { rr2, incidence } = constants, illum = illuminationAt(illumination);
  const [sx, sy, sz] = grid.start, [ux, uy, uz] = grid.stepU, [vx, vy, vz] = grid.stepV;
  const [lx, ly, lz] = location;
  // 0x10b033b4-0x10b0345b at 24 bits: X's start difference stays on the
  // stack, Y's and Z's are stored; Z's two sums stay on the stack.
  const delta = [f(f(f(sx - lx) + f(ux * minU)) + f(vx * minV)),
    f(f(f(sy - ly) + f(uy * minU)) + f(vy * minV)), f(f(f(uz * minU) + f(sz - lz)) + f(vz * minV))];
  const scale = f(rr2 * 4096), table = getNormalTable();
  const coefficient = (a, b) => {
    const dot = f(f(f(a[2] * b[2]) + f(a[1] * b[1])) + f(a[0] * b[0]));
    const rounded = fistp(f(dot * scale));
    return rounded >= -0x80000000 && rounded < 0x80000000 ? rounded : -0x80000000;
  };
  let row = coefficient(delta, delta);
  const du = coefficient(delta, grid.stepU), dv = coefficient(delta, grid.stepV);
  const uu = coefficient(grid.stepU, grid.stepU), vv = coefficient(grid.stepV, grid.stepV);
  const uv = coefficient(grid.stepU, grid.stepV);
  let rowU = (uu + 2 * du) | 0, rowV = (vv + 2 * dv) | 0;
  const stepUU = (2 * uu) | 0, stepVV = (2 * vv) | 0, stepUV = (2 * uv) | 0;
  for (let v = minV; v < maxV; v++) {
    let distance = row, step = rowU;
    for (let u = minU; u < maxU; u++) {
      const light = illum(u, v);
      // fild, fmul table, fmul incidence, fadd 2^23f, each at 24 bits
      // (0x10b036ba-0x10b036d0).
      const byte = light && (distance >>> 0) < 0x1000000
        ? bitsOf(f(f(f(light * table[distance >>> 12]) * incidence) + 8388608)) & 255 : 0;
      write(u, v, byte);
      distance = (distance + step) | 0;
      step = (step + stepUU) | 0;
    }
    row = (row + rowV) | 0;
    rowV = (rowV + stepVV) | 0;
    rowU = (rowU + stepUV) | 0;
  }
}
