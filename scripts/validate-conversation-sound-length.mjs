import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {decodeSoundResource} from '../src/runtime/script-sound-resource.mjs';
import {loadSoundDataSpecial} from '../src/runtime/script-sound-load.mjs';
import {CONVERSATION_BITRATES, conversationSoundLength, conversationSpeechLength}
  from '../src/runtime/script-conversation-sound-length.mjs';
import {gameDirectory} from './game-directory.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';

const root=gameDirectory();
const assets=new AssetStore((await readdir(path.join(root,'System'))).map(name=>({
  path:`System/${name}`,read:()=>readFile(path.join(root,'System',name)),
})));
const asset=await assets.get('DeusExSounds');
const entry=asset.pkg.exports[asset.exportsByPath.get('special.switch4clickon')-1];
const wave=decodeSoundResource({pkg:asset.pkg,bytes:asset.bytes,entry}).bytes;
// DL_Start's first speech selects this original Mission00 audio export. Its
// compressed bytes go to native timing directly; no WAV decoder is substituted.
const conversationAsset=await assets.get('DeusExConText');
const originalConversation=readObject(conversationAsset.pkg,conversationAsset.bytes,1926).values;
assert.equal(originalConversation.conName,'DL_Start');
assert.equal(originalConversation.audioPackageName,'Mission00');
assert.equal(originalConversation.eventList,32934);
const originalEvent=readObject(conversationAsset.pkg,conversationAsset.bytes,originalConversation.eventList).values;
assert.equal(originalEvent.ConSpeech,32839);
assert.equal(readObject(conversationAsset.pkg,conversationAsset.bytes,originalEvent.ConSpeech).values.soundID,79);
const speechAsset=await assets.get('DeusExConAudioMission00');
const speechEntry=speechAsset.pkg.exports[speechAsset.exportsByPath.get('conaudiomission00_79')-1];
assert.equal(speechEntry.serialOffset,4109855);
assert.equal(speechEntry.serialSize,43065);
const speechHeader=decodeSoundResource({pkg:speechAsset.pkg,bytes:speechAsset.bytes,entry:speechEntry});
const speechBytes=speechAsset.bytes.subarray(speechEntry.serialOffset+speechHeader.lazy.inlineOffset,
  speechEntry.serialOffset+speechHeader.lazy.inlineOffset+speechHeader.lazy.byteCount);
const encoded=bytes=>Buffer.from(bytes).toString('base64');
const cases=[
  {name:'original-switch',bytesBase64:encoded(wave)},
  {name:'null-sound',nullSound:true},
  {name:'null-data'},
  {name:'invalid-header',bytesBase64:encoded([1,2,3,4])},
  {name:'speech-minus-one',soundID:-1,nullSound:true},
  {name:'speech-null',soundID:123,nullSound:true},
  {name:'speech-switch',soundID:123,bytesBase64:encoded(wave)},
  {name:'original-dl-start-speech',soundID:79,bytesBase64:encoded(speechBytes)},
];
for(const [name,version,layer,row] of [
  ['mpeg-column0',0x1800,0x600,9],['mpeg-column1',0x1800,0x400,9],
  ['mpeg-column2',0x1800,0x200,9],['mpeg-column3',0x1000,0x600,9],
  ['mpeg-column4',0,0x200,9],['mpeg-sentinel',0x1800,0x200,0],
]){
  const bytes=Buffer.alloc(4);bytes.writeUInt32LE(0xe0ff|version|layer|(row<<20));
  cases.push({name,bytesBase64:encoded(bytes),num:12345});
}
const directory=await mkdtemp(path.join(os.tmpdir(),'deus-ex-conversation-length-'));
try{
  const casesFile=path.join(directory,'cases.json');
  await writeFile(casesFile,JSON.stringify(cases));
  const result=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
    ['scripts/native-conversation-sound-length-oracle.py',root,casesFile],{encoding:'utf8',maxBuffer:2**20}));
  assert.equal(result.conSysHash,'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa');
  assert.deepEqual(result.bitrates,CONVERSATION_BITRATES);
  for(const [index,record] of cases.entries()){
    const bytes=record.bytesBase64===undefined?null:new Uint8Array(Buffer.from(record.bytesBase64,'base64'));
    const sound=record.nullSound?null:{soundData:{lazyField08:-1,array:{data:bytes,num:record.num??bytes?.length??0}}};
    const events=[];
    const length=object=>conversationSoundLength(object,{
      read:(object,key)=>object[key],
      loadSpecial:data=>{
        events.push({op:'LoadSpecial'},{op:'LazyLoad'});
        return loadSoundDataSpecial(data,{read:(object,key)=>object[key]});
      },
      log:text=>events.push({op:'log',text}),
    });
    const value=Object.hasOwn(record,'soundID')?conversationSpeechLength({},record.soundID,{
      getSpeechAudio:(conversation,soundID)=>{events.push({op:'GetSpeechAudio',soundID});return sound;},
      getSoundLength:length,
    }):length(sound);
    assert.equal(value,result.cases[index].value,record.name);
    assert.deepEqual(events,result.cases[index].events,`${record.name} native service order`);
  }
  // New integration boundary: original prepared native2056 declaration, shared
  // dispatch and explicit already-loaded Sound storage; lookup remains a leaf.
  const runtime=new ScriptRuntime(assets);
  const conSys=await assets.get('ConSys'), conversation={};
  runtime.attach(conversation,await runtime.loadClass(conSys,conSys.exportsByPath.get('conversation')));
  const fn=await runtime.prepareFunction(conSys,conSys.exportsByPath.get('conversation.getspeechlength'));
  assert.equal(runtime.callFunction(fn,conversation,1,()=>-1),0);
  assert.throws(()=>runtime.callFunction(fn,conversation,1,()=>123),/GetSpeechAudio native loading/);
  const sound={soundData:{lazyField08:-1,array:{data:wave,num:wave.length}}};
  runtime.conversationLifecycle={audio:{
    getSpeechAudio:(receiver,soundID)=>{
      assert.equal(receiver,conversation);assert.equal(soundID,123);return sound;
    },
    read:(object,key)=>object[key],
    loadSpecial:data=>loadSoundDataSpecial(data,{read:(object,key)=>object[key]}),
    log:()=>assert.fail('Valid original WAV must not warn'),
  }};
  assert.equal(runtime.callFunction(fn,conversation,1,()=>123),
    result.cases.find(record=>record.name==='speech-switch').value);
  console.log('Original conversation timing passed: switch WAV, five MPEG columns and sentinel, null/invalid branches, GetSpeechLength, and unchanged LoadSpecial/lazy Load.');
  console.log('Shared native2056 dispatch matches the original speech-switch result; unbound audio lookup fails explicitly.');
  console.log(`Original DL_Start speech: format=${speechHeader.lazy.formatName}, bytes=${speechBytes.length}, seconds=${result.cases.find(record=>record.name==='original-dl-start-speech').value}.`);
}finally{await rm(directory,{recursive:true,force:true});}
