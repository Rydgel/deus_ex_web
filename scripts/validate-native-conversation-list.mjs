import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {bindConversationsNative,asciiCaseEqual,caseSensitiveContains} from '../src/runtime/script-native-conversation-list.mjs';

const original=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python',
  [fileURLToPath(new URL('./native-conversation-list-oracle.py',import.meta.url)),gameDirectory()],
  {encoding:'utf8',maxBuffer:8*1024*1024}));
assert.equal(original.hash,'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa');
for(const expected of original.cases){
  const ops=[],allocated=[];
  const conversations=[['NormalLine','Normal'],['Yes_Bark','Barker'],['Normal_Bark','Normal'],['lower_bark','Normal']]
    .map(([conName,conOwnerName],i)=>({label:conName,conName,conOwnerName,ownerRefCount:i===0?1:0}));
  const source=conversations.map(ConObject=>({ConObject,Next:null}));
  source.forEach((item,i)=>{item.Next=source[i+1]??null;});
  const list={conversations:source[0],Outer:{label:'outer'}};
  const actor={label:'actor',BindName:'Normal',BarkBindName:expected.case==='empty-bark'?'':'Barker',
    ConListItems:{label:'old',con:conversations[0],next:null}};
  let repeatChanged=false;
  const label=value=>typeof value==='object'&&value!==null?value.label:value;
  bindConversationsNative({list,actor,reference:value=>value,
    read:(object,field)=>object[field],
    write:(object,field,value)=>{
      ops.push(['write',object.label,field,label(value)]);object[field]=value;
    },
    equalText:(left,right)=>{
      const result=asciiCaseEqual(left,right);ops.push(['compare',left,right,result]);
      if(expected.case==='repeat-name-change'&&right===''&&!repeatChanged){
        repeatChanged=true;actor.BarkBindName='';
      }
      return result;
    },
    containsText:(left,right)=>{
      const result=caseSensitiveContains(left,right);ops.push(['contains',left,right,result]);return result;
    },
    allocate:details=>{
      assert.equal(details.name,'None');
      ops.push(['allocate',details.size,label(details.outer),0,details.flags]);
      const object={label:`bound${allocated.length}`,ObjectFlags:0x20,con:null,next:null};
      allocated.push(object);return object;
    },
    construct:({object})=>{ops.push(['construct',label(object)]);object.con=null;object.next=null;},
    deleteObject:({object,flags})=>{
      ops.push(['delete',label(object),flags,label(actor.ConListItems)]);
      list.conversations=null; // Original has saved the head before this call.
    },
  });
  const bound=[];
  for(let item=actor.ConListItems;item;item=item.next)bound.push(item.con.conName);
  assert.deepEqual(ops,expected.ops,`${expected.case}: original comparison, mutation, allocation and deletion order`);
  assert.deepEqual(bound,expected.bound);
  assert.deepEqual(conversations.map(con=>con.ownerRefCount),expected.counts);
}
console.log('Original ConSys list binding/purge passed bark branches, saved source head, reference counts, flags, prepend and service-call order.');
