/**
 * The decoded compiled BSP (UE1 v68-69 `Model`) as typed tables: host representation only. `readModel` (model.mjs) used to give
 * one object per node, surface, vertex, zone, leaf, light map and render bound, with an array for every plane, point, vector, mask
 * and pair (about 490,000 objects on the Island), which a major GC marks one by one. A table here is a few typed arrays; each field
 * holds exactly the value the object form held (a float32 as the same float32, a compact index or int32 as the same int32, a 64-bit
 * mask as two uint32 words), so every reader gets the same bits.
 *
 * `nodes` is the original 64-byte FBspNode (the layout the Rust occlusion block, the tracker's memory and fast-line-check.mjs
 * already read), so the same readers serve the model and the tracker's view of it. The other tables are arrays of records in one
 * Int32Array (or a Float32Array over the same words). A table's `at(i)` makes the old object form of record `i` (`modelObjects`
 * makes all of them, `modelFromObjects` goes the other way): for validators and cold paths. Hot readers read the typed views.
 */

/** FBspNode word offsets (64 bytes, 16 words) and byte offsets of its four byte fields. */
export const NODE = {
  WORDS: 16, PLANE: 0, ZONE_MASK: 4, VERT_POOL: 6, SURFACE: 7, BACK: 8, FRONT: 9, COPLANAR: 10, COLLISION_BOUND: 11, RENDER_BOUND: 12,
  LEAF: 14, ZONE_BYTE: 52, VERTEX_COUNT_BYTE: 54, FLAGS_BYTE: 55,
};
/** A model surface: texture, flags, base, normal, textureU, textureV, lightMap, brushPolygon, pan U, pan V, brushActor. */
export const SURF = { WORDS: 11, TEXTURE: 0, FLAGS: 1, BASE: 2, NORMAL: 3, TEXTURE_U: 4, TEXTURE_V: 5, LIGHT_MAP: 6, BRUSH_POLYGON: 7,
  PAN_U: 8, PAN_V: 9, BRUSH_ACTOR: 10 };
/** A zone: actor, connectivity (two words), visibility (two words). */
export const ZONE = { WORDS: 5, ACTOR: 0, CONNECTIVITY: 1, VISIBILITY: 3 };
/** A light map: dataOffset, pan (three floats), clamp (two), scale (two floats), lightActors. */
export const LIGHT_MAP = { WORDS: 9, DATA_OFFSET: 0, PAN: 1, CLAMP: 4, SCALE: 6, LIGHT_ACTORS: 8 };
/** A render bound: min (three floats), max (three floats), valid. */
export const BOUND = { WORDS: 7, MIN: 0, MAX: 3, VALID: 6 };
/** A leaf: zone, permeating, volumetric, visibleZones (two words). */
export const LEAF = { WORDS: 5, ZONE: 0, PERMEATING: 1, VOLUMETRIC: 2, VISIBLE_ZONES: 3 };

/** The object-form iteration every table offers for cold readers (validators, exports, one-off tools): each record is made by `at(i)`
 * when asked for. Hot readers do not use it; they read the typed views. */
class Records {
  *[Symbol.iterator]() { for (let i = 0; i < this.length; i++) yield this.at(i); }
  *entries() { for (let i = 0; i < this.length; i++) yield [i, this.at(i)]; }
  map(fn) { const out = new Array(this.length); for (let i = 0; i < this.length; i++) out[i] = fn(this.at(i), i, this); return out; }
  forEach(fn) { for (let i = 0; i < this.length; i++) fn(this.at(i), i, this); }
  filter(fn) { const out = []; for (let i = 0; i < this.length; i++) { const record = this.at(i); if (fn(record, i, this)) out.push(record); } return out; }
  flatMap(fn) { return this.map(fn).flat(); }
  some(fn) { for (let i = 0; i < this.length; i++) if (fn(this.at(i), i, this)) return true; return false; }
  every(fn) { for (let i = 0; i < this.length; i++) if (!fn(this.at(i), i, this)) return false; return true; }
  find(fn) { for (let i = 0; i < this.length; i++) { const record = this.at(i); if (fn(record, i, this)) return record; } return undefined; }
}

