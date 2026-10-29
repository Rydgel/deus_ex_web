import { traceRay } from '../../src/runtime/ray.mjs';
import { brushToWorld } from '../../src/runtime/coords.mjs';
import { traceExtent } from '../../src/runtime/extent-trace.mjs';
import { createLevelQueries } from '../../src/runtime/level-queries.mjs';
import { pointCheck, modelPointCheck } from '../../src/runtime/point-check.mjs';
import { findSpot } from '../../src/runtime/fitting.mjs';
import { primitivePointCheck } from '../../src/runtime/primitive-collision.mjs';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const scale = (a, s) => a.map(v => v * s);
const length = a => Math.hypot(...a);
const support = (n, e) => Math.abs(n[0]) * e[0] + Math.abs(n[1]) * e[1] + Math.abs(n[2]) * e[2];
const distance = (p, v) => dot(p, v) - p[3];
const floatBuffer = new DataView(new ArrayBuffer(4));
const asFloat = n => { floatBuffer.setInt32(0, n, true); return floatBuffer.getFloat32(0, true); };
const boxPlanes = (min, max) => [
  [1, 0, 0, max[0]], [-1, 0, 0, -min[0]], [0, 1, 0, max[1]],
  [0, -1, 0, -min[1]], [0, 0, 1, max[2]], [0, 0, -1, -min[2]],
];
const overlapBounds = (a, b) => a.min.every((v, i) => v <= b.max[i] && a.max[i] >= b.min[i]);
const boundsOf = hulls => ({ min: [0, 1, 2].map(i => Math.min(...hulls.map(h => h.min[i]))), max: [0, 1, 2].map(i => Math.max(...hulls.map(h => h.max[i]))) });

function tree(hulls) {
  if (!hulls.length) return null;
  const bounds = boundsOf(hulls);
  if (hulls.length <= 8) return { ...bounds, hulls };
  const spans = sub(bounds.max, bounds.min), axis = spans.indexOf(Math.max(...spans));
  hulls.sort((a, b) => a.min[axis] + a.max[axis] - b.min[axis] - b.max[axis]);
  const middle = hulls.length >> 1;
  return { ...bounds, left: tree(hulls.slice(0, middle)), right: tree(hulls.slice(middle)) };
}

/** Decode the original compiled solid-leaf hulls. Their terminal six int32 words
 * contain float bounding coordinates; bit 30 reverses a referenced BSP plane. */
export function readCollisionHulls(model, transformPoint, transformNormal) {
  const brush = Boolean(transformPoint);
  transformPoint ??= p => p;
  transformNormal ??= n => n;
  const hulls = [], seen = new Set();
  for (const [nodeIndex, node] of model.nodes.entries()) {
    let cursor = node.collisionBound;
    if (cursor === -1 || seen.has(cursor)) continue;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor >= model.leafHulls.length) throw new Error('Invalid collision hull offset');
    seen.add(cursor);
    const planes = [];
    while (cursor < model.leafHulls.length && model.leafHulls[cursor] >= 0) {
      const ref = model.leafHulls[cursor++], source = model.nodes[ref & ~0x40000000]?.plane;
      if (!source) throw new Error('Invalid collision hull plane');
      const sign = ref & 0x40000000 ? -1 : 1, n = source.slice(0, 3).map(v => v * sign);
      const n2 = dot(n, n);
      if (n2 < .5 || !source.every(Number.isFinite)) throw new Error('Invalid collision plane normal');
      const point = transformPoint(scale(n, source[3] * sign / n2));
      const transformed = transformNormal(n), normal = scale(transformed, 1 / length(transformed));
      planes.push([...normal, dot(normal, point)]);
    }
    if (!planes.length || model.leafHulls[cursor++] !== -1 || cursor + 6 > model.leafHulls.length) throw new Error('Truncated collision hull');
    const original = model.leafHulls.slice(cursor, cursor + 6).map(asFloat);
    if (!original.every(Number.isFinite) || original.slice(0, 3).some((v, i) => v > original[i + 3])) throw new Error('Invalid collision hull bounds');
    const corners = Array.from({ length: 8 }, (_, mask) => transformPoint([0, 1, 2].map(i => original[i + ((mask >> i & 1) ? 3 : 0)])));
    const min = [0, 1, 2].map(i => Math.min(...corners.map(p => p[i]))), max = [0, 1, 2].map(i => Math.max(...corners.map(p => p[i])));
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
    const clipBounds = [[0, 0, -1, f(.1 - min[2])], [0, 0, 1, f(max[2] + .1)],
      [-1, 0, 0, f(.1 - min[0])], [1, 0, 0, f(max[0] - .1)],
      [0, -1, 0, f(.1 - min[1])], [0, 1, 0, f(max[1] - .1)]];
    hulls.push({ min, max, planes: [...planes, ...boxPlanes(min, max), ...bevels],
      // The native owner/brush path skips these supplemental world bounds.
      sweepPlanes: [...planes, ...(brush ? [] : clipBounds), ...bevels], node: nodeIndex });
  }
  return hulls;
}

