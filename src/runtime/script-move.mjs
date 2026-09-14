import {refValue} from './script-vm.mjs';

const f=Math.fround;

function service(services,name,...args){
  if(typeof services?.[name]!=='function')throw new Error(`Original move service is not linked: ${name}`);
  return services[name](...args);
}
function read(services,object,name){
  if(object==null)throw new Error(`Original move field ${name} requires an object`);
  const value=service(services,'read',object,name);
  if(value===undefined)throw new Error(`Original move field is not linked: ${name}`);
  return value;
}
function vector(value){
  if(!Array.isArray(value)||value.length!==3)throw new Error('Original move requires a three-component vector');
  return value.map(f);
}

/** Engine.dll execMove 0x103e3030 (native 266): evaluate the Delta vector
 * argument, clear a 44-byte FCheckResult (Time=1.0, Item=-1), read the
 * receiver's Rotation at +0x120 as three raw dwords, then call
 * Level->MoveActor (vtable +0x88) as
 * MoveActor(this, Delta, Rotation, &hit, 0, 0, 0, 0) and publish its dword
 * return as the bool result. The movement itself is a live-level service
 * boundary: this wrapper never substitutes a movement approximation, and an
 * unlinked scene raises an explicit error rather than guessing. */
export function execMove(call,services){
  if(!Number.isInteger(call.argumentCount)||call.argumentCount!==1)
    throw new Error('Move requires one vector argument');
  const delta=vector(refValue(call.evaluateArgument(0))),actor=call.receiver;
  const rotation=read(services,actor,'Rotation');
  if(!Array.isArray(rotation)||rotation.length!==3)
    throw new Error('Original move requires a three-component Rotation');
  const hit=[0,0,0,0,0,0,0,0,0,1,-1];
  return Boolean(service(services,'moveActor',actor,delta,rotation,hit,0,0,0,0));
}
