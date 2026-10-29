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
 *   - visibility: three.js's own sphere test on the exact CPU spheres;
 *   - camera space (docs/script-lodmesh-lod.md "Camera space"): the pose a
 *     lit slot's frame matrix publishes and its morph, which the lighting
 *     reads, against the CPU twin (publishLodMeshOps + actor-mesh-lod.mjs on
 *     the exact cache poses), main frame, a reflected child frame and the
 *     child LOD states;
 *   - the distance LOD (docs/gpu-mesh.md "Distance LOD"): for an actor the
 *     LOD reduces, the final (morphed) pose and the resolved corner dwords
 *     against actor-mesh-lod.mjs on the exact output, and the colours and
 *     drawn test over its reduced faces.
 *   - a pawn's third-person weapon (docs/weapon-attachment.md, `--attached`): its binding takes the GPU path with the hand's Coords as the
 *     frame's GetFrame matrix, lit with the pawn as sink and Frame->Mirror 1.0 whatever the frame's. The Island pistol (the armed Terrorist22
 *     and ThugMale3 in view, main frame) and the MJ12 lab's mirror scene (JC's pistol in BehindView: his back in the main frame, his
 *     reflection in the pane's child frame) are compared like any actor (pose, camera-space pose, LOD, colours, the drawn test), the
 *     child frame's lighting run with the slot's Mirror 1.0 under a Mirror -1 run, and the real child frame's own hand and SetupForActor
 *     result (docs/weapon-attachment.md "GPU path").
 * On Island the walk then continues into MeetPaul: the player's mesh is
 * admitted mid-animation when the conversation turns on bBehindView, and
 * every frame after that is compared, so a slot whose first GPU pass a
 * second plan overtakes (the player growing from a point) fails.
 *
 *   node scripts/validate-gpu-mesh.mjs [--url http://127.0.0.1:5173] (default: its own server)
 *     [--maps 00_Training,01_NYC_UNATCOIsland] [--frames 5,30,60,90,120,160,200,250,300,360]
 *     [--device cpu]   (CPU substitutes for the GPU readbacks: JavaScript
 *                       lighting path, CPU positions; checks the harness)
 *     [--attached off]  (skip the pawns' weapon scenes: the Island pistol and the lab mirror scene)
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
import { debugUrl } from './page-url.mjs';

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
const maps=option('maps','00_Training,01_NYC_UNATCOIsland').split(',').filter(name=>name!=='none');
const frames=option('frames','5,30,60,90,120,160,200,250,300,360').split(',').map(Number);
const TOLERANCE={ulp:1,tweenUlp:2,byte:1,edgeOn:2**-20,uv:2**-20};

const hook=`\nwindow.__deusValidation={get npc(){return npcPreview;},get gpu(){return gpuMesh;},
  get lighting(){return meshLighting;},get camera(){return camera;},get game(){return game;},THREE};\n`;

async function capture(page,{frames,device,tolerance,admission,lodViews,attachedOnly=false}) {
  return page.evaluate(async({frames,device,tolerance,admission,lodViews,attachedOnly})=>{
    const {accumulateFaceNormal,faceKept}=await import('/src/runtime/mesh-lighting.mjs');
    // (the binding's faces are mesh-faces.mjs' typed block; the checks below read them as objects, in the reference readers' form)
    const {faceObjects,faceList}=await import('/src/runtime/mesh-faces.mjs');
    const {meshVertexNormalsInto,writeMeshEnvironmentUV}=await import('/src/runtime/mesh-environment.mjs');
    const {certificateStats}=await import('/src/viewer/gpu-mesh-bounds.mjs');
    const certifiedBefore=certificateStats.certified,ambiguousBefore=certificateStats.ambiguous;
    const v=window.__deusValidation,f32=Math.fround,THREE=v.THREE;
    const bits=new DataView(new ArrayBuffer(4));
    const ulp=x=>{bits.setFloat32(0,Math.abs(x),true);const e=(bits.getUint32(0,true)>>>23)&255;return 2**(Math.max(e,1)-150);};
    const report={captures:0,actors:0,vertices:0,components:0,exact:0,maxUlp:0,maxUlpTween:0,worstPosition:null,
      corners:0,maxByte:0,byteHistogram:[0,0,0],worstColor:null,drawnDisagreements:0,maxEdgeOn:0,excludedCorners:0,
      environmentVertices:0,maxNormalUlp:0,maxUV:0,groups:0,certified:0,ambiguous:0,visibilityMismatches:0,
      finalComponents:0,finalExact:0,maxFinalUlp:0,worstFinal:null,cornerWedges:0,wedgeMismatches:0,worstWedge:null,
      camera:{components:0,exact:0,maxUlp:0,worst:null},
      // The frame the lighting's camera matrix is made from (lighting.frame) against the Frame->Coords the LOD selects with.
      coordsGlue:{checked:0,mismatches:0},
      child:{actors:0,corners:0,maxByte:0,drawnDisagreements:0,restoredOff:0,corner:null},
      variant:{actors:0,morph:0,corners:0,maxByte:0,drawnDisagreements:0,restoredOff:0,corner:null,components:0,maxUlp:0,worst:null,wedges:0,wedgeMismatches:0,dropped:0},
      coverage:{translucent:0,modulated:0,masked:0,environment:0,unlit:0,mixedUnlit:0,blend:0,tween:0,movingLights:0,lod:0,lodMorph:0,lodReduced:0},
      // the pawns' third-person weapons: bindings compared in the main frame, and in a real child frame (their own hand and SetupForActor result)
      attached:{compared:0,lit:0,childFrames:0,childCorners:0,childMaxByte:0,childDrawnDisagreements:0,childCamera:{components:0,exact:0,maxUlp:0,worst:null}},
      fallbacks:{},errors:[]};
    const frustum=new THREE.Frustum(),matrix=new THREE.Matrix4();
    let focus=null;
    // The GPU camera-space final pose (`gpuRead`, null on the CPU harness)
    // against the CPU twin's, in the published vertices; the alphas too.
    function compareCamera(stats,gpuRead,cpuPoints,published,actorName){
      for(let i=0;i<published;i++)for(let k=0;k<3;k++){
        const c=cpuPoints[i*3+k],g=gpuRead?gpuRead[i*4+k]:c;
        stats.components++;
        if(Object.is(c,g)||c===g){stats.exact++;continue;}
        const error=Math.abs(g-c)/ulp(c);
        stats.maxUlp=Math.max(stats.maxUlp,error);
        if(!stats.worst||error>stats.worst.ulp)stats.worst={actor:actorName,vertex:i,axis:k,cpu:c,gpu:g,ulp:error};
      }
    }
    function compare(){
      const {npc,gpu,lighting,camera}=v;
      if(!npc||!gpu)throw new Error('GPU mesh path is not active');
      report.captures++;
      frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse),
        THREE.WebGLCoordinateSystem,camera.reversedDepth);
      const cameraPosition=[-camera.position.z,camera.position.x,camera.position.y];
      for(const actor of attachedOnly?(npc.weaponBindings??[]):[...npc.actors,...(npc.weaponBindings??[])]){
        const attached=Boolean(actor.attached);
        if(actor.path!=='gpu'){const key=actor.summary.gpuFallback??'cpu';report.fallbacks[key]=(report.fallbacks[key]??0)+1;continue;}
        if(!actor.root.visible)continue;
        const state=actor.gpuState();const exactBefore=state.exactValid;
        // An actor admitted after this frame's GPU run is posed and updated
        // by the next frame before it is drawn; nothing of it is drawn yet.
        if(!state.handle||!state.plan||state.plannedFrame>gpu.frame||!state.updated){report.pending=(report.pending??0)+1;continue;}
        report.actors++;if(attached)report.attached.compared++;
        const {handle,plan,faceWords,groups}=state,faces=faceObjects(state.faces),V=handle.mesh.V,F=handle.mesh.F;
        const tween=plan.channels.some(op=>op.tween&&op.alpha>0);
        if(focus&&actor.actor===focus){report.admission.captures++;if(tween)report.admission.tweenCaptures++;}
        // Visibility first: the exact spheres come from the CPU shadow.
        const output=state.exactOutput(),cpu=new Float32Array(output.buffer,output.byteOffset,V*3);
        // The CPU LOD on the exact output: drawn positions, resolved corners
        // and the lighting's reduced faces (null at full detail).
        const lod=state.lodDrawn(),drawnPoints=lod?Float32Array.from(lod.positions):cpu;
        const litFaces=lod?faceList(lod.lighting.faceWords):faces,litWords=lod?lod.lighting.faceWords:faceWords;
        if(lod){report.coverage.lod++;if(lod.state.morph)report.coverage.lodMorph++;if(lod.resolved?.some(v=>v<0))report.coverage.lodReduced++;
          const key=actor.summary.actor;report.lodActors??={};
          report.lodActors[key]={count:lod.state.count,start:lod.state.start,morph:lod.state.morph,
            dropped:lod.resolved?lod.resolved.filter((v,i)=>i%3===0&&v<0).length:0,faces:F};}
        for(const group of groups.values()){
          report.groups++;
          const exact=!group.lodEmpty&&frustum.intersectsSphere(group.exact.boundingSphere);
          // (a pawn's weapon draws whole from the hand's Coords: its world-space bounds are not where it is drawn)
          if(!attached&&exact!==group.mainVisible){report.visibilityMismatches++;(report.badVisibility??=[]).push({capture:report.captures,
            actor:actor.summary.actor,exact,main:group.mainVisible,box:[...group.viewBox].map(x=>+x.toFixed(2)),
            sphere:[...group.exact.boundingSphere.center.toArray().map(x=>+x.toFixed(2)),+group.exact.boundingSphere.radius.toFixed(2)]});}
        }
        // Positions: the vertices this frame's GetFrame published (the main
        // channel's count, which no blend slot exceeds; with the LOD a lower
        // count leaves the rest as they were, unspecified in the original
        // and never drawn or read).
        const published=plan.channels.find(op=>op.channel<0)?.count??V;
        report.unpublished=(report.unpublished??0)+(V-published);
        const gpuPose=device==='cpu'?null:gpu.read('pose',handle.vbase,V);
        for(let i=0;i<published;i++)for(let k=0;k<3;k++){
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
        // The final pose (the morph pass) and the resolved corner dwords.
        const gpuFinal=device==='cpu'?null:gpu.read('final',handle.vbase,V);
        for(let i=0;i<published;i++)for(let k=0;k<3;k++){
          const c=drawnPoints[i*3+k],g=device==='cpu'?c:gpuFinal[i*4+k];
          report.finalComponents++;
          if(Object.is(c,g)||c===g){report.finalExact++;continue;}
          const error=Math.abs(g-c)/ulp(c);
          report.maxFinalUlp=Math.max(report.maxFinalUlp,error);
          if(!report.worstFinal||error>report.worstFinal.ulp)report.worstFinal={actor:actor.summary.actor,vertex:i,axis:k,cpu:c,gpu:g,ulp:error,lod:Boolean(lod)};
        }
        const gpuWedges=device==='cpu'?null:gpu.read('cornerWedges',handle.cbase,F*3);
        for(let face=0;face<F;face++)for(let k=0;k<3;k++){
          const wedge=faces[face].wedges[k];
          const expected=(lod?.resolved?(lod.resolved[face*3]<0?0xffffffff:lod.scratch[wedge]):state.wedges[wedge])>>>0;
          const got=device==='cpu'?expected:gpuWedges[face*3+k]>>>0;
          report.cornerWedges++;
          if(got!==expected){report.wedgeMismatches++;
            report.worstWedge??={actor:actor.summary.actor,face,corner:k,expected:expected.toString(16),got:got.toString(16),lod:lod?.state??null};}
        }
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
          const indices=Uint32Array.from(faces.flatMap((face,i)=>!lod?.resolved?face.vertices
            :lod.resolved[i*3]>=0?[lod.resolved[i*3],lod.resolved[i*3+1],lod.resolved[i*3+2]]:[]));
          const normals=new Float32Array(V*3);
          meshVertexNormalsInto(drawnPoints,indices,normals);
          const gpuNormals=device==='cpu'?null:gpu.read('environment',handle.vbase,V);
          const uvs=device==='cpu'?null:gpu.environmentUVs(handle,cameraPosition);
          const uv=[0,0],relative=[0,0,0],normal=[0,0,0];
          for(let i=0;i<published;i++){
            for(let k=0;k<3;k++){
              const c=normals[i*3+k],g=device==='cpu'?c:gpuNormals[i*4+k];
              if(c!==g)report.maxNormalUlp=Math.max(report.maxNormalUlp,Math.abs(g-c)/ulp(c));
              relative[k]=f32(drawnPoints[i*3+k]-cameraPosition[k]);normal[k]=c;
            }
            writeMeshEnvironmentUV(uv,0,relative,normal);
            for(let k=0;k<2;k++){const g=device==='cpu'?uv[k]:uvs[i*4+k];report.maxUV=Math.max(report.maxUV,Math.abs(g-uv[k]));}
            report.environmentVertices++;
          }
        }
        // Colours: only actors relit in the frame just run.
        if(state.litFrame!==gpu.frame||!state.setup||!lighting?.frame)continue;
        if(attached)report.attached.lit++;
        const {setup,flags:actorFlags,unlit}=state.setup;
        if(setup.lights.some(light=>!light.light.values?.bStatic))report.coverage.movingLights++;
        const frame=lighting.frame;
        // The camera-space buffer of this frame (GetFrame called with its
        // Coords, then the morph): the CPU twin of the camera passes.
        const cameraState=state.cameraDrawn(null),cameraSpace=cameraState.positions;
        {
          const lodCoords=actor.lodState()?.frame?.coords;
          if(lodCoords){
            const want=[...frame.origin,...frame.axes[0],...frame.axes[1],...frame.axes[2]];
            report.coordsGlue.checked++;
            if(want.some((value,i)=>!Object.is(value,lodCoords[i])))report.coordsGlue.mismatches++;
          }
        }
        compareCamera(report.camera,device==='cpu'?null:gpu.read('cameraFinal',handle.vbase,V),cameraSpace,published,actor.summary.actor);
        const reference=npc.kernel.light({points:cameraSpace,faces:litWords,origin:frame.origin,axes:frame.axes,
          ambient:setup.ambient,scaleGlow:setup.scaleGlow,unlit,lights:setup.lights,flags:actorFlags,cameraSpace:true});
        let deviceColors;
        if(device==='cpu'){
          const kernel=lighting.kernel;lighting.kernel=null;
          try{deviceColors=lighting.lightMesh(actor.actor,Float32Array.from(cameraSpace),litFaces,litWords,state.setup,null,true).colors;}
          finally{lighting.kernel=kernel;}
        } else deviceColors=gpu.read('corners',handle.cbase,F*3);
        // The CPU's drawn test (kernel face loop, JavaScript form).
        const cameraPoints=Array.from({length:V},(_,i)=>[cameraSpace[i*3],cameraSpace[i*3+1],cameraSpace[i*3+2]]);
        const accumulated=cameraPoints.map(()=>[0,0,0]),drawn=new Uint8Array(F);
        const gpuFaces=device==='cpu'?null:gpu.read('faces',handle.fbase,F);
        const excludedVertices=new Set();
        for(let face=0;face<F;face++){
          const [a,b,c]=litFaces[face].vertices,p0=cameraPoints[a];
          const unit=accumulateFaceNormal(p0,cameraPoints[b],cameraPoints[c],accumulated[a],accumulated[b],accumulated[c]);
          const dot=unit[0]*p0[0]+unit[1]*p0[1]+unit[2]*p0[2];
          drawn[face]=!(litFaces[face].flags&1)&&(litFaces[face].flags&0x100||dot<0)?1:0;
          if(device==='cpu')continue;
          const gpuDrawn=gpuFaces[face*4+3]>0.5?1:0;
          if(gpuDrawn!==drawn[face]){
            const relative=Math.abs(dot)/Math.hypot(...p0);
            report.drawnDisagreements++;report.maxEdgeOn=Math.max(report.maxEdgeOn,relative);
            for(const vertex of litFaces[face].vertices)excludedVertices.add(vertex);
          }
        }
        for(let face=0;face<F;face++){
          if(!drawn[face])continue;
          for(let k=0;k<3;k++){
            if(excludedVertices.has(litFaces[face].vertices[k])){report.excludedCorners++;continue;}
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
        // The same actor lit in a mirror's child frame: Coords reflected across
        // a plane (all three axes, so the determinant is negative) and
        // Frame.Mirror -1, lit again with the same SetupForActor result
        // through the page's lighting run (docs/mesh-lighting.md "One call per
        // frame"). The kernel `light` with that camera and Mirror is the
        // reference; the main lighting is then restored and must match.
        if(device!=='cpu'){
          const mainCamera={origin:frame.origin,axes:frame.axes};
          const plane=[0.6,0.8,0,0.6*frame.origin[0]+0.8*frame.origin[1]+120];
          const reflectPoint=p=>{const d=2*(plane[0]*p[0]+plane[1]*p[1]+plane[2]*p[2]-plane[3]);return p.map((c,i)=>f32(c-d*plane[i]));};
          const reflectVector=p=>{const d=2*(plane[0]*p[0]+plane[1]*p[1]+plane[2]*p[2]);return p.map((c,i)=>f32(c-d*plane[i]));};
          const child={origin:reflectPoint(mainCamera.origin),axes:mainCamera.axes.map(reflectVector),mirror:-1};
          // (a pawn's weapon carries Mirror 1.0 in its slot: DrawActorSprite forces it, 0x10b2571a, whatever the frame's)
          const childMirror=attached?1:-1;
          const plain={flags:actorFlags,ambient:[...setup.ambient],scaleGlow:setup.scaleGlow,unlit:[...unlit],
            lights:setup.lights.map(light=>({location:[...light.location],rradius:light.rradius,color:[...light.color]})),...(attached?{mirror:1}:{})};
          // Each frame's lighting carries its GetFrame matrix (the camera passes).
          const plainChild={...plain,camera:state.cameraMatrix(child).flat()},plainMain={...plain,camera:state.cameraMatrix(null).flat()};
          // Compares one lighting run's corner bytes and drawn faces with the
          // kernel `light` on the given points and reduced faces, in `camera`
          // with Frame.Mirror `mirror`.
          const checkLit=(stats,{points,facesList,words,camera,mirror,colors,faceTexels})=>{
            // `points`: the frame's camera-space buffer (GetFrame with its Coords, then the morph).
            const reference=npc.kernel.light({points,faces:words,origin:camera.origin,axes:camera.axes,mirror,
              ambient:setup.ambient,scaleGlow:setup.scaleGlow,unlit,lights:setup.lights,flags:actorFlags,cameraSpace:true});
            compareCamera(stats.camera??={components:0,exact:0,maxUlp:0,worst:null},gpu.read('cameraFinal',handle.vbase,V),points,published,actor.summary.actor);
            const cameraPoints=Array.from({length:V},(_,i)=>[points[i*3],points[i*3+1],points[i*3+2]]);
            const sums=cameraPoints.map(()=>[0,0,0]),keep=new Uint8Array(F),excluded=new Set();
            for(let face=0;face<F;face++){
              const [a,b,c]=facesList[face].vertices,p0=cameraPoints[a];
              const unit=accumulateFaceNormal(p0,cameraPoints[b],cameraPoints[c],sums[a],sums[b],sums[c]);
              keep[face]=faceKept(unit,p0,mirror,facesList[face].flags)?1:0;
              const dot=unit[0]*p0[0]+unit[1]*p0[1]+unit[2]*p0[2];
              if((faceTexels[face*4+3]>0.5?1:0)!==keep[face]){
                stats.drawnDisagreements++;
                if((stats.notes??=[]).length<6)stats.notes.push({actor:actor.summary.actor,face,vertices:facesList[face].vertices,flags:facesList[face].flags,
                  gpu:faceTexels[face*4+3],keep:keep[face],dotRel:Math.abs(dot)/Math.hypot(...p0),unit,p0,label:stats.label});
                report.maxEdgeOn=Math.max(report.maxEdgeOn,Math.abs(dot)/Math.hypot(...p0));
                for(const vertex of facesList[face].vertices)excluded.add(vertex);
              }
            }
            stats.actors++;
            for(let face=0;face<F;face++){
              if(!keep[face])continue;
              for(let k=0;k<3;k++){
                if(excluded.has(facesList[face].vertices[k]))continue;
                stats.corners++;
                for(let channel=0;channel<3;channel++){
                  const expected=Math.round(reference[face*9+k*3+channel]*255),got=colors[(face*3+k)*4+channel];
                  const error=Math.abs(got-expected);
                  if(error>stats.maxByte){stats.maxByte=error;
                    stats.corner={actor:actor.summary.actor,face,corner:k,channel,expected,got};}
                }
              }
            }
          };
          gpu.beginLightRun();
          if(!gpu.setLighting(handle,plainChild))throw new Error('child frame lighting did not fit');
          gpu.lightRun(child);
          checkLit(report.child,{points:state.cameraDrawn(child).positions,facesList:litFaces,words:litWords,camera:child,mirror:childMirror,
            colors:gpu.read('corners',handle.cbase,F*3),faceTexels:gpu.read('faces',handle.fbase,F)});
          // The page puts the main lighting back after the pass.
          const restoreMain=()=>{gpu.beginLightRun();gpu.setLighting(handle,plainMain);gpu.lightRun(mainCamera);};
          restoreMain();
          const restored=gpu.read('corners',handle.cbase,F*3);
          for(let i=0;i<F*3*4;i+=4)for(let channel=0;channel<3;channel++)
            if(restored[i+channel]!==deviceColors[i+channel]&&drawn[Math.floor(i/12)])report.child.restoredOff++;
          // The same actor with a child frame's own DrawLodMesh state
          // (docs/script-lodmesh-lod.md "Child frames"): a reduced count with
          // and without a morph, run through the page's lighting run (setLod
          // redoes the morph, the corners and the lighting for the slot), then
          // the main state again. The CPU LOD of the same selection over the
          // exact output is the reference for the final pose, the corner
          // dwords and the corner colours.
          const topology=state.lodTopology();
          const mainParams=state.mainLodParams();
          if(topology&&mainParams&&published-topology.special>=8){
            // The ordinary vertices GetFrame published (its count includes the special ones).
            const N=topology.modelVerts,ordinary=published-topology.special;
            for(const spec of [{count:Math.min(ordinary,Math.floor(N*0.6)),morph:true},{count:Math.min(ordinary,Math.floor(N*0.35)),morph:false},
              {count:Math.min(ordinary,Math.floor(N*0.9)),morph:true}]){
              if(spec.morph&&!(topology.lodMorph>0))continue;
              if(spec.count<2||spec.count>=N)continue;
              const selection={active:true,morph:spec.morph,detail:f32(spec.count),requested:spec.count};
              const variant=state.lodVariant(selection,spec.count);
              if(!variant.params.active)continue;
              gpu.beginLightRun();
              gpu.setLod(handle,variant.params);
              if(!gpu.setLighting(handle,plainChild))throw new Error('child frame lighting did not fit');
              gpu.lightRun(child);
              const vFinal=gpu.read('final',handle.vbase,V),vWedges=gpu.read('cornerWedges',handle.cbase,F*3);
              report.variant.actors++;if(spec.morph)report.variant.morph++;
              // The final pose of every published vertex, and the corner dwords.
              for(let i=0;i<published;i++)for(let k=0;k<3;k++){
                const c=variant.drawn.positions[i*3+k],g=vFinal[i*4+k];
                report.variant.components++;
                if(!(Object.is(c,g)||c===g)){const error=Math.abs(g-c)/ulp(c);report.variant.maxUlp=Math.max(report.variant.maxUlp,error);
                  if(error>tolerance.tweenUlp&&!report.variant.worst)report.variant.worst={actor:actor.summary.actor,i,k,c,g,count:spec.count,morph:spec.morph,state:variant.drawn.state,cpu:Array.from(variant.drawn.positions.slice(0,9)),main:Array.from(cpu.slice(0,9)),gpuFinal:Array.from(vFinal.slice(0,8)),published};}
              }
              const dropped=variant.drawn.resolved.filter((v,i)=>i%3===0&&v<0).length;report.variant.dropped+=dropped;
              for(let face=0;face<F;face++)for(let k=0;k<3;k++){
                const expected=(variant.drawn.resolved[face*3]<0?0xffffffff:variant.drawn.scratch[faces[face].wedges[k]])>>>0;
                report.variant.wedges++;
                if((vWedges[face*3+k]>>>0)!==expected)report.variant.wedgeMismatches++;
              }
              report.variant.label={count:spec.count,morph:spec.morph,start:variant.params.start};
              const variantCamera=state.cameraDrawn(child,selection,spec.count);
              checkLit(report.variant,{points:variantCamera.positions,facesList:faceList(variant.drawn.lighting.faceWords),words:variant.drawn.lighting.faceWords,
                camera:child,mirror:childMirror,colors:gpu.read('corners',handle.cbase,F*3),faceTexels:gpu.read('faces',handle.fbase,F)});
              // The main frame's pass: its LOD state and lighting again.
              gpu.beginLightRun();gpu.setLod(handle,mainParams);gpu.setLighting(handle,plainMain);gpu.lightRun(mainCamera);
              const backFinal=gpu.read('final',handle.vbase,V),backWedges=gpu.read('cornerWedges',handle.cbase,F*3),backColors=gpu.read('corners',handle.cbase,F*3);
              for(let i=0;i<published;i++)for(let k=0;k<3;k++)if(!Object.is(backFinal[i*4+k],gpuFinal[i*4+k]))report.variant.restoredOff++;
              for(let i=0;i<F*3;i++)if((backWedges[i]>>>0)!==(gpuWedges[i]>>>0))report.variant.restoredOff++;
              for(let i=0;i<F*3*4;i+=4)for(let channel=0;channel<3;channel++)
                if(backColors[i+channel]!==deviceColors[i+channel]&&drawn[Math.floor(i/12)])report.variant.restoredOff++;
            }
          }
        }
      }
      // A pawn's weapon in the child frames of the frame just run (a mirror's): the frame's own hand (the weapon's Coords there) and
      // SetupForActor result, lit through the page's lighting run in a Mirror -1 frame, against the CPU twin and the kernel `light` with the
      // Mirror 1.0 the weapon forces. Done after the main-frame comparisons: it leaves the slot lit with the child's.
      if(device!=='cpu')for(const actor of npc.weaponBindings??[]){
        if(actor.path!=='gpu'||!actor.root.visible)continue;
        const state=actor.gpuState();
        if(!state.handle||!state.plan||state.plannedFrame>gpu.frame||!state.updated||!state.frameSetups.size)continue;
        const {handle,faceWords}=state,faces=faceObjects(state.faces),V=handle.mesh.V,F=handle.mesh.F,stats=report.attached;
        const published=state.plan.channels.find(op=>op.channel<0)?.count??V;
        state.exactOutput();
        const lod=state.lodDrawn(),litFaces=lod?faceList(lod.lighting.faceWords):faces,litWords=lod?lod.lighting.faceWords:faceWords;
        for(const [index,prepared] of state.frameSetups){
          const {setup,flags,unlit}=prepared,camera=state.cameraMatrix(null,index);
          const plain={flags,ambient:[...setup.ambient],scaleGlow:setup.scaleGlow,unlit:[...unlit],camera:camera.flat(),mirror:1,
            lights:setup.lights.map(light=>({location:[...light.location],rradius:light.rradius,color:[...light.color]}))};
          gpu.beginLightRun();
          if(!gpu.setLighting(handle,plain))throw new Error('attached child frame lighting did not fit');
          // the run is a mirror's (Mirror -1); the slot's own Mirror 1.0 is what the weapon is lit with
          gpu.lightRun({origin:[0,0,0],axes:[[1,0,0],[0,1,0],[0,0,1]],mirror:-1});
          const points=state.cameraDrawn(null,undefined,undefined,index).positions;
          compareCamera(stats.childCamera,gpu.read('cameraFinal',handle.vbase,V),points,published,actor.summary.actor);
          const reference=npc.kernel.light({points,faces:litWords,origin:[0,0,0],axes:[[1,0,0],[0,1,0],[0,0,1]],mirror:1,
            ambient:setup.ambient,scaleGlow:setup.scaleGlow,unlit,lights:setup.lights,flags,cameraSpace:true});
          const colors=gpu.read('corners',handle.cbase,F*3),faceTexels=gpu.read('faces',handle.fbase,F);
          const cameraPoints=Array.from({length:V},(_,i)=>[points[i*3],points[i*3+1],points[i*3+2]]);
          const sums=cameraPoints.map(()=>[0,0,0]),keep=new Uint8Array(F),excluded=new Set();
          for(let face=0;face<F;face++){
            const [a,b,c]=litFaces[face].vertices,p0=cameraPoints[a];
            const unit=accumulateFaceNormal(p0,cameraPoints[b],cameraPoints[c],sums[a],sums[b],sums[c]);
            keep[face]=faceKept(unit,p0,1,litFaces[face].flags)?1:0;
            if((faceTexels[face*4+3]>0.5?1:0)!==keep[face]){
              stats.childDrawnDisagreements++;
              const dot=unit[0]*p0[0]+unit[1]*p0[1]+unit[2]*p0[2];
              report.maxEdgeOn=Math.max(report.maxEdgeOn,Math.abs(dot)/Math.hypot(...p0));
              for(const vertex of litFaces[face].vertices)excluded.add(vertex);
            }
          }
          stats.childFrames++;
          for(let face=0;face<F;face++){
            if(!keep[face])continue;
            for(let k=0;k<3;k++){
              if(excluded.has(litFaces[face].vertices[k]))continue;
              stats.childCorners++;
              for(let channel=0;channel<3;channel++)
                stats.childMaxByte=Math.max(stats.childMaxByte,Math.abs(colors[(face*3+k)*4+channel]-Math.round(reference[face*9+k*3+channel]*255)));
            }
          }
        }
      }
    }
    if(lodViews){
      // The distance LOD: look at the farthest actor meshes (beyond 1,500
      // units) in turn and compare a few frames each, so actors the LOD
      // reduces, morphs and empties are compared.
      const game=v.game,runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor;
      const eye=game.view().location,units=r=>Math.round(r*32768/Math.PI);
      // The walk resumes from here afterwards.
      const home=[...runtime.readNamed(player,'Location')],homeRotation=[...runtime.readNamed(player,'ViewRotation')];
      const far=v.npc.actors.map(actor=>{let at=null;try{at=actor.location;}catch{}return {actor,at};})
        .filter(entry=>entry.at).map(entry=>({...entry,distance:Math.hypot(...entry.at.map((x,i)=>x-eye[i]))}))
        .filter(entry=>entry.distance>1500).sort((a,b)=>b.distance-a.distance);
      const picks=[];
      for(let k=0;k<lodViews&&far.length;k++)picks.push(far[Math.floor(k*far.length/lodViews)]);
      report.lodViews=picks.length;
      // Half the views with URender's MLOD at 2 (8 times the shipped 0.25):
      // the counts drop far enough to drop faces and empty groups.
      const settings=[null,{shapeLOD:2}];
      for(const [n,{at}] of picks.entries()){
        if(settings[n%2])v.npc.setLodSettings(settings[n%2]);else v.npc.resetLodSettings();
        const now=game.view().location,d=at.map((x,i)=>x-now[i]);
        runtime.writeNamed(player,'ViewRotation',[(units(Math.atan2(d[2],Math.hypot(d[0],d[1])))+65536)%65536,
          (units(Math.atan2(d[1],d[0]))+65536)%65536,0]);
        for(let frame=0;frame<24;frame++){
          await new Promise(requestAnimationFrame);
          const error=window.deusExViewer.framePhases(false).runtimeError;
          if(error)throw new Error(`runtime error: ${error}`);
          if(frame>=20){try{compare();}catch(error){report.errors.push(error.stack??String(error));}}
        }
      }
      v.npc.resetLodSettings();
      runtime.farMoveActor(player,home,0,1);runtime.writeNamed(player,'ViewRotation',homeRotation);
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
        // At least `frames` compared frames, then on until one of them compares the player mid-tween (when the conversation's
        // animation change lands depends on the scene's timing: NPC collision moves it).
        if(focus&&frame-report.admission.admittedFrame>=admission.frames&&report.admission.tweenCaptures>0)break;
      }
    }
    // Decisions Play made during the captured run (not the checks above).
    report.certified=certificateStats.certified-certifiedBefore;report.ambiguous=certificateStats.ambiguous-ambiguousBefore;
    return report;
  },{frames,device,tolerance,admission,lodViews,attachedOnly});
}

// The pawns' third-person weapons on the GPU path (docs/weapon-attachment.md "GPU path"): scenes that put an armed pawn in view, each the
// console commands of the scene's other validators, typed live (`call`: viewProbe's arguments, then `frames` display frames).
const cheat=Array.from({length:12},()=>'CheatView DeusEx.Terrorist');
const ATTACHED_SCENES=[
  {name:'Island pistol (main frame)',map:'01_NYC_UNATCOIsland',main:true,child:false,steps:[
    {call:{exec:[...cheat,'set DeusEx.JCDentonMale ViewRotation (Pitch=-500,Yaw=46936,Roll=0)']}},{call:{playersOnly:false},frames:150}]},
  {name:'lab mirror (JC in BehindView: main frame and reflection)',map:'05_NYC_UNATCOMJ12lab',main:true,child:true,steps:[
    {call:{location:[-3086.76978,1400.20129,-155.809525],region:{zone:'LevelInfo0',iLeaf:3650,zoneNumber:7}}},{call:{playersOnly:false},frames:60},
    {call:{exec:['summon DeusEx.WeaponPistol']},frames:60},{call:{rotation:[-10130,16432,0]},frames:60},{call:{exec:['ParseRightClick']},frames:120},
    {call:{exec:['ActivateBelt 1']},frames:120},{call:{exec:['BehindView 1']}},{call:{rotation:[-400,62536,0]},frames:120}]},
];
const attachedFrames=[2,5,8,11,14,17,20,23,26,29];
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
    await page.goto(debugUrl(`${url}/?gpuMesh=1&sim=inline`));
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
    const report=await capture(page,{frames,device,tolerance:TOLERANCE,admission,
      lodViews:map==='01_NYC_UNATCOIsland'?Number(option('lod-views',16)):0});
    await page.keyboard.up('KeyW');
    report.pageErrors=errors;
    const checks=[
      ['position ulp (keyframe/blend)',report.maxUlp<=TOLERANCE.ulp],
      ['position ulp (tween)',report.maxUlpTween<=TOLERANCE.tweenUlp],
      ['camera-space final pose ulp (main frame)',report.camera.maxUlp<=TOLERANCE.tweenUlp],
      ['camera-space final pose ulp (child frame)',(report.child.camera?.maxUlp??0)<=TOLERANCE.tweenUlp],
      ['camera-space final pose ulp (child LOD state)',(report.variant.camera?.maxUlp??0)<=TOLERANCE.tweenUlp],
      ['camera-space compared',device==='cpu'||(report.camera.components>0&&(report.child.camera?.components??0)>0)],
      ['lighting frame Coords equal the LOD frame Coords',report.coordsGlue.mismatches===0&&report.coordsGlue.checked>0],
      ['colour bytes',report.maxByte<=TOLERANCE.byte],
      ['edge-on drawn disagreements',report.maxEdgeOn<TOLERANCE.edgeOn],
      ['child frame colour bytes (reflected Coords, Mirror -1)',report.child.maxByte<=TOLERANCE.byte],
      ['child frame lighting restored',report.child.restoredOff===0],
      ['child LOD state: final pose ulp',report.variant.maxUlp<=TOLERANCE.tweenUlp],
      ['child LOD state: corner dwords',report.variant.wedgeMismatches===0],
      ['child LOD state: colour bytes',report.variant.maxByte<=TOLERANCE.byte],
      ['child LOD state: restored',report.variant.restoredOff===0],
      ['child LOD state: compared actors',device==='cpu'||report.variant.actors>0&&report.variant.corners>0],
      ['child frame compared actors',device==='cpu'||report.child.actors>0&&report.child.corners>0],
      ['environment UV',report.maxUV<=TOLERANCE.uv],
      ['visibility',report.visibilityMismatches===0],
      ['final pose ulp (morph pass)',report.maxFinalUlp<=TOLERANCE.tweenUlp],
      ['resolved corner dwords',report.wedgeMismatches===0],
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
if(option('attached','on')!=='off')try {
  const attachedBrowser=await chromium.launch({args:[`--use-angle=${angle}`]});
  try {
    for(const scene of ATTACHED_SCENES){
      const page=await attachedBrowser.newPage({viewport:{width:1440,height:960}});
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/,async route=>{
        const response=await route.fetch();
        await route.fulfill({response,body:(await response.text())+hook});
      });
      await page.goto(debugUrl(`${url}/?gpuMesh=1&sim=inline&antialias=0`));
      await page.waitForFunction(()=>window.deusExViewer?.status().ready,{}, {timeout:240000});
      await page.locator('#map').selectOption(scene.map);
      await page.waitForFunction(map=>{const s=window.deusExViewer?.status();return s?.ready&&s.map===map;},scene.map,{timeout:240000});
      await page.waitForFunction(()=>{const s=window.deusExViewer?.status();
        return s?.runtimeError||s?.gameplay?.hud?.health?.head?.displayedHealth===100;},{}, {timeout:240000});
      await page.locator('#scene').click({position:{x:600,y:350}});
      await page.waitForTimeout(1500);
      await page.evaluate(async steps=>{
        for(const step of steps){
          if(step.call)await window.deusExViewer.viewProbe(step.call);
          for(let i=0;i<(step.frames??0);i++)await new Promise(requestAnimationFrame);
        }
      },scene.steps);
      const report=await capture(page,{frames:attachedFrames,device,tolerance:TOLERANCE,admission:null,lodViews:0,attachedOnly:true});
      report.pageErrors=errors;
      const a=report.attached;
      const checks=[
        ['attached: bindings compared on the GPU path',a.compared>0],
        ['attached: position ulp',report.maxUlp<=TOLERANCE.ulp&&report.maxUlpTween<=TOLERANCE.tweenUlp],
        ['attached: camera-space final pose ulp (main frame)',report.camera.maxUlp<=TOLERANCE.tweenUlp],
        ['attached: final pose ulp (morph pass)',report.maxFinalUlp<=TOLERANCE.tweenUlp],
        ['attached: resolved corner dwords',report.wedgeMismatches===0],
        ...(scene.main?[['attached: lit and compared in the main frame',a.lit>0&&report.corners>0],
          ['attached: colour bytes (main frame)',report.maxByte<=TOLERANCE.byte]]:[]),
        ['attached: edge-on drawn disagreements',report.maxEdgeOn<TOLERANCE.edgeOn],
        ['attached: Mirror 1.0 slot lane under a Mirror -1 run (colour bytes)',report.child.maxByte<=TOLERANCE.byte],
        ['attached: Mirror 1.0 slot lane under a Mirror -1 run (compared)',device==='cpu'||(report.child.actors>0&&report.child.corners>0)],
        ['attached: child frame lighting restored',report.child.restoredOff===0],
        ...(scene.child?[['attached: real child frame compared',device==='cpu'||(a.childFrames>0&&a.childCorners>0)],
          ['attached: real child frame colour bytes',a.childMaxByte<=TOLERANCE.byte],
          ['attached: real child frame camera-space pose ulp',a.childCamera.maxUlp<=TOLERANCE.tweenUlp],
          ['attached: real child frame drawn disagreements',a.childDrawnDisagreements===0||report.maxEdgeOn<TOLERANCE.edgeOn]]:[]),
        ['attached: no errors',!report.errors.length&&!errors.length],
      ];
      const failures=checks.filter(([,ok])=>!ok).map(([name])=>name);
      failed||=failures.length>0;
      if(failures.length)failureNotes.push(`${scene.name}: ${failures.join(', ')}${report.errors.length?` (${report.errors[0].split('\n')[0]})`:''}${errors.length?` (page: ${errors[0]})`:''}`);
      console.log(JSON.stringify({scene:scene.name,device,tolerance:TOLERANCE,failures,
        bitExactFraction:+(report.exact/Math.max(1,report.components)).toFixed(6),...report},null,1));
      await page.close();
    }
  } finally {await attachedBrowser.close();}
} catch(error) {failed=true;failureNotes.push(`attached scenes: ${error.stack??error}`);}
} finally {await browser.close();await server?.close();}
// Face flags, animation modes and moving lights must all be exercised by the
// maps compared in this run.
const required=['translucent','modulated','masked','environment','mixedUnlit','blend','tween','movingLights','lod','lodMorph','lodReduced'];
const missing=required.filter(name=>!(coverage[name]>0));
console.log(JSON.stringify({coverage,missing}));
// Coverage is a property of the full run over both maps (Training alone has
// no moving mesh lights or tweens in its captured frames).
const fullRun=['00_Training','01_NYC_UNATCOIsland'].every(map=>maps.includes(map));
if(device==='gpu'&&fullRun&&missing.length)failed=true;
else if(missing.length)console.log(`coverage not required for a partial run: missing ${missing.join(', ')}`);
if(failed){console.error(`validate-gpu-mesh: FAIL\n${failureNotes.join('\n')}`);process.exit(1);}
console.log('validate-gpu-mesh: PASS');
