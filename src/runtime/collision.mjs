import { traceRay } from './ray.mjs';
import { brushToWorld } from './coords.mjs';
import { traceExtent } from './extent-trace.mjs';
import { createLevelQueries } from './level-queries.mjs';
import { runtimeLineKernel } from './collision-kernel.mjs';
import { pointCheck, modelPointCheck } from './point-check.mjs';
import { findSpot } from './fitting.mjs';
import { primitivePointCheck } from './primitive-collision.mjs';
import { readCollisionHulls, HullTree } from './collision-hulls.mjs';

export { readCollisionHulls };

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const scale = (a, s) => a.map(v => v * s);
const length = a => Math.hypot(...a);
const support = (n, e) => Math.abs(n[0]) * e[0] + Math.abs(n[1]) * e[1] + Math.abs(n[2]) * e[2];
const distance = (p, v) => dot(p, v) - p[3];
/** Sweep an axis-aligned extent through a convex solid using a parametric clip.
 * Contact parallel to, or departing from, a face does not obstruct sliding. `planes` is a flat run of [x, y, z, w] planes from
 * `from` to `to` (a hull's `sweep` or `planes` range, collision-hulls.mjs); `sweepHull` takes the object form of a hull. */
function sweepPlanes(planes, from, to, start, delta, extent, maxTime = 2) {
  // Original FBoxLineCheck: entry starts at -1, and shallow initial overlap
  // blocks inward movement while permitting escape or tangential movement.
  let enter = -1, leave = maxTime, nx = 0, ny = 0, nz = 0, found = false, depth = -Infinity;
  for (let k = from; k < to; k++) {
    const at = 4 * k, a = planes[at], b = planes[at + 1], c = planes[at + 2], w = planes[at + 3];
    const pushout = Math.abs(a) * extent[0] + Math.abs(b) * extent[1] + Math.abs(c) * extent[2];
    const distanceFrom = a * start[0] + b * start[1] + c * start[2] - w, speed = a * delta[0] + b * delta[1] + c * delta[2];
    let d = distanceFrom - pushout;
    depth = Math.max(depth, d);
    if (speed < 0 && distanceFrom >= 0 && d < 0) d = 0;
    if (speed < -1e-5) {
      const t = -d / speed;
      if (t > enter) { enter = t; nx = a; ny = b; nz = c; found = true; }
    } else if (speed > 1e-5) leave = Math.min(leave, -d / speed);
    else if (distanceFrom > pushout && distanceFrom + speed > pushout) return null;
    if (enter >= leave) return null;
  }
  if (enter <= -1 || leave <= 0 || enter >= 2 || !found) return null;
  return { time: enter, normal: [nx, ny, nz], penetrating: depth < 0 };
}
export function sweepHull(hull, start, delta, extent, maxTime = 2) {
  const planes = hull.sweepPlanes ?? hull.planes, flat = new Float64Array(4 * planes.length);
  planes.forEach((p, i) => flat.set(p, 4 * i));
  return sweepPlanes(flat, 0, planes.length, start, delta, extent, maxTime);
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
    this.offset = [0, 0, 0];
    this.model = model;
    this.transformPoint = transformPoint; this.transformNormal = transformNormal;
    this.prepared = null;
  }
  /** The compiled hulls, their box tree and the transformed partition planes: built at the first query that needs them. With a
   * compiled root (every map) the sweeps and overlaps below are answered by the original model queries and never need them. */
  prepare() {
    if (this.prepared) return this.prepared;
    const { model, transformPoint, transformNormal } = this;
    const hulls = readCollisionHulls(model, transformPoint, transformNormal), nodes = model.nodes;
    // One Float64Array of [x, y, z, w] a node: the node's plane, or the plane carried by the brush's transform.
    const partition = new Float64Array(4 * nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const plane = nodes.planeArray(i);
      if (!transformPoint) { partition.set(plane, 4 * i); continue; }
      const n = plane.slice(0, 3), point = transformPoint(scale(n, plane[3] / dot(n, n)));
      const transformed = transformNormal(n), normal = scale(transformed, 1 / length(transformed));
      partition.set([...normal, dot(normal, point)], 4 * i);
    }
    return this.prepared = { hulls, tree: new HullTree(hulls), partition };
  }
  get hulls() { return this.prepare().hulls; }
  /** How many collision hulls the model compiles: the distinct valid collision bounds of its nodes (what readCollisionHulls makes), without building them. */
  get hullCount() {
    if (this.prepared) return this.prepared.hulls.length;
    const bounds = new Set(), nodes = this.model.nodes;
    for (let i = 0; i < nodes.length; i++) if (nodes.collisionBound(i) !== -1) bounds.add(nodes.collisionBound(i));
    return bounds.size;
  }
  /** Hull indices whose boxes the swept extent overlaps. */
  candidates(start, delta, extent) {
    const end = add(start, delta);
    const lo = start.map((v, i) => Math.min(v, end[i]) - extent[i] - .001), hi = start.map((v, i) => Math.max(v, end[i]) + extent[i] + .001);
    return this.prepare().tree.overlapping(lo, hi);
  }
  *lineCandidates(start, delta, extent) {
    // FBoxLineCheck visits the original BSP in movement order. In an initial
    // overlap the first nonpositive-time hit prevents subsequent leaf updates;
    // changing the traversal order changes its normal and therefore sliding.
    const { nodes, rootOutside } = this.model;
    if (rootOutside === undefined) { yield* this.candidates(start, delta, scale(extent, 1.1)); return; }
    if (!nodes.length) return;
    const { hulls, partition } = this.prepare();
    const stack = [{ index: 0, parent: -1, outside: Boolean(rootOutside) }];
    let visits = 0;
    while (stack.length) {
      if (++visits > nodes.length * 4 + 4) throw new Error('Invalid cyclic collision BSP');
      const { index, parent, outside } = stack.pop();
      if (index === -1) {
        const hull = !outside && parent >= 0 && parent < nodes.length ? hulls.indexOfBound(nodes.collisionBound(parent)) : undefined;
        if (hull !== undefined) yield hull;
        continue;
      }
      const plane = partition.subarray(4 * index, 4 * index + 4);
      const from = distance(plane, start), to = from + dot(plane, delta), padded = support(plane, scale(extent, 1.1));
      const solid = nodes.vertexCount(index) > 0 && !(nodes.flags(index) & 0x21);
      const branches = [
        { index: nodes.back(index), parent: index, outside: outside && !solid, visit: from <= padded || to <= padded },
        { index: nodes.front(index), parent: index, outside: outside || solid, visit: from >= -padded || to >= -padded },
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
      const { hulls } = this.prepare();
      const next = sweepPlanes(hulls.sweep, hulls.sweepStart[hull], hulls.sweepStart[hull + 1], start, delta, extent, hit?.time ?? 2);
      if (next && (!hit || next.time < hit.time)) hit = { ...next, node: hulls.node[hull] };
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
    const p = sub(position, this.offset), { hulls } = this.prepare(), planes = hulls.planes;
    return this.candidates(p, [0, 0, 0], extent).some(h => {
      for (let k = hulls.planeStart[h]; k < hulls.planeStart[h + 1]; k++) {
        const n = planes.subarray(4 * k, 4 * k + 4);
        if (!(distance(n, p) - support(n, extent) < -1e-4)) return false;
      }
      return true;
    });
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
      extentCheck: traceExtent, levelInfo: this.queries?.levelInfo, lineKernel: this.lineKernel ?? null,
    });
  }
  /** The script runtime's interpreter instance now exists (`vm`: its RustScriptVm, null without one): the level queries'
   * hash, now and after every later registerActors, lives in it (collision-kernel.mjs runtimeLineKernel). */
  adoptRuntime(vm) {
    const kernel = runtimeLineKernel(vm);
    if (!kernel) return;
    this.lineKernel = kernel;
    this.queries?.adoptKernel(kernel);
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
