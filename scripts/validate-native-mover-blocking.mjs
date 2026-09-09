import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gameDirectory} from './game-directory.mjs';
const dir='reports/movement/native-mover-blocking',reuse=process.argv.includes('--reuse');await mkdir(dir,{recursive:true});
const cases=reuse?JSON.parse(await readFile(dir+'/cases.json')):[];
if(!reuse){for(const sourceFlags of [0,2,4,8,12,15])for(let otherFlags=0;otherFlags<16;otherFlags++)for(const kind of ['Actor','Pawn','Player','UncontrolledPlayer','Projectile','Brush','World'])cases.push({sourceFlags,otherFlags,kind});await writeFile(dir+'/cases.json',JSON.stringify(cases));}
let original;if(reuse)original=JSON.parse(await readFile(dir+'/original.json'));else{const r=spawnSync('.cache/native-probe-env/bin/python',['scripts/native-mover-blocking-oracle.py',gameDirectory(),dir+'/cases.json'],{encoding:'utf8',maxBuffer:16*1024*1024});if(r.status!==0)throw Error(r.stderr);original=JSON.parse(r.stdout);await writeFile(dir+'/original.json',r.stdout);}
assert.equal(original.casesSha256,createHash('sha256').update(await readFile(dir+'/cases.json')).digest('hex'));
if(process.argv.includes('--capture-only')){console.log(cases.length,'original cases captured');process.exit(0);}
const {moverBlockedBy}=await import('../src/runtime/check-encroachment.mjs');
const mismatches=[];cases.forEach((c,i)=>{const world={},source={movingBrush:true,flags:c.sourceFlags,worldActor:world},other=c.kind==='World'?world:{movingBrush:c.kind==='Brush',controlledPlayer:c.kind==='Player',flags:c.otherFlags};const actual=moverBlockedBy(source,other);if(actual!==original.results[i])mismatches.push({case:c,actual,expected:original.results[i]});});await writeFile(dir+'/comparison.json',JSON.stringify({cases:cases.length,mismatches}));console.log({cases:cases.length,mismatchCount:mismatches.length});assert.deepEqual(mismatches,[]);
