/**
 * The host collider's convex hulls (collision.mjs BspCollider) as typed arrays: host representation only. They were one object per
 * hull, with an array per plane and per bevel (191,000 objects on the Island) and one more array per partition plane, built for
 * every collider at load. The values are the same doubles, computed by the same expressions in the same order, and now held in a
 * few Float64Arrays: a hull's planes (its compiled planes, the six box planes of its bounds and the bevels) and its sweep planes
 * (the compiled planes, the six FBoxLineCheck bounds of a world hull, the bevels) are ranges of two arrays.
 *
 * Nothing reads them in Play: with a compiled root (`rootOutside`, every map) BspCollider answers its sweeps and overlaps with the
 * original model queries (ray.mjs, extent-trace.mjs, point-check.mjs) and uses hulls only for a model with no root (the
 * synthetic fixtures of the unit tests). The collider builds its set on first use.
 */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, s) => a.map(v => v * s);
const length = a => Math.hypot(...a);
const floatBuffer = new DataView(new ArrayBuffer(4));
const asFloat = n => { floatBuffer.setInt32(0, n, true); return floatBuffer.getFloat32(0, true); };
const boxPlanes = (min, max) => [
  [1, 0, 0, max[0]], [-1, 0, 0, -min[0]], [0, 1, 0, max[1]],
  [0, -1, 0, -min[1]], [0, 0, 1, max[2]], [0, 0, -1, -min[2]],
];

/** A growing Float64Array. */
class Doubles {
  constructor(capacity = 1024) { this.data = new Float64Array(capacity); this.length = 0; }
  push(...values) {
    if (this.length + values.length > this.data.length) {
      const grown = new Float64Array(Math.max(this.data.length * 2, this.length + values.length));
      grown.set(this.data); this.data = grown;
    }
    for (const v of values) this.data[this.length++] = v;
  }
  done() { return this.data.slice(0, this.length); }
}

export class HullSet {
  constructor(count, node, bound, min, max, planeStart, planes, sweepStart, sweep) {
    this.length = count; this.node = node; this.bound = bound; this.min = min; this.max = max;
    this.planeStart = planeStart; this.planes = planes; this.sweepStart = sweepStart; this.sweep = sweep;
  }
  /** The hull whose compiled collision bound is at leaf-hull word `bound`, or undefined. */
  indexOfBound(bound) {
    if (!this.byBound) { this.byBound = new Map(); for (let i = 0; i < this.length; i++) this.byBound.set(this.bound[i], i); }
    return this.byBound.get(bound);
  }
  /** Hull `i` as the object form: {min, max, planes, sweepPlanes, node}. Cold: validators and tests. */
  at(i) {
    if (!(i >= 0 && i < this.length) || !Number.isInteger(i)) return undefined;
    const list = (data, from, to) => Array.from({ length: to - from }, (_, k) => Array.from(data.subarray(4 * (from + k), 4 * (from + k) + 4)));
    return { min: Array.from(this.min.subarray(3 * i, 3 * i + 3)), max: Array.from(this.max.subarray(3 * i, 3 * i + 3)),
      planes: list(this.planes, this.planeStart[i], this.planeStart[i + 1]), sweepPlanes: list(this.sweep, this.sweepStart[i], this.sweepStart[i + 1]), node: this.node[i] };
  }
  objects() { return Array.from({ length: this.length }, (_, i) => this.at(i)); }
}

/** Decode the original compiled solid-leaf hulls. Their terminal six int32 words
 * contain float bounding coordinates; bit 30 reverses a referenced BSP plane. */
