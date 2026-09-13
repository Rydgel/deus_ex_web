import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {scriptCaps,scriptLen,scriptInStr,scriptMid,scriptLeft,scriptRight,scriptNameToString} from '../src/runtime/script-string-operations.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {extensionStringToName} from '../src/runtime/script-extension-strings.mjs';

const root=gameDirectory(),python=process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
const original=JSON.parse(execFileSync(python,['scripts/native-script-string-oracle.py',root],{encoding:'utf8'}));
for(const c of original.left){
  assert.equal(scriptLeft(c.input,c.take),c.output);
  assert.equal(c.count,c.output.length?c.output.length+1:0);
  assert.equal(c.capacity,c.count);
}
for(const c of original.right){
  assert.equal(scriptRight(c.input,c.take),c.output);
  assert.equal(c.count,c.output.length?c.output.length+1:0);
  assert.equal(c.capacity,c.count);
}
for(const c of original.length){
  assert.equal(c.codeAdvance,2);
  assert.deepEqual(c.events.map(event=>event.kind),['string']);
  assert.equal(c.events[0].value,c.input);
  if(c.input.includes('\0'))assert.throws(()=>scriptLen(c.input),/embedded-zero/);
  else assert.equal(scriptLen(c.input),c.value);
}
for(const c of original.instr){
  assert.equal(c.codeAdvance,3);
  assert.deepEqual(c.events.map(event=>event.kind),['string','string','wcsstr']);
  assert.equal(c.events[0].value,c.input);assert.equal(c.events[1].value,c.needle);
  assert.equal(c.events[2].left,c.input.includes('\0')?c.input.split('\0',1)[0]:c.input);
  assert.equal(c.events[2].right,c.needle.includes('\0')?c.needle.split('\0',1)[0]:c.needle);
  assert.equal(scriptInStr(c.input,c.needle),c.value);
}
for(const c of original.mid){
  assert.equal(c.codeAdvance,4);
  const expectedKinds=c.countArg===null?['string','int']:['string','int','int'];
  assert.deepEqual(c.events.map(event=>event.kind),expectedKinds);
  assert.equal(c.events[0].value,c.input);assert.equal(c.events[1].value,c.start);
  if(c.countArg!==null)assert.equal(c.events[2].value,c.countArg);
  if(c.input.includes('\0'))assert.throws(()=>scriptMid(c.input,c.start,c.countArg??undefined),/embedded-zero/);
  else assert.equal(scriptMid(c.input,c.start,c.countArg??undefined),c.output);
  if(c.input.includes('\0'))assert.equal(c.count,c.raw.length);
  else assert.equal(c.count,c.output?c.output.length+1:0);
  assert.equal(c.capacity,c.count);
}
for(const c of original.midLimits){
  assert.equal(c.codeAdvance,4);
  assert.deepEqual(c.eventKinds,c.countArg===null?['string','int']:['string','int','int']);
  assert.equal(c.capacity,c.count);
  if(c.countArg===null||c.countArg===0xffff)
    assert.equal(c.outputLength,Math.min(0xffff,c.inputLength-c.start));
  else if(c.countArg<0)assert.equal(c.outputLength,c.inputLength-c.start);
}
for(const c of original.caps)assert.equal(scriptCaps(c.input),c.output);
for(const c of original.names){
  assert.equal(scriptNameToString(c.input),c.spelling);
  assert.equal(c.count,c.input.length+1);assert.equal(c.capacity,c.count);assert.equal(c.codeAdvance,1);
}
for(const c of original.extension){
  const events=[];
  const result=extensionStringToName(c.input,{
    logError:({unit,text})=>events.push({op:'error',unit,text}),
    internName:(text,mode)=>{events.push({op:'intern',text,mode});return 84;},
  });
  assert.deepEqual(events,c.events);assert.equal(result,c.index);assert.equal(c.codeAdvance,2);
}
const files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),core=await assets.get('Core');
for(const [path,index] of [['object.concat_strstr',112],['object.equalequal_strstr',122],['object.notequal_strstr',123],
  ['object.left',128],['object.right',234],['object.caps',235]])
  assert.equal(readFunctionMetadata(core,core.exportsByPath.get(path)).nativeIndex,index);
for(const [path,index,scriptSize,parameters] of [
  ['object.len',125,5,[['S','string',false]]],
  ['object.instr',126,10,[['S','string',false],['t','string',false]]],
  ['object.mid',127,15,[['S','string',false],['i','int',false],['j','int',true]]],
]){
  const metadata=readFunctionMetadata(core,core.exportsByPath.get(path));
  assert.equal(metadata.nativeIndex,index);assert.equal(metadata.scriptSize,scriptSize);
  assert.deepEqual(metadata.parameters.filter(parameter=>!parameter.return).map(parameter=>
    [parameter.name,parameter.type,parameter.optional]),parameters);
}
const mapAsset=await assets.get('00_Training'),game=await createGame(decodeMap(mapAsset.bytes),mapAsset,assets,{randomSeed:1});
const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor;
const trigger=runtime.levelFor(player).actors.find(actor=>actor?.name==='DataLinkTrigger23');
let args;
runtime.boundaryFunctions.set('deusex.deusexplayer.startdatalinktransmission',call=>{
  args=Array.from({length:call.argumentCount},(_,i)=>{
    const value=call.evaluateArgument(i);return value?.reference?value.get():value;
  });
  return false; // Explicit capture boundary; no claim about transmission success.
});
runtime.processEvent(trigger,'Touch',[player]);
assert.equal(args[0],'dl_start');assert.equal(args[1],trigger);
console.log(`Original Core.dll string declarations, ${original.length.length} Len cases, ${original.instr.length} InStr cases, ${original.mid.length} Mid cases, ${original.left.length} Left cases, ${original.right.length} Right cases, ${original.caps.length} Caps loop cases, ${original.names.length} GNames conversion cases, ${original.extension.length} Extension StringToName cases and original DataLinkTrigger.Touch argument evaluation passed.`);
