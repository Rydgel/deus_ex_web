/** UGalaxyAudioSubsystem PlaySound/Update (src/runtime/galaxy-audio.mjs)
 * against the original bodies run by scripts/native-galaxy-audio-oracle.py
 * (docs/galaxy-audio.md). Each case scripts PlaySound and Update calls over
 * a listener, actors and registered sounds; the comparison covers every
 * return, the Galaxy voice calls (start, control, stop, status), the
 * FastLineCheck and GlobalLighting requests, and every channel record bit
 * after each call. The cases and the runner are scripts/galaxy-audio-cases.mjs's.
 *
 * The arithmetic runs in the Rust core's galaxy.rs, as in Play (the kernel is
 * loaded first); GALAXY_AUDIO_BODY=js runs the BigInt reference body instead.
 *
 *   node scripts/validate-native-galaxy-audio.mjs [--reuse]
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {loadScriptVmKernel,scriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';
import {gameDirectory} from './game-directory.mjs';
import {buildCases,runCase,mask} from './galaxy-audio-cases.mjs';
const directory='.cache/galaxy-audio';await mkdir(directory,{recursive:true});
const reference_body=process.env.GALAXY_AUDIO_BODY==='js';
if(!reference_body){
  await loadScriptVmKernel();
  assert.ok(scriptVmKernel.galaxy,'the script VM kernel has no galaxy.rs exports (npm run build:wasm)');
}
const options=reference_body?{kernel:null}:{};
const cases=buildCases();
await writeFile(`${directory}/cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')||process.env.GALAXY_REUSE){
  const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-galaxy-audio-oracle.py',gameDirectory(),`${directory}/cases.json`],{encoding:'utf8',maxBuffer:1<<28});
  if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/original.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/original.json`,'utf8'));
assert.equal(reference.results.length,cases.length,'the capture matches the case list (rerun without --reuse)');

let mismatches=0,ops=0,starts=0,controls=0,faults=0;
for(const [index,c] of cases.entries()){
  const expected=reference.results[index];
  if(expected.fault){faults++;console.log(JSON.stringify({index,fault:expected.fault}));mismatches++;continue;}
  let actual;
  try{actual=runCase(c,options);}catch(error){mismatches++;console.log(JSON.stringify({index,error:String(error.message)}));continue;}
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
console.log(JSON.stringify({cases:cases.length,ops,starts,controls,faults,mismatches,body:reference_body?'js':'rust'}));
if(mismatches)process.exitCode=1;
