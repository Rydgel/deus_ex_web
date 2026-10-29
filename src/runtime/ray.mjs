import { traceKernel, TRACE_DIFFERENTIAL, checkTraceKernel } from './trace-kernel.mjs';
import { x87C0 } from './x87-nan.mjs';

const f = Math.fround;
const planeDistance = (p, v) => f(v[2] * p[2] + v[0] * p[0] + v[1] * p[1] - p[3]);
const dotZYX = (a, b) => a[2] * b[2] + a[1] * b[1] + a[0] * b[0];
const transformVector = (v, rows) => rows.map(row => f(v[0] * row[0] + v[1] * row[1] + v[2] * row[2]));

/** Original zero-extent LineCheck / BSP traversal. Optional owner coordinates
 * contain ABrush.ToWorld's origin followed by its X/Y/Z axes. Generation of
 * those coordinates must be verified separately from the ray algorithm.
 * Evidence and float-store ordering: docs/fitting.md.
 */
// Differential check (host development): RAY_DIFFERENTIAL=1 runs the reference
// traversal beside the fast one and throws on any difference.
const differential = typeof process !== 'undefined' && process.env?.RAY_DIFFERENTIAL === '1';

/** Once the Rust trace kernel is loaded (trace-kernel.mjs, native/script-vm
 * src/trace.rs) it answers; traceRayFast answers before that and every case
 * the kernel hands back. TRACE_DIFFERENTIAL=1 checks each kernel answer
 * against traceRayFast. */
export function traceRay(model, start, end, extraNodeFlags = 0, ownerCoords = null) {
  let result = traceKernel === null ? undefined : traceKernel.ray(model, start, end, extraNodeFlags, ownerCoords);
  if (result === undefined) result = traceRayFast(model, start, end, extraNodeFlags, ownerCoords);
  else if (TRACE_DIFFERENTIAL) checkTraceKernel('traceRay', result,
    () => traceRayFast(model, start, end, extraNodeFlags, ownerCoords), { start, end, extraNodeFlags, ownerCoords });
  if (differential) {
    const reference = traceRayReference(model, start, end, extraNodeFlags, ownerCoords);
    if (!sameRayResult(result, reference))
      throw new Error(`traceRay differential mismatch: ${JSON.stringify({ start, end, extraNodeFlags, ownerCoords, result, reference })}`);
  }
  return result;
}
/** Whether the zero-extent ray from `start` to `end` over `model` misses (traceRay(model, start, end) === null), asked of the kernel
 * without the hit object a hit builds; undefined where the kernel hands back (the caller's JavaScript answers). */
export function traceRayClear(model, start, end) {
  const clear = traceKernel === null ? undefined : traceKernel.rayClear(model, start, end);
  if (clear === undefined) return undefined;
  if (TRACE_DIFFERENTIAL && clear !== (traceRayFast(model, start, end, 0, null) === null))
    throw new Error(`traceRayClear differential mismatch: ${JSON.stringify({ start, end, clear })}`);
  return clear;
}
function sameRayResult(a, b) {
  if (a === null || b === null) return a === b;
  const same = (x, y) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]));
  return Object.is(a.time, b.time) && a.node === b.node && a.penetrating === b.penetrating &&
    same(a.location, b.location) && same(a.normal, b.normal) &&
    Object.keys(a).join() === Object.keys(b).join();
}

// Transformed planes of an owned (brush) model, reused while the owner's
// coordinates are unchanged: [nx, ny, nz, w] per node, computed on first use.
const ownedPlaneCache = new WeakMap();
function ownedPlanes(model, ownerCoords) {
  let entry = ownedPlaneCache.get(model);
  if (entry && entry.coords.length === ownerCoords.length && entry.coords.every((v, i) => v === ownerCoords[i])) return entry;
  const rows = [ownerCoords.slice(3, 6), ownerCoords.slice(6, 9), ownerCoords.slice(9, 12)];
  entry = { coords: ownerCoords.slice(), rows, origin: transformVector(ownerCoords.slice(0, 3), rows), planes: new Array(model.nodes.length) };
  ownedPlaneCache.set(model, entry);
  return entry;
}

/** traceRay without per-call temporaries: the same float stores, the same
 * double intermediates in the same order, the same traversal and errors.
 * Scratch stacks are module-level; a nested call (none occur) gets its own.
 * The JavaScript reference the Rust kernel transcribes. */
let scratch = null, scratchBusy = false;
const newScratch = size => ({ size, index: new Int32Array(size), boundary: new Int32Array(size),
  outside: new Uint8Array(size), points: new Float64Array(size * 6) });

