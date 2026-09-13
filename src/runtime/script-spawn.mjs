import {refValue} from './script-vm.mjs';
import {SCRIPTED_ACTOR_CONSTRUCTION} from './script-scripted-actor-construction.mjs';
import {INVENTORY_CONSTRUCTION, resolveInheritedInventoryConstructorChain} from './script-inventory-construction.mjs';

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

const collisionDefaults=Object.freeze([
  'bCollideWorld','bCollideWhenPlacing','bCollideActors','bBlockActors','bBlockPlayers',
]);

function classKey(cls) {
  return String(cls?.record?.key??'').toLowerCase();
}

/**
 * The script-only DataLinkPlay class must arrive here with the constructor
 * selected by Core UClass::Bind.  The callback is deliberately host-owned:
 * the class registry contains the live ClassConstructor slots, while this
 * module only checks the recovered chain/result before any level mutation.
 */
function selectDataLinkPlayConstructor(cls,services) {
  if(classKey(cls)!==SCRIPTED_ACTOR_CONSTRUCTION.dataLinkPlay.key)
    throw new Error('DataLinkPlay constructor selection received the wrong class');
  const base=cls.base,actor=base?.base;
  if(classKey(base)!==SCRIPTED_ACTOR_CONSTRUCTION.conPlayBase.key||
      classKey(actor)!==SCRIPTED_ACTOR_CONSTRUCTION.engineActor.key||
      classKey(actor.base)!=='core.object')
    throw new Error('DataLinkPlay requires the exact ConPlayBase -> Engine.Actor -> Core.Object chain');
  if(typeof services.resolveConstructor!=='function')
    throw new Error('DataLinkPlay Spawn requires the original UClass::Bind constructor service');
  const selection=services.resolveConstructor(cls);
  const expected=SCRIPTED_ACTOR_CONSTRUCTION.engineActor;
  if(!selection||selection.classKey!==SCRIPTED_ACTOR_CONSTRUCTION.dataLinkPlay.key||
      selection.inherited!==true||selection.constructor!==expected.internalConstructor||
      selection.nativeVtable!==expected.vtable||
      selection.propertiesSize!==SCRIPTED_ACTOR_CONSTRUCTION.layout.dataLinkPlayPropertiesSize)
    throw new Error('DataLinkPlay Spawn requires the inherited Engine.Actor constructor binding');
  return selection;
}

/** Shared bounded ULevel::SpawnActor sequence for the two source-backed
 * classes. `kind` is an exact class gate; it is never a generic subclass
 * fallback. DataLinkPlay supplies the inherited constructor report to the
 * host construction boundary, then runs inherited Actor bytecode through
 * ProcessEvent just like CameraPoint.
 */
/**
 * Shared bounded ULevel::SpawnActor sequence. The exact class key remains a
 * caller supplied admission gate: this helper is reusable for an additional
 * source-backed script Actor only when its lifecycle host explicitly admits
 * that key. It never becomes a generic Actor fallback.
 */
/**
 * The recovered `ULevel::SpawnActor` prologue gates at
 * `0x10394f81`-`0x103950b0`, before any actor-array mutation and before any
 * class-specific behaviour: null class, the `Class+0x484` bit 0 abstract test
 * (`0x10394fc2`), the `AActor::PrivateStaticClass` ancestry walk, and the
 * non-editor `bStatic`/`bNoDelete` class-default test. Each logs and returns
 * null. They are ordinary reads, so a caller may run them before dispatching
 * to a subclass startup and the startup may run them again.
 * Returns `true` when the spawn is rejected here.
 */
export function spawnActorRejectedByGates(args,services) {
  const {cls,level}=args;
  if(!cls)return true;
  const reject=reason=>{services.warning?.({type:'SpawnRejected',class:cls.record.key,reason});return true;};
  if(cls.metadata.classFlags&1)return reject('abstract class');
  if(!services.isActorClass(cls))return reject('class is not an Actor');
  if(!level||typeof level.editor!=='boolean')throw new Error('SpawnActor requires an explicit original editor context');
  if(!level.editor&&(services.defaultRead(cls,'bStatic')||services.defaultRead(cls,'bNoDelete')))
    return reject('static or nondeletable class default');
  return false;
}

