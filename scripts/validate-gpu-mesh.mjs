/**
 * GPU mesh path against the CPU kernels on the same inputs, in the same page
 * (docs/gpu-mesh.md, "Validation" and "Tolerances"). Headless Chromium
 * (ANGLE on the GPU, --angle) runs Play with ?gpuMesh=1 against a dev server; at selected frames
 * it reads the GPU pose, face, corner and environment float targets
 * (readPixels; the draw shader fetches exactly these) and compares them with:
 *   - positions: the CPU shadow's exact GetFrame output (the Wasm kernel);
 *   - colours: the kernel `light` run with the SetupForActor result the GPU
 *     used this frame, on the exact CPU pose;
 *   - environment: meshVertexNormalsInto and writeMeshEnvironmentUV;
 *   - visibility: three.js's own sphere test on the exact CPU spheres.
 * On Island the walk then continues into MeetPaul: the player's mesh is
 * admitted mid-animation when the conversation turns on bBehindView, and
 * every frame after that is compared, so a slot whose first GPU pass a
 * second plan overtakes (the player growing from a point) fails.
 *
 *   node scripts/validate-gpu-mesh.mjs [--url http://127.0.0.1:5173] (default: its own server)
 *     [--maps 00_Training,01_NYC_UNATCOIsland] [--frames 5,30,60,90,120,160,200,250,300,360]
 *     [--device cpu]   (CPU substitutes for the GPU readbacks: JavaScript
 *                       lighting path, CPU positions; checks the harness)
 *     [--angle metal|gl|vulkan]  (ANGLE backend: metal on macOS, gl elsewhere.
 *                       Linux Chromium ignores metal and falls back to
 *                       SwiftShader, a software renderer whose float results
 *                       and frame timing differ; gl reaches the Linux host's
 *                       AMD iGPU, docs/linux-host.md)
 *
 * Exits nonzero when a tolerance is exceeded or coverage is missing.
 */
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const device=option('device','gpu');
const angle=option('angle',process.platform==='darwin'?'metal':'gl');
try{gameDirectory();}catch{console.log('SKIP validate-gpu-mesh: no installed game data');process.exit(0);}
// Without --url, a bounded dev server of this checkout with the repository's
// configuration (game-data middleware included) on a free port. A checkout
// under .work/ keeps its own files servable.
let server=null,url=option('url',null);
if(!url){
  const root=fileURLToPath(new URL('..',import.meta.url));
  const {default:base}=await import('../vite.config.mjs');
  // The tree may itself sit in .work/ or .claude/worktrees/, which the config denies.
  const deny=base.server.fs.deny.filter(pattern=>!(pattern.includes('.work')&&root.includes('/.work/'))
    &&!(pattern.includes('.claude/worktrees')&&root.includes('/.claude/worktrees/')));
  server=await createServer({...base,configFile:false,root,logLevel:'error',
    server:{...base.server,port:0,strictPort:false,fs:{...base.server.fs,deny},watch:null}});
  await server.listen();
  url=server.resolvedUrls.local[0].replace(/\/$/,'');
}
const maps=option('maps','00_Training,01_NYC_UNATCOIsland').split(',');
const frames=option('frames','5,30,60,90,120,160,200,250,300,360').split(',').map(Number);
const TOLERANCE={ulp:1,tweenUlp:2,byte:1,edgeOn:2**-20,uv:2**-20};

const hook=`\nwindow.__deusValidation={get npc(){return npcPreview;},get gpu(){return gpuMesh;},
  get lighting(){return meshLighting;},get camera(){return camera;},get game(){return game;},THREE};\n`;