export function traceRayFast(model, start, end, extraNodeFlags = 0, ownerCoords = null) {
  const { nodes } = model;
  if (!nodes.length) return null;
  if (model.rootOutside === undefined) throw new Error('Ray traversal requires a compiled BSP root');
  const sx = f(start[0]), sy = f(start[1]), sz = f(start[2]), ex = f(end[0]), ey = f(end[1]), ez = f(end[2]);
  const owned = ownerCoords ? ownedPlanes(model, ownerCoords) : null;
  const ownedPlane = (node, index) => {
    let plane = owned.planes[index];
    if (!plane) {
      const rows = owned.rows, origin = owned.origin;
      const normal = rows.map(row => f(dotZYX(node.plane, row)));
      plane = [...normal, node.plane[3] - dotZYX(origin, normal)];
      owned.planes[index] = plane;
    }
    return plane;
  };
  let local = scratch;
  const nested = scratchBusy;
  if (!local || nested) local = newScratch(64);
  if (!nested) { scratch = local; scratchBusy = true; }
  try {
    let reachedOutside = false, visits = 0, depth = 0;
    const mask = (extraNodeFlags & ~0x10) | 0x21, limit = nodes.length * 8 + 8;
    const push = (index, boundary, outside, fx, fy, fz, tx, ty, tz) => {
      if (depth === local.size) {
        const grown = newScratch(local.size * 2);
        grown.index.set(local.index); grown.boundary.set(local.boundary);
        grown.outside.set(local.outside); grown.points.set(local.points);
        local = grown;
        if (!nested) scratch = grown;
      }
      local.index[depth] = index; local.boundary[depth] = boundary; local.outside[depth] = outside ? 1 : 0;
      const at = depth * 6;
      local.points[at] = fx; local.points[at + 1] = fy; local.points[at + 2] = fz;
      local.points[at + 3] = tx; local.points[at + 4] = ty; local.points[at + 5] = tz;
      depth++;
    };
    push(0, 0, Boolean(model.rootOutside), sx, sy, sz, ex, ey, ez);
    let hit = false, hx = 0, hy = 0, hz = 0, hitNode = 0;
    while (depth) {
      depth--;
      let index = local.index[depth], boundary = local.boundary[depth], outside = local.outside[depth] === 1;
      const at = depth * 6;
      let fx = local.points[at], fy = local.points[at + 1], fz = local.points[at + 2];
      let tx = local.points[at + 3], ty = local.points[at + 4], tz = local.points[at + 5];
      while (index !== -1) {
        if (++visits > limit) throw new Error('Invalid cyclic ray BSP');
        const node = nodes[index];
        if (!node) throw new Error('Invalid ray BSP node');
        const solid = node.vertexCount > 0 && !(node.flags & mask);
        let a, b;
        if (!owned) {
          const p = node.plane;
          a = f(fz * p[2] + fx * p[0] + fy * p[1] - p[3]);
          b = f(tz * p[2] + tx * p[0] + ty * p[1] - p[3]);
        } else {
          const p = ownedPlane(node, index);
          a = f(fz * p[2] + fy * p[1] + fx * p[0] - p[3]);
          b = f(tz * p[2] + ty * p[1] + tx * p[0] - p[3]);
        }
        if (a > -.001 && b > -.001) { outside ||= solid; index = node.front; }
        else if (a < .001 && b < .001) { outside &&= !solid; index = node.back; }
        else {
          const crossingSolid = node.vertexCount > 0 && !(node.flags & (extraNodeFlags | 0x21));
          const fraction = a / (b - a);
          const mx = f(fx + f(f(fx - tx) * fraction)), my = f(fy + f(f(fy - ty) * fraction)), mz = f(fz + f(f(fz - tz) * fraction));
          const frontFirst = a > 0;
          push(frontFirst ? node.back : node.front, index,
            frontFirst ? outside && !crossingSolid : outside || crossingSolid, mx, my, mz, tx, ty, tz);
          index = frontFirst ? node.front : node.back;
          outside = frontFirst ? outside || crossingSolid : outside && !crossingSolid;
          tx = mx; ty = my; tz = mz;
        }
      }
      if (outside) reachedOutside = true;
      else if (reachedOutside || !(extraNodeFlags & 0x10)) {
        hit = true; hx = fx; hy = fy; hz = fz; hitNode = boundary; break;
      }
    }
    if (!hit) return null;
    const dx = f(ex - sx), dy = f(ey - sy), dz = f(ez - sz);
    const squared = f(dx * dx + dy * dy + dz * dz);
    const projection = (hx - sx) * dx + (hy - sy) * dy + (hz - sz) * dz;
    const backedOff = f(projection / squared) - .5 / Math.sqrt(squared);
    const time = !(backedOff >= 0) ? 0 : backedOff < 1 ? backedOff : 1;
    const location = [f(sx + f(dx * time)), f(sy + f(dy * time)), f(sz + f(dz * time))];
    const plane = nodes[hitNode].plane;
    let normal = [plane[0], plane[1], plane[2]];
    if (owned) normal = transformVector(normal, owned.rows);
    // The facing test is fcomp + test ah,1: C0 is set for a NaN too (unordered), so a NaN ray faces the other way (docs/fitting.md "NaN in FindSpot").
    else if (x87C0(-dz * normal[2] - dy * normal[1] - dx * normal[0], 0)) normal = normal.map(value => -value);
    return { time: f(time), normal, location, node: hitNode, penetrating: hx === sx && hy === sy && hz === sz };
  } finally {
    if (!nested) scratchBusy = false;
  }
}