export function spawnScriptActor(args,services,{kind,key,constructorSelection=false}) {
  const {cls,level,name,owner,instigator,location,rotation}=args;
  const {read,write,defaultRead,construct,setRegion,setOwner,initExecution,
    processEvent,setActorZone,validate}=services;
  if(spawnActorRejectedByGates(args,services))return null;
  if(classKey(cls)!==key)throw new Error(`SpawnActor ${kind} subclass startup is not implemented`);
  if(typeof validate!=='function'||validate(args)!==true)
    throw new Error('SpawnActor requires verified native defaults and complete world bindings');
  const selected=constructorSelection?selectDataLinkPlayConstructor(cls,services):null;
  if(!Array.isArray(level.actors)||!level.actors[0]||!level.nativeObject?.outer)
    throw new Error('SpawnActor requires LevelInfo and the native level Outer package');
  if(level.editor||level.undo!==null||level.spawnTracking!==false)
    throw new Error('SpawnActor editor, transaction and spawn-tracking paths are not implemented');
  if(typeof level.tickParity!=='boolean'||typeof level.spawnNotifyGuard?.active!=='boolean')
    throw new Error('SpawnActor requires level tick parity and the global notification guard');
  if(collisionDefaults.some(field=>defaultRead(cls,field)))
    throw new Error(`SpawnActor collision placement is outside the accepted ${kind} defaults`);
  const index=level.actors.length;
  level.actors.push(null);
  const options={outer:level.nativeObject.outer,name,flags:0,template:null};
  const actor=selected
    ?construct(cls,options,{constructorSelection:selected})
    :construct(cls,options);
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
  // Both accepted classes inherit Actor.Spawned; the host's ProcessEvent
  // binding owns the native/script distinction at this boundary.
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
    const notify=read(level.actors[0],'SpawnNotify');
    level.spawnNotifyGuard.active=false;
    if(notify!==null)
      throw new Error('SpawnNotify event return/parameter handling is not implemented');
  }
  // Original SpawnActor has no further pending-delete check after BeginPlay.
  return actor;
}

/** Accepted Engine SpawnActor path for the verified native CameraPoint class.
 * The world adapter must establish the native class/default/registry context
 * before mutation. Complete collision, network, undo and SpawnNotify paths
 * remain explicit boundaries. See docs/script-spawn.md for instruction order.
 */
export function spawnScriptCameraPoint(args,services) {
  return spawnScriptActor(args,services,{
    kind:'CameraPoint',key:'engine.camerapoint',constructorSelection:false,
  });
}

/** Accepted SpawnActor path for the exact script-only DataLinkPlay chain.
 * Core UClass::Bind copies Engine.Actor's ClassConstructor through
 * ConPlayBase into DataLinkPlay; the host must expose that recovered result
 * through `resolveConstructor` before this function mutates the level.
 */
export function spawnScriptDataLinkPlay(args,services) {
  return spawnScriptActor(args,services,{
    kind:'DataLinkPlay',key:SCRIPTED_ACTOR_CONSTRUCTION.dataLinkPlay.key,
    constructorSelection:true,
  });
}

/**
 * The linked `DataVaultImage -> Engine.Inventory -> Engine.Actor -> Core.Object`
 * ancestry, or null for any other class.  This is the shape Core UClass::Bind
 * needs in order to copy Engine.AInventory's ClassConstructor (0x1030299b) and
 * vtable (0x104286f8) down to a script-only subclass: the copy-down recurses
 * through however many script subclasses the chain holds, so the admitted set
 * is an ancestry, not a class name.  The abstract DataVaultImage parent itself
 * is rejected earlier by the shared prologue abstract gate.
 */
export function inventoryImageChain(cls) {
  const evidence=INVENTORY_CONSTRUCTION;
  const chain=[];
  for(let node=cls;node;node=node.base){
    chain.push(node);
    if(classKey(node)===evidence.engineInventory.key){
      // Below Engine.Inventory the original chain is fixed.
      if(classKey(node.base)!==SCRIPTED_ACTOR_CONSTRUCTION.engineActor.key||
          classKey(node.base.base)!=='core.object'||node.base.base.base!=null)return null;
      // DataVaultImage must be the class Engine.Inventory was reached through,
      // so an unrelated Inventory subclass does not enter this path.
      return chain.length>=3&&classKey(chain[chain.length-2])===evidence.dataVaultImage.key
        ?chain:null;
    }
  }
  return null;
}