async function capture(page,{frames,device,tolerance,admission}) {
  return page.evaluate(async({frames,device,tolerance,admission})=>{
    const {accumulateFaceNormal}=await import('/src/runtime/mesh-lighting.mjs');
    const {meshVertexNormalsInto,writeMeshEnvironmentUV}=await import('/src/runtime/mesh-environment.mjs');
    const {certificateStats}=await import('/src/viewer/gpu-mesh-bounds.mjs');
    const certifiedBefore=certificateStats.certified,ambiguousBefore=certificateStats.ambiguous;
    const v=window.__deusValidation,f32=Math.fround,THREE=v.THREE;
    const bits=new DataView(new ArrayBuffer(4));
    const ulp=x=>{bits.setFloat32(0,Math.abs(x),true);const e=(bits.getUint32(0,true)>>>23)&255;return 2**(Math.max(e,1)-150);};
    const report={captures:0,actors:0,vertices:0,components:0,exact:0,maxUlp:0,maxUlpTween:0,worstPosition:null,
      corners:0,maxByte:0,byteHistogram:[0,0,0],worstColor:null,drawnDisagreements:0,maxEdgeOn:0,excludedCorners:0,
      environmentVertices:0,maxNormalUlp:0,maxUV:0,groups:0,certified:0,ambiguous:0,visibilityMismatches:0,
      coverage:{translucent:0,modulated:0,masked:0,environment:0,unlit:0,mixedUnlit:0,blend:0,tween:0,movingLights:0},fallbacks:{},errors:[]};
    const frustum=new THREE.Frustum(),matrix=new THREE.Matrix4();
    let focus=null;
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
        const state=actor.gpuState();const exactBefore=state.exactValid;
        // An actor admitted after this frame's GPU run is posed and updated
        // by the next frame before it is drawn; nothing of it is drawn yet.
        if(!state.handle||!state.plan||state.plannedFrame>gpu.frame||!state.updated){report.pending=(report.pending??0)+1;continue;}
        report.actors++;
        const {handle,plan,faces,faceWords,groups}=state,V=handle.mesh.V,F=handle.mesh.F;
        const tween=plan.channels.some(op=>op.tween&&op.alpha>0);
        if(focus&&actor.actor===focus){report.admission.captures++;if(tween)report.admission.tweenCaptures++;}
        // Visibility first: the exact spheres come from the CPU shadow.
        const output=state.exactOutput(),cpu=new Float32Array(output.buffer,output.byteOffset,V*3);
        for(const group of groups.values()){
          report.groups++;
          const exact=frustum.intersectsSphere(group.exact.boundingSphere);
          if(exact!==group.mainVisible){report.visibilityMismatches++;(report.badVisibility??=[]).push({capture:report.captures,
            actor:actor.summary.actor,exact,main:group.mainVisible,box:[...group.viewBox].map(x=>+x.toFixed(2)),
            sphere:[...group.exact.boundingSphere.center.toArray().map(x=>+x.toFixed(2)),+group.exact.boundingSphere.radius.toFixed(2)]});}
        }
        // Positions.
        const gpuPose=device==='cpu'?null:gpu.read('pose',handle.vbase,V);
        for(let i=0;i<V;i++)for(let k=0;k<3;k++){
          const c=cpu[i*3+k],g=device==='cpu'?c:gpuPose[i*4+k];
          report.components++;
          if(Object.is(c,g)||c===g){report.exact++;continue;}
          const error=Math.abs(g-c)/ulp(c);
          if(tween)report.maxUlpTween=Math.max(report.maxUlpTween,error);else report.maxUlp=Math.max(report.maxUlp,error);
          if(error>tolerance.tweenUlp){const key=`${report.captures}:${actor.summary.actor}`;
            report.badActors??={};report.badActors[key]??={count:0,V,channels:plan.channels.map(op=>[op.channel,op.tween,op.first,op.second,op.alpha]),
              exactValidAtCapture:exactBefore,slot:handle.slot,vbase:handle.vbase};report.badActors[key].count++;}
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
    if(admission){
      // Keep walking until the conversation shows the player, then compare
      // every frame from its admission on.
      const game=v.game,runtime=game.doors.scriptRuntime.runtime;
      report.admission={behindFrame:-1,admittedFrame:-1,captures:0,tweenCaptures:0};
      for(let frame=0;frame<admission.maxFrames;frame++){
        await new Promise(requestAnimationFrame);
        const error=window.deusExViewer.framePhases(false).runtimeError;
        if(error)throw new Error(`runtime error: ${error}`);
        const player=game.player.collisionActor;
        if(report.admission.behindFrame<0&&runtime.readNamed(player,'bBehindView'))report.admission.behindFrame=frame;
        if(report.admission.behindFrame<0)continue;
        if(!focus&&v.npc.actors.some(actor=>actor.actor===player)){focus=player;report.admission.admittedFrame=frame;}
        if(focus){try{compare();}catch(error){report.errors.push(error.stack??String(error));}}
        if(focus&&frame-report.admission.admittedFrame>=admission.frames)break;
      }
    }
    // Decisions Play made during the captured run (not the checks above).
    report.certified=certificateStats.certified-certifiedBefore;report.ambiguous=certificateStats.ambiguous-ambiguousBefore;
    return report;
  },{frames,device,tolerance,admission});
}

const browser=await chromium.launch({args:[`--use-angle=${angle}`]});
let failed=false;
const coverage={},failureNotes=[];
try {
  for(const map of maps){
    const page=await browser.newPage({viewport:{width:1440,height:960}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/,async route=>{
      const response=await route.fetch();
      await route.fulfill({response,body:(await response.text())+hook});
    });
    // Reads the runtime through main.mjs: the page's own simulation (?sim=inline).
    await page.goto(`${url}/?gpuMesh=1&sim=inline`);
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
    const admission=map==='01_NYC_UNATCOIsland'?{frames:90,maxFrames:20000}:null;
    const report=await capture(page,{frames,device,tolerance:TOLERANCE,admission});
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
      ...(admission?[['player admitted in behind view and compared while tweening',report.admission?.tweenCaptures>0]]:[]),
    ];
    for(const [name,count] of Object.entries(report.coverage))coverage[name]=(coverage[name]??0)+count;
    const failures=checks.filter(([,ok])=>!ok).map(([name])=>name);
    failed||=failures.length>0;
    // The sweep runner shows stderr: name what failed and why.
    if(failures.length)failureNotes.push(`${map}: ${failures.join(', ')}${report.errors.length?` (${report.errors[0].split('\n')[0]})`:''}${errors.length?` (page: ${errors[0]})`:''}`);
    console.log(JSON.stringify({map,device,tolerance:TOLERANCE,failures,
      bitExactFraction:+(report.exact/Math.max(1,report.components)).toFixed(6),...report},null,1));
    await page.close();
  }
} finally {await browser.close();await server?.close();}
// Face flags, animation modes and moving lights must all be exercised by the
// maps compared in this run.
const required=['translucent','modulated','masked','environment','mixedUnlit','blend','tween','movingLights'];
const missing=required.filter(name=>!(coverage[name]>0));
console.log(JSON.stringify({coverage,missing}));
// Coverage is a property of the full run over both maps (Training alone has
// no moving mesh lights or tweens in its captured frames).
const fullRun=['00_Training','01_NYC_UNATCOIsland'].every(map=>maps.includes(map));
if(device==='gpu'&&fullRun&&missing.length)failed=true;
else if(missing.length)console.log(`coverage not required for a partial run: missing ${missing.join(', ')}`);
if(failed){console.error(`validate-gpu-mesh: FAIL\n${failureNotes.join('\n')}`);process.exit(1);}
console.log('validate-gpu-mesh: PASS');
