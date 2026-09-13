import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {bindSpeechActor,clearSpeechActors} from '../src/runtime/script-conversation-speech.mjs';
import {clearConversationEvents} from '../src/runtime/script-conversation-clear.mjs';

const python=process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
const cases=JSON.parse(execFileSync(python,['scripts/native-conversation-speech-oracle.py',gameDirectory()],{encoding:'utf8'}));
for(const c of cases){
  const event={speakerName:c.speakerName,speakingToName:c.speakingToName,speaker:0x44444444,speakingTo:0x55555555};
  const actor={BindName:c.BindName,BarkBindName:c.BarkBindName},writes=[];
  const represent=value=>value===actor?'candidate':value??0;
  const write=(object,key,value)=>{object[key]=value;writes.push([key==='speaker'?0x40:0x50,represent(value)]);};
  assert.equal(bindSpeechActor({event,firstActor:c.invoke?actor:null,secondActor:actor,read:(o,k)=>o[k],write}),Boolean(c.result));
  assert.deepEqual([represent(event.speaker),represent(event.speakingTo)],c.fields);
  assert.deepEqual(writes,c.writes);
  writes.length=0;
  event.nextEvent={nextEvent:null};
  clearConversationEvents({eventList:event},{read:(o,k)=>o[k]});
  assert.deepEqual(writes,c.conversationClearWrites);
  assert.deepEqual([represent(event.speaker),represent(event.speakingTo)],c.conversationClearFields);
  clearSpeechActors(event,{write});assert.deepEqual(writes,c.clearWrites);
}
console.log(`Original ConSys speech binding and clearing passed ${cases.length} name/bark/invoker/reference cases.`);
