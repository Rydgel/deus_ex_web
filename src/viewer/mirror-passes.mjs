/** The mirror child frames of one view (docs/mirror-surfaces.md), planned
 * without drawing: mirrors.mjs renders the plan, and the simulation side
 * (drawn-set.mjs) plans the same passes from the same inputs to know what
 * each pass draws (docs/sim-worker.md). A group is a mirror plane: its world
 * `plane`, its reflection `matrix` and its `meshes`, each with a
 * `matrixWorld` and a `geometry` whose bounding sphere and positions three.js
 * would use. */
import * as THREE from 'three';
import { DECAL_LAYER } from './render-layers.mjs';
import { toView } from '../unreal/geometry.mjs';

/** OccludeBsp takes the mirror path only while Frame->Recursion (+0x1c) is
 * below 3 (0x10b18881); CreateChildFrame gives a child its parent's
 * Recursion + 1 (0x10b15e4a-0x10b15e5c). Child frames nest to recursion 3. */
export const MIRROR_RECURSION_LIMIT = 3;
/** In OccludeBsp's mirror requests (sim-session.mjs `visibility`): the
 * moving brush tracker filtered the movers into the BSP, so a moving
 * group's requests are named `${mover}:${polygon}` among the nodes. */
export const TRACKED_MOVER_MIRRORS = 'movers';

// OccludeBsp's reflected axes have negative handedness. WebGL's front-face
// state is object/material state rather than camera state, so reflecting the
// camera alone reverses culling. Negate its local X axis for submission and
// sample the resulting target right-to-left (light-atlas.mjs). The two
// reflections cancel in screen space while keeping each material/program
// immutable across the child and parent draws. Each nesting level reflects
// once more, so only odd depths are negated: every child target is then
// mirrored against its parent's pixels, and right-to-left sampling holds at
// every depth.
const submissionHandedness = new THREE.Matrix4().makeScale(-1, 1, 1);
const clipMatrix = new THREE.Matrix4();

/** A group's screen rectangle in a view (drawing-buffer pixels), widened by
 * a pixel; the full view when a vertex is behind the eye. */
export function screenBounds(group, width, height, viewProjection) {
  let minX=width,minY=height,maxX=0,maxY=0,found=false;
  for(const mesh of group.meshes){
    const position=mesh.geometry.getAttribute('position');if(!position)continue;
    clipMatrix.multiplyMatrices(viewProjection,mesh.matrixWorld);const e=clipMatrix.elements,a=position.array;
    for(let i=0;i<a.length;i+=position.itemSize){
      const x=a[i],y=a[i+1],z=a[i+2],w=e[3]*x+e[7]*y+e[11]*z+e[15];
      // A surface crossing the eye plane can cover any part of the screen;
      // retain the full child bounds instead of under-clipping it.
      if(!(w>0))return {x:0,y:0,width,height};
      const sx=(e[0]*x+e[4]*y+e[8]*z+e[12])/w*.5+.5;
      const sy=(e[1]*x+e[5]*y+e[9]*z+e[13])/w*.5+.5;
      minX=Math.min(minX,sx*width);maxX=Math.max(maxX,sx*width);
      minY=Math.min(minY,sy*height);maxY=Math.max(maxY,sy*height);found=true;
    }
  }
  if(!found)return null;
  const x=Math.max(0,Math.floor(minX)-1),y=Math.max(0,Math.floor(minY)-1);
  const right=Math.min(width,Math.ceil(maxX)+1),top=Math.min(height,Math.ceil(maxY)+1);
  return right>x&&top>y?{x,y,width:right-x,height:top-y}:null;
}

/** Rectangle intersection, or null when empty. */
export function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), top = Math.min(a.y + a.height, b.y + b.height);
  return right > x && top > y ? { x, y, width: right - x, height: top - y } : null;
}

/** The world BSP nodes of a static mirror group (null for a moving one):
 * `group.nodes` when given (drawn-set.mjs), else its world meshes' triangle
 * nodes (world.mjs `userData.nodes`). */
export function groupNodes(group) {
  if (group.nodeSet !== undefined) return group.nodeSet;
  const nodes = group.nodes !== undefined ? group.nodes
    : group.moving ? null : group.meshes.flatMap(mesh => mesh.userData?.actor ? [] : [...(mesh.userData?.nodes ?? [])]);
  return group.nodeSet = nodes ? new Set(nodes) : null;
}

