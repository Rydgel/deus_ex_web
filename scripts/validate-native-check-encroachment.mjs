import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
const reuse=process.argv.includes('--reuse'),captureOnly=process.argv.includes('--capture-only'),dir='reports/movement/native-check-encroachment';await mkdir(dir,{recursive:true});
let cases;
if(reuse)cases=JSON.parse(await readFile(dir+'/cases.json'));
else{
 cases=[];
 for(const flags of [0,1,2,4,8,15])for(const otherFlags of [0,1,2,4,8,15])for(const kind of ['Actor','Pawn','Player','Projectile','Brush'])for(const notify of [0,1])for(const reject of [[],['a']]){
  cases.push({actors:[{id:'s',kind:'Player',flags},{id:'a',kind,flags:otherFlags}],hits:['a'],notify,reject});
 }
 for(const notify of [0,1])cases.push({actors:[{id:'s',kind:'Player',touching:['old',null,null,null]},{id:'old',position:[500,0,0],touching:['s',null,null,null]},{id:'a',flags:1}],hits:['a'],notify});
 for(const op of ['begin','end'])for(const slot of [0,1,2,3])for(const present of [false,true])for(const suppress of [0,1]){
  const touching=Array(4).fill(null);if(present)touching[slot]='a';
  cases.push({op,source:'s',other:'a',noNotifySelf:suppress,actors:[{id:'s',kind:'Player',touching},{id:'a',touching:present?['s',null,null,null]:[]} ]});
 }
 cases.push({op:'begin',source:'s',other:'a',cancelTouch:'s',actors:[{id:'s',kind:'Player'},{id:'a'}]});
 for(const position of [[0,0,0],[40,0,0],[39.99999,0,0],[0,0,86],[0,0,85.99999]])for(const kind of ['Actor','Brush'])cases.push({op:'overlap',source:'s',other:'a',actors:[{id:'s',kind:'Player'},{id:'a',kind,position}]});
 for(const incoming of ['Actor','Pawn','Player'])for(const existing of ['Actor','Pawn','Player'])for(const stopped of [[],[0],[1,3],[0,1,2,3]]){
  cases.push({op:'begin',source:'s',other:'a',actors:[{id:'s',kind:'Player',touching:['b0','b1','b2','b3']},{id:'a',kind:incoming},...Array.from({length:4},(_,i)=>({id:'b'+i,kind:existing,physics:stopped.includes(i)?0:1,touching:['s',null,null,null]}))]});
 }
 for(const incoming of ['Pawn','Player'])for(let slot=0;slot<4;slot++)for(const preferred of ['Actor','Pawn']){
  cases.push({op:'begin',source:'s',other:'a',actors:[{id:'s',kind:'Player',touching:['b0','b1','b2','b3']},{id:'a',kind:incoming},...Array.from({length:4},(_,i)=>({id:'b'+i,kind:i===slot?preferred:'Player',touching:['s',null,null,null]}))]});
 }
 for(const changeFlags of [{s:1},{a:1},{b:1},{s:15}])for(const notify of [0,1])cases.push({actors:[{id:'s',kind:'Player'},{id:'a'},{id:'b'}],hits:['$world','s','a','b'],changeFlags,notify});
 await writeFile(dir+'/cases.json',JSON.stringify(cases));
}
let original;
if(reuse)original=JSON.parse(await readFile(dir+'/original.json'));
else{const r=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-check-encroachment-oracle.py',gameDirectory(),dir+'/cases.json'],{encoding:'utf8',maxBuffer:32*1024*1024});if(r.status!==0)throw Error(r.stderr);await writeFile(dir+'/original.json',r.stdout);original=JSON.parse(r.stdout);}
assert.equal(original.casesSha256,createHash('sha256').update(await readFile(dir+'/cases.json')).digest('hex'),'Original capture must match input cases');
if(captureOnly){console.log(cases.length,'original cases captured');process.exit(0);}
const {checkPlayerEncroachment}=await import('../src/runtime/check-encroachment.mjs'),{beginTouch,endTouch,isOverlapping}=await import('../src/runtime/actor-touch.mjs');
const mismatches=[];
cases.forEach((c,i)=>{
 const actors=c.actors.map(a=>({...a,position:a.position??[0,0,0],radius:a.radius??20,height:a.height??43,flags:a.flags??15,physics:a.physics??1,pawnFlags:a.kind==='Player'?2:0,controlledPlayer:a.kind==='Player',isPawn:a.kind==='Player'||a.kind==='Pawn',projectile:a.kind==='Projectile',movingBrush:a.kind==='Brush',touching:(a.touching??[]).concat(Array(4).fill(null)).slice(0,4)})),byId=new Map(actors.map(a=>[a.id,a])),world={id:'$world'};
 for(const a of actors){a.touching=a.touching.map(id=>byId.get(id)??null);a.worldActor=world;}
 const source=byId.get(c.source??'s'),other=byId.get(c.other),events=[];
 const dispatch=(a,event,args)=>{events.push({event,actor:a.id,other:args[0].id,touching:a.touching.map(a=>a?.id??null)});if(event==='EncroachingOn')for(const [id,flags]of Object.entries(c.changeFlags??{}))byId.get(id).flags=flags;if(event==='Touch'&&c.cancelTouch===a.id)a.touching=a.touching.map(x=>x===args[0]?null:x);return event==='EncroachingOn'&&(c.reject??[]).includes(args[0].id);};
 let result=null;
 if(c.op==='begin')beginTouch(source,other,dispatch);
 else if(c.op==='end')endTouch(source,other,c.noNotifySelf,dispatch);
 else if(c.op==='overlap')result=isOverlapping(source,other);
 else result=checkPlayerEncroachment(source,c.position??[100,0,0],[0,0,0],c.notify??1,{worldActor:world,encroachmentCheck:(a,position,rotation,extra)=>{events.push({query:{actor:a.id,position,rotation,extra}});return (c.hits??[]).map(id=>({actor:byId.get(id)??world}));},dispatch});
 const actual={result,events,touching:Object.fromEntries(actors.map(a=>[a.id,a.touching.map(a=>a?.id??null)]))};
 try{assert.deepEqual(actual,original.results[i]);}catch{mismatches.push({index:i,input:c,actual,expected:original.results[i]});}
});
await writeFile(dir+'/comparison.json',JSON.stringify({cases:cases.length,mismatches}));console.log(JSON.stringify({cases:cases.length,mismatchCount:mismatches.length,examples:mismatches.slice(0,5)}));assert.equal(mismatches.length,0);
