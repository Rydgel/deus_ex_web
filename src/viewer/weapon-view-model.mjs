import * as THREE from 'three';
import {fromView} from '../unreal/geometry.mjs';
import {actorRenderFeedback} from './actor-render-feedback.mjs';
import {createGpuMeshLayout} from './gpu-mesh-layout.mjs';
import {createWeaponOverlaySim} from './weapon-overlay-sim.mjs';
import {createWeaponOverlayDraw} from './weapon-overlay-draw.mjs';

/** The player's view model as one object (focused checks): its simulation
 * half (weapon-overlay-sim.mjs: Render.dll's gates, RenderOverlays, the
 * mesh bindings and render feedback) and its page half
 * (weapon-overlay-draw.mjs) one after the other in this thread. Play runs
 * the halves through sim-session.mjs. Evidence:
 * docs/script-weapon-rendering.md.
 *
 * `playerSource` is the player actor or a getter for it: Player start logs
 * a new player in, so the viewer passes a getter. `gpu` is a GPU mesh
 * instance of the view model's own (gpu-mesh.mjs). */
export async function createWeaponViewModel(runtime,assets,playerSource,{kernel=null,lighting=null,displayGamma={value:1},gpu=null}={}) {
  const draw=createWeaponOverlayDraw(assets,{gpu,displayGamma});
  const sim=await createWeaponOverlaySim(runtime,assets,playerSource,{kernel,lighting,
    layout:gpu?createGpuMeshLayout(gpu.capacities):null,onCreate:creation=>draw.create(creation),onRelease:id=>draw.release(id)});
  const frustum=new THREE.Frustum(),matrix=new THREE.Matrix4();
  return {scene:draw.scene,summary:sim.summary,
    async ready(){await sim.ready();await draw.ready();},
    /** The overlay pass after the world draw, with the world frame's camera. */
    render(renderer,camera){
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse),
        camera.coordinateSystem,camera.reversedDepth);
      const frame=sim.frame({frustum});
      if(!frame)return;
      for(const actor of frame.drawn)actorRenderFeedback(runtime,actor,{canvas:true})();
      draw.prepare(frame,fromView(camera.position.toArray()));
      draw.render(renderer,camera,frame);
    },
    dispose(){sim.dispose();draw.dispose();},
  };
}