export function readCollisionHulls(model, transformPoint, transformNormal) {
  const brush = Boolean(transformPoint);
  transformPoint ??= p => p;
  transformNormal ??= n => n;
  const { nodes, leafHulls } = model;
  const node = [], bound = [], min = new Doubles(), max = new Doubles(), planeStart = [0], sweepStart = [0], all = new Doubles(4096), sweep = new Doubles(4096), seen = new Set();
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    let cursor = nodes.collisionBound(nodeIndex);
    if (cursor === -1 || seen.has(cursor)) continue;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor >= leafHulls.length) throw new Error('Invalid collision hull offset');
    seen.add(cursor);
    const start = cursor, planes = [];
    while (cursor < leafHulls.length && leafHulls[cursor] >= 0) {
      const ref = leafHulls[cursor++], index = ref & ~0x40000000;
      if (!(index >= 0 && index < nodes.length)) throw new Error('Invalid collision hull plane');
      const source = nodes.planeArray(index);
      const sign = ref & 0x40000000 ? -1 : 1, n = source.slice(0, 3).map(v => v * sign);
      const n2 = dot(n, n);
      if (n2 < .5 || !source.every(Number.isFinite)) throw new Error('Invalid collision plane normal');
      const point = transformPoint(scale(n, source[3] * sign / n2));
      const transformed = transformNormal(n), normal = scale(transformed, 1 / length(transformed));
      planes.push([...normal, dot(normal, point)]);
    }
    if (!planes.length || leafHulls[cursor++] !== -1 || cursor + 6 > leafHulls.length) throw new Error('Truncated collision hull');
    const original = Array.from(leafHulls.subarray(cursor, cursor + 6), asFloat);
    if (!original.every(Number.isFinite) || original.slice(0, 3).some((v, i) => v > original[i + 3])) throw new Error('Invalid collision hull bounds');
    const corners = Array.from({ length: 8 }, (_, mask) => transformPoint([0, 1, 2].map(i => original[i + ((mask >> i & 1) ? 3 : 0)])));
    const lo = [0, 1, 2].map(i => Math.min(...corners.map(p => p[i]))), hi = [0, 1, 2].map(i => Math.max(...corners.map(p => p[i])));
    // Additional support planes around edges make box sweeps work at bevelled
    // corners as well as faces. Positive combinations remain supporting planes.
    const bevels = [];
    for (let a = 0; a < planes.length; a++) for (let b = 0; b < a; b++) {
      for (let axis = 0; axis < 3; axis++) if (planes[a][axis] * planes[b][axis] < -1e-8) {
        const p = planes[a].map((v, i) => v * Math.abs(planes[b][axis]) + planes[b][i] * Math.abs(planes[a][axis]));
        const size = length(p.slice(0, 3));
        if (size > 1e-5) bevels.push(p.map(v => v / size));
      }
    }
    // FBoxLineCheck's six supplemental bounds are asymmetric in this binary:
    // Z expands both ways; the positive X/Y boundaries move inward by 0.1.
    // Keep point-overlap geometry separate from these line-check tolerances.
    // Engine.dll 0x103f4968 / 0x103f4ad6 / 0x103f4c35 / 0x103f4d94 /
    // 0x103f4ef3 / 0x103f5052; verified by executing the original LineCheck.
    const f = Math.fround;
    const clipBounds = [[0, 0, -1, f(.1 - lo[2])], [0, 0, 1, f(hi[2] + .1)],
      [-1, 0, 0, f(.1 - lo[0])], [1, 0, 0, f(hi[0] - .1)],
      [0, -1, 0, f(.1 - lo[1])], [0, 1, 0, f(hi[1] - .1)]];
    node.push(nodeIndex); bound.push(start); min.push(...lo); max.push(...hi);
    // The native owner/brush path skips these supplemental world bounds.
    for (const p of [...planes, ...boxPlanes(lo, hi), ...bevels]) all.push(...p);
    for (const p of [...planes, ...(brush ? [] : clipBounds), ...bevels]) sweep.push(...p);
    planeStart.push(all.length / 4); sweepStart.push(sweep.length / 4);
  }
  return new HullSet(node.length, Int32Array.from(node), Int32Array.from(bound), min.done(), max.done(),
    Int32Array.from(planeStart), all.done(), Int32Array.from(sweepStart), sweep.done());
}

/** The hulls' bounding-box tree, over hull indices. A node is a record in `nodes` (kind, a, b: for a leaf the range of `items`, for a
 * branch its two children) with its bounds in `bounds`; built by the same split as the object tree (the longest axis, the hulls
 * ordered by their box centres, halved), so queries visit hulls in the same order. */
export class HullTree {
  constructor(set) {
    this.set = set;
    const nodes = [], bounds = [], items = [];
    const build = list => {
      if (!list.length) return -1;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const h of list) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], set.min[3 * h + i]); hi[i] = Math.max(hi[i], set.max[3 * h + i]); }
      const id = nodes.length / 3;
      nodes.push(0, 0, 0); bounds.push(...lo, ...hi);
      if (list.length <= 8) {
        nodes[3 * id] = 0; nodes[3 * id + 1] = items.length; nodes[3 * id + 2] = list.length;
        items.push(...list);
        return id;
      }
      const spans = hi.map((v, i) => v - lo[i]), axis = spans.indexOf(Math.max(...spans));
      list.sort((a, b) => set.min[3 * a + axis] + set.max[3 * a + axis] - set.min[3 * b + axis] - set.max[3 * b + axis]);
      const middle = list.length >> 1;
      const left = build(list.slice(0, middle)), right = build(list.slice(middle));
      nodes[3 * id] = 1; nodes[3 * id + 1] = left; nodes[3 * id + 2] = right;
      return id;
    };
    this.root = build(Array.from({ length: set.length }, (_, i) => i));
    this.nodes = Int32Array.from(nodes); this.bounds = Float64Array.from(bounds); this.items = Int32Array.from(items);
  }
  /** Indices of the hulls whose boxes overlap the box [lo, hi], in the object tree's order. */
  overlapping(lo, hi) {
    const result = [], stack = this.root >= 0 ? [this.root] : [], { nodes, bounds, items, set } = this;
    const overlaps = (min, max, at) => min[at] <= hi[0] && max[at] >= lo[0] && min[at + 1] <= hi[1] && max[at + 1] >= lo[1] && min[at + 2] <= hi[2] && max[at + 2] >= lo[2];
    const box = id => bounds[6 * id] <= hi[0] && bounds[6 * id + 3] >= lo[0] && bounds[6 * id + 1] <= hi[1] && bounds[6 * id + 4] >= lo[1] &&
      bounds[6 * id + 2] <= hi[2] && bounds[6 * id + 5] >= lo[2];
    while (stack.length) {
      const id = stack.pop();
      if (!box(id)) continue;
      if (nodes[3 * id] === 0) {
        for (let k = nodes[3 * id + 1]; k < nodes[3 * id + 1] + nodes[3 * id + 2]; k++) if (overlaps(set.min, set.max, 3 * items[k])) result.push(items[k]);
      } else stack.push(nodes[3 * id + 1], nodes[3 * id + 2]);
    }
    return result;
  }
}
