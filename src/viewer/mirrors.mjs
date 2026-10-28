import * as THREE from 'three';
import { POLY, toView, fromView } from '../unreal/geometry.mjs';
import { MIRROR_RECURSION_LIMIT, mirrorsMayRender, planMirrorPasses, planFramePasses } from './mirror-passes.mjs';
export { MIRROR_RECURSION_LIMIT };

/** Original OccludeBsp reflects Origin and all three axes. Keep the negative
 * determinant: a right-handed lookAt is not the original view. */
export function mirrorMatrix(plane) {
  const { x, y, z } = plane.normal, c = plane.constant;
  return new THREE.Matrix4().set(
    1 - 2*x*x, -2*x*y, -2*x*z, -2*c*x,
    -2*y*x, 1 - 2*y*y, -2*y*z, -2*c*y,
    -2*z*x, -2*z*y, 1 - 2*z*z, -2*c*z,
    0, 0, 0, 1);
}

/** Mirrored surface index -> the BSP node plane [X,Y,Z,W] (dot(N,P)=W) that
 * OccludeBsp reflects across: [ebp-0x1c] is the FBspNode, whose first 16
 * bytes are its FPlane. Every mirrored surface in the shipped maps has a
 * single node plane (validate-mirrors.mjs); a surface whose nodes disagree is
 * left out so the caller reports it. */
export function mirrorPlanes(model) {
  const planes = new Map(), mixed = new Set();
  for (const node of model.nodes) {
    const surface = model.surfaces[node.surface];
    if (!surface || !(surface.flags & POLY.Mirrored) || mixed.has(node.surface)) continue;
    const plane = node.plane.map(Math.fround), seen = planes.get(node.surface);
    if (!seen) planes.set(node.surface, plane);
    else if (seen.join() !== plane.join()) { planes.delete(node.surface); mixed.add(node.surface); }
  }
  return planes;
}

/** OccludeBsp after CreateChildFrame (10b18b58-10b18b93) on D3D, whose
 * RenDev SpanBased (+0x48) is never set: a surface with any of
 * Invisible|Masked|Translucent|Modulated (0x47) keeps drawing over the
 * reflected child with PF_Occlude; an opaque mirror also becomes
 * PF_Invisible, so only the child shows (validate-mirrors.mjs). */
export const mirrorDrawFlags = flags => ((flags & 0x47 ? flags : flags | POLY.Invisible) | 0x80000000) >>> 0;

/** Mirrored BSP surfaces of any orientation: static ones grouped by their
 * exact node plane (CreateChildFrame 0x10b15a40 merges child frames only
 * for the same surface, zone and exact clip plane; one child per plane gives
 * the same image), a mover's per polygon following the brush.
 * Translucent mirrors composite S+R(1-S); opaque ones show the reflection
 * alone (mirrorDrawFlags). A mirror seen in a child view has its own child,
 * to MIRROR_RECURSION_LIMIT. Masked, modulated and two-sided mirrors remain
 * explicit boundaries; see mirror-surfaces.md. */
