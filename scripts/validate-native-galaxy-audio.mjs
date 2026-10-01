/** UGalaxyAudioSubsystem PlaySound/Update (src/runtime/galaxy-audio.mjs)
 * against the original bodies run by scripts/native-galaxy-audio-oracle.py
 * (docs/galaxy-audio.md). Each case scripts PlaySound and Update calls over
 * a listener, actors and registered sounds; the comparison covers every
 * return, the Galaxy voice calls (start, control, stop, status), the
 * FastLineCheck and GlobalLighting requests, and every channel record bit
 * after each call.
 *
 *   node scripts/validate-native-galaxy-audio.mjs [--reuse]
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createGalaxyAudio} from '../src/runtime/galaxy-audio.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/galaxy-audio';await mkdir(directory,{recursive:true});
const f=Math.fround;
const view=new DataView(new ArrayBuffer(4));
const bits=v=>(view.setFloat32(0,v,true),view.getUint32(0,true));
const config={channels:16,ambientFactor:0.7,dopplerSpeed:6500,soundVolume:204,speechVolume:255};
const identity={origin:[0,0,0],x:[1,0,0],y:[0,1,0],z:[0,0,1]};
// Listener facing +Y (a yaw quarter turn): x right, z forward.
const turned={origin:[10,20,30],x:[0,1,0],y:[0,0,1],z:[1,0,0]};
const listener={name:'player',pawn:true,index:7,location:[0,0,48],eyeHeight:38,showFlags:0x4800};
const cases=[];
// Basic: play, start, control, finish.
cases.push({config,sounds:{door:22050},listener:'player',actors:[listener,{name:'door',index:100,location:[300,100,0]}],
  ops:[{op:'play',actor:'door',id:(100<<4)|(1<<1),sound:'door',location:[300,100,0],volume:1,radius:1600,pitch:1},
    {op:'update',dt:1/60,coords:identity},{op:'update',dt:1/60,coords:turned},{op:'update',dt:1/60,coords:identity,playing:{1:false}}]});
// Channel stealing: four channels, priorities, NoOverride and slot-0 ids.
const steal=[[1,0.5,200],[2,1,900],[3,0.8,100],[4,0.2,1500],[5,1,50],[6,0.9,300]];
cases.push({config:{...config,channels:4},sounds:{a:11025,b:44100},listener:'player',actors:[listener,
  ...steal.map(([i])=>({name:`s${i}`,index:200+i,location:[i*90,-i*40,0]}))],
  ops:[...steal.map(([i,volume,radius])=>({op:'play',actor:`s${i}`,id:((200+i)<<4)|(i%2?2:4),sound:i%2?'a':'b',location:[i*90,-i*40,0],volume,radius,pitch:1})),
    {op:'play',actor:'s5',id:((205)<<4)|2|1,sound:'a',location:[450,-200,0],volume:1,radius:50,pitch:1},
    {op:'play',actor:'s5',id:((205)<<4)|2,sound:'b',location:[450,-200,0],volume:1,radius:2000,pitch:1.5},
    {op:'play',actor:null,id:0,sound:'a',location:[10,10,10],volume:1,radius:500,pitch:1},
    {op:'update',dt:0.02,coords:identity}],counter:-3});
// Ambient: scan, refresh, light, Doppler, leaving range.
cases.push({config,sounds:{hum:22050,fan:11025},listener:'player',actors:[listener,
  {name:'hum',index:300,location:[200,0,48],soundRadius:16,soundVolume:190,soundPitch:64,ambient:'hum',velocity:[120,-40,0]},
  {name:'fan',index:301,location:[-150,80,0],soundRadius:8,soundVolume:255,soundPitch:80,ambient:'fan',lightType:1,lightBrightness:128},
  {name:'far',index:302,location:[9000,0,0],soundRadius:4,soundVolume:255,soundPitch:64,ambient:'hum'}],
  ops:[{op:'update',dt:1/30,coords:identity,light:[0.5]},{op:'update',dt:1/30,coords:turned,light:[1.25]},
    {op:'play',actor:'hum',id:(300<<4)|(1<<1),sound:'fan',location:[200,0,48],volume:1,radius:800,pitch:1},
    {op:'update',dt:0.5,coords:identity,light:[1]},{op:'noteDestroy',actor:'hum'},{op:'update',dt:0.1,coords:identity,light:[1]},
    {op:'stopSoundId',id:(301<<4)|8|1},{op:'stopSoundId',id:12345},{op:'update',dt:0.1,coords:identity,light:[1]}]});
// Occlusion ramps up and down; speech ratio; surround/reverse stereo.
cases.push({config:{...config,useSurround:1,reverseStereo:1,soundVolume:255,speechVolume:128},sounds:{gun:44100,talk:22050},listener:'player',
  actors:[listener,{name:'guard',pawn:true,index:400,location:[-300,-200,40]},{name:'talker',pawn:true,index:401,location:[100,400,40]}],
  ops:[{op:'play',actor:'guard',id:(400<<4)|(1<<1),sound:'gun',location:[-300,-200,40],volume:1,radius:2000,pitch:1},
    {op:'play',actor:'talker',id:(401<<4)|(5<<1),sound:'talk',location:[100,400,40],volume:0.8,radius:1500,pitch:1},
    ...[false,false,false,true,true].map(clear=>({op:'update',dt:0.15,coords:identity,fast:[clear]}))]});
// Equal volumes and a ViewTarget listener.
cases.push({config:{...config,soundVolume:200,speechVolume:200},sounds:{beep:8000},listener:'player',
  actors:[{...listener,viewTarget:'camera'},{name:'camera',index:9,location:[500,500,100]},{name:'box',index:500,location:[520,480,90]}],
  ops:[{op:'play',actor:'box',id:(500<<4)|(3<<1),sound:'beep',location:[520,480,90],volume:0.6,radius:400,pitch:0.75},
    {op:'play',actor:'box',id:(500<<4)|(5<<1),sound:'beep',location:[520,480,90],volume:0.6,radius:400,pitch:1.25},
    {op:'update',dt:0.01,coords:turned},{op:'update',dt:2,coords:turned}]});
// Seeded random sweep.
let seed=0x5eed1234;
const random=()=>(seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32;
const pick=list=>list[Math.floor(random()*list.length)];
const coord=()=>f((random()-.5)*pick([200,2000,8000]));
const unit=()=>{const a=random()*Math.PI*2;return [f(Math.cos(a)),f(Math.sin(a)),0];};
for(let i=0;i<160;i++){
  const actors=[{...listener,location:[coord(),coord(),coord()],pawn:random()<.8,showFlags:pick([0x4800,0x800,0])}];
  const n=2+Math.floor(random()*6);
  for(let k=0;k<n;k++)actors.push({name:`a${k}`,index:1000+k,pawn:random()<.3,location:[coord(),coord(),coord()],
    velocity:[coord()/4,coord()/4,0],soundRadius:Math.floor(random()*64),soundVolume:Math.floor(random()*256),soundPitch:Math.floor(random()*128),
    ...(random()<.4?{ambient:pick(['x','y'])}:{}),lightType:random()<.3?1:0,lightBrightness:Math.floor(random()*256)});
  const ops=[];
  for(let k=0;k<12;k++){
    if(random()<.08){const a=pick(actors.slice(1));ops.push({op:'noteDestroy',actor:a.name});continue;}
    if(random()<.06){const a=pick(actors.slice(1));ops.push({op:'stopSoundId',id:(a.index<<4)|(Math.floor(random()*7)<<1)|(random()<.5?1:0)});continue;}
    if(random()<.55){const a=pick(actors.slice(1));ops.push({op:'play',actor:a.name,id:(a.index<<4)|(Math.floor(random()*7)<<1)|(random()<.2?1:0),
      sound:pick(['x','y']),location:a.location,volume:f(random()),radius:f(pick([64,400,1600,random()*3000+1])),pitch:f(pick([1,0.5,random()*2]))});}
    else{const [ax,ay]=unit();ops.push({op:'update',dt:pick([1/60,1/30,0.2,1]),coords:{origin:[coord(),coord(),coord()],x:[ax,ay,0],y:[0,0,1],z:[ay,-ax,0]},
      fast:Array.from({length:8},()=>random()<.6),light:Array.from({length:4},()=>f(random()*2)),playing:{1:random()<.8,2:random()<.8}});}
  }
  cases.push({config:{...config,channels:pick([4,8,16]),useSurround:random()<.3?1:0,reverseStereo:random()<.3?1:0,
    soundVolume:pick([204,255,128,64]),speechVolume:pick([255,204,128])},sounds:{x:22050,y:11025},listener:'player',actors,ops,counter:-Math.floor(random()*5)});
}
await writeFile(`${directory}/cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')||process.env.GALAXY_REUSE){
  const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-galaxy-audio-oracle.py',gameDirectory(),`${directory}/cases.json`],{encoding:'utf8',maxBuffer:1<<28});
  if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/original.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/original.json`,'utf8'));
assert.equal(reference.results.length,cases.length,'the capture matches the case list (rerun without --reuse)');

function run(c){
  const actors=new Map(),levelInfo={Pauser:''};
  for(const spec of c.actors)actors.set(spec.name,{spec,Location:spec.location.map(f),Velocity:(spec.velocity??[0,0,0]).map(f)});
  const fieldOf={SoundRadius:'soundRadius',SoundVolume:'soundVolume',SoundPitch:'soundPitch',LightType:'lightType',
    LightBrightness:'lightBrightness',EyeHeight:'eyeHeight',ShowFlags:'showFlags'};
  const sounds=Object.fromEntries(Object.entries(c.sounds).map(([name,rate])=>[name,{name,rate}]));
  const read=(object,name)=>{
    if(object===levelInfo)return levelInfo[name];
    if(name==='Location')return object.Location;if(name==='Velocity')return object.Velocity;
    if(name==='Level')return levelInfo;if(name==='AmbientSound')return object.spec.ambient?sounds[object.spec.ambient]:null;
    const key=fieldOf[name];if(!key)throw Error(`unread field ${name}`);
    const value=object.spec[key]??0;return key==='eyeHeight'?f(value):value;
  };
  const listener=actors.get(c.listener);
  let events=[],voices=0,playing={},fast=[],light=[];
  const name=actor=>actor?.spec.name??null;
  const galaxy=createGalaxyAudio({effectsChannels:c.config.channels,ambientFactor:f(c.config.ambientFactor),dopplerSpeed:f(c.config.dopplerSpeed),
    soundVolume:c.config.soundVolume,speechVolume:c.config.speechVolume,useSurround:c.config.useSurround??0,reverseStereo:c.config.reverseStereo??0},{
    listener:()=>({actor:listener,viewTarget:listener.spec.viewTarget?actors.get(listener.spec.viewTarget):null}),read,
    isA:(object,key)=>key==='engine.pawn'&&Boolean(object.spec.pawn),index:actor=>actor.spec.index??0,
    actors:()=>[...actors.values()],isValid:()=>true,atan2:Math.atan2,
    fastLineCheck:(end,start)=>{const clear=fast.length?fast.shift():true;events.push({fastLineCheck:{end:end.map(bits),start:start.map(bits)},clear});return clear;},
    globalLighting:(realtime,actor,volume)=>{const scale=light.length?light.shift():null;const after=scale===null?volume:f(volume*scale);
      events.push({globalLighting:name(actor),realtime:realtime?1:0,volume:bits(volume),after:bits(after)});return after;},
    sample:sound=>sound,voicePlaying:voice=>playing[voice]??true,
    startVoice:(index,sample,frequency,volume,pan)=>{voices++;events.push({start:index,sample:sample.name,frequency,volume,pan,flag:0,voice:voices});return voices;},
    controlVoice:(voice,frequency,volume,pan)=>events.push({control:voice,frequency,volume,pan}),
    stopVoice:voice=>events.push({stop2d:voice}),
  });
  galaxy.state.counter=c.counter??0;
  const channels=()=>galaxy.state.channels.map(ch=>({voice:ch.voice??0,actor:name(ch.actor),id:ch.id,is3D:ch.is3D,sound:ch.sound?.name??null,
    rest:[...ch.location,ch.volume,ch.radius,ch.pitch,ch.priority,ch.time,ch.lipSync,ch.amplitude,ch.occlusion].map(bits)}));
  const results=[];
  for(const op of c.ops){
    events=[];
    if(op.op==='play'){
      const ok=galaxy.playSound(op.actor?actors.get(op.actor):null,op.id|0,sounds[op.sound],op.location.map(f),f(op.volume),f(op.radius),f(op.pitch));
      results.push({op:'play',result:ok?1:0,events,channels:channels(),counter:galaxy.state.counter});
    }else if(op.op==='noteDestroy'){
      galaxy.noteDestroy(actors.get(op.actor));results.push({op:'noteDestroy',events,channels:channels()});
    }else if(op.op==='stopSoundId'){
      galaxy.stopSoundId(op.id|0);results.push({op:'stopSoundId',events,channels:channels()});
    }else{
      playing={...playing,...Object.fromEntries(Object.entries(op.playing??{}).map(([k,v])=>[Number(k),v]))};
      fast=[...(op.fast??[])];light=(op.light??[]).map(f);
      const coords=Object.fromEntries(Object.entries(op.coords).map(([k,v])=>[k,v.map(f)]));
      galaxy.update(op.dt,coords);
      results.push({op:'update',events,channels:channels()});
    }
  }
  return results;
}
// StopSound (0x10607e50) copies a 16-dword stack buffer whose words 5-10
// (Location, Volume, Radius, Pitch) it never initializes: an idle channel
// keeps stack garbage there, which nothing reads until PlaySound overwrites
// it. Mask those words on idle channels on both sides.
const mask=results=>results.map(r=>({...r,channels:r.channels.map(ch=>ch.id===0&&ch.actor===null
  ?{...ch,rest:ch.rest.map((v,k)=>k<6?'idle':v)}:ch)}));
let mismatches=0,ops=0,starts=0,controls=0,faults=0;
for(const [index,c] of cases.entries()){
  const expected=reference.results[index];
  if(expected.fault){faults++;console.log(JSON.stringify({index,fault:expected.fault}));mismatches++;continue;}
  let actual;
  try{actual=run(c);}catch(error){mismatches++;console.log(JSON.stringify({index,error:String(error.message)}));continue;}
  ops+=actual.length;
  for(const r of actual){starts+=r.events.filter(e=>'start' in e).length;controls+=r.events.filter(e=>'control' in e).length;}
  actual=mask(actual);expected.results=mask(expected.results);
  const a=JSON.stringify(actual),e=JSON.stringify(expected.results);
  if(a!==e){
    mismatches++;
    if(mismatches<=3){
      const diff=(a,e,path)=>{
        if(JSON.stringify(a)===JSON.stringify(e))return null;
        if(a&&e&&typeof a==='object'&&typeof e==='object'){
          for(const k of new Set([...Object.keys(a),...Object.keys(e)])){const d=diff(a[k],e[k],`${path}.${k}`);if(d)return d;}
        }
        return {path,actual:a,expected:e};
      };
      console.log(JSON.stringify({index,...diff(actual,expected.results,'')}).slice(0,1500));
    }
  }
}
console.log(JSON.stringify({cases:cases.length,ops,starts,controls,faults,mismatches}));
if(mismatches)process.exitCode=1;