/** The node accessors over `i32`, `f32` and `u8` views and the word offset of node 0 (`base`); BspNodes owns the views, the
 * tracker's view (bsp-occlusion.mjs) takes them from the kernel's memory. */
export class NodeAccess extends Records {
  /** Whether `i` is a node of the table. */
  has(i) { return i >= 0 && i < this.length && Number.isInteger(i); }
  plane(i, k) { return this.f32[this.base + (i << 4) + k]; }
  zoneMask(i, k) { return this.i32[this.base + (i << 4) + 4 + k] >>> 0; }
  vertexPool(i) { return this.i32[this.base + (i << 4) + 6]; }
  surface(i) { return this.i32[this.base + (i << 4) + 7]; }
  back(i) { return this.i32[this.base + (i << 4) + 8]; }
  front(i) { return this.i32[this.base + (i << 4) + 9]; }
  coplanar(i) { return this.i32[this.base + (i << 4) + 10]; }
  collisionBound(i) { return this.i32[this.base + (i << 4) + 11]; }
  renderBound(i) { return this.i32[this.base + (i << 4) + 12]; }
  leaf(i, side) { return this.i32[this.base + (i << 4) + 14 + side]; }
  zone(i, side) { return this.u8[(this.base << 2) + (i << 6) + 52 + side]; }
  vertexCount(i) { return this.u8[(this.base << 2) + (i << 6) + 54]; }
  flags(i) { return this.u8[(this.base << 2) + (i << 6) + 55]; }
  /** The plane as a new array [x, y, z, w]. */
  planeArray(i) { const f = this.f32, o = this.base + (i << 4); return [f[o], f[o + 1], f[o + 2], f[o + 3]]; }
  /** Node `i` in the object form (undefined outside the table). */
  at(i) {
    if (!(i >= 0 && i < this.length) || !Number.isInteger(i)) return undefined;
    return { plane: this.planeArray(i), zoneMask: [this.zoneMask(i, 0), this.zoneMask(i, 1)], flags: this.flags(i),
      vertexPool: this.vertexPool(i), surface: this.surface(i), back: this.back(i), front: this.front(i), coplanar: this.coplanar(i),
      collisionBound: this.collisionBound(i), renderBound: this.renderBound(i), zones: [this.zone(i, 0), this.zone(i, 1)],
      vertexCount: this.vertexCount(i), leaves: [this.leaf(i, 0), this.leaf(i, 1)] };
  }
}

/** A node block in a kernel's memory (the moving brush tracker's view of Level->Model, bsp-occlusion.mjs): the same accessors over views
 * made again when the memory grew. `count` is a number, or a function for a block whose count follows the tracker. */
export class MemoryNodes extends NodeAccess {
  constructor(memory, at, count) {
    super();
    this.memory = memory; this.base = at >>> 2; this.count = count;
    this.buffer = null; this.i32View = null; this.f32View = null; this.u8View = null;
  }
  get length() { return typeof this.count === 'function' ? this.count() : this.count; }
  refresh() {
    const buffer = this.memory.buffer;
    if (this.buffer !== buffer) {
      this.buffer = buffer; this.i32View = new Int32Array(buffer); this.f32View = new Float32Array(buffer); this.u8View = new Uint8Array(buffer);
    }
  }
  get i32() { this.refresh(); return this.i32View; }
  get f32() { this.refresh(); return this.f32View; }
  get u8() { this.refresh(); return this.u8View; }
}

export class BspNodes extends NodeAccess {
  constructor(count) {
    super();
    const buffer = new ArrayBuffer(count * 64);
    this.length = count; this.base = 0;
    this.i32 = new Int32Array(buffer); this.f32 = new Float32Array(buffer); this.u8 = new Uint8Array(buffer);
  }
}

/** The nodes of a mover brush as the tracker's polygons make them (polys.mjs moverModelFromPolys): one node a polygon, with the plane
 * the polygon's normal and `normal . base` kept as the doubles it is computed in (a float32 table could not hold the offset), the
 * surface the polygon's, both zones 0, and the polygon's vertex count. The accessors are NodeAccess's that these nodes have fields for. */
