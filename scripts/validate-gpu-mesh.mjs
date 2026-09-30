/**
 * GPU mesh path against the CPU kernels on the same inputs, in the same page
 * (docs/gpu-mesh.md, "Validation" and "Tolerances"). Headless Chromium
 * (Metal) runs Play with ?gpuMesh=1 against a dev server; at selected frames
 * it reads the GPU pose, face, corner and environment float targets
 * (readPixels; the draw shader fetches exactly these) and compares them with:
 *   - positions: the CPU shadow's exact GetFrame output (the Wasm kernel);
 *   - colours: the kernel `light` run with the SetupForActor result the GPU
 *     used this frame, on the exact CPU pose;
 *   - environment: meshVertexNormalsInto and writeMeshEnvironmentUV;
 *   - visibility: three.js's own sphere test on the exact CPU spheres.
 *
 *   node scripts/validate-gpu-mesh.mjs [--url http://127.0.0.1:5175]
 *     [--maps 00_Training,01_NYC_UNATCOIsland] [--frames 5,30,60,120,200,300]
 *     [--device cpu]   (CPU substitutes for the GPU readbacks: JavaScript
 *                       lighting path, CPU positions; checks the harness)
 *
 * Exits nonzero when a tolerance is exceeded or coverage is missing.
 */
import {chromium} from '@playwright/test';

const option=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const url=option('url','http://127.0.0.1:5175'),device=option('device','gpu');
const maps=option('maps','00_Training,01_NYC_UNATCOIsland').split(',');
const frames=option('frames','5,30,60,120,200,300').split(',').map(Number);
const TOLERANCE={ulp:1,tweenUlp:2,byte:1,edgeOn:2**-20,uv:2**-20};

const hook=`\nwindow.__deusValidation={get npc(){return npcPreview;},get gpu(){return gpuMesh;},
  get lighting(){return meshLighting;},get camera(){return camera;},THREE};\n`;