/**
 * Build the inherited-constructor selection for an admitted DataVaultImage
 * subclass from its linked chain, deriving each record the way UClass::Bind
 * reads it: a class carries its own ClassConstructor only when it is RF_Native
 * (0x04000000), which is the same flag the recovered Bind body tests before it
 * would reach native DLL-export resolution. A native subclass on this chain,
 * or a subclass that declares its own fields, is refused rather than given
 * Engine.Inventory's body and DataVaultImage's PropertiesSize.
 */
export function inventoryImageSelection(cls) {
  const chain=inventoryImageChain(cls);
  if(!chain)return null;
  const evidence=INVENTORY_CONSTRUCTION;
  const records=[];
  for(const node of chain){
    const key=classKey(node);
    if(key===evidence.engineInventory.key){
      records.push({key,nativeConstructor:evidence.engineInventory.internalConstructor,
        nativeVtable:evidence.engineInventory.vtable});
      break;
    }
    if(((node.metadata?.entry?.flags??0)&0x04000000)!==0)
      throw new Error(`UClass::Bind native DLL-export resolution is not implemented for ${key}`);
    if(key!==evidence.dataVaultImage.key&&node.propertyOrder?.length)
      throw new Error(`${key} declares its own fields; its linked PropertiesSize is required`);
    records.push({key,nativeConstructor:null});
  }
  return resolveInheritedInventoryConstructorChain(records,
    evidence.layout.dataVaultImagePropertiesSize);
}

function selectInventoryConstructor(cls,chain,services) {
  const evidence=INVENTORY_CONSTRUCTION;
  if(typeof services.resolveConstructor!=='function')
    throw new Error('DataVaultImage Spawn requires the original UClass::Bind constructor service');
  const selection=services.resolveConstructor(cls);
  const expected=evidence.engineInventory;
  if(!selection||selection.classKey!==classKey(cls)||
      selection.inherited!==true||selection.constructor!==expected.internalConstructor||
      selection.nativeVtable!==expected.vtable||
      !Number.isInteger(selection.propertiesSize)||
      selection.propertiesSize<evidence.layout.inventoryPropertiesSize)
    throw new Error('DataVaultImage Spawn requires the inherited Engine.Inventory constructor binding');
  return selection;
}

/**
 * Accepted ULevel::SpawnActor path for a concrete DeusEx DataVaultImage
 * subclass, admitted by its linked Engine.Inventory ancestry rather than by
 * class name. Unlike the DataLinkPlay/CameraPoint path these classes carry authored
 * collision defaults (bBlockActors), so the bounded collision-default gate
 * is replaced by the original sequence actually recovered for it:
 * the pre-startup hash registration (0x103953b7-0x103953cf, before
 * SetOwner/InitExecution), the post-PostBeginPlay CheckEncroachment through
 * level vtable +0xb8 with the +0x94 DestroyActor failure edge, and the
 * FindBase tail gate (Base null + bCollideWorld + Inventory ancestry +
 * Physics in {0,5}) between SetInitialState and PostPostBeginPlay.
 */
