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
  const projection = new THREE.Matrix4(), camera = new THREE.PerspectiveCamera();
  const stats = { surfaces: 0, planes: 0, renderedPlanes: 0, unsupportedSurfaces: 0 };
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
  function render(renderer, scene, source, { markers, updateActors, sky } = {}) {
    stats.renderedPlanes = 0;
    if (!planes.size) return;
    source.updateMatrixWorld(); scene.updateMatrixWorld();
    frustum.setFromProjectionMatrix(projection.multiplyMatrices(source.projectionMatrix, source.matrixWorldInverse));
    const visible = [...planes.values()].filter(group => {
      group.active.value = 0;
      return group.plane.distanceToPoint(source.position) > 0 &&
        group.meshes.some(mesh => mesh.visible && frustum.intersectsObject(mesh));
    });
    if (!visible.length) return;
    renderer.getDrawingBufferSize(size);
    const target = renderer.getRenderTarget(), clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha(), clipping = renderer.clippingPlanes;
    const gamma = displayGamma.value, markerVisible = markers?.visible;
    const sides = new Map(), visibility = new Map();
    scene.traverse(object => {
      for (const material of object.material ? [].concat(object.material) : []) {
        if (sides.has(material)) continue;
        sides.set(material, material.side);
        if (material.side !== THREE.DoubleSide)
          material.side = material.side === THREE.FrontSide ? THREE.BackSide : THREE.FrontSide;
      }
    });
    for (const group of planes.values()) for (const mesh of group.meshes) {
      visibility.set(mesh, mesh.visible); mesh.visible = false;
    }
    if (markers) markers.visible = false;
    displayGamma.value = 1; // Compose the floor before the original display gamma ramp.
    try {
      for (const group of visible) {
        group.target.setSize(size.x, size.y); group.size.value.copy(size);
        camera.copy(source, false); camera.matrixAutoUpdate = camera.matrixWorldAutoUpdate = false;
        camera.matrixWorld.multiplyMatrices(group.matrix, source.matrixWorld);
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        camera.position.setFromMatrixPosition(camera.matrixWorld);
        updateActors?.(fromView(camera.position.toArray()));
        renderer.setRenderTarget(group.target); renderer.setClearColor(0, 1); renderer.clear();
        // Clip geometry behind the original mirror plane, not the reflected
        // eye's side. No bias or invented distance/opacity constant.
        renderer.clippingPlanes = [group.plane];
        renderer.render(scene, camera);
        group.active.value = 1; stats.renderedPlanes++;
      }
      if (sky) notes.add('Mirror views through sky-zone openings are not yet verified.');
    } finally {
      for (const [material, side] of sides) material.side = side;
      for (const [mesh, value] of visibility) mesh.visible = value;
      if (markers) markers.visible = markerVisible;
      displayGamma.value = gamma;
      renderer.clippingPlanes = clipping;
      renderer.setRenderTarget(target); renderer.setClearColor(clearColor, clearAlpha);
      updateActors?.(fromView(source.position.toArray()));
    }
  }
  return { stats, surface, render, dispose() { for (const p of planes.values()) p.target.dispose(); } };
}
