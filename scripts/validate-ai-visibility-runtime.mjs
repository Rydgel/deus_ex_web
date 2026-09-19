/** Real Training light-switch/BSP/linked-property boundaries for natives 700/701. */
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createScriptLights} from '../src/runtime/script-lights.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${directory}`))
  files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1});
const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor,level=runtime.levelFor(player);
const read=(actor,name)=>runtime.namedReference(actor,name).get(),write=(actor,name,value)=>runtime.namedReference(actor,name).set(value);
const lights=await Promise.all([0,1,2,3].map(i=>runtime.objects.resolve(asset,asset.exportsByPath.get(`triggerlight${i}`))));
const lightSwitch=await runtime.objects.resolve(asset,asset.exportsByPath.get('lightswitch0'));
const controller=await createScriptLights({runtime,assets,lights});controller.reset();
const point=read(lights[0],'Location').map((v,i)=>v+(i===2?-40:0));
// Original map startup/whole-world ticking remains separate: install explicit
// native Region/time inputs using the existing original BSP PointRegion.
write(player,'Location',point);write(player,'Velocity',[0,0,0]);
const region=level.pointRegion(point);runtime.setRegion(player,region.zone,region.leaf,region.zoneNumber);
const {slotOf}=runtime.classLoader.graph;
for(const [actor,fields] of [[player,{Location:0x114,Velocity:0x144,Region:0xc8,VisUpdateTime:0x2e8,
  CurrentVisibility:0x2ec,LastVisibility:0x2f0,LightType:0x1e0,LightBrightness:0x1e2,LightSaturation:0x1e4,LightRadius:0x1e5}],
  [region.zone,{AmbientBrightness:0x38c,AmbientSaturation:0x38e}],[level.actors[0],{TimeSeconds:0x478}]])
  for(const [name,offset] of Object.entries(fields))
    assert.equal(slotOf(runtime.lookupMember(runtime.instance(actor).cls,'fields',name).loadRecord,0x48),offset,name);
const invoke=(index,args)=>runtime.invokeNative({index,receiver:player,argumentCount:args.length,evaluateArgument:i=>args[i]});
const floatBits=v=>{const b=Buffer.alloc(4);b.writeFloatLE(v);return b.toString('hex');};
const samples=[],results=[],queries=[];
function capture(name) {
  const objects={zone:{AmbientBrightness:read(region.zone,'AmbientBrightness'),AmbientSaturation:read(region.zone,'AmbientSaturation')},
    subject:{bUnlit:read(player,'bUnlit')}};
  // Entries with LightType=0 cannot reach any subsequent field/trace read.
  // Retain all other lights in their actual Level.Actors order.
  for(const [i,actor] of level.actors.entries())if(actor&&actor!==player&&read(actor,'LightType'))
    objects[`light${i}`]=Object.fromEntries(['Location','LightType','LightBrightness','LightSaturation','LightRadius','bStatic'].map(n=>[n,read(actor,n)]));
  const traces=[],traceCalls=[],query=level.hash.lineCheck;
  level.hash.lineCheck=function(start,end,extent,flags,extra,source) {
    assert.equal(source,player);assert.equal(flags,6);assert.equal(extra,0);assert.deepEqual(extent,[0,0,0]);
    const hit=query.call(this,start,end,extent,flags,extra,source);
    traces.push(Number(hit.outside));traceCalls.push({start:[...start],end:[...end]});return hit;
  };
  let result;
  try {result=invoke(700,[point]);} finally {level.hash.lineCheck=query;}
  samples.push({name,point,objects,traces});results.push(result);queries.push(traceCalls);return result;
}
const initial=capture('training-initial');
assert.ok(initial>0&&initial<1);
write(level.actors[0],'TimeSeconds',100);write(player,'VisUpdateTime',0);
assert.equal(invoke(701,[false]),initial);
assert.equal(read(player,'CurrentVisibility'),initial);assert.equal(read(player,'LastVisibility'),initial);
// This initial TriggerToggle direction reverses on the first Frob, retaining
// authored brightness. A second Frob reaches the original dark endpoint.
runtime.processEvent(lightSwitch,'Frob',[player,null]);controller.tick(1/120);
runtime.processEvent(lightSwitch,'Frob',[player,null]);controller.tick(1/120);
assert.deepEqual(lights.map(a=>read(a,'LightBrightness')),[0,0,0,0]);
const dark=capture('training-switch-off');assert.ok(dark<initial,`${dark} < ${initial}`);
write(level.actors[0],'TimeSeconds',100.25);assert.equal(invoke(701,[false]),initial,'exact .25 keeps current cache');
write(level.actors[0],'TimeSeconds',100.5);assert.equal(invoke(701,[false]),initial,'refresh returns previous current');
assert.equal(read(player,'CurrentVisibility'),dark);assert.equal(read(player,'LastVisibility'),initial);
write(level.actors[0],'TimeSeconds',100.625);
assert.equal(invoke(701,[false]),Math.fround((dark-initial)*0.5+initial));
runtime.processEvent(lightSwitch,'Frob',[player,null]);controller.tick(1/120);
assert.deepEqual(lights.map(a=>read(a,'LightBrightness')),[50,50,25,25]);
assert.equal(capture('training-switch-restored'),initial);
write(level.actors[0],'TimeSeconds',101.25);assert.equal(invoke(701,[false]),initial);

// Re-run the complete original scalar worker on these live map values, with
// actual BSP/Mover trace results recorded above as the isolated query leaf.
const original=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-ai-visibility-oracle.py',root],{input:JSON.stringify(samples),encoding:'utf8',maxBuffer:16*1024*1024}));
for(const [i,result] of original.cases.entries()) {
  assert.equal(floatBits(results[i]),result.result,samples[i].name);
  assert.deepEqual(queries[i],result.events.filter(e=>e.op==='trace').map(({start,end})=>({start,end})),samples[i].name);
}
assert.ok(queries.some(q=>q.length>0),'actual static-light BSP queries are exercised');
await writeFile('.cache/research/ai-visibility-training.json',JSON.stringify({samples,results,queries}));
console.log(`PASS Training AI visibility: ${samples.length} original-DLL map comparisons, linked offsets, ${queries.reduce((n,q)=>n+q.length,0)} real BSP/mover rays, original LightSwitch off/on and cache interpolation (${initial} -> ${dark} -> ${initial}).`);
