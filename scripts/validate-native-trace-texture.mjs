import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createTraceTextureIterator} from '../src/runtime/script-iterators.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/trace-texture';await mkdir(directory,{recursive:true});
// Surface records pair a texture name dword with a group name dword; entries
// without `texture` model a null material (the texName/texGroup outs keep
// their per-hit zeroed values while PolyFlags still publishes). `nodes` maps
// a hit record's Item to a surface index, mirroring Model->Nodes[Item].iSurf.
const base={
 end:[100,200,300],
 nodes:[0,1,0],
 surfs:[{flags:0x100,texture:0x101,group:0x202},{flags:0x200}],
 actors:[{id:'wrong'},{id:'owned',owner:'self'},{id:'descendant',super:'LevelInfo'}],
 hits:[{actor:'self'},{actor:'wrong'},{actor:'world',item:0},{actor:'owned'},{actor:'world',item:1},{actor:'descendant',item:2}],
};
const cases=[base,{...base,baseClass:'Mover'},{...base,breakAfter:3},{...base,hits:[]},{...base,start:[1,2,3],extent:[20,20,43]}];
await writeFile(`${directory}/cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-trace-texture-oracle.py',gameDirectory(),`${directory}/cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/original.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/original.json`,'utf8'));let mismatches=0;
const nameOf=v=>v===0?'None':`tex${v}`,groupOf=v=>v===0?'None':`grp${v}`;
for(const [index,c] of cases.entries()){
 let query;const yields=[];
 const world={id:'world',lineage:['engine.levelinfo']};
 const source={id:'self',position:c.sourcePosition??[10,20,30],worldActor:world};
 const actors={self:source,world};
 for(const a of c.actors??[])actors[a.id]={id:a.id,lineage:[`engine.${(a.super??'actor').toLowerCase()}`]};
 const queries={levelInfo:world,multiLineCheck(q){query={end:q.end,start:q.start,extent:q.extent,checkActors:q.checkActors,world:q.worldActor===world,extra:q.extra};
  return c.hits.map((h,i)=>({actor:actors[h.actor],location:h.location??[i,2,3],normal:h.normal??[0,0,1],item:h.item??-1}));}};
 const level={hash:queries,model:{nodes:c.nodes.map(surface=>({surface})),surfaces:c.surfs.map(s=>({flags:s.flags}))},
  surfaceTexture:c.surfs.map(s=>s.texture===undefined?null:{name:nameOf(s.texture),outerName:groupOf(s.group??0)})};
 const slot=initial=>{const s={reference:true,value:initial,get(){return s.value},set(v){s.value=v}};return s;};
 // Zero-hit sweeps leave every out untouched: seed name/group/flags with the
 // oracle's sentinel dwords (0x11/0x22/-7) through the same dword mapping.
 const out={actor:slot(null),name:slot(nameOf(0x11)),group:slot(groupOf(0x22)),flags:slot(-7),location:slot([9,9,9]),normal:slot([8,8,8])};
 const args=[c.baseClass,out.actor,out.name,out.group,out.flags,out.location,out.normal,c.end,c.start,c.extent];
 const iterator=createTraceTextureIterator({receiver:source,argumentCount:10,evaluateArgument:i=>args[i],levelFor:()=>level});
 while(iterator.next()){
  yields.push({actor:out.actor.value?.id??null,texName:out.name.value,texGroup:out.group.value,
   flags:out.flags.value,location:out.location.value,normal:out.normal.value});
  if(yields.length===c.breakAfter)break;
 }
 const actual={query,yields,finalActor:out.actor.value?.id??null,finalLocation:out.location.value,finalNormal:out.normal.value,
  finalTexName:out.name.value,finalTexGroup:out.group.value,finalFlags:out.flags.value};
 const expected={...reference.results[index],
  yields:reference.results[index].yields.map(y=>({...y,texName:nameOf(y.texName),texGroup:groupOf(y.texGroup)})),
  finalTexName:nameOf(reference.results[index].finalTexName),finalTexGroup:groupOf(reference.results[index].finalTexGroup)};
 try{assert.deepEqual(actual,expected);}catch{mismatches++;console.log(JSON.stringify({index,actual,expected}));}
}
// Real VM calls may omit the trailing optional expressions — the UC compiler
// emits only the supplied arguments and the exec's OPTX macros then keep the
// pre-stored Location/zero defaults (docs/script-trace.md). A short call must
// still reach MultiLineCheck rather than fail arity.
{
 let shortQuery;const shortWorld={id:'world',lineage:['engine.levelinfo']};
 const shortSource={id:'self',position:[10,20,30],worldActor:shortWorld};
 const shortSlot=initial=>{const s={reference:true,value:initial,get(){return s.value},set(v){s.value=v}};return s;};
 const shortOut={actor:shortSlot(null),name:shortSlot(0),group:shortSlot(0),flags:shortSlot(0),location:shortSlot([0,0,0]),normal:shortSlot([0,0,0])};
 const short=createTraceTextureIterator({receiver:shortSource,argumentCount:8,
  evaluateArgument:i=>[null,shortOut.actor,shortOut.name,shortOut.group,shortOut.flags,shortOut.location,shortOut.normal,[1,2,3]][i],
  levelFor:()=>({hash:{multiLineCheck(q){shortQuery=q;return[];}},model:{nodes:[],surfaces:[]},surfaceTexture:[]})});
 assert.equal(short.next(),false);
 try{assert.deepEqual({start:shortQuery.start,extent:shortQuery.extent},{start:[10,20,30],extent:[0,0,0]});}
 catch{mismatches++;console.log('short-call defaults mismatch');}
}
console.log(JSON.stringify({cases:cases.length,mismatches}));if(mismatches)process.exitCode=1;
