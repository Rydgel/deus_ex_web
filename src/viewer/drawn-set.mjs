/** Which actors a Play frame draws, decided on the simulation side
 * (docs/sim-worker.md "The drawn set and LastRenderTime"). Render.dll copies
 * TimeSeconds to the LastRenderTime of each submitted actor
 * (actor-render-feedback.mjs); Play submits what three.js draws, and three.js
 * decides with its frustum test on each object's bounds, in every pass:
 * the mirror child frames (mirror-passes.mjs), the sky frame and the main
 * frame. This model runs three.js's own math on the same inputs: the page's
 * static brush and mirror meshes (world.stampScene), the simulation's mover
 * states, camera and sky frame, the sprite records and the actor mesh
 * layer's decisions. It is host culling, not the original visibility
 * contract (docs/render-visibility.md). */
import * as THREE from 'three';
import { toView } from '../unreal/geometry.mjs';
import { mirrorMatrix } from './mirrors.mjs';
import { mirrorsMayRender, planMirrorPasses, planFramePasses, passOrder } from './mirror-passes.mjs';
import { moverGroupMatrix } from './mover-matrix.mjs';
import { rotatorEuler } from './play-camera.mjs';

const SPRITE_RADIUS = 0.7071067811865476, identity = new THREE.Quaternion();

/** A static mesh as three.js culls it: its geometry's bounding sphere and
 * positions, and a world matrix kept here. */
function meshOf(data) {
  const positions = data.positions ? new THREE.BufferAttribute(data.positions, 3) : null;
  return { actor: data.actor, visible: data.visible, owner: data.owner, matrix: new THREE.Matrix4().fromArray(data.matrix),
    matrixWorld: new THREE.Matrix4(),
    geometry: { boundingSphere: new THREE.Sphere(new THREE.Vector3(...data.sphere.slice(0, 3)), data.sphere[3]),
      getAttribute: name => name === 'position' ? positions : undefined } };
}

