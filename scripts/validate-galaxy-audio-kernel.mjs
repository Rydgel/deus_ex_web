/** The Rust core's PlaySound/Update arithmetic (native/script-vm/src/galaxy.rs through galaxy-update-kernel.mjs) against the BigInt
 * reference body of src/runtime/galaxy-audio.mjs (docs/galaxy-audio.md "Update in Rust"). Both bodies play the same cases on fresh
 * audio objects, and every result is compared as JSON of float32 words (scripts/galaxy-audio-cases.mjs `bits`) and integers: the
 * returns, each voice start/control/stop with its frequency, volume and pan, the FastLineCheck and GlobalLighting requests, the
 * lip-sync calls, and every channel record word after each call. (Numbers would hide a NaN's payload: V8 canonicalizes NaNs it
 * stores in Array literals.)
 *
 * Cases: the oracle validator's (scripts/validate-native-galaxy-audio.mjs, 165), the same with a speaking lip-sync pawn (step 12),
 * and a seeded sweep of extremes: huge, tiny, infinite and NaN locations and radii, every delta-time edge, zero volumes, channel
 * counts up to the kernel's 64 and past it (the reference runs there). A case on which the reference body throws (a NaN reaches
 * x87sqrt, which the BigInt model cannot take) is counted, and the kernel's run of it must not return a value the reference could
 * not have. `ambientInRangeExact` is compared with the kernel's extended compare over values at, around and far from the radius.
 *
 *   node scripts/validate-galaxy-audio-kernel.mjs [--sweep N] [--seed S]
 */
