import assert from'node:assert/strict';import{mkdir,writeFile}from'node:fs/promises';import{execFile}from'node:child_process';import{promisify}from'node:util';import path from'node:path';import{gameDirectory}from'./game-directory.mjs';import{createDoorState,gotoDoorLabel,processDoorState}from'../src/runtime/door-state.mjs';
const cases=[['open','process','process','physicsEnd','process'],['open','open','process','physicsEnd','close','process','physicsEnd','process']];
const dir=path.resolve('reports/movement/door-state');await mkdir(dir,{recursive:true});const file=path.join(dir,'cases.json');await writeFile(file,JSON.stringify(cases));const{stdout}=await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON??'python3',['scripts/native-door-state-oracle.py',gameDirectory(),file],{maxBuffer:1024*1024,timeout:120000});await writeFile(path.join(dir,'original.json'),stdout);const native=JSON.parse(stdout);
const actual=cases.map(operations=>{const door=createDoorState({key:0,previousKey:0,interpolating:false},{MoveTime:2}),events=[];return operations.map(operation=>{if(operation==='open'||operation==='close')gotoDoorLabel(door,operation);else if(operation==='physicsEnd')door.interpolation.interpolating=false;else{const was=door.code;processDoorState(door,{interpolateTo:(d,key)=>{events.push(key===1?'DoOpen':'DoClose');d.interpolation.interpolating=true;},playSound:()=>{},finishNotify:()=>events.push(was==='finishOpen'?'FinishedOpening':'FinishedClosing'),dispatch:()=>{}});if(was&&!door.code)events.push('Stop');}return{operation,events:events.slice(),latent:door.latent,interpolating:door.interpolation.interpolating,code:!!door.code};});});assert.deepEqual(actual,native.results);await writeFile(path.join(dir,'comparison.json'),JSON.stringify({cases:cases.length,hashes:native.hashes,mismatches:[]},null,2));console.log(`${cases.length} original scheduling cases exact`);

// ProcessState returns on null Code before it reads the untouched latent slot.
const emptyFile=path.join(dir,'empty-code.json');
await writeFile(emptyFile,JSON.stringify([['poisonEmpty','process']]));
const emptyRun=await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON??'python3',
  ['scripts/native-door-state-oracle.py',gameDirectory(),emptyFile],{timeout:120000});
const empty=JSON.parse(emptyRun.stdout).results[0];
assert.equal(empty[1].latent,0xdeadbeef);
assert.deepEqual(empty[1].events,[]);
const {ScriptState}=await import('../src/runtime/script-state.mjs');
const state=new ScriptState({}, {pollLatent:()=>{throw Error('must not poll null Code');}});
state.latent=undefined; state.process(1/60);
assert.equal(state.latent,undefined);
console.log('Original null-Code ProcessState preserves unread latent storage');