export class PolygonNodes extends Records {
  constructor(count) {
    super();
    this.length = count; this.planes = new Float64Array(4 * count); this.surfaces = new Int32Array(count); this.counts = new Int32Array(count);
  }
  has(i) { return i >= 0 && i < this.length && Number.isInteger(i); }
  plane(i, k) { return this.planes[4 * i + k]; }
  surface(i) { return this.surfaces[i]; }
  vertexCount(i) { return this.counts[i]; }
  zone() { return 0; }
  planeArray(i) { const p = this.planes; return [p[4 * i], p[4 * i + 1], p[4 * i + 2], p[4 * i + 3]]; }
  at(i) { return this.has(i) ? { plane: this.planeArray(i), surface: this.surfaces[i], zones: [0, 0], vertexCount: this.counts[i] } : undefined; }
}

/** Points and vectors: three float32 a record. */
export class Vec3s extends Records {
  constructor(count) { super(); this.length = count; this.data = new Float32Array(3 * count); }
  x(i) { return this.data[3 * i]; }
  y(i) { return this.data[3 * i + 1]; }
  z(i) { return this.data[3 * i + 2]; }
  at(i) {
    if (!(i >= 0 && i < this.length) || !Number.isInteger(i)) return undefined;
    const d = this.data; return [d[3 * i], d[3 * i + 1], d[3 * i + 2]];
  }
}

/** A list of arrays as a table that answers `at(i)` with the array itself (exact doubles): a one-off model for lightmapBasis, such as a
 * tracker facet's point and vectors. */
export const arrayTable = list => ({ length: list.length, at: i => list[i] });

const inTable = (table, i) => i >= 0 && i < table.length && Number.isInteger(i);

export class Surfaces extends Records {
  constructor(count) { super(); this.length = count; this.words = new Int32Array(SURF.WORDS * count); }
  texture(i) { return this.words[SURF.WORDS * i]; }
  flags(i) { return this.words[SURF.WORDS * i + 1] >>> 0; }
  base(i) { return this.words[SURF.WORDS * i + 2]; }
  normal(i) { return this.words[SURF.WORDS * i + 3]; }
  textureU(i) { return this.words[SURF.WORDS * i + 4]; }
  textureV(i) { return this.words[SURF.WORDS * i + 5]; }
  lightMap(i) { return this.words[SURF.WORDS * i + 6]; }
  brushPolygon(i) { return this.words[SURF.WORDS * i + 7]; }
  panU(i) { return this.words[SURF.WORDS * i + 8]; }
  panV(i) { return this.words[SURF.WORDS * i + 9]; }
  brushActor(i) { return this.words[SURF.WORDS * i + 10]; }
  at(i) {
    if (!inTable(this, i)) return undefined;
    return { texture: this.texture(i), flags: this.flags(i), base: this.base(i), normal: this.normal(i), textureU: this.textureU(i),
      textureV: this.textureV(i), lightMap: this.lightMap(i), brushPolygon: this.brushPolygon(i), pan: [this.panU(i), this.panV(i)],
      brushActor: this.brushActor(i) };
  }
}

/** The surfaces as the moving brush tracker holds them (brush-tracker.mjs trackedModel): the static ones, then the tracker's own
 * (`top` the first; `mover` the index of the mover each belongs to), whose record has only the fields the tracker keeps. */
export class TrackedSurfaces extends Surfaces {
  constructor(count, top) { super(count); this.top = top; this.movers = new Int32Array(Math.max(0, count - top)); }
  isDynamic(i) { return i >= this.top; }
  mover(i) { return this.movers[i - this.top]; }
  at(i) {
    if (!inTable(this, i)) return undefined;
    if (i < this.top) return super.at(i);
    return { texture: null, flags: this.flags(i), base: this.base(i) >>> 0, normal: this.normal(i) >>> 0, textureU: this.textureU(i) >>> 0,
      textureV: this.textureV(i) >>> 0, lightMap: this.lightMap(i), brushPolygon: this.brushPolygon(i), dynamic: true, mover: this.mover(i) };
  }
}