/** Whether OccludeBsp asked for this group's child frame in the main frame
 * (`requested`: the mirror requests' nodes; null when occlusion did not
 * run). A moving group is requested by its key (mover and polygon) when
 * the brush tracker put the movers in the BSP (TRACKED_MOVER_MIRRORS);
 * without the tracker it keeps the frustum test. */
export function requestedGroup(group, requested) {
  if (!requested) return true;
  const nodes = groupNodes(group);
  if (!nodes) return !requested.has(TRACKED_MOVER_MIRRORS) || requested.has(group.key);
  for (const node of requested) if (nodes.has(node)) return true;
  return false;
}

/** Whether any mirror plane would draw for this source camera: the plane
 * side and frustum predicate of the first level, so the actor layer knows
 * reflected views may need off-screen actors. `visible(mesh)` is the mesh's
 * visibility; `requested` OccludeBsp's mirror requests (requestedGroup). */
export function mirrorsMayRender(source, groups, visible = mesh => mesh.visible, requested = null) {
  if (requested) groups = groups.filter(group => requestedGroup(group, requested));
  if (!groups.length) return false;
  source.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(source.projectionMatrix, source.matrixWorldInverse));
  for (const group of groups)
    if (group.plane.distanceToPoint(source.position) > 0 &&
      group.meshes.some(mesh => visible(mesh) && frustum.intersectsObject(mesh))) return true;
  return false;
}

/** OccludeFrame's child frames switch: ?childFrames=off (Node:
 * CHILD_FRAMES=off) keeps the main frame's requests and the frustum-tested
 * mirror and sky passes (docs/bsp-occlusion.md "Child frames"). */
export const childFramesMode = () => (typeof process !== 'undefined' && process.env?.CHILD_FRAMES)
  || globalThis.DEUS_EX_CHILD_FRAMES || 'on';

/** Each child frame's own SetupDynamics (docs/bsp-occlusion.md "Child
 * frames"): the render iterators' items are built again for every frame.
 * ?iteratorFrames=off (Node: ITERATOR_FRAMES=off) keeps the root frame's
 * items in every child frame (measurement and fallback); `full` packs every
 * frame's candidates from scratch and `verify` also checks the patched ones
 * against that (measurement and validation). */
export const iteratorFramesMode = () => (typeof process !== 'undefined' && process.env?.ITERATOR_FRAMES)
  || globalThis.DEUS_EX_ITERATOR_FRAMES || 'on';

/** The mirror groups a child frame looks through (sim-session.mjs
 * `visibility` frames). CreateChildFrame merges every request of one parent
 * with equal iSurf, zone and NearClip (0x10b15a40), and OccludeBsp passes
 * iSurf 0 for each mirror request (0x10b18b4a), so one frame stands for all
 * the coplanar mirror polygons of a zone that were requested, e.g. three
 * panes in a row. `frame.requests` names each one: a tracked mover's polygon
 * by its key, a static one by its node (the group holding that node). A frame
 * without `requests` (an older producer) looks through its first request's
 * group alone. Null when no request has a group the page supports. */
export function frameGroups(groups, frame) {
  const requests = frame.requests ?? [{ iNode: frame.iNode, group: frame.group }], found = [];
  for (const request of requests) {
    const group = request.group ? groups.find(g => g.key === request.group) ?? null
      : groups.find(g => groupNodes(g)?.has(request.iNode)) ?? null;
    if (group && !found.includes(group)) found.push(group);
  }
  return found.length ? found : null;
}

/** The first of a frame's groups (the request that made the frame). */
export function frameGroup(groups, frame) { return frameGroups(groups, frame)?.[0] ?? null; }

/** A child frame's span bounds in drawing-buffer pixels, bottom-up
 * (`rect` the frame's render viewport, top-down; `height` the buffer's),
 * widened by a pixel and clamped. */
function spanBox(frame, rect, size) {
  const b = frame.bounds;
  if (!b) return null;
  const x = Math.max(0, rect.x + b[0] - 1), right = Math.min(size.x, rect.x + b[2] + 1);
  const top = Math.max(0, rect.y + b[1] - 1), bottom = Math.min(size.y, rect.y + b[3] + 1);
  return right > x && bottom > top ? { x, y: size.y - bottom, width: right - x, height: bottom - top } : null;
}