async function capture(page,{frames,device,tolerance}) {
  return page.evaluate(async({frames,device,tolerance})=>{
    const {accumulateFaceNormal}=await import('/src/runtime/mesh-lighting.mjs');
    const {meshVertexNormalsInto,writeMeshEnvironmentUV}=await import('/src/runtime/mesh-environment.mjs');
    const v=window.__deusValidation,f32=Math.fround,THREE=v.THREE;
    const bits=new DataView(new ArrayBuffer(4));
    const ulp=x=>{bits.setFloat32(0,Math.abs(x),true);const e=(bits.getUint32(0,true)>>>23)&255;return 2**(Math.max(e,1)-150);};
    const report={captures:0,actors:0,vertices:0,components:0,exact:0,maxUlp:0,maxUlpTween:0,worstPosition:null,
      corners:0,maxByte:0,byteHistogram:[0,0,0],worstColor:null,drawnDisagreements:0,maxEdgeOn:0,excludedCorners:0,
      environmentVertices:0,maxNormalUlp:0,maxUV:0,groups:0,certified:0,ambiguous:0,visibilityMismatches:0,
      coverage:{translucent:0,modulated:0,masked:0,environment:0,unlit:0,mixedUnlit:0,blend:0,tween:0,movingLights:0},fallbacks:{},errors:[]};
    const frustum=new THREE.Frustum(),matrix=new THREE.Matrix4();
    function compare(){
      const {npc,gpu,lighting,camera}=v;
      if(!npc||!gpu)throw new Error('GPU mesh path is not active');
      report.captures++;
      frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse),
        THREE.WebGLCoordinateSystem,camera.reversedDepth);
      const cameraPosition=[-camera.position.z,camera.position.x,camera.position.y];
      for(const actor of npc.actors){
        if(actor.path!=='gpu'){const key=actor.summary.gpuFallback??'cpu';report.fallbacks[key]=(report.fallbacks[key]??0)+1;continue;}
        if(!actor.root.visible)continue;
        const state=actor.gpuState();
        if(!state.handle||!state.plan)continue;
        report.actors++;
        const {handle,plan,faces,faceWords,groups}=state,V=handle.mesh.V,F=handle.mesh.F;
        const tween=plan.channels.some(op=>op.tween&&op.alpha>0);
        // Visibility first: the exact spheres come from the CPU shadow.
        const output=state.exactOutput(),cpu=new Float32Array(output.buffer,output.byteOffset,V*3);
        for(const group of groups.values()){
          report.groups++;
          const exact=frustum.intersectsSphere(group.exact.boundingSphere);
          if(exact!==group.mainVisible)report.visibilityMismatches++;
        }
        // Positions.
        const gpuPose=device==='cpu'?null:gpu.read('pose',handle.vbase,V);
        for(let i=0;i<V;i++)for(let k=0;k<3;k++){
          const c=cpu[i*3+k],g=device==='cpu'?c:gpuPose[i*4+k];
          report.components++;
          if(Object.is(c,g)||c===g){report.exact++;continue;}
          const error=Math.abs(g-c)/ulp(c);
          if(tween)report.maxUlpTween=Math.max(report.maxUlpTween,error);else report.maxUlp=Math.max(report.maxUlp,error);
          if(!report.worstPosition||error>report.worstPosition.ulp)
            report.worstPosition={actor:actor.summary.actor,vertex:i,axis:k,cpu:c,gpu:g,ulp:error,tween};
        }
        report.vertices+=V;
        // Coverage of face flags and actor state.
        const flags=faces.map(face=>face.flags);
        if(flags.some(x=>x&4))report.coverage.translucent++;
        if(flags.some(x=>x&0x40))report.coverage.modulated++;
        if(flags.some(x=>x&2))report.coverage.masked++;
        if(flags.some(x=>x&0x400000)){report.coverage.unlit++;if(flags.some(x=>!(x&0x400000)))report.coverage.mixedUnlit++;}
        if(plan.channels.some(op=>op.blend))report.coverage.blend++;
        if(tween)report.coverage.tween++;
        // Environment normals and UVs (pose-dependent, independent of relight).
        if(state.hasEnvironment){
          report.coverage.environment++;
          const indices=Uint32Array.from(faces.flatMap(face=>face.vertices)),normals=new Float32Array(V*3);
          meshVertexNormalsInto(cpu,indices,normals);
          const gpuNormals=device==='cpu'?null:gpu.read('environment',handle.vbase,V);
          const uvs=device==='cpu'?null:gpu.environmentUVs(handle,cameraPosition);
          const uv=[0,0],relative=[0,0,0],normal=[0,0,0];
          for(let i=0;i<V;i++){
            for(let k=0;k<3;k++){
              const c=normals[i*3+k],g=device==='cpu'?c:gpuNormals[i*4+k];
              if(c!==g)report.maxNormalUlp=Math.max(report.maxNormalUlp,Math.abs(g-c)/ulp(c));
              relative[k]=f32(cpu[i*3+k]-cameraPosition[k]);normal[k]=c;
            }
            writeMeshEnvironmentUV(uv,0,relative,normal);
            for(let k=0;k<2;k++){const g=device==='cpu'?uv[k]:uvs[i*4+k];report.maxUV=Math.max(report.maxUV,Math.abs(g-uv[k]));}
            report.environmentVertices++;
          }
        }
        // Colours: only actors relit in the frame just run.
        if(state.litFrame!==gpu.frame||!state.setup||!lighting?.frame)continue;
        const {setup,flags:actorFlags,unlit}=state.setup;
        if(setup.lights.some(light=>!light.light.values?.bStatic))report.coverage.movingLights++;
        const frame=lighting.frame;
        const reference=npc.kernel.light({points:cpu,faces:faceWords,origin:frame.origin,axes:frame.axes,
          ambient:setup.ambient,scaleGlow:setup.scaleGlow,unlit,lights:setup.lights,flags:actorFlags});
        let deviceColors;
        if(device==='cpu'){
          const kernel=lighting.kernel;lighting.kernel=null;
          try{deviceColors=lighting.lightMesh(actor.actor,Float32Array.from(cpu),faces,faceWords,state.setup).colors;}
          finally{lighting.kernel=kernel;}
        } else deviceColors=gpu.read('corners',handle.cbase,F*3);
        // The CPU's drawn test (kernel face loop, JavaScript form).
        const cameraPoints=Array.from({length:V},(_,i)=>lighting.toCamera([cpu[i*3],cpu[i*3+1],cpu[i*3+2]]));
        const accumulated=cameraPoints.map(()=>[0,0,0]),drawn=new Uint8Array(F);
        const gpuFaces=device==='cpu'?null:gpu.read('faces',handle.fbase,F);
        const excludedVertices=new Set();
        for(let face=0;face<F;face++){
          const [a,b,c]=faces[face].vertices,p0=cameraPoints[a];
          const unit=accumulateFaceNormal(p0,cameraPoints[b],cameraPoints[c],accumulated[a],accumulated[b],accumulated[c]);
          const dot=unit[0]*p0[0]+unit[1]*p0[1]+unit[2]*p0[2];
          drawn[face]=!(faces[face].flags&1)&&(faces[face].flags&0x100||dot<0)?1:0;
          if(device==='cpu')continue;
          const gpuDrawn=gpuFaces[face*4+3]>0.5?1:0;
          if(gpuDrawn!==drawn[face]){
            const relative=Math.abs(dot)/Math.hypot(...p0);
            report.drawnDisagreements++;report.maxEdgeOn=Math.max(report.maxEdgeOn,relative);
            for(const vertex of faces[face].vertices)excludedVertices.add(vertex);
          }
        }
        for(let face=0;face<F;face++){
          if(!drawn[face])continue;
          for(let k=0;k<3;k++){
            if(excludedVertices.has(faces[face].vertices[k])){report.excludedCorners++;continue;}
            report.corners++;
            for(let channel=0;channel<3;channel++){
              const expected=Math.round(reference[face*9+k*3+channel]*255);
              const got=device==='cpu'?Math.round(deviceColors[face*9+k*3+channel]*255):deviceColors[(face*3+k)*4+channel];
              const error=Math.abs(got-expected);
              report.byteHistogram[Math.min(2,error)]++;
              if(error>report.maxByte){report.maxByte=error;
                report.worstColor={actor:actor.summary.actor,face,corner:k,channel,expected,got,faceFlags:faces[face].flags,
                  actorFlags,lights:setup.lights.length};}
            }
          }
        }
      }
    }
    for(let frame=0,captured=0;captured<frames.length;frame++){
      await new Promise(requestAnimationFrame);
      if(window.deusExViewer.framePhases(false).runtimeError)
        throw new Error(`runtime error: ${window.deusExViewer.framePhases(false).runtimeError}`);
      if(frame===frames[captured]){try{compare();}catch(error){report.errors.push(error.stack??String(error));}captured++;}
    }
    return report;
  },{frames,device,tolerance});
}

