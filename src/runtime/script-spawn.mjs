import {refValue} from './script-vm.mjs';

/** Engine execSpawn103e36d0. Defaults are sampled between argument
 * evaluations, not together at entry. SpawnActor receives NAME_None; the
 * script SpawnTag is written only after its complete startup has returned.
 * The separate level/native construction path is a required binding below.
 */
export function execScriptSpawn(call,{read,write,levelFor,spawnActor}) {
  if(call.argumentCount<1||call.argumentCount>5)throw new Error('Spawn requires a class and at most four optional arguments');
  const argument=index=>index<call.argumentCount?refValue(call.evaluateArgument(index)):undefined;
  const cls=argument(0)??null;
  const owner=argument(1)??null;
  const tag=argument(2)??'None';
  let location=read(call.receiver,'Location').slice();
  const suppliedLocation=argument(3);
  if(suppliedLocation!==undefined)location=suppliedLocation.slice();
  let rotation=read(call.receiver,'Rotation').slice();
  const suppliedRotation=argument(4);
  if(suppliedRotation!==undefined)rotation=suppliedRotation.slice();
  // Even a null class reaches every argument evaluation above.
  if(cls===null)return null;
  if(typeof levelFor!=='function'||typeof spawnActor!=='function')
    throw new Error('Spawn requires the original level construction/startup services');
  const level=levelFor(call.receiver);
  if(!level)throw new Error('Spawn requires a live actor level');
  const instigator=read(call.receiver,'Instigator');
  const actor=spawnActor({cls,level,name:'None',owner,instigator,location,rotation});
  if(actor!==null){
    if(!actor)throw new Error('SpawnActor returned an unresolved actor identity');
    write(actor,'Tag',tag);
  }
  return actor;
}

/** Accepted Engine SpawnActor path for the verified native CameraPoint class.
 * The world adapter must establish the native class/default/registry context
 * before mutation. Complete collision, network, undo and SpawnNotify paths
 * remain explicit boundaries. See docs/script-spawn.md for instruction order.
 */
export function spawnScriptCameraPoint(args,services) {
  const {cls,level,name,owner,instigator,location,rotation}=args;
  const {read,write,defaultRead,construct,setRegion,setOwner,initExecution,
    processEvent,setActorZone,validate}=services;
  if(!cls)return null;
  const reject=reason=>{services.warning?.({type:'SpawnRejected',class:cls.record.key,reason});return null;};
  if(cls.metadata.classFlags&1)return reject('abstract class');
  if(!services.isActorClass(cls))return reject('class is not an Actor');
  if(!level||typeof level.editor!=='boolean')throw new Error('SpawnActor requires an explicit original editor context');
  if(!level.editor&&(defaultRead(cls,'bStatic')||defaultRead(cls,'bNoDelete')))
    return reject('static or nondeletable class default');
  if(cls.record.key!=='engine.camerapoint')throw new Error('SpawnActor native subclass startup is not implemented');
  if(typeof validate!=='function'||validate(args)!==true)
    throw new Error('SpawnActor requires verified native defaults and complete world bindings');
  if(!Array.isArray(level.actors)||!level.actors[0]||!level.nativeObject?.outer)
    throw new Error('SpawnActor requires LevelInfo and the native level Outer package');
  if(level.editor||level.undo!==null||level.spawnTracking!==false)
    throw new Error('SpawnActor editor, transaction and spawn-tracking paths are not implemented');
  if(typeof level.tickParity!=='boolean'||typeof level.spawnNotifyGuard?.active!=='boolean')
    throw new Error('SpawnActor requires level tick parity and the global notification guard');
  if(['bCollideWorld','bCollideWhenPlacing','bCollideActors','bBlockActors','bBlockPlayers'].some(field=>defaultRead(cls,field)))
    throw new Error('SpawnActor collision placement is outside the accepted CameraPoint defaults');
  const index=level.actors.length;
  level.actors.push(null);
  const actor=construct(cls,{outer:level.nativeObject.outer,name,flags:0,template:null});
  level.actors[index]=actor;
  write(actor,'ObjectFlags',read(actor,'ObjectFlags')|1);
  write(actor,'Tag',cls.record.name);
  setRegion(actor,level.actors[0],-1,0);
  write(actor,'Level',level.actors[0]);
  services.setNativeLevel(actor,level);
  write(actor,'bTicked',!level.tickParity);
  if(read(actor,'Role')!==4)services.warning?.({type:'SpawnRole',actor,role:read(actor,'Role')});
  if(read(actor,'Brush')!==null)write(actor,'Brush',null);
  write(actor,'Location',location);
  write(actor,'OldLocation',location);
  write(actor,'Rotation',rotation);
  // The accepted class has no collision hash registration and no Pawn regions.
  setRegion(actor,level.actors[0],-1,0);
  setOwner(actor,owner);
  write(actor,'Instigator',instigator);
  initExecution(actor);
  // CameraPoint vtable +0x74 resolves to AActor.Spawned's no-op native body.
  processEvent(actor,'Spawned');
  processEvent(actor,'PreBeginPlay');
  processEvent(actor,'BeginPlay');
  if(read(actor,'bDeleteMe'))return null;
  // +0x30 is reused for the appended actor index before this call.
  setActorZone(actor,index===0,true);
  write(actor,'LastRenderTime',-10);
  processEvent(actor,'PostBeginPlay');
  // CheckEncroachment is called even for noncolliding actors. Its recovered
  // early return has no effects when all three collision/block flags are clear.
  if(read(actor,'Brush')!==null||['bCollideActors','bBlockActors','bBlockPlayers'].some(field=>read(actor,field)))
    throw new Error('SpawnActor requires full CheckEncroachment after startup changed collision flags');
  processEvent(actor,'SetInitialState');
  // CameraPoint has no Decoration/Inventory/Pawn ancestry, so FindBase skips.
  processEvent(actor,'PostPostBeginPlay');
  if(level.spawnTracking!==false)throw new Error('SpawnActor tracking allocation is not implemented');
  if(!level.spawnNotifyGuard.active){
    level.spawnNotifyGuard.active=true;
    if(read(level.actors[0],'SpawnNotify')!==null)
      throw new Error('SpawnNotify event return/parameter handling is not implemented');
    level.spawnNotifyGuard.active=false;
  }
  // Original SpawnActor has no further pending-delete check after BeginPlay.
  return actor;
}