import assert from 'node:assert/strict';
import {loadScriptVmKernel,scriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';
import {ambientInRangeExact,ambientInRange} from "../src/runtime/galaxy-audio.mjs";
import {buildCases,runCase,rng} from './galaxy-audio-cases.mjs';
import {createGalaxyAudio} from '../src/runtime/galaxy-audio.mjs';

await loadScriptVmKernel();
const kernel=scriptVmKernel.galaxy;
assert.ok(kernel,'the script VM kernel has no galaxy.rs exports (npm run build:wasm)');
const option=(n,d)=>{const i=process.argv.indexOf(`--${n}`);return i<0?d:Number(process.argv[i+1]);};
const f=Math.fround;

const play=(c,options,extra)=>{
  try{const r=runCase(c,options,extra);const used=r.audio.usesKernel();delete r.audio;return {json:JSON.stringify(r),used};}
  catch(error){return {error:String(error?.message??error)};}
};
const stats={cases:0,ops:0,thrown:0,kernelRuns:0,mismatches:0,voiceCalls:0,lipSyncs:0};
function compare(label,c,extra){
  stats.cases++;stats.ops+=c.ops.length;
  const reference=play(c,{kernel:null},extra),actual=play(c,{kernel},extra);
  if(reference.used)throw new Error('the reference run used the kernel');
  if(reference.error!==undefined){
    stats.thrown++;
    // The reference could not run this case; the kernel (which is total) may, but it must not claim a result for the same inputs
    // that differs in kind: nothing to compare beyond that it did not crash the host.
    return;
  }
  if(actual.error!==undefined){stats.mismatches++;console.log(JSON.stringify({label,kernelError:actual.error}).slice(0,600));return;}
  if((c.config.channels??16)<=kernel.maxChannels&&!actual.used)throw new Error('the kernel run did not use the kernel');
  stats.kernelRuns+=actual.used?1:0;
  stats.voiceCalls+=(actual.json.match(/"control"|"start"/g)??[]).length;stats.lipSyncs+=(actual.json.match(/"lipSync"/g)??[]).length;
  if(actual.json!==reference.json){
    stats.mismatches++;
    if(stats.mismatches<=4){
      const a=JSON.parse(actual.json),e=JSON.parse(reference.json);
      const diff=(x,y,path)=>{
        if(JSON.stringify(x)===JSON.stringify(y))return null;
        if(x&&y&&typeof x==='object'&&typeof y==='object')for(const k of new Set([...Object.keys(x),...Object.keys(y)])){const d=diff(x[k],y[k],`${path}.${k}`);if(d)return d;}
        return {path,kernel:x,reference:y};
      };
      console.log(JSON.stringify({label,...diff(a,e,'')}).slice(0,900));
    }
  }
}

// 1. The oracle validator's cases, plain and with a speaking lip-sync pawn.
const oracle=buildCases();
oracle.forEach((c,i)=>compare(`oracle ${i}`,c));
oracle.forEach((c,i)=>compare(`oracle ${i} lip-sync`,{...c,actors:c.actors.map(a=>({...a,speaking:Boolean(a.pawn)}))},{lipSync:true}));

// 2. A seeded sweep of extremes.
const random=rng(option('seed',0x6a1a8e7));
const pick=list=>list[Math.floor(random()*list.length)];
const finite=()=>f(pick([0,-0,1,-1,0.5,1e-30,-1e-38,1e-45,3e38,-3e38,16383,28671.125,random()*100,(random()-.5)*pick([10,1e3,1e5,1e7,1e12])]));
const special=()=>pick([finite,finite,finite,finite,finite,()=>Infinity,()=>-Infinity,()=>NaN])();
const edgeCase=(index)=>{
  const wild=index%4===0;
  const value=wild?special:finite;
  const actors=[{name:'player',pawn:random()<.7,index:7,location:[value(),value(),value()],eyeHeight:value(),showFlags:pick([0x4800,0x4800,0x800,0x4000,0]),
    ...(random()<.2?{viewTarget:'cam'}:{})},{name:'cam',index:9,location:[value(),value(),value()]}];
  const count=1+Math.floor(random()*8);
  for(let k=0;k<count;k++)actors.push({name:`a${k}`,index:2000+k*pick([1,1,17]),pawn:random()<.4,speaking:random()<.5,
    location:[value(),value(),value()],velocity:[value(),value(),value()],
    soundRadius:pick([0,1,255,256,Math.floor(random()*64),Math.floor(random()*300)]),soundVolume:pick([0,255,256,Math.floor(random()*256)]),
    soundPitch:pick([0,255,Math.floor(random()*128)]),...(random()<.5?{ambient:pick(['x','y'])}:{}),
    lightType:pick([0,0,1,256,3]),lightBrightness:pick([0,255,Math.floor(random()*256)])});
  const channels=pick([1,2,4,8,16,16,32,64,65]);
  const config={channels,ambientFactor:f(pick([0.7,0,1,2,random(),1e-3])),dopplerSpeed:f(pick([6500,0,1,-5,1e9,random()*1e4])),
    soundVolume:pick([204,255,0,128,64,1,300]),speechVolume:pick([255,204,0,128,1,200,300]),useSurround:random()<.3?1:0,reverseStereo:random()<.3?1:0};
  const ops=[];
  const names=actors.slice(2).map(a=>a.name);
  for(let k=0;k<10;k++){
    const r=random();
    if(r<.12&&names.length){ops.push({op:'noteDestroy',actor:pick(names)});continue;}
    if(r<.18){ops.push({op:'stopSoundId',id:Math.floor(random()*2**20)<<(random()<.5?0:4)});continue;}
    if(r<.55&&names.length){
      const target=pick(names),a=actors.find(x=>x.name===target);
      ops.push({op:'play',actor:a.name,id:(a.index<<4)|(Math.floor(random()*7)<<1)|(random()<.2?1:0),sound:pick(['x','y']),
        location:random()<.5?a.location:[value(),value(),value()],volume:f(pick([1,0,0.5,random(),-1,1e30,NaN].filter(v=>wild||v===v))),
        radius:f(pick([64,400,1600,random()*3000+1,1e-30,3e38,0.001].concat(wild?[Infinity,NaN,-5]:[]))),pitch:f(pick([1,0.5,random()*2,0,-1,1e30]))});
      continue;
    }
    const a=random()*Math.PI*2,u=[f(Math.cos(a)),f(Math.sin(a)),0];
    ops.push({op:'update',dt:pick([1/60,1/30,0.2,1,0,-0,-1,0.5,7,1e-9,1e-300,NaN,Infinity,-Infinity,0.9999999,1.0000001]),
      coords:{origin:[value(),value(),value()],x:wild&&random()<.3?[value(),value(),value()]:u,y:[0,0,1],z:wild&&random()<.3?[value(),value(),value()]:[u[1],-u[0],0]},
      fast:Array.from({length:8},()=>random()<.6),light:Array.from({length:4},()=>f(random()*pick([1,2,1e9,-1]))),
      playing:{1:random()<.8,2:random()<.8,3:random()<.8}});
  }
  return {config,sounds:{x:pick([22050,44100,8000,0,-5,2**31+7]),y:pick([11025,1e9,3.7])},listener:'player',actors,ops,counter:-Math.floor(random()*5)};
};
const sweep=option('sweep',3000);
for(let i=0;i<sweep;i++){
  const c=edgeCase(i);
  compare(`sweep ${i}`,c,{lipSync:random()<.5});
}

// 3. Update's reverb tail: the glxReverb block handed to the library for random reverb zones (every clamp and the byte masks).
const identityCoords = {origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1]};
const reverbBlockOf = (zone, options) => {
  let out = null;
  const player = {Region: {'engine.actor.pointregion.zone': zone}};
  createGalaxyAudio({effectsChannels: 16, ambientFactor: 0.7, dopplerSpeed: 6500, soundVolume: 204, speechVolume: 255, useSurround: 0,
    reverseStereo: 0, useReverb: 1}, {listener: () => ({actor: player, viewTarget: null}),
    read: (object, name) => name === 'Location' ? [0, 0, 0] : name === 'ShowFlags' ? 0 : object[name],
    library: {lock() {}, unlock() {}, setSampleReverb: words => { out = Array.from(words); return 0; }}}, options).update(0, identityCoords);
  return out;
};
let reverbZones = 0, reverbSet = 0;
for (let i = 0; i < 4000; i++) {
  const byte = () => pick([0, 1, 2, 127, 128, 254, 255, 256, 300, Math.floor(random() * 256), Math.floor(random() * 4096)]);
  const zone = {bReverbZone: random() < 0.9, MasterGain: byte(), CutoffHz: pick([-5, 0, 1, 44099, 44100, 44101, 2 ** 31 + 5, Math.floor(random() * 50000), -(2 ** 31)]),
    Delay: Array.from({length: 6}, byte), Gain: Array.from({length: 6}, byte)};
  const expected = reverbBlockOf(zone, {kernel: null}), actual = reverbBlockOf(zone, {kernel});
  assert.deepEqual(actual, expected, `reverb block ${JSON.stringify(zone)}`);
  reverbZones++; reverbSet += expected ? 1 : 0;
}

