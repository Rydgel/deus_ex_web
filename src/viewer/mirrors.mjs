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

/** Static upward-facing translucent BSP floors. The four Training heights are
 * parallel, so their front faces cannot see one another in a reflected view.
 * Other mirror branches remain explicit boundaries; see mirror-surfaces.md. */
export function createMirrors(notes, displayGamma) {
  const planes = new Map(), size = new THREE.Vector2(), frustum = new THREE.Frustum();
  const projection = new THREE.Matrix4(), clipMatrix = new THREE.Matrix4(), camera = new THREE.PerspectiveCamera();
  // OccludeBsp's reflected axes have negative handedness.  WebGL's front-face
  // state is object/material state rather than camera state, so reflecting the
  // camera alone reverses culling.  Negate its local X axis for submission and
  // sample the resulting target right-to-left (light-atlas.mjs).  The two
  // reflections cancel in screen space while keeping each material/program
  // immutable across the child and parent draws.
  const submissionHandedness = new THREE.Matrix4().makeScale(-1, 1, 1);
  // Keep one global clipping-plane shader shape for both child and parent
  // draws.  Changing between zero and one planes makes three.js reselect a
  // program for every material on every pass.  A zero normal disables the
  // plane for the parent without changing that compiled shape.
  const renderClip = new THREE.Plane(new THREE.Vector3(), 1), clippingPlanes = [renderClip];
  const stats = { surfaces: 0, planes: 0, renderedPlanes: 0, scissorPixels: 0, unsupportedSurfaces: 0 };
  function screenBounds(group, width, height) {
    let minX=width,minY=height,maxX=0,maxY=0,found=false;
    for(const mesh of group.meshes){
      const position=mesh.geometry.getAttribute('position');if(!position)continue;
      clipMatrix.multiplyMatrices(projection,mesh.matrixWorld);const e=clipMatrix.elements,a=position.array;
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
  function surface(model, surface, actorName) {
    if (!(surface.flags & POLY.Mirrored)) return null;
    const n = model.vectors[surface.normal], p = model.points[surface.base];
    if (actorName || n[0] !== 0 || n[1] !== 0 || n[2] !== 1 ||
        !(surface.flags & POLY.Translucent) || surface.flags & (POLY.Modulated | POLY.TwoSided)) {
      stats.unsupportedSurfaces++;
      notes.add('Mirrors outside static upward-facing translucent BSP floors remain unsupported.');
      return null;
    }
    const key = String(p[2]);
    if (!planes.has(key)) {
      const target = new THREE.WebGLRenderTarget(1, 1, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        generateMipmaps: false, depthBuffer: true,
      });
      target.texture.colorSpace = THREE.NoColorSpace; // Original display-encoded framebuffer bytes.
      const plane = new THREE.Plane(new THREE.Vector3(...toView(n)), -p[2]);
      planes.set(key, { key, plane, matrix: mirrorMatrix(plane), target, meshes: [],
        texture: { value: target.texture }, size: { value: new THREE.Vector2(1, 1) }, active: { value: 0 } });
    }
    stats.surfaces++; stats.planes = planes.size;
    return planes.get(key);
  }
  /** Whether render() would draw any mirror plane for this source camera:
   * the same plane side and floor-frustum predicate, evaluated early so the
   * actor layer knows reflected views may need off-screen actors. */
  function mayRender(source) {
    if (!planes.size) return false;
    source.updateMatrixWorld();
    frustum.setFromProjectionMatrix(projection.multiplyMatrices(source.projectionMatrix, source.matrixWorldInverse));
    for (const group of planes.values())
      if (group.plane.distanceToPoint(source.position) > 0 &&
        group.meshes.some(mesh => mesh.visible && frustum.intersectsObject(mesh))) return true;
    return false;
  }
  function render(renderer, scene, source, { markers, updateActors, sky } = {}) {
    stats.renderedPlanes = 0;stats.scissorPixels=0;
    if (!planes.size) return;
    // The plane test below needs the planes' world matrices; each
    // renderer.render call updates the whole scene itself (auto-update), so
    // only the plane meshes and their ancestors are updated here.
    source.updateMatrixWorld();
    for (const group of planes.values()) for (const mesh of group.meshes) mesh.updateWorldMatrix(true, false);
    frustum.setFromProjectionMatrix(projection.multiplyMatrices(source.projectionMatrix, source.matrixWorldInverse));
    const visible = [...planes.values()].filter(group => {
      group.active.value = 0;
      return group.plane.distanceToPoint(source.position) > 0 &&
        group.meshes.some(mesh => mesh.visible && frustum.intersectsObject(mesh));
    });
    if (!visible.length) return;
    renderer.getDrawingBufferSize(size);
    const target = renderer.getRenderTarget(), clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha(),oldScissor=renderer.getScissor(new THREE.Vector4());
    const oldScissorTest=renderer.getScissorTest();
    const gamma = displayGamma.value, markerVisible = markers?.visible;
    const visibility = new Map();
    for (const group of planes.values()) for (const mesh of group.meshes) {
      visibility.set(mesh, mesh.visible); mesh.visible = false;
    }
    if (markers) markers.visible = false;
    displayGamma.value = 1; // Compose the floor before the original display gamma ramp.
    try {
      for (const group of visible) {
        const bounds=screenBounds(group,size.x,size.y);if(!bounds)continue;
        group.target.setSize(size.x, size.y); group.size.value.copy(size);
        camera.copy(source, false); camera.matrixAutoUpdate = camera.matrixWorldAutoUpdate = false;
        camera.matrixWorld.multiplyMatrices(group.matrix, source.matrixWorld);
        camera.matrixWorld.multiply(submissionHandedness);
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        camera.position.setFromMatrixPosition(camera.matrixWorld);
        updateActors?.(fromView(camera.position.toArray()), camera);
        renderer.setRenderTarget(group.target); renderer.setClearColor(0, 1);
        renderer.setScissor(bounds.x,bounds.y,bounds.width,bounds.height);renderer.setScissorTest(true);
        renderer.clear();
        // Clip geometry behind the original mirror plane, not the reflected
        // eye's side. No bias or invented distance/opacity constant.
        renderClip.copy(group.plane);renderer.clippingPlanes = clippingPlanes;
        renderer.render(scene, camera);
        group.active.value = 1; stats.renderedPlanes++;stats.scissorPixels+=bounds.width*bounds.height;
      }
      if (sky) notes.add('Mirror views through sky-zone openings are not yet verified.');
    } finally {
      for (const [mesh, value] of visibility) mesh.visible = value;
      if (markers) markers.visible = markerVisible;
      displayGamma.value = gamma;
      renderClip.normal.set(0, 0, 0);renderClip.constant = 1;
      renderer.clippingPlanes = clippingPlanes;
      renderer.setScissor(oldScissor);renderer.setScissorTest(oldScissorTest);
      renderer.setRenderTarget(target); renderer.setClearColor(clearColor, clearAlpha);
      updateActors?.(fromView(source.position.toArray()), source);
    }
  }
  return { stats, surface, render, mayRender, dispose() { for (const p of planes.values()) p.target.dispose(); } };
}