export function spawnScriptInventoryActor(args,services) {
  const {cls,level,name,owner,instigator,location,rotation}=args;
  const {read,write,defaultRead,construct,setRegion,setOwner,initExecution,
    processEvent,setActorZone,validate}=services;
  if(spawnActorRejectedByGates(args,services))return null;
  const chain=inventoryImageChain(cls);
  if(!chain)
    throw new Error(`SpawnActor ${classKey(cls)} subclass startup is not implemented`);
  if(typeof validate!=='function'||validate(args)!==true)
    throw new Error('SpawnActor requires verified native defaults and complete world bindings');
  const selected=selectInventoryConstructor(cls,chain,services);
  if(!Array.isArray(level.actors)||!level.actors[0]||!level.nativeObject?.outer)
    throw new Error('SpawnActor requires LevelInfo and the native level Outer package');
  if(level.editor||level.undo!==null||level.spawnTracking!==false)
    throw new Error('SpawnActor editor, transaction and spawn-tracking paths are not implemented');
  if(typeof level.tickParity!=='boolean'||typeof level.spawnNotifyGuard?.active!=='boolean')
    throw new Error('SpawnActor requires level tick parity and the global notification guard');
  // 0x103950fb-0x103951ae: bCollideWorld or bCollideWhenPlacing class defaults
  // would route through ULevel::FindSpot (+0xb0). Both are clear on the
  // admitted class; keep the unimplemented branch explicit like the shared path.
  if(defaultRead(cls,'bCollideWorld')||defaultRead(cls,'bCollideWhenPlacing'))
    throw new Error('SpawnActor Inventory FindSpot placement is not implemented');
  const index=level.actors.length;
  level.actors.push(null);
  const options={outer:level.nativeObject.outer,name,flags:0,template:null};
  const actor=construct(cls,options,{constructorSelection:selected});
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
  // The collision view must exist before the original pre-startup hash gate:
  // the native registration reads the +0x1dc bitfield the view derives.
  if(typeof services.installCollisionView!=='function'||
      typeof services.checkEncroachment!=='function'||
      typeof services.findBase!=='function'||typeof services.destroyActor!=='function')
    throw new Error('SpawnActor Inventory requires the recovered collision, encroachment, FindBase and DestroyActor services');
  services.installCollisionView(actor);
  // 0x103953b7-0x103953cf: the spawned actor joins the XLevel hash before
  // SetOwner/InitExecution when +0x1dc bit 0 is set. The shipped image classes
  // keep it clear, so the gate evaluates per class and adds nothing for them.
  if((actor.flags??0)&INVENTORY_CONSTRUCTION.startup.preStartupHashMask&&level.hash)
    level.hash.addActor(actor);
  // 0x1039541c-0x10395432: the default Region re-init runs after the hash gate.
  setRegion(actor,level.actors[0],-1,0);
  setOwner(actor,owner);
  write(actor,'Instigator',instigator);
  initExecution(actor);
  // AInventory inherits AActor's Spawned slot (vtable +0x74 -> 0x10303373).
  processEvent(actor,'Spawned');
  processEvent(actor,'PreBeginPlay');
  processEvent(actor,'BeginPlay');
  if(read(actor,'bDeleteMe'))return null;
  setActorZone(actor,index===0,true);
  write(actor,'LastRenderTime',-10);
  processEvent(actor,'PostBeginPlay');
  // 0x103955d6: CheckEncroachment is called even for noncolliding actors,
  // with the +0x94 ULevel::DestroyActor edge on failure. The authored
  // bBlockActors on this chain makes the general IsBlockedBy path live rather
  // than the bounded early-return-only case.
  // 0x103955bd/0x1039559a: the native pushes the actor's current +0x114
  // Location and +0x120 Rotation by value, not the spawn arguments.
  if(services.checkEncroachment(actor,read(actor,'Location').map(Math.fround),read(actor,'Rotation').map(v=>v|0),0)){
    services.destroyActor(actor);
    return null;
  }
  processEvent(actor,'SetInitialState');
  // 0x10395612-0x1039569c: the FindBase tail. Inventory ancestry is fixed by
  // the admission chain; the remaining gates are a null Base, the bCollideWorld
  // flag Pickup's BeginState has just set, and Physics in {0,5}. The shipped
  // image classes spawn Falling (2), so the gate evaluates to false here and
  // Inventory.BecomeItem's SetPhysics(PHYS_None) reaches it later.
  if(actor.base==null&&(actor.flags&2)&&
      INVENTORY_CONSTRUCTION.startup.findBaseAncestry.some(key=>actor.lineage.includes(key))&&
      INVENTORY_CONSTRUCTION.startup.findBasePhysicsValues.includes(actor.physics))
    services.findBase(actor);
  processEvent(actor,'PostPostBeginPlay');
  if(level.spawnTracking!==false)throw new Error('SpawnActor tracking allocation is not implemented');
  if(!level.spawnNotifyGuard.active){
    level.spawnNotifyGuard.active=true;
    const notify=read(level.actors[0],'SpawnNotify');
    level.spawnNotifyGuard.active=false;
    if(notify!==null)
      throw new Error('SpawnNotify event return/parameter handling is not implemented');
  }
  return actor;
}
