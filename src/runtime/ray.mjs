const f = Math.fround;
const planeDistance = (p, v) => f(v[2] * p[2] + v[0] * p[0] + v[1] * p[1] - p[3]);
const dotZYX = (a, b) => a[2] * b[2] + a[1] * b[1] + a[0] * b[0];
const transformVector = (v, rows) => rows.map(row => f(v[0] * row[0] + v[1] * row[1] + v[2] * row[2]));

/** Original zero-extent LineCheck / BSP traversal. Optional owner coordinates
 * contain ABrush.ToWorld's origin followed by its X/Y/Z axes. Generation of
 * those coordinates must be verified separately from the ray algorithm.
 * Evidence and float-store ordering: docs/fitting.md.
 */
export function traceRay(model, start, end, extraNodeFlags = 0, ownerCoords = null) {
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
  else if (-delta[2] * normal[2] - delta[1] * normal[1] - delta[0] * normal[0] < 0) normal = normal.map(value => -value);
  return { time: f(time), normal, location, node: rawHit.node, penetrating: rawHit.location.every((v, i) => v === start[i]) };
}
