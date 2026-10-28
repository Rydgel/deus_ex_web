import {test,expect} from '@playwright/test';
import { BASE } from './browsers.mjs';

test('only submitted actor meshes refresh render time',async({page})=>{
  // Use the real WebGL submission/culling path with controlled actor fields.
  // No game assets or full renderer fidelity are required for this boundary.
  await page.goto(`${BASE}/?debug=1`);
  const stamps=await page.evaluate(async()=>{
    const THREE=await import('/node_modules/three/build/three.module.js');
    const {actorRenderFeedback}=await import('/src/viewer/actor-render-feedback.mjs');
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,1,0.1,100);
    const renderer=new THREE.WebGLRenderer();renderer.setSize(64,64);
    const levelInfo={TimeSeconds:17.125};
    const runtime={levelFor:()=>({actors:[levelInfo]}),namedReference:(actor,name)=>({get:()=>actor[name],set:v=>{actor[name]=v;}})};
    const cases=[{}, {hidden:true}, {offscreen:true}, {parentHidden:true}];
    const actors=cases.map(options=>{
      const actor={LastRenderTime:-10,bHidden:Boolean(options.hidden),bDeleteMe:false};
      const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());
      mesh.position.set(options.offscreen?1000:0,0,-5);
      mesh.visible=!options.hidden;mesh.onAfterRender=actorRenderFeedback(runtime,actor);
      const parent=new THREE.Group();parent.visible=!options.parentHidden;
      parent.add(mesh);scene.add(parent);return actor;
    });
    renderer.render(scene,camera);
    const result=actors.map(a=>a.LastRenderTime);
    scene.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});
    renderer.dispose();return result;
  });
  expect(stamps).toEqual([17.125,-10,-10,-10]);
});