/** Sweep an axis-aligned extent through a convex solid using a parametric clip.
 * Contact parallel to, or departing from, a face does not obstruct sliding. */
export function sweepHull(hull, start, delta, extent, maxTime = 2) {
  // Original FBoxLineCheck: entry starts at -1, and shallow initial overlap
  // blocks inward movement while permitting escape or tangential movement.
  let enter = -1, leave = maxTime, normal = null, depth = -Infinity;
  for (const plane of hull.sweepPlanes ?? hull.planes) {
    const pushout = support(plane, extent), from = distance(plane, start), speed = dot(plane, delta);
    let d = from - pushout;
    depth = Math.max(depth, d);
    if (speed < 0 && from >= 0 && d < 0) d = 0;
    if (speed < -1e-5) {
      const t = -d / speed;
      if (t > enter) { enter = t; normal = plane.slice(0, 3); }
    } else if (speed > 1e-5) leave = Math.min(leave, -d / speed);
    else if (from > pushout && from + speed > pushout) return null;
    if (enter >= leave) return null;
  }
  if (enter <= -1 || leave <= 0 || enter >= 2 || !normal) return null;
  return { time: enter, normal, penetrating: depth < 0 };
}

/** The host collider's hulls use the mover's load-time transform plus a
 * translation offset. A mover rotated since load (a hinged door) is answered
 * only by the original model queries (level-queries.mjs), never here. */
function assertHostCollider(actor) {
  const loaded = actor.collider.ownerValues?.Rotation ?? [0, 0, 0], now = actor.rotation ?? loaded;
  if (now.some((v, i) => (v | 0) !== (loaded[i] | 0)))
    throw new Error(`Host brush collider of rotated mover ${actor.name} is not rebuilt; use the original model queries`);
}