export function createDrawnSet(scene) {
  const root = new THREE.Matrix4().fromArray(scene.root);
  const movers = new Map(scene.movers.map(mover => {
    const base = new THREE.Matrix4().fromArray(mover.base), world = new THREE.Matrix4().multiplyMatrices(root, base);
    const meshes = mover.meshes.map(meshOf);
    for (const mesh of meshes) mesh.matrixWorld.multiplyMatrices(world, mesh.matrix);
    return [mover.name, { base, matrix: new THREE.Matrix4(), world, meshes }];
  }));
  const groups = scene.mirrors.map(data => {
    const plane = new THREE.Plane(new THREE.Vector3(...data.plane.normal), data.plane.constant);
    const localPlane = data.localPlane ? new THREE.Plane(new THREE.Vector3(...data.localPlane.normal), data.localPlane.constant) : null;
    return { key: data.key, moving: data.moving, plane, localPlane, matrix: mirrorMatrix(plane), meshes: data.meshes.map(meshOf),
      nodes: data.nodes ?? null };
  });
  const placeMirrors = () => {
    for (const group of groups) {
      for (const mesh of group.meshes)
        mesh.matrixWorld.multiplyMatrices(mesh.owner ? movers.get(mesh.owner).world : root, mesh.matrix);
      // A moving group's world plane and reflection from its mover's current
      // transform (mirrors.mjs follow).
      if (!group.moving || !group.meshes[0]) continue;
      group.plane.copy(group.localPlane).applyMatrix4(group.meshes[0].matrixWorld);
      group.matrix = mirrorMatrix(group.plane);
    }
  };
  placeMirrors();
  const frustum = new THREE.Frustum(), projection = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const spriteMatrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
  const skyCamera = new THREE.PerspectiveCamera(75, 1, 1, 65536);
  const frustumOf = camera => frustum.setFromProjectionMatrix(
    projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem, camera.reversedDepth);
  return {
    groups,
    /** The movers' group matrices from this frame's mover states, as
     * world.syncMovers poses them, and the mirror planes that follow them. */
    placeMovers(states) {
      for (const state of states) {
        const mover = movers.get(state.name);
        if (!mover) continue;
        moverGroupMatrix(state, mover.base, mover.matrix);
        mover.world.multiplyMatrices(root, mover.matrix);
        for (const mesh of mover.meshes) mesh.matrixWorld.multiplyMatrices(mover.world, mesh.matrix);
      }
      placeMirrors();
    },
    /** Whether the mirror planes may draw for this camera (mirrors.mjs
     * mayRender): the actor layer then admits actors only children draw. */
    mayRender: (camera, requested = null) => mirrorsMayRender(camera, groups, undefined, requested),
    /** The frame's passes in draw order: the mirror children (when
     * `mirrors`), the sky frame (when `sky`) and the main frame (when
     * `drawWorld`), each with its camera and the mirror group it looks
     * through; `requested` OccludeBsp's mirror requests (mirror-passes.mjs
     * requestedGroup). With `frames` (OccludeFrame's child frames,
     * sim-session.mjs visibility) the mirror passes are its mirror frames
     * (planFramePasses, `rect` the render viewport) and the sky pass its
     * root sky frame, each pass with its `frame`; a sky frame inside a
     * mirror frame is a 'sky' pass of its own (`within`: the mirror's node),
     * ahead of that mirror's pass. */
    passes({ camera, sky, drawWorld, size, mirrors = true, requested = null, frames = null, rect = null }) {
      const passes = [];
      let mirrored = false;
      if (frames) {
        const plan = mirrors && groups.length ? planFramePasses(camera, groups, size, frames, rect) : [];
        mirrored = plan.length > 0;
        // A mirror frame's sky frames draw into its target before its own
        // view (mirrors.mjs draw), after the mirror frames inside it.
        for (const node of passOrder(plan)) {
          for (const inside of node.skies) passes.push({ kind: 'sky', camera: inside.camera, frame: inside.frame, within: node });
          passes.push({ kind: 'mirror', camera: node.camera, through: node.group, node, frame: node.frame });
        }
      } else {
        mirrored = mirrors && groups.length > 0 && mirrorsMayRender(camera, groups, undefined, requested);
        if (mirrored)
          for (const node of passOrder(planMirrorPasses(camera, groups, size, undefined, requested)))
            passes.push({ kind: 'mirror', camera: node.camera, through: node.group, node });
      }
      if (sky) {
        skyCamera.copy(camera); skyCamera.position.fromArray(toView(sky.location));
        skyCamera.quaternion.premultiply(new THREE.Quaternion().setFromEuler(rotatorEuler(sky.rotation)));
        skyCamera.updateMatrixWorld();
        passes.push({ kind: 'sky', camera: skyCamera, frame: frames?.find(f => f.parent === 0 && f.kind === 'sky') ?? null });
      }
      if (drawWorld) { camera.updateMatrixWorld(); passes.push({ kind: 'main', camera }); }
      return { passes, mirrored };
    },
    /** The names of the movers whose brush meshes one pass draws. */
    moversIn(pass, out = new Set()) {
      frustumOf(pass.camera);
      for (const [name, mover] of movers) {
        if (out.has(name)) continue;
        for (const mesh of mover.meshes) {
          if (!mesh.visible || pass.through?.meshes.includes(mesh)) continue;
          sphere.copy(mesh.geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
          if (frustum.intersectsSphere(sphere)) { out.add(name); break; }
        }
      }
      return out;
    },
    /** The handles of the sprites one pass draws: three.js's sprite sphere
     * (radius √½ scaled by the sprite's largest axis) at each sprite. A
     * sprite record carries its texture's size once known. */
    spritesIn(pass, sprites, out = new Set()) {
      frustumOf(pass.camera);
      for (const sprite of sprites) {
        if (!sprite.size || out.has(sprite.handle)) continue;
        position.fromArray(toView(sprite.location));
        scale.set(sprite.size[0] * sprite.drawScale, sprite.size[1] * sprite.drawScale, 1);
        spriteMatrix.compose(position, identity, scale);
        sphere.center.set(0, 0, 0); sphere.radius = SPRITE_RADIUS; sphere.applyMatrix4(spriteMatrix);
        if (frustum.intersectsSphere(sphere)) out.add(sprite.handle);
      }
      return out;
    },
    /** A pass camera's frustum, as three.js renders with it. */
    frustum: camera => new THREE.Frustum().copy(frustumOf(camera)),
  };
}
