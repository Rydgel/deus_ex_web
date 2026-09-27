#!/usr/bin/env node
/** Compare the input command and ReadInput translations with original Engine
 * instruction slices executed by scripts/native-input-console-oracle.py. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {createConsoleCommands, IST_PRESS, IST_RELEASE, IST_HOLD, IST_AXIS}
  from '../src/runtime/script-console-command.mjs';

const python=process.env.NATIVE_PROBE_PYTHON??process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
const root=gameDirectory();
const native=JSON.parse(execFileSync(python,['scripts/native-input-console-oracle.py',root],{encoding:'utf8'}));

const props=[
  {name:'bFire',metadata:{type:'byte',flags:0x4,arrayDim:1}},
  {name:'bRun',metadata:{type:'byte',flags:0x4,arrayDim:1}},
  {name:'aBaseY',metadata:{type:'float',flags:0x4,arrayDim:1}},
  {name:'aMouseX',metadata:{type:'float',flags:0x4,arrayDim:1}},
  {name:'aArray',metadata:{type:'float',flags:0x4,arrayDim:2}},
  {name:'bArray',metadata:{type:'byte',flags:0x4,arrayDim:2}},
  {name:'notInput',metadata:{type:'float',flags:0,arrayDim:1}},
];
const cls={record:{key:'fixture.actor'},base:null,propertyOrder:props};
const actor={cls,values:{bFire:0,bRun:0,aBaseY:0,aMouseX:0,aArray:[4,5],bArray:[128,7],notInput:19}};
const viewport={Actor:actor,Console:null};
const fieldOf=(object,name)=>{
  for(let current=object.cls;current;current=current.base)
    for(const field of current.propertyOrder)
      if(field.name.toLowerCase()===String(name).toLowerCase())return field;
  return null;
};
const runtime={
  readNamed:(object,name)=>object?.[name]??null,
  namedField:fieldOf,
  instance:object=>({cls:object.cls}),
  readField:(object,field)=>object.values[field.name],
  writeField:(object,field,value)=>{
    const cast=x=>field.metadata.type==='float'?Math.fround(x):field.metadata.type==='byte'?Number(x)&255:x;
    object.values[field.name]=Array.isArray(value)?value.map(cast):cast(value);
  },
  processEvent:()=>{},scriptConsoleExec:()=>false,levelFor:()=>({}),
};
const input={aliases:[],bindings:Array(255).fill(''),keyName:()=>'',keyBinding:()=>''};
const observed=[];
const commands=createConsoleCommands({runtime,input,services:{viewport:()=>viewport,rootProcess:()=>false,
  hostBinding:(key,action)=>{observed.push([key,action]);return false;},updateInput:()=>{}}});
const output={log(){}};

const byte=x=>Number(x)&255;
commands.state.action=IST_PRESS;commands.inputExec('BUTTON bFire',output);
assert.equal(byte(actor.values.bFire),native.buttons.press);
commands.state.action=IST_RELEASE;actor.values.bFire=128;commands.inputExec('BUTTON bFire',output);
assert.equal(byte(actor.values.bFire),native.buttons.release);
commands.inputExec('BUTTON bFire',output);
assert.equal(byte(actor.values.bFire),native.buttons.release,'BUTTON release preserves an already-clear byte');
commands.state.action=IST_PRESS;actor.values.bFire=0;commands.inputExec('PULSE bFire',output);
assert.equal(byte(actor.values.bFire),native.buttons.press);
commands.state.action=IST_RELEASE;commands.inputExec('PULSE bFire',output);
assert.equal(byte(actor.values.bFire),native.buttons.press,'PULSE release leaves its byte as-is');
commands.state.action=IST_PRESS;actor.values.bRun=0;commands.inputExec('TOGGLE bRun',output);
assert.equal(byte(actor.values.bRun),native.buttons.toggleOff);
commands.inputExec('TOGGLE bRun',output);
assert.equal(byte(actor.values.bRun),native.buttons.toggleOn);
assert.throws(()=>commands.inputExec('BUTTON notInput',output),/CPF_Input byte property/);
assert.throws(()=>commands.inputExec('AXIS notInput',output),/CPF_Input float property/);

commands.state.action=IST_HOLD;commands.state.delta=Math.fround(.05);actor.values.aBaseY=0;
commands.inputExec('AXIS aBaseY Speed=300',output);
assert.equal(actor.values.aBaseY,native.axis.hold2_dt005_speed300_prior0);
commands.state.action=IST_AXIS;commands.state.delta=Math.fround(.05);actor.values.aBaseY=0;
commands.inputExec('AXIS aBaseY Speed=6',output);
assert.equal(actor.values.aBaseY,native.axis.axis4_dt005_speed6_prior0);
actor.values.aBaseY=0;
commands.inputExec('AXIS aBaseY',output);
assert.equal(actor.values.aBaseY,native.axis.axis4_dt005_speed1_prior0,'omitted Speed uses native 1.0');
commands.state.action=IST_HOLD;commands.state.delta=Math.fround(.05);actor.values.aBaseY=3;actor.values.bFire=128;
commands.readInput(.05,{log(){throw new Error('unexpected output');}});
assert.equal(actor.values.aBaseY,native.sampling.dt005_value3);
assert.equal(actor.values.bFire,128,'ReadInput skips ByteProperty inputs');
assert.equal(actor.values.notInput,19,'ReadInput skips fields without CPF_Input');
actor.values.aBaseY=3;
commands.readInput(-1,{log(){throw new Error('unexpected output');}});
assert.equal(actor.values.aBaseY,native.sampling.sentinelMinus1_value3);
actor.values.aBaseY=3;
commands.readInput(0,{log(){throw new Error('unexpected output');}});
assert.equal(actor.values.aBaseY,Infinity);
assert.equal(native.sampling.zeroDt_value3,'Infinity');

commands.state.held[9]=1;commands.state.held[2]=1;observed.length=0;
commands.state.delta=Math.fround(.05);
commands.readInput(.05,{log(){throw new Error('unexpected output');}});
assert.deepEqual(observed,[[2,IST_HOLD],[9,IST_HOLD]],'held keys replay ascending before scale');

actor.values.bFire=128;actor.values.aBaseY=3;actor.values.notInput=19;
actor.values.aArray=[4,5];actor.values.bArray=[128,7];
commands.resetInput();
assert.equal(actor.values.bFire,0);assert.equal(actor.values.aBaseY,0);
assert.deepEqual(actor.values.aArray,[0,5],'ResetInput stores one float at the native property address');
assert.deepEqual(actor.values.bArray,[0,7],'ResetInput stores one byte at the native property address');
assert.equal(actor.values.notInput,19,'ResetInput preserves non-CPF_Input fields');
assert.equal(commands.state.action,0);assert.equal(commands.state.delta,0);
assert.equal(IST_AXIS,4);
console.log('validate-native-input-console: BUTTON/PULSE/TOGGLE, AXIS action 2/4, ReadInput scaling/sentinel/zero-delta/held order, and ResetInput field filters match original Engine instruction fixtures');