export class BspCollider {
  constructor(model, transformPoint, transformNormal, ownerValues = null) {
    this.ownedBrush = Boolean(transformPoint || ownerValues);
    this.ownerValues = ownerValues;
    this.hulls = readCollisionHulls(model, transformPoint, transformNormal);
    this.tree = tree([...this.hulls]);
    this.offset = [0, 0, 0];
    this.model = model;
    this.hullByBound = new Map(this.hulls.map(h => [model.nodes[h.node].collisionBound, h]));
    this.partitionPlanes = model.nodes.map(({ plane }) => {
      if (!transformPoint) return plane;
      const n = plane.slice(0, 3), point = transformPoint(scale(n, plane[3] / dot(n, n)));
      const transformed = transformNormal(n), normal = scale(transformed, 1 / length(transformed));
      return [...normal, dot(normal, point)];
    });
  }
  candidates(start, delta, extent) {
    const end = add(start, delta), bounds = { min: start.map((v, i) => Math.min(v, end[i]) - extent[i] - .001), max: start.map((v, i) => Math.max(v, end[i]) + extent[i] + .001) };
    const result = [], stack = this.tree ? [this.tree] : [];
    while (stack.length) {
      const node = stack.pop();
      if (!overlapBounds(node, bounds)) continue;
      if (node.hulls) result.push(...node.hulls.filter(h => overlapBounds(h, bounds)));
      else stack.push(node.left, node.right);
    }
    return result;
  }
  *lineCandidates(start, delta, extent) {
    // FBoxLineCheck visits the original BSP in movement order. In an initial
    // overlap the first nonpositive-time hit prevents subsequent leaf updates;
    // changing the traversal order changes its normal and therefore sliding.
    const { nodes, rootOutside } = this.model;
    if (rootOutside === undefined) { yield* this.candidates(start, delta, scale(extent, 1.1)); return; }
    if (!nodes.length) return;
    const stack = [{ index: 0, parent: -1, outside: Boolean(rootOutside) }];
    let visits = 0;
    while (stack.length) {
      if (++visits > nodes.length * 4 + 4) throw new Error('Invalid cyclic collision BSP');
      const { index, parent, outside } = stack.pop();
      if (index === -1) {
        const hull = !outside && this.hullByBound.get(nodes[parent]?.collisionBound);
        if (hull) yield hull;
        continue;
      }
      const node = nodes[index], plane = this.partitionPlanes[index];
      const from = distance(plane, start), to = from + dot(plane, delta), padded = support(plane, scale(extent, 1.1));
      const solid = node.vertexCount > 0 && !(node.flags & 0x21);
      const branches = [
        { index: node.back, parent: index, outside: outside && !solid, visit: from <= padded || to <= padded },
        { index: node.front, parent: index, outside: outside || solid, visit: from >= -padded || to >= -padded },
      ];
      const near = from >= to ? 1 : 0;
      if (branches[1 - near].visit) stack.push(branches[1 - near]);
      if (branches[near].visit) stack.push(branches[near]);
    }
  }
  sweep(start, delta, extent) {
    if (this.model.rootOutside !== undefined && extent.some(v => v !== 0)) {
      const owner = this.ownerValues && { ...this.ownerValues,
        Location: (this.ownerValues.Location ?? [0,0,0]).map((v,i) => Math.fround(v + this.offset[i])) };
      return traceExtent(this.model, start, add(start, delta), extent, owner && brushToWorld(owner));
    }
    if (this.ownerValues && this.model.rootOutside !== undefined && extent.every(v => v === 0)) {
      // Owner rays keep world endpoints. Apply the mover's current location
      // through original ToWorld, rather than shifting the query in double
      // precision or tracing the approximate transformed extent hulls.
      const values = this.ownerValues;
      const Location = (values.Location ?? [0, 0, 0]).map((v, i) => Math.fround(v + this.offset[i]));
      return traceRay(this.model, start, add(start, delta), 0, brushToWorld({ ...values, Location }));
    }
    start = sub(start, this.offset);
    if (!this.ownedBrush && this.model.rootOutside !== undefined && extent.every(v => v === 0)) {
      // The original ray routine traverses the BSP directly. Extent hull
      // clipping reports different hits, notably when starting inside solid.
      const hit = traceRay(this.model, start, add(start, delta));
      if (hit && this.offset.some(v => v !== 0)) hit.location = add(hit.location, this.offset).map(Math.fround);
      return hit;
    }
    let hit = null;
    // The native BSP traversal pads extents by 1.1 before visiting leaves. Its
    // raw clip may be beyond the endpoint and enter the segment after backoff.
    for (const hull of this.lineCandidates(start, delta, extent)) {
      const next = sweepHull(hull, start, delta, extent, hit?.time ?? 2);
      if (next && (!hit || next.time < hit.time)) hit = { ...next, node: hull.node };
    }
    if (!hit) return null;
    // UModel.LineCheck, Engine.dll 0x103f403b: MAX, not MIN. For a
    // 30-unit extent trace this removes 3 units; zero-extent rays remove 0.5.
    const size = length(delta);
    const backoff = extent.some(v => v !== 0) ? Math.max(.1, .1 / size) : .5 / size;
    const time = Math.max(0, hit.time - backoff);
    return time < 1 ? { ...hit, time } : null;
  }
  overlaps(position, extent) {
    if (!this.ownedBrush && this.model.rootOutside !== undefined) return !pointCheck(this.model, position, extent);
    if (this.ownerValues && this.model.rootOutside !== undefined) {
      const Location = this.ownerValues.Location.map((v,i) => Math.fround(v + this.offset[i]));
      return !modelPointCheck(this.model, position, extent, brushToWorld({ ...this.ownerValues, Location })).outside;
    }
    const p = sub(position, this.offset);
    return this.candidates(p, [0, 0, 0], extent).some(h => h.planes.every(n => distance(n, p) - support(n, extent) < -1e-4));
  }
}

