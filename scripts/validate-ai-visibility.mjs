/** Original full AI light/cache workers, including extended return precision. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';

const cases=[],light={LightType:1,LightBrightness:128,LightSaturation:255,LightRadius:9};
const add=(name,extra={})=>cases.push({name,...extra});
add('empty-dark');
add('unlit-skips-light-traces',{objects:{subject:{bUnlit:true},light:{...light,bStatic:true}},traces:[]});
add('ambient-saturated',{objects:{zone:{AmbientBrightness:32,AmbientSaturation:255}}});
add('ambient-colored',{objects:{zone:{AmbientBrightness:101,AmbientSaturation:17}}});
add('ambient-clamps',{objects:{zone:{AmbientBrightness:255,AmbientSaturation:255}}});
add('dynamic-light-center',{objects:{light}});
add('scalar-and-attenuation-precision',{point:[31.135,47.715,16.42],objects:{light:{...light,LightBrightness:193,LightSaturation:46}}});
add('null-self-type-and-brightness-filter',{objects:{subject:light,disabled:{...light,LightType:0},dark:{...light,LightBrightness:0}},actors:['info',null,'subject','disabled','dark']});
for(const distance of [24.999,25,25.001])add(`zero-radius-${distance}`,{point:[distance,0,0],objects:{light:{...light,LightRadius:0}}});
add('static-clear',{point:[50,70,25],objects:{light:{...light,bStatic:true}}});
add('static-blocked',{objects:{light:{...light,bStatic:true}},traces:[0]});
add('dynamic-does-not-trace',{objects:{light:{...light,bStatic:false}},traces:[]});
add('brightness-read-after-trace',{objects:{light:{...light,bStatic:true}},callbacks:{0:{set:{light:{LightBrightness:219,LightSaturation:91}}}}});
add('radius-and-distance-captured-before-trace',{point:[35,0,0],objects:{light:{...light,bStatic:true}},callbacks:{0:{set:{light:{LightRadius:0,Location:[70,0,0]}}}}});
add('zone-pointer-captured-fields-live',{objects:{light:{...light,bStatic:true},secondZone:{AmbientBrightness:255}},callbacks:{0:{set:{subject:{Zone:'secondZone'},zone:{AmbientBrightness:13,AmbientSaturation:80}}}}});
add('live-array-append',{objects:{light:{...light,bStatic:true},later:light},actors:['info','subject','light'],callbacks:{0:{actors:['info','subject','light','later']}}});
add('live-array-shrink',{objects:{light:{...light,bStatic:true},later:light},callbacks:{0:{actors:['info','subject','light']}}});
add('two-light-ambient-sum',{point:[100,-110,75],objects:{zone:{AmbientBrightness:19,AmbientSaturation:143},a:{...light,LightBrightness:217,Location:[40,18,33]},b:{...light,LightSaturation:47,Location:[80,80,40]}}});
add('native-700-vector-evaluation',{exec:true,point:[35,11,-29],objects:{light}});
const cached={VisUpdateTime:10,CurrentVisibility:0.41233187913894653,LastVisibility:0.123};
for(const elapsed of [-0.125,0,0.123456,0.25,0.25001,0.5,0.50001])add(`cache-elapsed-${elapsed}`,{
  native:701,time:10+elapsed,velocity:0,objects:{subject:cached,zone:{AmbientBrightness:27,AmbientSaturation:231}}});
add('unordered-elapsed-refresh',{native:701,objects:{subject:{VisUpdateTimeBits:0x7fc12345},light}});
add('refresh-reads-last-after-callback',{native:701,time:10.3,objects:{subject:cached,light:{...light,bStatic:true}},callbacks:{0:{set:{subject:{LastVisibility:0.71325,VisUpdateTime:44}}}}});
add('cold-refresh-overwrites-query-cache-mutation',{native:701,objects:{subject:cached,light:{...light,bStatic:true}},callbacks:{0:{set:{subject:{LastVisibility:0.71325,CurrentVisibility:0.919,VisUpdateTime:44}}}}});
for(const speed of [0,30,115,200,220])add(`velocity-${speed}`,{native:701,time:10.123456,objects:{subject:{...cached,Velocity:[speed,0,0]}}});
add('velocity-sqrt-extended',{native:701,time:10.123456,objects:{subject:{...cached,Velocity:[87.719,53.125,17.687]}}});
add('velocity-clamp-result',{native:701,time:10.25,objects:{subject:{...cached,CurrentVisibility:0.9,Velocity:[200,0,0]}}});
for(const extra of [{nothing:true},{velocity:0},{velocity:-2}])add(`native-701-${extra.nothing?'default':extra.velocity}`,{
  native:701,exec:true,time:10.125,objects:{subject:{...cached,Velocity:[115,0,0]}},...extra});

const reference=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-ai-visibility-oracle.py',gameDirectory()],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:12*1024*1024}));
if(process.argv.includes('--reference-only')) {
  await writeFile('.cache/research/ai-visibility-original.json',JSON.stringify({cases,reference}));
  for(const r of reference.cases)console.log(r.name,r.result,r.events.map(e=>e.op).join(' -> '));
  process.exit(0);
}
const {actorLightLevelExtended,actorVisibilityExtended,execAIGetLightLevel,execAIVisibility}=
  await import('../src/runtime/script-ai-visibility.mjs');
const {x87load,x87mul,x87store,x87width}=await import('../src/runtime/script-vm.mjs');
const floats={TimeSeconds:0x478,VisUpdateTime:0x2e8,CurrentVisibility:0x2ec,LastVisibility:0x2f0};
const vectors={Location:0x114,Velocity:0x144};
const bytes={LightType:0x1e0,LightBrightness:0x1e2,LightHue:0x1e3,LightSaturation:0x1e4,
  LightRadius:0x1e5,AmbientBrightness:0x38c,AmbientSaturation:0x38e};
const flags={bStatic:[0x28,1],bUnlit:[0x194,1]};
const bits=value=>{const b=Buffer.alloc(4);b.writeFloatLE(value);return b.toString('hex');};
const extendedBits=value=>{
  assert.equal(value.nan,undefined);assert.equal(value.inf,undefined);
  const b=Buffer.alloc(10),width=value.sig===0n?0:x87width(value.sig);
  b.writeBigUInt64LE(width?value.sig<<BigInt(64-width):0n);
  b.writeUInt16LE((value.neg<<15)|(width?value.exp+width-1+16383:0),8);return b.toString('hex');
};
for(let i=0;i<cases.length;i++) {
  const sample=cases[i],original=reference.cases[i];
  const buffers=Object.fromEntries(Object.entries(original.before).map(([id,hex])=>[id,Buffer.from(hex,'hex')]));
  const actors=Object.fromEntries(Object.keys(buffers).map(id=>[id,{id}]));
  const pointers=Object.fromEntries(Object.entries(original.addresses).map(([id,p])=>[p,actors[id]]));
  const level={actors:(sample.actors??['info','subject',...Object.keys(actors).filter(n=>!['info','subject','zone'].includes(n))]).map(n=>actors[n]??null)};
  const read=(actor,key)=>{
    const b=buffers[actor.id];
    if(Object.hasOwn(floats,key))return b.readFloatLE(floats[key]);
    if(Object.hasOwn(vectors,key))return [0,1,2].map(i=>b.readFloatLE(vectors[key]+i*4));
    if(Object.hasOwn(bytes,key))return b[bytes[key]];
    if(Object.hasOwn(flags,key)){const [at,mask]=flags[key];return Boolean(b.readUInt32LE(at)&mask);}
    if(key==='Zone')return pointers[b.readUInt32LE(0xc8)];
    throw new Error(key);
  };
  const write=(actor,key,value)=>{
    const b=buffers[actor.id];
    if(Object.hasOwn(floats,key))return b.writeFloatLE(value,floats[key]);
    if(Object.hasOwn(vectors,key)){value.forEach((v,i)=>b.writeFloatLE(v,vectors[key]+i*4));return;}
    if(Object.hasOwn(bytes,key)){b[bytes[key]]=value;return;}
    if(key==='Zone')return b.writeUInt32LE(original.addresses[value],0xc8);
    throw new Error(key);
  };
  const state=()=>Object.fromEntries(Object.entries(buffers).map(([id,b])=>[id,b.subarray(0x2e8,0x2f4).toString('hex')]));
  const events=[];let traceCount=0;
  const services={read,write,level:()=>level,levelInfo:l=>l.actors[0],levelActors:l=>l.actors,
    isA:(actor,name)=>actor===actors.info&&name==='LevelInfo',zone:a=>read(a,'Zone'),
    lightLineCheck:(l,source,end,start)=>{
      assert.equal(l,level);const result=(sample.traces??[1])[traceCount];assert.notEqual(result,undefined);
      events.push({op:'trace',source:source.id,end,start,result,state:state()});
      const action=sample.callbacks?.[traceCount++]??{};
      for(const [id,fields] of Object.entries(action.set??{}))for(const [key,value] of Object.entries(fields))write(actors[id],key,value);
      if(action.actors)level.actors=action.actors.map(n=>actors[n]??null);
      return result;
    },
  };
  services.lighting=(actor,point)=>{
    events.push({op:'light',actor:actor.id,point,state:state()});return actorLightLevelExtended(actor,point,services);
  };
  let result;
  if(sample.exec){
    const value=sample.native===701?(sample.nothing?undefined:sample.velocity??1):(sample.point??[0,0,0]);
    const call={receiver:actors.subject,argumentCount:1,evaluateArgument:()=>value};
    result=bits((sample.native===701?execAIVisibility:execAIGetLightLevel)(call,services));
  }else{
    const value=sample.native===701?actorVisibilityExtended(actors.subject,sample.velocity??1,services)
      :services.lighting(actors.subject,(sample.point??[0,0,0]).map(Math.fround));
    result=bits(x87store(value));
    assert.equal(extendedBits(value),original.extended,`${sample.name}: extended result`);
    assert.equal(bits(x87store(x87mul(value,x87load(0.7132515907287598)))),original.multiplied,`${sample.name}: caller multiply`);
  }
  assert.equal(result,original.result,`${sample.name}: result`);
  assert.deepEqual(events,original.events,`${sample.name}: queries/cache at call boundaries`);
  for(const [id,b] of Object.entries(buffers))assert.equal(b.toString('hex'),original.after[id],`${sample.name}: ${id} full storage`);
}
console.log(`PASS ${cases.length} original AI lighting/visibility cases: full workers, native wrappers, cache stores, live lights/zone/trace mutations and extended return precision.`);