// 4. ambientInRangeExact's compare: the kernel's extended compare over values at, around and far from the radius.
let rangeChecks=0,rangeInside=0;
for(let i=0;i<20000;i++){
  const radiusByte=pick([0,1,15,63,255,256,Math.floor(random()*256)]),reach=((radiusByte&0xff)+1)*25;
  const angle=random()*Math.PI*2,tilt=random()*Math.PI-Math.PI/2;
  const scale=reach*pick([1,1,1,1+1e-7,1-1e-7,1+1e-12,0.5,2,random()*3]);
  const at=[f(Math.cos(angle)*Math.cos(tilt)*scale),f(Math.sin(angle)*Math.cos(tilt)*scale),f(Math.sin(tilt)*scale)];
  const listener=[f(pick([0,random()*200-100,1e6])),f(pick([0,random()*200-100])),f(pick([0,random()*200-100,-1e6]))];
  const location=at.map((v,k)=>f(v+listener[k]));
  const expected=ambientInRangeExact(location,listener,radiusByte);
  assert.equal(kernel.inRangeExact(location,listener,radiusByte),expected,`inRangeExact ${JSON.stringify({location,listener,radiusByte})}`);
  assert.equal(ambientInRange(location,listener,radiusByte,kernel),ambientInRange(location,listener,radiusByte,null),'ambientInRange');
  rangeChecks++;rangeInside+=expected?1:0;
}
// A radius sphere's exact points: 3-4-5 triples on the sphere (inside by equality), and the non-finite distances.
for(const [dx,dy,dz,byte] of [[3,4,0,0],[0,0,25,0],[0,0,26,0],[75,100,0,4],[1e30,0,0,255],[Infinity,0,0,3],[NaN,0,0,3],[0,-Infinity,0,0]]){
  const loc=[f(dx),f(dy),f(dz)],origin=[0,0,0];
  let expected;try{expected=ambientInRangeExact(loc,origin,byte);}catch{continue;}
  assert.equal(kernel.inRangeExact(loc,origin,byte),expected,`inRangeExact ${[dx,dy,dz,byte]}`);rangeChecks++;
}

console.log(JSON.stringify({...stats,reverbZones,reverbSet,rangeChecks,rangeInside}));
if(stats.mismatches)process.exitCode=1;
else if(!stats.kernelRuns||!stats.voiceCalls)throw new Error('the cases exercised nothing');
