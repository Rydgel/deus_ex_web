/** AMover::physMovingBrush (src/runtime/mover-interpolation.mjs) against the
 * original body executed by scripts/native-mover-interpolation-oracle.py with
 * controlled MoveActor responses (docs/doors.md "physMovingBrush"). Cases: the
 * Training translating pair, rotating keys (the UNATCO Island cell door's yaw
 * quarter turn), every KeyNum 0..7, the clamp to 8 and its reads past both
 * arrays, int32 rotator wrap and _ftol overflow, rejected moves, an
 * InterpolateEnd that leaves PhysAlpha to the VM, and a seeded random sweep.
 *
 *   node scripts/validate-native-mover-interpolation.mjs [--reuse]
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {physMovingBrush} from '../src/runtime/mover-interpolation.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/doors';await mkdir(directory,{recursive:true});
const f=Math.fround,ZERO=[0,0,0];
const bitsView=new DataView(new ArrayBuffer(4));
const bits=v=>(bitsView.setFloat32(0,v,true),bitsView.getUint32(0,true));
const cases=[];
const basic={rate:.5,position:[-220,800,-64],rotation:[0,16384,0],oldPosition:[-220,800,-64],basePosition:[-220,800,-64],keyPosition:[0,-56,0]};
for(const alpha of [0,.25,.5,.75,.99,1])for(const dt of [0,.000001,.01,.5])cases.push({...basic,alpha,dt});
for(const override of [{alpha:.99,dt:.1,responses:[false,false]},{alpha:0,dt:1/120},{alpha:0,dt:.5,interpolating:false},{alpha:.25,dt:.125,glideType:0},{alpha:.75,dt:.125,keyPosition:[0,0,0],oldPosition:[-220,744,-64],position:[-220,791.25,-64]}])cases.push({...basic,...override});
// UNATCO Island DeusExMover10: BasePos [1824,-1744,48], KeyRot[1] yaw 16384.
const cell={rate:.5,position:[1824,-1744,48],basePosition:[1824,-1744,48],oldPosition:[1824,-1744,48],
 keyPositions:Array(8).fill(ZERO),keyRotations:[ZERO,[0,16384,0],...Array(6).fill(ZERO)],
 baseRotation:ZERO,oldRotation:ZERO,rotation:ZERO,keyNum:1};
for(const alpha of [0,.1,.5,.9])for(const dt of [1/120,1/60,.25,3])for(const glideType of [0,1])cases.push({...cell,alpha,dt,glideType});
cases.push({...cell,alpha:.5,dt:.5,oldRotation:[0,16384,0],rotation:[0,16384,0],keyNum:0,endAlpha:null});
cases.push({...cell,alpha:.2,dt:.1,oldRotation:[0,-16384,0],baseRotation:[0,32768,0],rotation:[0,-16384,0]});
cases.push({...cell,alpha:.4,dt:3,responses:[false,true],endAlpha:null});
// Every key slot, a distinct position and rotation per key.
const keyed=Array.from({length:8},(_,k)=>[k*16-40,k*-24+8,k*k*3.25]);
const keyRots=Array.from({length:8},(_,k)=>[k*1000-3000,k*-8192,k*700]);
for(let keyNum=0;keyNum<8;keyNum++)cases.push({rate:1/3,position:[10,20,30],basePosition:[10,20,30],oldPosition:[12.5,18,30.25],
 keyPositions:keyed,keyRotations:keyRots,baseRotation:[100,-200,300],oldRotation:[-50,4000,0],rotation:[-50,4000,0],keyNum,alpha:.3,dt:.4});
// KeyNum >= 8 clamps to 8: KeyPos[8] reads KeyRot[0], KeyRot[8] reads BasePos.
for(const keyNum of [8,9,255])cases.push({rate:2,position:[1,2,3],basePosition:[1,2,3],oldPosition:[1,2,3],
 keyPositions:keyed,keyRotations:[[0x3f800000,0x40000000,-0x40800000],...keyRots.slice(1)],baseRotation:ZERO,oldRotation:ZERO,rotation:ZERO,keyNum,alpha:0,dt:.25});
// int32 wrap in the span and _ftol of products outside int32 / int64.
cases.push({...cell,keyRotations:[ZERO,[0x7fffffff,0x7fffffff,-0x80000000],...Array(6).fill(ZERO)],baseRotation:[0x7fffffff,1,-1],oldRotation:[-0x80000000,-0x7fffffff,0x7fffffff],alpha:.5,dt:.25});
cases.push({...cell,keyRotations:[ZERO,[0x40000000,-0x40000000,0x7fff0000],...Array(6).fill(ZERO)],oldRotation:[-0x40000000,0x40000000,-0x7fff0000],alpha:-3,rate:1,dt:.5});
cases.push({...cell,alpha:1.5,dt:.1});
cases.push({...cell,alpha:.5,rate:1e30,dt:.5});
// Seeded random sweep over every input the body reads.
let seed=0x13579bdf;
const random=()=>(seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32;
const pick=list=>list[Math.floor(random()*list.length)];
const coord=()=>f((random()-.5)*pick([1,64,4096,1e6]));
const angle=()=>pick([()=>Math.floor((random()-.5)*131072),()=>Math.floor((random()-.5)*2**32)|0,()=>pick([0,16384,-16384,32768])])();
for(let i=0;i<200;i++){
 const keyNum=pick([0,1,2,3,7,8,12]);
 cases.push({rate:f(pick([.5,1/3,2,200,random()*4])),alpha:f(pick([0,1,random(),random()*2-.5])),dt:f(pick([1/120,1/30,random(),random()*5])),
  glideType:pick([0,1,1,2]),keyNum,position:[coord(),coord(),coord()],basePosition:[coord(),coord(),coord()],oldPosition:[coord(),coord(),coord()],
  keyPositions:Array.from({length:8},()=>[coord(),coord(),coord()]),keyRotations:Array.from({length:8},()=>[angle(),angle(),angle()]),
  baseRotation:[angle(),angle(),angle()],oldRotation:[angle(),angle(),angle()],rotation:[angle(),angle(),angle()],
  responses:Array.from({length:4},()=>random()<.8),endAlpha:pick([0,null])});
}
await writeFile(`${directory}/cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-mover-interpolation-oracle.py',gameDirectory(),`${directory}/cases.json`],{encoding:'utf8',maxBuffer:1<<26});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/original.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/original.json`,'utf8'));
assert.equal(reference.results.length,cases.length,'the capture matches the case list (rerun without --reuse)');
let mismatches=0,moves=0,ends=0;
for(const [index,c] of cases.entries()){
 const rotation=c.rotation??ZERO;
 const state={key:c.keyNum??1,alpha:f(c.alpha),rate:f(c.rate),interpolating:c.interpolating??true,
  keyPositions:(c.keyPositions??[ZERO,c.keyPosition,...Array(6).fill(ZERO)]).map(v=>v.map(f)),keyRotations:(c.keyRotations??Array(8).fill(ZERO)).map(v=>v.slice()),
  basePosition:c.basePosition.map(f),oldPosition:c.oldPosition.map(f),baseRotation:(c.baseRotation??rotation).slice(),oldRotation:(c.oldRotation??rotation).slice()};
 const events=[],responses=(c.responses??[]).slice(),endAlpha=c.endAlpha===undefined?0:c.endAlpha;
 let position=c.position.map(f),current=rotation.slice();
 physMovingBrush(state,c.dt,{location:()=>position,glideType:()=>c.glideType??1,
  move:(delta,newRotation)=>{
   const success=responses.length?responses.shift():true;events.push({move:delta.map(bits),rotation:newRotation,success});
   // The harness's own Location update, as the oracle's double sum packed to float.
   if(success){position=position.map((v,i)=>f(v+delta[i]));current=newRotation.slice();}
   return success;
  },
  interpolateEnd:()=>{events.push({interpolateEnd:true});if(endAlpha!==null)state.alpha=f(endAlpha);}});
 moves+=events.filter(e=>e.move).length;ends+=events.filter(e=>e.interpolateEnd).length;
 const actual={events,position:position.map(bits),rotation:current,alpha:bits(state.alpha),interpolating:state.interpolating};
 const expected=reference.results[index];
 const same=JSON.stringify(actual)===JSON.stringify(expected);
 if(!same){mismatches++;if(mismatches<=5)console.log(JSON.stringify({index,actual,expected}).slice(0,2000));}
}
console.log(JSON.stringify({cases:cases.length,moves,interpolateEnds:ends,mismatches}));
if(mismatches)process.exitCode=1;