function traceRayReference(model, start, end, extraNodeFlags = 0, ownerCoords = null) {
  const { nodes } = model;
  if (!nodes.length) return null;
  if (model.rootOutside === undefined) throw new Error('Ray traversal requires a compiled BSP root');
  start = start.map(f); end = end.map(f);
  const rows = ownerCoords && [ownerCoords.slice(3, 6), ownerCoords.slice(6, 9), ownerCoords.slice(9, 12)];
  const origin = rows && transformVector(ownerCoords.slice(0, 3), rows);
  const ownedPlanes = new Map();
  const distance = (node, point) => {
    if (!rows) return planeDistance(node.plane, point);
    let plane = ownedPlanes.get(node);
    if (!plane) {
      const normal = rows.map(row => f(dotZYX(node.plane, row)));
      // The offset remains unrounded in the native x87 stack until distance
      // is stored. Pre-rounding it changes intersections on scaled brushes.
      plane = [...normal, node.plane[3] - dotZYX(origin, normal)];
      ownedPlanes.set(node, plane);
    }
    return f(dotZYX(point, plane) - plane[3]);
  };
  let reachedOutside = false, visits = 0;
  const mask = (extraNodeFlags & ~0x10) | 0x21;
  // Use an explicit stack for the original start-side recursion and end-side
  // tail traversal. A deep original BSP must not consume the JavaScript stack.
  const stack = [{ index: 0, boundary: 0, outside: Boolean(model.rootOutside), start, end }];
  let rawHit = null;
  while (stack.length) {
    let { index, boundary, outside, start: from, end: to } = stack.pop();
    while (index !== -1) {
      if (++visits > nodes.length * 8 + 8) throw new Error('Invalid cyclic ray BSP');
      const node = nodes[index];
      if (!node) throw new Error('Invalid ray BSP node');
      const solid = node.vertexCount > 0 && !(node.flags & mask);
      const a = distance(node, from), b = distance(node, to);
      if (a > -.001 && b > -.001) { outside ||= solid; index = node.front; }
      else if (a < .001 && b < .001) { outside &&= !solid; index = node.back; }
      else {
        // Crossing branches call the original IsCsg helper (0x103f68b0),
        // which retains extra bit 0x10. The same-side inline checks clear it.
        const crossingSolid = node.vertexCount > 0 && !(node.flags & (extraNodeFlags | 0x21));
        const fraction = a / (b - a);
        const middle = from.map((value, axis) => f(value + f(f(value - to[axis]) * fraction)));
        const frontFirst = a > 0;
        stack.push({ index: frontFirst ? node.back : node.front, boundary: index,
          outside: frontFirst ? outside && !crossingSolid : outside || crossingSolid, start: middle, end: to });
        index = frontFirst ? node.front : node.back;
        outside = frontFirst ? outside || crossingSolid : outside && !crossingSolid;
        to = middle;
      }
    }
    if (outside) reachedOutside = true;
    else if (reachedOutside || !(extraNodeFlags & 0x10)) {
      rawHit = { location: from, node: boundary, normal: nodes[boundary].plane.slice(0, 3) }; break;
    }
  }
  if (!rawHit) return null;
  const delta = end.map((value, axis) => f(value - start[axis]));
  const squared = f(delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]);
  const projection = (rawHit.location[0] - start[0]) * delta[0]
    + (rawHit.location[1] - start[1]) * delta[1] + (rawHit.location[2] - start[2]) * delta[2];
  const backedOff = f(projection / squared) - .5 / Math.sqrt(squared);
  // Original x87 compare takes the lower clamp on less-than OR unordered.
  // A zero-length ray in solid therefore returns time zero after 0/0.
  const time = !(backedOff >= 0) ? 0 : backedOff < 1 ? backedOff : 1;
  const location = start.map((value, axis) => f(value + f(delta[axis] * time)));
  let normal = rawHit.normal;
  if (rows) normal = transformVector(normal, rows);
  else if (x87C0(-delta[2] * normal[2] - delta[1] * normal[1] - delta[0] * normal[0], 0)) normal = normal.map(value => -value);
  return { time: f(time), normal, location, node: rawHit.node, penetrating: rawHit.location.every((v, i) => v === start[i]) };
}