const browser=await chromium.launch({args:['--use-angle=metal']});
let failed=false;
try {
  for(const map of maps){
    const page=await browser.newPage({viewport:{width:1440,height:960}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/,async route=>{
      const response=await route.fetch();
      await route.fulfill({response,body:(await response.text())+hook});
    });
    await page.goto(`${url}/?gpuMesh=1`);
    await page.waitForFunction(()=>window.deusExViewer?.status().ready,{}, {timeout:240000});
    if(map!=='00_Training'){
      await page.locator('#map').selectOption(map);
      await page.waitForFunction(map=>{const s=window.deusExViewer?.status();return s?.ready&&s.map===map;},map,{timeout:240000});
    }
    await page.waitForFunction(()=>{const s=window.deusExViewer?.status();
      return s?.runtimeError||s?.gameplay?.hud?.health?.head?.displayedHealth===100;},{}, {timeout:240000});
    await page.locator('#scene').click({position:{x:600,y:350}});
    await page.waitForTimeout(1500);
    await page.keyboard.down('KeyW');
    const report=await capture(page,{frames,device,tolerance:TOLERANCE});
    await page.keyboard.up('KeyW');
    report.pageErrors=errors;
    const checks=[
      ['position ulp (keyframe/blend)',report.maxUlp<=TOLERANCE.ulp],
      ['position ulp (tween)',report.maxUlpTween<=TOLERANCE.tweenUlp],
      ['colour bytes',report.maxByte<=TOLERANCE.byte],
      ['edge-on drawn disagreements',report.maxEdgeOn<TOLERANCE.edgeOn],
      ['environment UV',report.maxUV<=TOLERANCE.uv],
      ['visibility',report.visibilityMismatches===0],
      ['no errors',!report.errors.length&&!errors.length],
      ['compared actors',report.actors>0&&report.corners>0],
    ];
    const coverage=report.coverage;
    const covered=[['translucent',coverage.translucent],['modulated',coverage.modulated],['masked',coverage.masked],
      ['environment',coverage.environment],['blend',coverage.blend]];
    for(const [name,count] of covered)checks.push([`coverage: ${name}`,count>0]);
    const failures=checks.filter(([,ok])=>!ok).map(([name])=>name);
    failed||=failures.length>0;
    console.log(JSON.stringify({map,device,tolerance:TOLERANCE,failures,
      bitExactFraction:+(report.exact/Math.max(1,report.components)).toFixed(6),...report},null,1));
    await page.close();
  }
} finally {await browser.close();}
if(failed){console.error('validate-gpu-mesh: FAIL');process.exit(1);}
console.log('validate-gpu-mesh: PASS');