/** UE actor/actor collision uses upright cylinders; BSP checks use box extents. */
export function sweepCylinder(actor, start, delta, extent) {
  const p = sub(start, actor.position), r = actor.radius + extent[0], h = actor.height + extent[2];
  const a = delta[0] ** 2 + delta[1] ** 2, b = p[0] * delta[0] + p[1] * delta[1], c = p[0] ** 2 + p[1] ** 2 - r ** 2;
  let enter = -Infinity, leave = Infinity, normal = [0, 0, 0];
  if (a < 1e-12) { if (c >= 0) return null; }
  else {
    const disc = b * b - a * c;
    if (disc <= 0) return null;
    enter = (-b - Math.sqrt(disc)) / a; leave = (-b + Math.sqrt(disc)) / a;
    normal = [(p[0] + delta[0] * enter) / r, (p[1] + delta[1] * enter) / r, 0];
  }
  if (Math.abs(delta[2]) < 1e-12) { if (Math.abs(p[2]) >= h) return null; }
  else {
    const t1 = (-h - p[2]) / delta[2], t2 = (h - p[2]) / delta[2], t = Math.min(t1, t2);
    if (t > enter) { enter = t; normal = [0, 0, -Math.sign(delta[2])]; }
    leave = Math.min(leave, Math.max(t1, t2));
  }
  if (enter >= leave || leave <= 1e-8 || enter > 1 || enter < -1e-7) return null;
  return { time: Math.max(0, enter), normal, penetrating: false };
}

export class CollisionWorld {
  constructor(model) { this.bsp = new BspCollider(model); this.movers = []; this.actors = []; }
  registerActors(actors) {
    this.queries = createLevelQueries(this.bsp.model, actors, {
      extentCheck: traceExtent, levelInfo: this.queries?.levelInfo,
    });
  }
  lineCheck(start, end, extent, flags, extra = 0, source = null) {
    if (!this.queries) throw new Error('Level actors must be registered before native level queries');
    return this.queries.lineCheck(start, end, extent, flags, extra, source);
  }
  setMoverOffset(actor, offset) {
    const change = () => {
      actor.collider.offset = offset.map(Math.fround);
      if (actor.position) actor.position = actor.values.Location.map((v,i) => Math.fround(v + actor.collider.offset[i]));
    };
    if (this.queries) this.queries.changeActor(actor, change); else change();
  }
  setMoverPosition(actor, position) {
    const change = () => {
      actor.position = position.map(Math.fround);
      actor.collider.offset = actor.position.map((v,i) => Math.fround(v - actor.values.Location[i]));
    };
    if (this.queries) this.queries.changeActor(actor, change); else change();
  }
  sweep(start, delta, extent = [0, 0, 0], ignore = null) {
    let hit = this.bsp.sweep(start, delta, extent);
    if (hit) hit.actor = null;
    for (const actor of [...this.movers, ...this.actors]) {
      if (actor === ignore || !actor.blocking) continue;
      if (actor.collider) assertHostCollider(actor);
      const next = actor.collider ? actor.collider.sweep(start, delta, extent) : sweepCylinder(actor, start, delta, extent);
      if (next && (!hit || next.time < hit.time)) hit = { ...next, actor };
    }
    return hit;
  }
  overlaps(p, e, ignore = null) {
    if (this.bsp.overlaps(p, e)) return true;
    return [...this.movers, ...this.actors].some(a => a !== ignore && a.blocking && (a.collider ? (assertHostCollider(a), a.collider.overlaps(p, e))
      : !primitivePointCheck({location: a.position, radius: a.radius, height: a.height}, p, e).outside));
  }
  findSpot(position, extent, checkActors = 0, checkFirst = 1) {
    if (this.queries) return findSpot(this.queries, position, extent, checkActors, checkFirst);
    // Geometry-only synthetic fixtures predate the complete level format.
    if (!this.overlaps(position, extent)) return [...position];
    let candidate = [...position];
    const adjust = (direction, size) => {
      // Known gap: original flags 6 also query movers. This prototype only
      // queries world geometry, including its native half-unit ray backoff.
      const hit = this.bsp.sweep(candidate, direction, [0, 0, 0]);
      if (!hit) return;
      candidate = add(candidate, scale(hit.normal, (1.05 - hit.time) * size));
    };
    for (const sign of [-1, 1]) for (let axis = 0; axis < 3; axis++) {
      const direction = [0, 0, 0]; direction[axis] = sign * extent[axis]; adjust(direction, extent[axis]);
    }
    if (!this.overlaps(candidate, extent)) return candidate;
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) adjust([x * extent[0], y * extent[1], z * extent[2]], length(extent) + 2);
    if (dot(sub(candidate, position), sub(candidate, position)) > dot(extent, extent) * 1.5 || this.overlaps(candidate, extent)) return null;
    return candidate;
  }
}
