import {refValue} from './script-vm.mjs';
import {fastLineCheck} from './fast-line-check.mjs';

const f=Math.fround;
const HEARING_RADIUS=0.7692307829856873;
const OCCLUDED_RADIUS=0.6000000238418579;
const OCCLUDED_VOLUME=0.3499999940395355;

function service(services,name,...args) {
  if(typeof services?.[name]!=='function')throw new Error(`Original sound service is not linked: ${name}`);
  return services[name](...args);
}
function read(services,object,name) {
  if(object==null)throw new Error(`Original sound field ${name} requires an object`);
  const value=service(services,'read',object,name);
  if(value===undefined)throw new Error(`Original sound field is not linked: ${name}`);
  return value;
}
function vector(value) {
  if(!Array.isArray(value)||value.length!==3)throw new Error('Original sound requires a three-component vector');
  return value.map(f);
}
function array(services,object,name) {
  const value=read(services,object,name);
  if(!Array.isArray(value))throw new Error(`Original sound requires native array ${name}`);
  return value;
}
function levelInfo(services,emitter) {
  const actor=array(services,read(services,emitter,'XLevel'),'Actors')[0];
  if(!actor||!service(services,'isA',actor,'Engine.LevelInfo'))
    throw new Error('Original PlaySound requires Actors(0) to be LevelInfo');
  return actor;
}

/** Engine.dll CheckHearSound 103e1b00. Native graph fields and event/trace
 * services are explicit; no audio or generic collision approximation here.
 * Each call gets its own parameter vector, as in the native by-value ABI.
 * Evidence and float precision scope: docs/script-sound.md. */
export function checkActorHearSound(emitter,listener,id,sound,parameters,radiusSquared,services) {
  let listenerActor=listener;
  if(service(services,'isA',listener,'Engine.PlayerPawn'))
    listenerActor=read(services,listener,'ViewTarget')??listener;
  const threshold=f(f(radiusSquared)*HEARING_RADIUS);
  const listenerPosition=vector(read(services,listenerActor,'Location'));
  const emitterPosition=vector(read(services,emitter,'Location'));
  const [x,y,z]=listenerPosition.map((value,index)=>value-emitterPosition[index]);
  const distance=(z*z+y*y)+x*x,storedDistance=f(distance);
  if(!(distance<threshold||Number.isNaN(distance)||Number.isNaN(threshold)))
    return {listener,heard:false,reason:'distance'};
  const params=vector(parameters);
  const model=read(services,read(services,emitter,'XLevel'),'Model');
  const end=vector(read(services,emitter,'Location'));
  const clear=services?.fastLineCheck
    ?service(services,'fastLineCheck',model,listenerPosition,end)
    :fastLineCheck(model,listenerPosition,end);
  if(typeof clear!=='boolean')throw new Error('Original sound FastLineCheck must return a boolean');
  if(!clear){
    const adjusted=read(services,emitter,'Owner')===listener?threshold:threshold*OCCLUDED_RADIUS;
    params[0]=f(params[0]*OCCLUDED_VOLUME);
    if(storedDistance>adjusted)return {listener,heard:false,reason:'occlusion'};
  }
  service(services,'processNativeEvent',listener,'ClientHearSound',[
    emitter,id,sound,vector(read(services,emitter,'Location')),params,
  ]);
  return {listener,heard:true};
}

/** Engine.dll execPlaySound 103e1f60. The caller owns Result storage: a null
 * sound leaves it untouched. evaluateArgument retains the caller's frame and
 * is invoked in source order; live default reads occur even for supplied args.
 * services.read includes native fields (XLevel/ObjectIndex/level graph), not
 * just reflected script properties. ObjectIndex is the global UObject index.
 */
export function execActorPlaySound(call,services) {
  if(!Number.isInteger(call.argumentCount)||call.argumentCount<0||call.argumentCount>6)
    throw new Error('PlaySound accepts at most six arguments');
  const emitter=call.receiver;
  const argument=(index,initial)=>{
    const evaluated=index<call.argumentCount?refValue(call.evaluateArgument(index)):undefined;
    return evaluated===undefined?initial:evaluated;
  };
  const sound=argument(0,null),slot=argument(1,1)&255;
  const volume=f(argument(2,read(services,emitter,'TransientSoundVolume')));
  const noOverride=argument(3,0)|0;
  let radius=f(argument(4,read(services,emitter,'TransientSoundRadius')));
  const pitch=f(argument(5,1));
  if(sound===null)return {resultWritten:false};
  if(!(radius>0))radius=f(800);

  const xLevel=read(services,emitter,'XLevel');
  if(xLevel!==null){
    const driver=read(services,xLevel,'DemoRecDriver');
    if(driver!==null&&read(services,driver,'ServerConnection')===null
        &&read(services,levelInfo(services,emitter),'NetMode')!==3)
      service(services,'processNativeEvent',emitter,'DemoPlaySound',[sound,slot,volume,noOverride,radius,pitch]);
  }

  // DemoPlaySound can change the live object/level graph. Read the index now.
  const objectIndex=read(services,emitter,'ObjectIndex');
  if(!Number.isInteger(objectIndex)||objectIndex<0||objectIndex>0x7fffffff)
    throw new Error('PlaySound requires the registered global UObject index');
  const id=((objectIndex<<4)+(slot<<1)+noOverride)|0;
  const squaredRadius=radius===0||Number.isNaN(radius)?f(1000):radius;
  const radiusSquared=f(squaredRadius*squaredRadius);
  const params=[f(100*volume),radius,f(100*pitch)];
  // null means Frame.Node is not a UFunction, e.g. a state frame.
  const flags=service(services,'frameFunctionFlags',call);
  if(flags!==null&&!Number.isInteger(flags))throw new Error('Original sound requires Frame.Node function ancestry/flags');
  const listeners=[];
  const hear=pawn=>listeners.push(checkActorHearSound(emitter,pawn,id,sound,params,radiusSquared,services));
  if(read(services,levelInfo(services,emitter),'NetMode')===3||(flags!==null&&(flags&0x100))){
    const engine=read(services,read(services,emitter,'XLevel'),'Engine');
    const client=read(services,engine,'Client');
    if(client!==null)for(let i=0;;i++){
      const viewports=array(services,client,'Viewports');
      if(i>=viewports.length)break;
      const pawn=read(services,viewports[i],'Actor');
      if(pawn!==null&&read(services,pawn,'XLevel')===read(services,emitter,'XLevel'))hear(pawn);
    }
  }else{
    let pawn=read(services,read(services,emitter,'Level'),'PawnList');
    while(pawn!==null){
      if(read(services,pawn,'bIsPlayer'))hear(pawn);
      pawn=read(services,pawn,'NextPawn');
    }
  }
  return {resultWritten:true,result:id,arguments:[sound,slot,volume,noOverride,radius,pitch],listeners};
}