export function createMirrors(notes, displayGamma) {
  const planes = new Map(), size = new THREE.Vector2(), plannedSize = new THREE.Vector2();
  const modelPlanes = new WeakMap();
  // Keep one global clipping-plane shader shape for both child and parent
  // draws.  Changing between zero and one planes makes three.js reselect a
  // program for every material on every pass.  A zero normal disables the
  // plane for the parent without changing that compiled shape.
  const renderClip = new THREE.Plane(new THREE.Vector3(), 1), clippingPlanes = [renderClip];
  const stats = { surfaces: 0, opaqueSurfaces: 0, planes: 0, renderedPlanes: 0, depth: 0, scissorPixels: 0, unsupportedSurfaces: 0 };
  // One target per depth and sibling: a frame's children are all sampled by
  // its own draw, and each child's descendants are finished before that
  // child draws.
  const targets = new Map();
  function targetFor(depth, index) {
    const key = `${depth}:${index}`;
    if (!targets.has(key)) {
      const target = new THREE.WebGLRenderTarget(1, 1, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        generateMipmaps: false, depthBuffer: true,
      });
      target.texture.colorSpace = THREE.NoColorSpace; // Original display-encoded framebuffer bytes.
      targets.set(key, target);
    }
    return targets.get(key);
  }
  function unsupported(message) { stats.unsupportedSurfaces++; notes.add(message); return null; }
  function surface(model, surfaceIndex, actorName) {
    const surface = model.surfaces[surfaceIndex];
    if (!(surface.flags & POLY.Mirrored)) return null;
    if (surface.flags & (POLY.Masked | POLY.Modulated | POLY.TwoSided))
      return unsupported('Masked, modulated and two-sided mirrors remain unsupported; they draw as ordinary surfaces.');
    if (!modelPlanes.has(model)) modelPlanes.set(model, mirrorPlanes(model));
    const node = modelPlanes.get(model).get(surfaceIndex);
    if (!node) return unsupported('A mirrored surface without one node plane remains unsupported.');
    // A mover's polygon joins the level BSP through the brush tracker each
    // time the brush moves; its node plane is the polygon's, in world space.
    // The group follows the mover: its plane is the brush-local plane under
    // the mover's current transform (host-computed, see mirror-surfaces.md).
    const key = actorName ? `${actorName}:${surfaceIndex}` : node.join();
    if (!planes.has(key)) {
      const plane = new THREE.Plane(new THREE.Vector3(...toView(node.slice(0, 3))), -node[3]);
      // texture/active: the child target the current pass samples, if any.
      planes.set(key, { key, plane, matrix: mirrorMatrix(plane), meshes: [], moving: Boolean(actorName),
        localPlane: actorName ? plane.clone() : null,
        texture: { value: null }, size: { value: new THREE.Vector2(1, 1) }, active: { value: 0 } });
    }
    stats.surfaces++; stats.planes = planes.size;
    if (!(surface.flags & 0x47)) stats.opaqueSurfaces++;
    return planes.get(key);
  }
  /** A moving group's world plane and reflection from its mover's current
   * transform (the meshes are children of the mover's group). */
  function follow(group) {
    const mesh = group.meshes[0];
    if (!group.moving || !mesh) return;
    mesh.updateWorldMatrix(true, false);
    group.plane.copy(group.localPlane).applyMatrix4(mesh.matrixWorld);
    group.matrix = mirrorMatrix(group.plane);
  }
  /** Whether render() would draw any mirror plane for this source camera:
   * the same plane side and floor-frustum predicate, evaluated early so the
   * actor layer knows reflected views may need off-screen actors. */
  function mayRender(source, requested = null) {
    if (!planes.size) return false;
    for (const group of planes.values()) follow(group);
    return mirrorsMayRender(source, [...planes.values()], undefined, requested);
  }
  /** `frames` (OccludeFrame's child frames, sim-session.mjs visibility;
   * `rect` their render viewport in drawing-buffer pixels) plan the passes
   * instead of the frustum; `framePass(frame)` selects one frame's world and
   * sprites (null: all again) and `skyIn(skyFrame, camera, node)` draws a sky
   * frame OccludeBsp made inside a mirror frame (its own camera, from its
   * own Coords), before the mirror's view. `viewport` {x, y, width, height}
   * (top-down, drawing-buffer pixels) is the region the frame draws into when
   * it is not the whole buffer (a ViewportWindow's frame): each child's image
   * sits in its target at that region, flipped across the buffer's centre for
   * an odd depth, where the parent's shader samples it. `plan` (the
   * snapshot's `stamps.plan`, sim-session.mjs) is what the simulation side
   * planned its passes with, {size, mirrors}: the passes are planned with that
   * drawing-buffer size and switch, not the canvas's now (a resize can land
   * between a frame's post and its draw), so the page draws the passes whose
   * actor decisions it holds. */
  function render(renderer, scene, source, { markers, updateActors, sky, requested = null, frames = null, rect = null,
    framePass = null, skyIn = null, viewport = null, plan: planned = null } = {}) {
    stats.renderedPlanes = 0;stats.depth=0;stats.scissorPixels=0;
    if (!planes.size) return;
    for (const group of planes.values()) group.active.value = 0;
    // Diagnostics switch: every mirror draws without its reflection. The
    // simulation side's frame also has none without its world frame.
    if (!(planned ? planned.mirrors : api.enabled)) return;
    // The plane test below needs the planes' world matrices; each
    // renderer.render call updates the whole scene itself (auto-update), so
    // only the plane meshes and their ancestors are updated here.
    source.updateMatrixWorld();
    for (const group of planes.values()) for (const mesh of group.meshes) mesh.updateWorldMatrix(true, false);
    for (const group of planes.values()) follow(group);
    renderer.getDrawingBufferSize(size);
    const planSize = planned ? plannedSize.fromArray(planned.size) : size;
    const plan = frames ? planFramePasses(source, [...planes.values()], planSize, frames, rect) : null;
    if (frames ? !plan.length : !mayRender(source, requested)) return;
    const target = renderer.getRenderTarget(), clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    const gamma = displayGamma.value, markerVisible = markers?.visible;
    const visibility = new Map();
    for (const group of planes.values()) for (const mesh of group.meshes) visibility.set(mesh, mesh.visible);
    if (markers) markers.visible = false;
    displayGamma.value = 1; // Compose the floor before the original display gamma ramp.
    /** Draws a plan's passes (mirror-passes.mjs): each child renders its
     * own children first, then itself; returns the children with their
     * targets. */
    function draw(nodes) {
      const result = [];
      for (const node of nodes) {
        const { group, camera: child, depth, scissor, index } = node;
        // The groups the frame looks through: one for a frame of one request,
        // several when OccludeBsp's requests merged (mirror-passes.mjs frameGroups).
        const through = node.groups ?? [group];
        const nested = draw(node.children);
        const target = targetFor(depth, index);
        target.setSize(size.x, size.y);
        target.scissor.set(scissor.x, scissor.y, scissor.width, scissor.height); target.scissorTest = true;
        if (viewport) target.viewport.set(depth % 2 ? size.x - viewport.x - viewport.width : viewport.x,
          size.y - viewport.y - viewport.height, viewport.width, viewport.height);
        for (const g of planes.values()) g.active.value = 0;
        for (const n of nested) { n.group.texture.value = n.target.texture; n.group.size.value.copy(size); n.group.active.value = 1; }
        // The mirror's own plane is the child's clip plane; its faces are not
        // part of the reflected view.
        for (const g of through) for (const mesh of g.meshes) mesh.visible = false;
        updateActors?.(fromView(child.position.toArray()), child, node);
        renderer.setRenderTarget(target); renderer.setClearColor(0, 1);
        renderer.clear();
        // The sky frames inside this mirror frame, unclipped, each with depth
        // cleared after it.
        if (skyIn && node.skies.length) {
          renderClip.normal.set(0, 0, 0); renderClip.constant = 1; renderer.clippingPlanes = clippingPlanes;
          for (const sky of node.skies) { skyIn(sky.frame, sky.camera, node); renderer.clearDepth(); }
        }
        framePass?.(node.frame ?? null);
        // Clip geometry behind the original mirror plane, not the reflected
        // eye's side. No bias or invented distance/opacity constant.
        renderClip.copy(group.plane);renderer.clippingPlanes = clippingPlanes;
        try { renderer.render(scene, child); } finally { framePass?.(null); }
        for (const g of through) for (const mesh of g.meshes) mesh.visible = visibility.get(mesh);
        stats.renderedPlanes++;stats.depth=Math.max(stats.depth,depth);stats.scissorPixels+=scissor.width*scissor.height;
        for (const g of through) result.push({ group: g, target });
      }
      return result;
    }
    try {
      const rendered = draw(plan ?? planMirrorPasses(source, [...planes.values()], planSize, mesh => visibility.get(mesh), requested));
      for (const group of planes.values()) group.active.value = 0;
      for (const { group, target } of rendered) { group.texture.value = target.texture; group.size.value.copy(size); group.active.value = 1; }
      if (sky && !frames) notes.add('Mirror views through sky-zone openings are not yet verified.');
    } finally {
      for (const [mesh, value] of visibility) mesh.visible = value;
      if (markers) markers.visible = markerVisible;
      displayGamma.value = gamma;
      renderClip.normal.set(0, 0, 0);renderClip.constant = 1;
      renderer.clippingPlanes = clippingPlanes;
      renderer.setRenderTarget(target); renderer.setClearColor(clearColor, clearAlpha);
      updateActors?.(fromView(source.position.toArray()), source, null);
    }
  }
  /** The renderer's clipping planes as every draw after a mirror pass has them: the one plane, disabled (zero normal).
   * A level with mirror planes draws with that program shape from its first frame (main.mjs at the swap), so its first
   * mirror pass does not reselect every material's program, and the shader warm-up builds one shape (shader-warmup.mjs). */
  function clipShape(renderer) { renderClip.normal.set(0, 0, 0); renderClip.constant = 1; renderer.clippingPlanes = clippingPlanes; }
  const api = { enabled: true, stats, surface, render, mayRender, follow, clipShape,
    /** The mirror planes (mirror-passes.mjs groups). */
    groups: () => [...planes.values()], dispose() { for (const t of targets.values()) t.dispose(); },
    /** Validation access (validate-mirrors-play.mjs); never used by Play. */
    targets: () => [...targets.values()] };
  return api;
}
