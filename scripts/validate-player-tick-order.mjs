/** Source-ordered control/camera composition audit, not original Actor.Tick VM execution. */
import assert from'node:assert/strict';import{readFile,readdir,mkdir,writeFile}from'node:fs/promises';import{spawnSync}from'node:child_process';
import{AssetStore}from'../src/unreal/assets.mjs';import{decodeMap}from'../src/unreal/map.mjs';import{createGame}from'../src/viewer/game.mjs';import{runPlayerPhysics}from'../src/runtime/player-physics.mjs';import{walkingInput,healthyWalkingGroundSpeed}from'../src/runtime/player-input.mjs';import{handleWalkingControls,stanceCrouchRequested,afterStanceControls,afterJumpControls}from'../src/runtime/player-controls.mjs';import{gameDirectory}from'./game-directory.mjs';
const root=gameDirectory(),files=[];for(const dir of['System','Textures','Maps'])for(const name of await readdir(`${root}/${dir}`))files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training'),map=decodeMap(asset.bytes),directory='reports/movement/player-tick-order';await mkdir(directory,{recursive:true});
const repeat=(input,count)=>Array.from({length:count},()=>input),sequences=[{name:'forward-backward',inputs:[...repeat({forward:1},3),...repeat({forward:-1},3)]},{name:'jump',inputs:[{jump:true},...repeat({},5)]},{name:'hold-crouch',inputs:[...repeat({crouch:true},3),...repeat({},3)]},{name:'duck-plus-jump',inputs:[{crouch:true,jump:true},...repeat({crouch:true},3)]},{name:'release-duck-in-air',inputs:[{crouch:true},{crouch:true},{crouch:true,jump:true},{},{}]}];
const snapshot=p=>({position:[...p.position],velocity:[...p.velocity],height:p.height,grounded:p.grounded,forceDuck:p.forceDuck,eyeHeight:p.eyeHeight,baseEyeHeight:p.baseEyeHeight,walkBob:[...p.walkBob],bobTime:p.bobTime,bodyRotation:[...p.bodyRotation],viewRotation:[...p.viewRotation],controlCrouching:Boolean(p.controls?.isCrouching),controlWalking:Boolean(p.controls?.isWalking)});
const comparisons=[],cameraCases=[],cameraExpected=[];let mismatches=0;
for(const sequence of sequences){
 const actualGame=await createGame(map,asset,assets),referenceGame=await createGame(map,asset,assets);
 for(const g of[actualGame,referenceGame]){const p=g.player;g.collision.queries.changeActor(p.collisionActor,()=>{p.position=[-1149.2435302734375,825.8439331054688,-80.0999984741211];p.height=43;p.bodyRotation=[0,0,0];p.viewRotation=[0,0,0];p.yaw=0;});p.velocity=[0,0,0];p.grounded=true;p.physicsPawn={base:g.collision.queries.levelInfo,hitSlopedWall:false,moveTimer:0,pawnFlags:0,destination:[0,0,0]};}
 const actual=actualGame.player,reference=referenceGame.player;let controls={isCrouching:false,forceDuck:false},jumpHeld=false;const frames=[];
 const originalEye=actual.updateView.bind(actual);let incoming;
 actual.updateView=(dt,oldZ)=>{const eye={physics:actual.grounded?1:2,justLanded:actual.justLanded,eyeHeight:actual.eyeHeight,baseEyeHeight:actual.baseEyeHeight,locationZ:actual.position[2],oldLocationZ:oldZ,timeDilation:actual.timeDilation??1,shakeVert:actual.shakeVert,joltMagnitude:actual.joltMagnitude,bob:actual.bobState.Bob};cameraCases.push({rotation:incoming.rotation,velocity:incoming.velocity,walkBob:incoming.walkBob,dt,eye});originalEye(dt,oldZ);cameraExpected.push({eyeHeight:actual.eyeHeight,justLanded:actual.justLanded,joltMagnitude:actual.joltMagnitude});};
 for(const [index,input]of sequence.inputs.entries()){
  const dt=Math.fround(1/120);incoming={rotation:[...actual.bodyRotation],velocity:[...actual.velocity],walkBob:[...actual.walkBob]};actual.tick(dt,input);
  // Original PlayerInput.HandleWalking precedes PlayerMove bob/rotation. The
  // explicit ProcessMove phases retain prior crouching through resize and jump.
  controls=handleWalkingControls(controls,{duck:input.crouch,run:input.walk},{alwaysRun:true,toggleCrouch:false});
  reference.controls=controls;reference.updateBob(dt);const rotation=[...reference.bodyRotation];
  reference.crouchInput=controls.isCrouching;reference.stance(stanceCrouchRequested(controls));controls=afterStanceControls(controls,reference.forceDuck);reference.controls=controls;
  const forward=input.forward??0,right=input.right??0,groundSpeed=healthyWalkingGroundSpeed(reference.defaults.GroundSpeed,forward);reference.bobState.GroundSpeed=groundSpeed;
  if(input.jump&&!jumpHeld&&reference.grounded&&!controls.forceDuck){reference.velocity[2]=reference.defaults.JumpZ;reference.grounded=false;}
  jumpHeld=Boolean(input.jump);controls=afterJumpControls(controls,reference.grounded?1:2).state;reference.controls=controls;reference.crouchInput=controls.isCrouching;
  const {newAccel}=walkingInput({rotation,aForward:forward*6000,aStrafe:right*6000});const oldZ=runPlayerPhysics(reference,dt,{acceleration:newAccel,groundSpeed,isWalking:controls.isWalking,zone:reference.zoneAt(reference.position)});reference.updateView(dt,oldZ);
  const a=snapshot(actual),b=snapshot(reference);let mismatch=false;try{assert.deepEqual(a,b);}catch{mismatch=true;}
  frames.push({index,mismatch,actual:a,expected:b});
 }
 const first=frames.find(f=>f.mismatch);if(first)mismatches++;comparisons.push({name:sequence.name,frames,firstMismatch:first?.index??null});
}
await writeFile(`${directory}/camera-cases.json`,JSON.stringify(cameraCases));
if(!process.argv.includes('--reuse')){const r=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-camera-oracle.py',root,`${directory}/camera-cases.json`],{encoding:'utf8',maxBuffer:8e6});if(r.status!==0)throw Error(r.stderr);await writeFile(`${directory}/camera-original.json`,r.stdout);}
const camera=JSON.parse(await readFile(`${directory}/camera-original.json`,'utf8')),cameraMismatches=[];
for(let i=0;i<cameraExpected.length;i++)try{assert.deepEqual(cameraExpected[i],camera.results[i].eye);}catch{cameraMismatches.push({i,actual:cameraExpected[i],expected:camera.results[i].eye});}
await writeFile(`${directory}/comparison.json`,JSON.stringify({kind:'source-ordered shell plus original native camera expressions',comparisons,cameraCases:cameraCases.length,cameraMismatches},null,2));console.log({sequences:comparisons.map(c=>({name:c.name,firstMismatch:c.firstMismatch})),cameraCases:cameraCases.length,cameraMismatches:cameraMismatches.length});if(mismatches||cameraMismatches.length)process.exitCode=1;