/** Vertices: point and side, two words a record. */
export class Vertices extends Records {
  constructor(count) { super(); this.length = count; this.words = new Int32Array(2 * count); }
  point(i) { return this.words[2 * i]; }
  side(i) { return this.words[2 * i + 1]; }
  at(i) { return inTable(this, i) ? { point: this.words[2 * i], side: this.words[2 * i + 1] } : undefined; }
}

export class Zones extends Records {
  constructor(count) { super(); this.length = count; this.words = new Int32Array(ZONE.WORDS * count); }
  actor(i) { return this.words[ZONE.WORDS * i]; }
  connectivity(i, k) { return this.words[ZONE.WORDS * i + 1 + k] >>> 0; }
  visibility(i, k) { return this.words[ZONE.WORDS * i + 3 + k] >>> 0; }
  at(i) {
    if (!inTable(this, i)) return undefined;
    return { actor: this.actor(i), connectivity: [this.connectivity(i, 0), this.connectivity(i, 1)],
      visibility: [this.visibility(i, 0), this.visibility(i, 1)] };
  }
}

export class LightMaps extends Records {
  constructor(count) {
    super();
    this.length = count;
    const buffer = new ArrayBuffer(4 * LIGHT_MAP.WORDS * count);
    this.words = new Int32Array(buffer); this.floats = new Float32Array(buffer);
  }
  dataOffset(i) { return this.words[LIGHT_MAP.WORDS * i]; }
  pan(i, k) { return this.floats[LIGHT_MAP.WORDS * i + 1 + k]; }
  clamp(i, k) { return this.words[LIGHT_MAP.WORDS * i + 4 + k]; }
  scale(i, k) { return this.floats[LIGHT_MAP.WORDS * i + 6 + k]; }
  lightActors(i) { return this.words[LIGHT_MAP.WORDS * i + 8]; }
  at(i) {
    if (!inTable(this, i)) return undefined;
    return { dataOffset: this.dataOffset(i), pan: [this.pan(i, 0), this.pan(i, 1), this.pan(i, 2)], clamp: [this.clamp(i, 0), this.clamp(i, 1)],
      scale: [this.scale(i, 0), this.scale(i, 1)], lightActors: this.lightActors(i) };
  }
}

export class RenderBounds extends Records {
  constructor(count) {
    super();
    this.length = count;
    const buffer = new ArrayBuffer(4 * BOUND.WORDS * count);
    this.words = new Int32Array(buffer); this.floats = new Float32Array(buffer);
  }
  min(i, k) { return this.floats[BOUND.WORDS * i + k]; }
  max(i, k) { return this.floats[BOUND.WORDS * i + 3 + k]; }
  valid(i) { return this.words[BOUND.WORDS * i + 6] !== 0; }
  at(i) {
    if (!inTable(this, i)) return undefined;
    return { min: [this.min(i, 0), this.min(i, 1), this.min(i, 2)], max: [this.max(i, 0), this.max(i, 1), this.max(i, 2)], valid: this.valid(i) };
  }
}

export class Leaves extends Records {
  constructor(count) { super(); this.length = count; this.words = new Int32Array(LEAF.WORDS * count); }
  zone(i) { return this.words[LEAF.WORDS * i]; }
  permeating(i) { return this.words[LEAF.WORDS * i + 1]; }
  volumetric(i) { return this.words[LEAF.WORDS * i + 2]; }
  visibleZones(i, k) { return this.words[LEAF.WORDS * i + 3 + k] >>> 0; }
  at(i) {
    if (!inTable(this, i)) return undefined;
    return { zone: this.zone(i), permeating: this.permeating(i), volumetric: this.volumetric(i), visibleZones: [this.visibleZones(i, 0), this.visibleZones(i, 1)] };
  }
}

const f32 = new Float32Array(1);
/** The float32 a number rounds to as the old object form's readers saw it; a model made from objects keeps those values exactly only
 * when they already are float32 (readModel's always are). */
