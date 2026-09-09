import fs from 'node:fs';import{spawnSync}from'node:child_process';import{walkingSurfacePrelude}from'../src/runtime/walking-surface.mjs';
export function surfaceCases(){return [
 {position:[0,0,45],rotation:[0,0,0],radius:20,height:43},
 {position:[123.4,-25.1,33.333],rotation:[0,7151,0],radius:20,height:16},
 {position:[0,0,45],rotation:[0,0,0],radius:20,height:43,everyHit:true},
 ...[0,8,9,17,18,26,27,35,36].map(hitAt=>({position:[13,-27,105],rotation:[900,51411,42],radius:20,height:43,hitAt})),...[0,9,18,27,35].map(hitAt=>({position:[0,0,45],rotation:[0,0,0],radius:20,height:43,group:'Ladder',hitAt}))];}
export function runSurface(c){let index=0;const events=[],texture={key:'fixture.Concrete.Floor',outerName:c.group??'Concrete',friction:1};const pawn={...c,physics:1,
 lineCheck(start,end,extent,flags){events.push({line:{start:[...start],end,extent,flags}});const hit=c.everyHit||c.hitAt===index++;return {time:hit?.5:1,location:end,normal:[0,0,hit?1:0],texture:hit?texture:null};},
 textureForHit(hit){return hit.texture;},walkTexture(t,location,normal){events.push({walkTexture:!!t,location,normal});}};
 try{return {handled:walkingSurfacePrelude(pawn),events};}catch(error){if(!error.message.startsWith('Unsupported original Ladder'))throw error;events.push({unsupported:'Ladder'});return {handled:false,events};}}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1]){
 fs.mkdirSync('.cache/walking',{recursive:true});const cases=surfaceCases();fs.writeFileSync('.cache/walking/surface-cases.json',JSON.stringify(cases));
 const n=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-walking-surface-oracle.py',process.env.DEUS_EX_ROOT??'Deus Ex GOTY Edition','.cache/walking/surface-cases.json'],{encoding:'utf8'});if(n.status)throw Error(n.stderr);fs.writeFileSync('.cache/walking/surface-native.json',n.stdout);
 const native=JSON.parse(n.stdout).results,failures=[];cases.forEach((c,i)=>{const actual=runSurface(c);if(JSON.stringify(actual)!==JSON.stringify(native[i]))failures.push({i,actual,expected:native[i]});});fs.writeFileSync('.cache/walking/surface-comparison.json',JSON.stringify({cases:cases.length,failures},null,2));console.log({cases:cases.length,failures:failures.length});process.exitCode=failures.length?1:0;
}
