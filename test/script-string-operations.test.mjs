import assert from 'node:assert/strict';
import test from 'node:test';
import { scriptStringEqual, scriptLen, scriptInStr, scriptMid, scriptCaps, scriptLeft, scriptRight, scriptAt, scriptNameToString, scriptObjectToString } from '../src/runtime/script-string-operations.mjs';
import { compileFunction } from '../src/runtime/script-vm.mjs';

test('ObjectToString preserves the package and Outer path used to reload carried bodies',()=>{
  const carcass={kind:'Class',name:'UNATCOTroopCarcass',asset:{name:'DeusEx'},entry:{path:'UNATCOTroopCarcass'}};
  assert.equal(scriptObjectToString(carcass),'DeusEx.UNATCOTroopCarcass');
  assert.equal(scriptObjectToString(null),'None');
  assert.equal(scriptObjectToString({name:'Child',outer:{name:'Parent',outer:{name:'Package'}}}),
    'Package.Parent.Child');
  const identity={},record={name:'LiveChild',outer:{name:'Transient'}};
  assert.equal(scriptObjectToString(identity,value=>value===identity?record:value),'Transient.LiveChild');
});

test('string comparisons use terminated UTF-16 text and Caps folds only ASCII',()=>{
  assert.equal(scriptStringEqual('A\0ignored','A'),true);
  assert.equal(scriptStringEqual('a','A'),false);
  assert.equal(scriptCaps('éßıσ aAzZ09_`{'),'éßıσ AAZZ09_`{');
  assert.throws(()=>scriptCaps('A\0B'),/embedded-zero/);
  assert.throws(()=>scriptNameToString(null),/FName spelling/);
  assert.equal(scriptLen('A😃Z'),4);
  assert.throws(()=>scriptLen('A\0B'),/embedded-zero/);
  assert.equal(scriptInStr('A😃Z','😃'),1);
  assert.equal(scriptInStr('a\0b','b'),-1);
  assert.equal(scriptMid('abc',1,2),'bc');
  assert.equal(scriptMid('abc',1,-1),'bc');
  assert.equal(scriptMid('abc',0),'abc');
  assert.equal(scriptMid('a'.repeat(0xffff+1),0).length,0xffff);
  assert.equal(scriptMid('A😃Z',1,1),'\ud83d');
  assert.equal(scriptMid('abc',-1,1),'');
  assert.equal(scriptMid('abc',3,1),'');
  assert.throws(()=>scriptMid('abc',0,1.5),/int32/);
  assert.throws(()=>scriptMid('a\0b',0,1),/embedded-zero/);
  assert.equal(scriptLeft('JaimeReyes',16),'JaimeReyes');
  assert.equal(scriptLeft('abcdefghijklmnopq',16),'abcdefghijklmnop');
  assert.equal(scriptLeft('abc',-1),'');
  assert.throws(()=>scriptLeft('abc',1.5),/int32/);
  assert.equal(scriptRight('JaimeReyes',5),'Reyes');
  assert.equal(scriptRight('abc',9),'abc');
  assert.equal(scriptRight('abc',-1),'');
  assert.equal(scriptRight('A😃Z',2),'\ude03Z');
  assert.throws(()=>scriptRight('abc',1.5),/int32/);
  assert.throws(()=>scriptRight('a\0b',1),/embedded-zero/);
  assert.equal(scriptAt('',''),' ');
  assert.equal(scriptAt('A','B'),'A B');
  assert.equal(scriptAt('A😃Z','B'),'A😃Z B');
  assert.throws(()=>scriptAt('A\0B','C'),/embedded-zero/);
});

test('VM dispatches registered string primitives and NameToString conversion',()=>{
  const run=bytes=>compileFunction({entry:{path:'fixture.string'},pkg:{names:[{name:'MiXeD'}]},
    bytes:Uint8Array.from(bytes),size:bytes.length}).run({});
  assert.equal(run([0x04,0x7a,0x1f,65,0,0x1f,65,0,0x16]),true);
  assert.equal(run([0x04,0x7b,0x1f,65,0,0x1f,65,0,0x16]),false);
  assert.equal(run([0x04,0x7d,0x1f,65,0,0x16]),1);
  assert.equal(run([0x04,0x7e,0x1f,97,98,99,0,0x1f,98,0,0x16]),1);
  assert.equal(run([0x04,0x7f,0x1f,97,98,99,0,0x1d,1,0,0,0,0x1d,2,0,0,0,0x16]),'bc');
  // Mid's optional count is omitted at EndFunctionParms and therefore takes
  // the original “through the end” default without evaluating another arg.
  assert.equal(run([0x04,0x7f,0x1f,97,98,99,0,0x1d,1,0,0,0,0x16]),'bc');
  assert.equal(run([0x04,0xeb,0x1f,97,98,0,0x16]),'AB');
  assert.equal(run([0x04,0xea,0x1f,65,66,67,0,0x1d,2,0,0,0,0x16]),'BC');
  assert.equal(run([0x04,0x70,0x1f,65,0,0x1f,66,0,0x16]),'AB');
  assert.equal(run([0x04,0xa8,0x1f,65,0,0x1f,66,0,0x16]),'A B');
  assert.equal(run([0x04,0x80,0x1f,65,66,67,0,0x1d,2,0,0,0,0x16]),'AB');
  // NameConst expands a four-byte FName; package serialization stores compact 0.
  const fn={entry:{path:'fixture.name'},pkg:{names:[{name:'MiXeD'}]},
    bytes:Uint8Array.from([0x04,0x57,0x21,0]),size:7};
  assert.equal(compileFunction(fn).run({}),'MiXeD');
});