const skyRotation = new THREE.Matrix4(), skyBasis = new THREE.Matrix4();

/** A sky child frame's camera (Render.dll 0x10b184b1..0x10b187d1), from its
 * parent's camera and the two frames' own Coords (12 binary32: origin, then
 * the X, Y and Z axes in world space): the request turns each of the
 * parent's axes by the SkyZone's roll, pitch and yaw (FCoords *=, over the
 * Coords with the origin zeroed) and moves the origin to the SkyZone's
 * Location. The world turn M is read back from the two frames' axes
 * (`sky axes = M * parent axes`, both orthonormal), conjugated into the
 * viewer's axes and applied to the parent camera's world rotation, so the
 * parent's own handedness (mirrored, odd depths negated) carries over; the
 * origin is the frame's own. `parent` is the camera the parent frame draws
 * with. */
export function skyFrameCamera(parent, parentCoords, skyCoords) {
  const p = k => parentCoords.slice(3 + 3 * k, 6 + 3 * k), s = k => skyCoords.slice(3 + 3 * k, 6 + 3 * k);
  const M = [0, 1, 2].map(i => [0, 1, 2].map(j => s(0)[i] * p(0)[j] + s(1)[i] * p(1)[j] + s(2)[i] * p(2)[j]));
  // The viewer's reflection (toView: x' = y, y' = z, z' = -x) around M.
  const T = [[0, 1, 0], [0, 0, 1], [-1, 0, 0]];
  const TM = T.map(row => [0, 1, 2].map(j => row[0] * M[0][j] + row[1] * M[1][j] + row[2] * M[2][j]));
  const Q = TM.map(row => [0, 1, 2].map(j => row[0] * T[j][0] + row[1] * T[j][1] + row[2] * T[j][2]));
  skyRotation.set(Q[0][0], Q[0][1], Q[0][2], 0, Q[1][0], Q[1][1], Q[1][2], 0, Q[2][0], Q[2][1], Q[2][2], 0, 0, 0, 0, 1);
  const camera = new THREE.PerspectiveCamera();
  camera.copy(parent, false); camera.matrixAutoUpdate = camera.matrixWorldAutoUpdate = false;
  camera.matrixWorld.multiplyMatrices(skyRotation, skyBasis.extractRotation(parent.matrixWorld)).setPosition(...toView(skyCoords.slice(0, 3)));
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  camera.position.setFromMatrixPosition(camera.matrixWorld);
  return camera;
}

/** OccludeFrame's mirror child frames as passes (the frames of
 * sim-session.mjs `visibility`, child frames on): each mirror frame
 * through its group, with the reflected camera, its span's bounds (in
 * `rect`, the frame's render viewport) as its region, the sky frames
 * OccludeBsp made inside it (`skies`, each with its camera) and its own mirror children; frames
 * whose surface has no supported group are left out with their children.
 * The nodes are those of planMirrorPasses, with `frame` added. */
export function planFramePasses(source, groups, size, frames, rect = null) {
  rect ??= { x: 0, y: 0, width: size.x, height: size.y };
  const byParent = new Map();
  for (const frame of frames) {
    if (!byParent.has(frame.parent)) byParent.set(frame.parent, []);
    byParent.get(frame.parent).push(frame);
  }
  const flip = b => ({ x: size.x - b.x - b.width, y: b.y, width: b.width, height: b.height });
  function children(view, parent) {
    const out = [];
    for (const frame of byParent.get(parent) ?? []) {
      if (frame.kind !== 'mirror') continue;
      const through = frameGroups(groups, frame), group = through?.[0], box = group && spanBox(frame, rect, size);
      if (!box) continue;
      const depth = view.depth + 1, camera = new THREE.PerspectiveCamera();
      const world = new THREE.Matrix4().multiplyMatrices(group.matrix, view.world);
      camera.copy(source, false); camera.matrixAutoUpdate = camera.matrixWorldAutoUpdate = false;
      if (depth % 2 && camera.view?.enabled) { camera.view.offsetX = -camera.view.offsetX; camera.updateProjectionMatrix(); }
      camera.layers.disable(DECAL_LAYER);
      camera.matrixWorld.copy(world);
      if (depth % 2) camera.matrixWorld.multiply(submissionHandedness);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      camera.position.setFromMatrixPosition(camera.matrixWorld);
      // The span is in screen pixels; a depth's target is mirrored against
      // its parent's (the parent's is screen space flipped depth - 1 times).
      const bounds = (depth - 1) % 2 ? flip(box) : box, scissor = flip(bounds);
      // The sky child frames made inside this mirror frame, each with its own
      // camera from its own Coords.
      const skies = (byParent.get(frame.index) ?? []).filter(f => f.kind === 'sky')
        .map(sky => ({ frame: sky, camera: skyFrameCamera(camera, frame.coords, sky.coords) }));
      // `id` names the pass on both sides (the frame OccludeFrame numbered).
      const node = { id: `frame ${frame.index}`, group, groups: through, camera, world, depth, scissor, index: out.length, bounds, frame, skies };
      node.children = children({ camera, world, depth, scissor, through: group }, frame.index);
      out.push(node);
    }
    return out;
  }
  source.updateMatrixWorld();
  return children({ camera: source, world: source.matrixWorld, depth: 0 }, 0);
}

