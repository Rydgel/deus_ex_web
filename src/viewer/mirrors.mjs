import * as THREE from 'three';
import { POLY, toView, fromView } from '../unreal/geometry.mjs';

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

/** OccludeBsp takes the mirror path only while Frame->Recursion (+0x1c) is
 * below 3 (0x10b18881); CreateChildFrame gives a child its parent's
 * Recursion + 1 (0x10b15e4a-0x10b15e5c). Child frames nest to recursion 3. */
export const MIRROR_RECURSION_LIMIT = 3;

/** Mirrored BSP surfaces of any orientation: static ones grouped by their
 * exact node plane (CreateChildFrame 0x10b15a40 merges child frames whose
 * clip planes are equal), a mover's per polygon following the brush.
 * Translucent mirrors composite S+R(1-S); opaque ones show the reflection
 * alone (mirrorDrawFlags). A mirror seen in a child view has its own child,
 * to MIRROR_RECURSION_LIMIT. Masked, modulated and two-sided mirrors remain
 * explicit boundaries; see mirror-surfaces.md. */
export function createMirrors(notes, displayGamma) {
  const planes = new Map(), size = new THREE.Vector2(), frustum = new THREE.Frustum();
  const projection = new THREE.Matrix4(), clipMatrix = new THREE.Matrix4();
  const modelPlanes = new WeakMap();
  // OccludeBsp's reflected axes have negative handedness.  WebGL's front-face
  // state is object/material state rather than camera state, so reflecting the
  // camera alone reverses culling.  Negate its local X axis for submission and
  // sample the resulting target right-to-left (light-atlas.mjs).  The two
  // reflections cancel in screen space while keeping each material/program
  // immutable across the child and parent draws.  Each nesting level reflects
  // once more, so only odd depths are negated: every child target is then
  // mirrored against its parent's pixels, and right-to-left sampling holds
  // at every depth.
  const submissionHandedness = new THREE.Matrix4().makeScale(-1, 1, 1);
  // Keep one global clipping-plane shader shape for both child and parent
  // draws.  Changing between zero and one planes makes three.js reselect a
  // program for every material on every pass.  A zero normal disables the
  // plane for the parent without changing that compiled shape.
  const renderClip = new THREE.Plane(new THREE.Vector3(), 1), clippingPlanes = [renderClip];
  const stats = { surfaces: 0, opaqueSurfaces: 0, planes: 0, renderedPlanes: 0, depth: 0, scissorPixels: 0, unsupportedSurfaces: 0 };
  // One pass camera per depth, and one target per depth and sibling: a
  // frame's children are all sampled by its own draw, and each child's
  // descendants are finished before that child draws.
  const cameras = [], targets = new Map();
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
  function screenBounds(group, width, height, viewProjection) {
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
  function intersect(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width), top = Math.min(a.y + a.height, b.y + b.height);
    return right > x && top > y ? { x, y, width: right - x, height: top - y } : null;
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
  function mayRender(source) {
    if (!planes.size) return false;
    source.updateMatrixWorld();
    frustum.setFromProjectionMatrix(projection.multiplyMatrices(source.projectionMatrix, source.matrixWorldInverse));
    for (const group of planes.values()) follow(group);
    for (const group of planes.values())
      if (group.plane.distanceToPoint(source.position) > 0 &&
        group.meshes.some(mesh => mesh.visible && frustum.intersectsObject(mesh))) return true;
    return false;
  }
  function render(renderer, scene, source, { markers, updateActors, sky } = {}) {
    stats.renderedPlanes = 0;stats.depth=0;stats.scissorPixels=0;
    if (!planes.size) return;
    for (const group of planes.values()) group.active.value = 0;
    // Diagnostics switch: every mirror draws without its reflection.
    if (!api.enabled) return;
    // The plane test below needs the planes' world matrices; each
    // renderer.render call updates the whole scene itself (auto-update), so
    // only the plane meshes and their ancestors are updated here.
    source.updateMatrixWorld();
    for (const group of planes.values()) for (const mesh of group.meshes) mesh.updateWorldMatrix(true, false);
    for (const group of planes.values()) follow(group);
    if (!mayRender(source)) return;
    renderer.getDrawingBufferSize(size);
    const target = renderer.getRenderTarget(), clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    const gamma = displayGamma.value, markerVisible = markers?.visible;
    const visibility = new Map();
    for (const group of planes.values()) for (const mesh of group.meshes) visibility.set(mesh, mesh.visible);
    if (markers) markers.visible = false;
    displayGamma.value = 1; // Compose the floor before the original display gamma ramp.
    const passFrustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4();
    /** The children of a frame (DrawFrame draws them before it, 0x10b1a336).
     * `view`: its submitted camera, true (reflected) world matrix, depth,
     * scissor in its target's pixels and the group it looks through. Each
     * child renders its own children first, then itself; returns the
     * children with their targets. */
    function children(view) {
      if (view.depth >= MIRROR_RECURSION_LIMIT) return [];
      viewProjection.multiplyMatrices(view.camera.projectionMatrix, view.camera.matrixWorldInverse);
      passFrustum.setFromProjectionMatrix(viewProjection);
      const eye = view.camera.position, found = [];
      for (const group of planes.values()) {
        if (group === view.through || !(group.plane.distanceToPoint(eye) > 0) ||
          !group.meshes.some(mesh => visibility.get(mesh) && passFrustum.intersectsObject(mesh))) continue;
        // Only the part of the mirror inside this frame's own region shows.
        const seen = screenBounds(group, size.x, size.y, viewProjection), bounds = seen && intersect(seen, view.scissor);
        if (bounds) found.push({ group, bounds });
      }
      const result = [];
      for (const [index, { group, bounds }] of found.entries()) {
        const depth = view.depth + 1, child = cameras[depth] ??= new THREE.PerspectiveCamera();
        const world = new THREE.Matrix4().multiplyMatrices(group.matrix, view.world);
        child.copy(source, false); child.matrixAutoUpdate = child.matrixWorldAutoUpdate = false;
        child.matrixWorld.copy(world);
        if (depth % 2) child.matrixWorld.multiply(submissionHandedness);
        child.matrixWorldInverse.copy(child.matrixWorld).invert();
        child.position.setFromMatrixPosition(child.matrixWorld);
        // This frame's columns [x, x+w) are the child's [W-x-w, W-x): the
        // child is mirrored against it. The scissor is the target's own, in
        // its pixels (renderer.setScissor would scale drawing-buffer bounds
        // by the pixel ratio a second time).
        const scissor = { x: size.x - bounds.x - bounds.width, y: bounds.y, width: bounds.width, height: bounds.height };
        const nested = children({ camera: child, world, depth, scissor, through: group });
        // children() reused the deeper cameras; this child's is intact.
        const target = targetFor(depth, index);
        target.setSize(size.x, size.y);
        target.scissor.set(scissor.x, scissor.y, scissor.width, scissor.height); target.scissorTest = true;
        for (const g of planes.values()) g.active.value = 0;
        for (const n of nested) { n.group.texture.value = n.target.texture; n.group.size.value.copy(size); n.group.active.value = 1; }
        // The mirror's own plane is the child's clip plane; its faces are not
        // part of the reflected view.
        for (const mesh of group.meshes) mesh.visible = false;
        updateActors?.(fromView(child.position.toArray()), child);
        renderer.setRenderTarget(target); renderer.setClearColor(0, 1);
        renderer.clear();
        // Clip geometry behind the original mirror plane, not the reflected
        // eye's side. No bias or invented distance/opacity constant.
        renderClip.copy(group.plane);renderer.clippingPlanes = clippingPlanes;
        renderer.render(scene, child);
        for (const mesh of group.meshes) mesh.visible = visibility.get(mesh);
        stats.renderedPlanes++;stats.depth=Math.max(stats.depth,depth);stats.scissorPixels+=bounds.width*bounds.height;
        result.push({ group, target });
      }
      return result;
    }
    try {
      const rendered = children({ camera: source, world: source.matrixWorld, depth: 0,
        scissor: { x: 0, y: 0, width: size.x, height: size.y }, through: null });
      for (const group of planes.values()) group.active.value = 0;
      for (const { group, target } of rendered) { group.texture.value = target.texture; group.size.value.copy(size); group.active.value = 1; }
      if (sky) notes.add('Mirror views through sky-zone openings are not yet verified.');
    } finally {
      for (const [mesh, value] of visibility) mesh.visible = value;
      if (markers) markers.visible = markerVisible;
      displayGamma.value = gamma;
      renderClip.normal.set(0, 0, 0);renderClip.constant = 1;
      renderer.clippingPlanes = clippingPlanes;
      renderer.setRenderTarget(target); renderer.setClearColor(clearColor, clearAlpha);
      updateActors?.(fromView(source.position.toArray()), source);
    }
  }
  const api = { enabled: true, stats, surface, render, mayRender, dispose() { for (const t of targets.values()) t.dispose(); },
    /** Validation access (validate-mirrors-play.mjs); never used by Play. */
    targets: () => [...targets.values()] };
  return api;
}