function exactFloat(value, what) {
  f32[0] = value;
  if (!Object.is(f32[0], value)) throw new RangeError(`${what} ${value} is not a float32`);
  return value;
}
const exactInt = (value, what) => {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) throw new RangeError(`${what} ${value} is not a 32-bit integer`);
  return value;
};

/** The columns from the old object form (`nodes` as an array of node objects and so on): what a fixture or a validator holds. Fields
 * the fixture leaves out are zero (a node's links -1). Values are checked to be exactly representable. */
export function modelFromObjects(old) {
  const out = { ...old };
  const vec3s = (list, what) => {
    if (!Array.isArray(list)) return list;
    const table = new Vec3s(list.length);
    list.forEach((p, i) => { for (let k = 0; k < 3; k++) table.data[3 * i + k] = exactFloat(p[k], what); });
    return table;
  };
  out.vectors = vec3s(old.vectors, 'vector');
  out.points = vec3s(old.points, 'point');
  if (Array.isArray(old.nodes)) {
    const nodes = new BspNodes(old.nodes.length);
    old.nodes.forEach((n, i) => {
      const o = i << 4, plane = n.plane ?? [0, 0, 0, 0], zoneMask = n.zoneMask ?? [0, 0], zones = n.zones ?? [0, 0], leaves = n.leaves ?? [0, 0];
      for (let k = 0; k < 4; k++) nodes.f32[o + k] = exactFloat(plane[k], 'plane');
      nodes.i32[o + 4] = exactInt(zoneMask[0], 'zone mask'); nodes.i32[o + 5] = exactInt(zoneMask[1], 'zone mask');
      nodes.i32[o + 6] = exactInt(n.vertexPool ?? 0, 'vertex pool');
      nodes.i32[o + 7] = exactInt(n.surface ?? 0, 'surface');
      nodes.i32[o + 8] = exactInt(n.back ?? -1, 'back'); nodes.i32[o + 9] = exactInt(n.front ?? -1, 'front');
      nodes.i32[o + 10] = exactInt(n.coplanar ?? -1, 'coplanar');
      nodes.i32[o + 11] = exactInt(n.collisionBound ?? -1, 'collision bound'); nodes.i32[o + 12] = exactInt(n.renderBound ?? -1, 'render bound');
      const at = i * 64;
      for (const [offset, value, what] of [[52, zones[0], 'zone'], [53, zones[1], 'zone'], [54, n.vertexCount ?? 0, 'vertex count'], [55, n.flags ?? 0, 'flags']]) {
        if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError(`node ${what} ${value} is not a byte`);
        nodes.u8[at + offset] = value;
      }
      nodes.i32[o + 14] = exactInt(leaves[0], 'leaf'); nodes.i32[o + 15] = exactInt(leaves[1], 'leaf');
    });
    out.nodes = nodes;
  }
  if (Array.isArray(old.surfaces)) {
    const table = new Surfaces(old.surfaces.length), w = table.words;
    old.surfaces.forEach((s, i) => {
      const o = SURF.WORDS * i, pan = s.pan ?? [0, 0];
      w[o] = exactInt(s.texture ?? 0, 'texture'); w[o + 1] = exactInt(s.flags ?? 0, 'flags'); w[o + 2] = exactInt(s.base ?? 0, 'base');
      w[o + 3] = exactInt(s.normal ?? 0, 'normal'); w[o + 4] = exactInt(s.textureU ?? 0, 'textureU'); w[o + 5] = exactInt(s.textureV ?? 0, 'textureV');
      w[o + 6] = exactInt(s.lightMap ?? -1, 'lightMap'); w[o + 7] = exactInt(s.brushPolygon ?? -1, 'brushPolygon');
      w[o + 8] = exactInt(pan[0], 'pan'); w[o + 9] = exactInt(pan[1], 'pan'); w[o + 10] = exactInt(s.brushActor ?? 0, 'brushActor');
    });
    out.surfaces = table;
  }
  if (Array.isArray(old.vertices)) {
    const table = new Vertices(old.vertices.length);
    old.vertices.forEach((v, i) => { table.words[2 * i] = exactInt(v.point, 'vertex point'); table.words[2 * i + 1] = exactInt(v.side ?? 0, 'vertex side'); });
    out.vertices = table;
  }
  if (Array.isArray(old.zones)) {
    const table = new Zones(old.zones.length), w = table.words;
    old.zones.forEach((z, i) => {
      const o = ZONE.WORDS * i, c = z.connectivity ?? [0, 0], v = z.visibility ?? [0, 0];
      w[o] = exactInt(z.actor ?? 0, 'zone actor'); w[o + 1] = exactInt(c[0], 'connectivity'); w[o + 2] = exactInt(c[1], 'connectivity');
      w[o + 3] = exactInt(v[0], 'visibility'); w[o + 4] = exactInt(v[1], 'visibility');
    });
    out.zones = table;
  }
  if (Array.isArray(old.lightMaps)) {
    const table = new LightMaps(old.lightMaps.length);
    old.lightMaps.forEach((m, i) => {
      const o = LIGHT_MAP.WORDS * i;
      table.words[o] = exactInt(m.dataOffset ?? 0, 'dataOffset');
      for (let k = 0; k < 3; k++) table.floats[o + 1 + k] = exactFloat(m.pan?.[k] ?? 0, 'light map pan');
      table.words[o + 4] = exactInt(m.clamp?.[0] ?? 0, 'clamp'); table.words[o + 5] = exactInt(m.clamp?.[1] ?? 0, 'clamp');
      table.floats[o + 6] = exactFloat(m.scale?.[0] ?? 1, 'scale'); table.floats[o + 7] = exactFloat(m.scale?.[1] ?? 1, 'scale');
      table.words[o + 8] = exactInt(m.lightActors ?? 0, 'lightActors');
    });
    out.lightMaps = table;
  }
  if (Array.isArray(old.renderBounds)) {
    const table = new RenderBounds(old.renderBounds.length);
    old.renderBounds.forEach((b, i) => {
      const o = BOUND.WORDS * i;
      for (let k = 0; k < 3; k++) { table.floats[o + k] = exactFloat(b.min[k], 'bound'); table.floats[o + 3 + k] = exactFloat(b.max[k], 'bound'); }
      table.words[o + 6] = b.valid ? 1 : 0;
    });
    out.renderBounds = table;
  }
  if (Array.isArray(old.leaves)) {
    const table = new Leaves(old.leaves.length), w = table.words;
    old.leaves.forEach((l, i) => {
      const o = LEAF.WORDS * i, v = l.visibleZones ?? [0, 0];
      w[o] = exactInt(l.zone ?? 0, 'leaf zone'); w[o + 1] = exactInt(l.permeating ?? -1, 'permeating'); w[o + 2] = exactInt(l.volumetric ?? -1, 'volumetric');
      w[o + 3] = exactInt(v[0], 'visibleZones'); w[o + 4] = exactInt(v[1], 'visibleZones');
    });
    out.leaves = table;
  }
  if (Array.isArray(old.leafHulls)) out.leafHulls = Int32Array.from(old.leafHulls, v => exactInt(v, 'leaf hull word') | 0);
  if (Array.isArray(old.lights)) out.lights = Int32Array.from(old.lights, v => exactInt(v, 'light') | 0);
  return out;
}

/** The old object form of a model: arrays of node, surface, vertex... objects and of point arrays, every record made at once. Cold:
 * for validators, fixtures and the differential tests against the original object reader. */
export function modelObjects(model) {
  const all = table => table && Array.from({ length: table.length }, (_, i) => table.at(i)), list = array => array && Array.from(array);
  return { ...model, vectors: all(model.vectors), points: all(model.points), nodes: all(model.nodes), surfaces: all(model.surfaces),
    vertices: all(model.vertices), zones: all(model.zones), lightMaps: all(model.lightMaps), renderBounds: all(model.renderBounds),
    leaves: all(model.leaves), leafHulls: list(model.leafHulls), lights: list(model.lights) };
}
