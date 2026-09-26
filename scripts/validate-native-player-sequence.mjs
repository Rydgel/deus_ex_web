import{createPlayerSequenceFixture}from'./native-player-sequence-fixture.mjs';
import{runPlayerPhysics}from'../src/runtime/player-physics.mjs';
import assert from'node:assert/strict';
import{createHash}from'node:crypto';
import{readFile,writeFile,mkdir,readdir}from'node:fs/promises';
import{spawnSync}from'node:child_process';
import{AssetStore}from'../src/unreal/assets.mjs';
import{decodeMap}from'../src/unreal/map.mjs';
import{walkingSurfaceTextures}from'../src/runtime/walking-surface.mjs';
import{objectAt}from'../src/unreal/objects.mjs';
import{ClassDefaults}from'../src/unreal/classes.mjs';
import{gameDirectory}from'./game-directory.mjs';
import{nativeLevelScene}from'./native-level-scene.mjs';
const root=gameDirectory(),files=[];for(const dir of['System','Textures','Maps','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
let mismatches=0;
const assets=new AssetStore(files),defaults=new ClassDefaults(assets),de=await assets.get('DeusEx');const jc=de.pkg.exports.findIndex((e,i)=>objectAt(de.pkg,i+1)?.name==='JCDentonMale');if(jc<0)throw Error('Missing JC class');const pawnValues=await defaults.get(de,jc+1);
for(const [name,start]of [['00_Training',[-1149.2435302734375,825.8439331054688,-80.0999984741211]],['01_NYC_UNATCOIsland',[-4760.56982421875,10430.8115234375,-280.67498779296875]]]){
 if(process.argv.includes('--stairs-only')&&name!=='00_Training')continue;
 const dir=`reports/movement/player-sequence/${name}${process.argv.includes('--stairs-only')?'-stairs':''}`;await mkdir(dir,{recursive:true});
 // Build the scene here, not from native-level's report, which that validator may be rewriting; the JSON copy is the oracle's exact input.
 const asset=await assets.get(name),map=decodeMap(asset.bytes),scene=JSON.parse(JSON.stringify(await nativeLevelScene(defaults,asset,map)));scene.textures=await walkingSurfaceTextures(assets,asset,map.model);scene.zones=map.model.zones.map(z=>z.actor?map.actors.find(a=>a.index===z.actor)?.name:null);scene.pawnValues=pawnValues;scene.zoneValues=await defaults.forActor(asset,map.actors.find(a=>a.className==='LevelInfo'));
 scene.actors.push({id:'$player',kind:'Pawn',collisionBits:15,values:{Location:start,CollisionRadius:20,CollisionHeight:43}});
 let cases=[{name:'walk',position:start,acceleration:[1024,0,0],frames:4,dt:.1},{name:'crouch-dimensions',position:start.map((x,i)=>i===2?x-27:x),height:16,acceleration:[1024,0,0],frames:4,dt:.1},{name:'drop',position:start.map((x,i)=>i===2?x+80:x),physics:2,frames:6,dt:.1},{name:'upward-launch',position:start,physics:2,velocity:[0,0,330],frames:9,dt:.1}];
 if(name==='00_Training')cases.push({name:'stairs-candidate',position:[0,832,-144.2],velocity:[-320,0,0],acceleration:[-1024,0,0],frames:5,dt:.1},{name:'walk-wall',position:[-300,start[1],start[2]],acceleration:[1024,0,0],frames:5,dt:.1});
 if(process.argv.includes('--stairs-only'))cases=[{name:'recorded-stair-approach',position:[181.2455291748047,825.8439331054688,-128.09999084472656],velocity:[-164.99082946777344,0,0],acceleration:[-2400,0,0],groundSpeed:207,frames:12,dt:.05}];
 await writeFile(`${dir}/scene.json`,JSON.stringify(scene));await writeFile(`${dir}/cases.json`,JSON.stringify(cases));
 if(!process.argv.includes('--reuse')){const r=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-player-sequence-oracle.py',root,`${dir}/scene.json`,`${dir}/cases.json`],{encoding:'utf8',maxBuffer:32e6});if(r.status!==0)throw Error(r.stderr);await writeFile(`${dir}/original.json`,r.stdout);}
 const reference=JSON.parse(await readFile(`${dir}/original.json`,'utf8'));
 const sha=s=>createHash('sha256').update(s).digest('hex');assert.equal(reference.sceneSha256,sha(await readFile(`${dir}/scene.json`)));assert.equal(reference.casesSha256,sha(await readFile(`${dir}/cases.json`)));assert.equal(reference.results.length,cases.length);
 for(const [i,r]of reference.results.entries()){if(r.unsupported)continue;assert.equal(r.frames.length,cases[i].frames);for(const frame of r.frames)assert.ok([...frame.position,...frame.velocity].every(Number.isFinite));assert.ok(r.trace.some(e=>e.move));}
 const summary=reference.results.map((r,i)=>r.unsupported?{name:cases[i].name,unsupported:r.unsupported}:({name:cases[i].name,frames:r.frames.length,last:r.frames.at(-1),moves:r.trace.filter(e=>e.move).length,native:[...new Set(r.trace.filter(e=>e.native).map(e=>e.native))],scriptBoundaries:[...new Set(r.trace.filter(e=>e.scriptBoundary!==undefined).map(e=>e.caller))]}));
 const comparison=[];
 for(const [i,c]of cases.entries()){
  const original=reference.results[i];if(original.unsupported){comparison.push({name:c.name,unsupported:original.unsupported});continue;}
  const game=createPlayerSequenceFixture(scene),player=game.player,q=game.collision.queries;
  q.changeActor(player.collisionActor,()=>{player.position=c.position.map(Math.fround);player.radius=20;player.height=c.height??43;player.bodyRotation=[0,0,0];});
  player.velocity=(c.velocity??[0,0,0]).map(Math.fround);player.grounded=(c.physics??1)===1;player.physicsPawn={base:q.levelInfo,hitSlopedWall:false,moveTimer:0,pawnFlags:0,destination:[0,0,0]};
  const calls=[],line=q.lineCheck.bind(q);q.lineCheck=(start,end,extent,flags,extra=0,source)=>{const hit=line(start,end,extent,flags,extra,source);calls.push({start:[...start],end:[...end],extent:[...extent],flags,extra,time:hit.time,normal:hit.normal,actor:hit.actor===q.levelInfo?'$world':hit.actor?.id??hit.actor?.name??null});return hit;};
  let mismatch=null;
  for(let frame=0;frame<c.frames;frame++){
   try{runPlayerPhysics(player,c.dt,{acceleration:c.acceleration??[0,0,0],groundSpeed:c.groundSpeed??scene.pawnValues.GroundSpeed,isWalking:false,zone:scene.zoneValues});
    const actual={position:player.position,velocity:player.velocity,physics:player.grounded?1:2},expected=Object.fromEntries(['position','velocity','physics'].map(k=>[k,original.frames[frame][k]]));assert.deepEqual(actual,expected);
   }catch(error){const nativeLines=original.queries.filter(e=>e.line);let firstQuery=null;for(let k=0;k<Math.min(calls.length,nativeLines.length);k++){const a=calls[k],b=nativeLines[k];const expected={...b.line,time:b.result.time,normal:b.result.normal,actor:b.result.actor};delete expected.source;try{assert.deepEqual(a,expected);}catch{firstQuery={index:k,actual:a,expected};break;}}mismatch={frame,message:error.message,actual:{position:player.position,velocity:player.velocity,physics:player.grounded?1:2},expected:original.frames[frame],firstQuery};break;}
  }
  const nativeLines=original.queries.filter(e=>e.line);let queryMismatch=null;
  for(let k=0;k<Math.max(calls.length,nativeLines.length);k++){const a=calls[k],b=nativeLines[k],expected=b?{...b.line,time:b.result.time,normal:b.result.normal,actor:b.result.actor}:null;if(expected)delete expected.source;const actual=a?{...a}:null;if(actual&&!actual.actor)delete actual.normal;if(expected&&!expected.actor)delete expected.normal;try{assert.deepEqual(actual,expected);}catch{queryMismatch={index:k,actual:a??null,expected};break;}}
  if(mismatch||queryMismatch)mismatches++;
  comparison.push({name:c.name,frames:c.frames,mismatch,queryMismatch,queries:calls.length});
 }
 await writeFile(`${dir}/comparison.json`,JSON.stringify(comparison,null,2));await writeFile(`${dir}/summary.json`,JSON.stringify(summary,null,2));console.log(name,comparison.map(c=>({name:c.name,unsupported:!!c.unsupported,mismatch:c.mismatch?.frame??null,queryMismatch:c.queryMismatch?.index??null})));
}

if(mismatches)process.exitCode=1;