/** The children of the source view, recursively (the main frame's only
 * those in `requested`, requestedGroup): for each, its group, its
 * camera (the source's projection, the reflected world matrix with odd
 * depths negated for submission), its depth, its scissor in its target's
 * pixels and its own children, which DrawFrame draws before it (0x10b1a336).
 * `size` is the drawing buffer's size. */
export function planMirrorPasses(source, groups, size, visible = mesh => mesh.visible, requested = null) {
  const passFrustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4();
  function children(view) {
    if (view.depth >= MIRROR_RECURSION_LIMIT) return [];
    viewProjection.multiplyMatrices(view.camera.projectionMatrix, view.camera.matrixWorldInverse);
    passFrustum.setFromProjectionMatrix(viewProjection);
    const eye = view.camera.position, found = [];
    for (const group of groups) {
      // The main frame takes only the children OccludeBsp made; deeper
      // levels keep the frustum test until child frames are occluded.
      if (view.depth === 0 && !requestedGroup(group, requested)) continue;
      if (group === view.through || !(group.plane.distanceToPoint(eye) > 0) ||
        !group.meshes.some(mesh => visible(mesh) && passFrustum.intersectsObject(mesh))) continue;
      // Only the part of the mirror inside this frame's own region shows.
      const seen = screenBounds(group, size.x, size.y, viewProjection), bounds = seen && intersect(seen, view.scissor);
      if (bounds) found.push({ group, bounds });
    }
    return found.map(({ group, bounds }, index) => {
      const depth = view.depth + 1, camera = new THREE.PerspectiveCamera();
      const world = new THREE.Matrix4().multiplyMatrices(group.matrix, view.world);
      camera.copy(source, false); camera.matrixAutoUpdate = camera.matrixWorldAutoUpdate = false;
      // The original's half-pixel centre (play-camera.mjs setPixelCentre) is
      // a screen-space shift: an odd depth's target is sampled right to
      // left, so its horizontal offset is reversed to land the same way.
      if (depth % 2 && camera.view?.enabled) { camera.view.offsetX = -camera.view.offsetX; camera.updateProjectionMatrix(); }
      // ClipDecal empties every fragment in a mirror frame (docs/decals.md).
      camera.layers.disable(DECAL_LAYER);
      camera.matrixWorld.copy(world);
      if (depth % 2) camera.matrixWorld.multiply(submissionHandedness);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      camera.position.setFromMatrixPosition(camera.matrixWorld);
      // This frame's columns [x, x+w) are the child's [W-x-w, W-x): the
      // child is mirrored against it.
      const scissor = { x: size.x - bounds.x - bounds.width, y: bounds.y, width: bounds.width, height: bounds.height };
      // `id` names the pass on both sides: the groups it looks through from the root.
      const id = view.id ? `${view.id}>${group.key}` : group.key;
      const node = { id, group, groups: [group], camera, world, depth, scissor, index, bounds };
      node.children = children({ id, camera, world, depth, scissor, through: group });
      return node;
    });
  }
  source.updateMatrixWorld();
  return children({ id: null, camera: source, world: source.matrixWorld, depth: 0,
    scissor: { x: 0, y: 0, width: size.x, height: size.y }, through: null });
}

/** The plan's passes in draw order (each child's children before it). */
export function passOrder(nodes, out = []) {
  for (const node of nodes) { passOrder(node.children, out); out.push(node); }
  return out;
}
