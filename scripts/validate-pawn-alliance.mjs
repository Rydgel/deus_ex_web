import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';

const samples=[];
const add=(label,fields={})=>samples.push({label,...fields});
add('null',{null:true});add('self',{self:true});
add('deleted',{target:{bDeleteMe:true}});add('undetectable',{target:{bDetectable:false}});
add('dead',{target:{Health:0}});add('negative-health',{target:{Health:-1}});
add('neutral-default');add('ignore-alliance',{check:0});
add('explicit-check',{check:1});
const hostile={Alliance:'UNATCO',AlliancesEx:[{AllianceName:'Player',AllianceLevel:-1}]};
add('enemy-target-hostile',{receiver:{Alliance:'Player'},target:hostile});
add('enemy-receiver-hostile',{receiver:hostile,target:{Alliance:'Player'}});
const alliance=(label,entries=[],extra={})=>add(label,{index:2106,name:'UNATCO',receiver:{AlliancesEx:entries,...extra}});
const entry=(level,agitation=0)=>({AllianceName:'unatco',AllianceLevel:level,AgitationLevel:agitation});
alliance('unknown');add('none-name',{index:2106,name:'None',receiver:{AlliancesEx:[entry(-1)]}});
alliance('friendly',[entry(.2)]);alliance('hostile',[entry(-.2)]);alliance('neutral',[entry(0)]);
alliance('agitated',[entry(.2,1)]);alliance('below-agitation',[entry(.2,Math.fround(1-2**-24))]);
alliance('first-match',[entry(.2),entry(-1)]);
alliance('last-slot',[...Array.from({length:15},()=>({})),entry(-1)]);
alliance('likes-neutral',[],{bLikesNeutral:true});
alliance('reverse-neutral',[],{bReverseAlliances:true});
alliance('likes-before-reverse',[],{bLikesNeutral:true,bReverseAlliances:true});
alliance('reverse-hostile',[entry(-1)],{bReverseAlliances:true});
alliance('reverse-friendly',[entry(1)],{bReverseAlliances:true});
alliance('nan-alliance',[{...entry(0),AllianceLevelBits:0x7fc12345}]);
alliance('nan-agitation',[{...entry(.2),AgitationLevelBits:0x7fc12345}]);
add('null-pawn',{index:2107,null:true,receiver:{bLikesNeutral:true,bReverseAlliances:true}});
add('pawn-first-hostile-wins',{index:2107,receiver:{Alliance:'Player',bLikesNeutral:true},target:hostile});
add('plain-pawn-no-reverse-query',{index:2107,receiver:{Alliance:'Player',bLikesNeutral:true},target:{...hostile,scripted:false}});
add('both-queries',{index:2107,receiver:{Alliance:'Player'},target:{Alliance:'UNATCO'}});

const original=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-pawn-alliance-oracle.py',gameDirectory()],{input:JSON.stringify(samples),encoding:'utf8'}));
if(process.argv.includes('--reference-only')) {
  await mkdir('.cache/research',{recursive:true});
  await writeFile('.cache/research/pawn-alliance-original.json',JSON.stringify({samples,original}));
  console.log(`Captured ${original.length} original enemy/alliance exec calls.`);process.exit(0);
}
const {execPawnAlliance}=await import('../src/runtime/script-pawn-alliance.mjs');
const io=new DataView(new ArrayBuffer(4));
const float=(entry,name)=>{
  if(entry[name+'Bits']===undefined)return Math.fround(entry[name]??0);
  io.setUint32(0,entry[name+'Bits'],true);return io.getFloat32(0,true);
};
const key=name=>`deusex.scriptedpawn.allianceinfoex.${name.toLowerCase()}`;
for(const [i,sample] of samples.entries()) {
  const actor=(id,fields={})=>({id,scripted:true,Alliance:'None',bDetectable:true,Health:100,...fields,
    AlliancesEx:Array.from({length:16},(_,i)=>{
      const entry=fields.AlliancesEx?.[i]??{};
      return {[key('AllianceName')]:entry.AllianceName??'None',[key('AllianceLevel')]:float(entry,'AllianceLevel'),
        [key('AgitationLevel')]:float(entry,'AgitationLevel')};
    })});
  const receiver=actor('receiver',sample.receiver),target=actor('target',sample.target),events=[];
  const query=sample.null?null:sample.self?receiver:target;
  const index=sample.index??2105;
  // EX_Nothing leaves the native's true optional default intact. Exercise
  // both that explicit VM hole and the shorter host-call representation.
  const args=index===2106?[sample.name]:index===2105?[query,sample.check]:[query];
  const before=structuredClone([receiver,target]);
  const services={read:(a,name)=>{
    if(name==='AlliancesEx')events.push(a.id);
    return a[name];
  },isA:a=>a.scripted};
  const result=execPawnAlliance({receiver,index,argumentCount:args.length,evaluateArgument:i=>args[i]},services);
  assert.equal(Number(result),original[i].result,sample.label);
  // Only non-None alliance names read the fixed array; None still reaches
  // GetAllianceType's flag postprocessing and is in the native event log.
  assert.deepEqual(events,original[i].events.filter(([,name])=>name!=='none').map(([id])=>id),sample.label);
  assert.deepEqual([receiver,target],before,`${sample.label}: read-only`);
  if(index===2105&&sample.check===undefined)
    assert.equal(Number(execPawnAlliance({receiver,index,argumentCount:1,evaluateArgument:()=>query},services)),original[i].result);
}
console.log(`PASS ${samples.length} original enemy/alliance calls: gates, optional defaults, mutual hostility, 16-slot order, flags, NaNs, byte returns and read-only state.`);
