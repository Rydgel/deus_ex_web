import {refValue} from './script-vm.mjs';
import {SCRIPTED_ACTOR_CONSTRUCTION} from './script-scripted-actor-construction.mjs';
import {INVENTORY_CONSTRUCTION, resolveInheritedInventoryConstructorChain} from './script-inventory-construction.mjs';
import {NATIVE_ACTOR_CONSTRUCTORS} from './script-native-actor-constructors.mjs';

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

const RF_NATIVE=0x04000000;
const ENGINE_PAWN='engine.pawn';
// 0x10395629-0x1039568d: FindBase considers Decoration, Inventory and Pawn
// ancestry, in that order; 0x1039568f: Physics byte 0 or 5.
const FIND_BASE_ANCESTRY=Object.freeze(['engine.decoration','engine.inventory',ENGINE_PAWN]);
const FIND_BASE_PHYSICS=Object.freeze([0,5]);

function classKey(cls) {
  return String(cls?.record?.key??'').toLowerCase();
}

function lineageOf(cls) {
  const keys=[];
  for(let node=cls;node;node=node.base)keys.push(classKey(node));
  return keys;
}

/**
 * The native construction StaticConstructObject runs for a SpawnActor product:
 * the class's ClassConstructor (Class+0x4e0), which the recovered UClass::Bind
 * (script-class-bind.mjs) stored on the loaded class record by copying the
 * nearest registered native ancestor's InternalConstructor down the chain. The
 * row for that constructor comes from the family table the original DLLs
 * generate (script-native-actor-constructors.mjs): its final vtable, and any
 * member bytes the body writes besides it. Returns the selection the host's
 * `construct` service turns into the native body.
 */
export function nativeActorConstruction(cls,{classConstructor=node=>node?.loadRecord?.nativeConstructor}={}) {
  const bound=classConstructor(cls);
  if(!Number.isInteger(bound))
    throw new Error(`SpawnActor ${classKey(cls)} has no bound ClassConstructor`);
  for(let node=cls;node;node=node.base){
    if(((node.metadata?.entry?.flags??0)&RF_NATIVE)===0)continue;
    const row=NATIVE_ACTOR_CONSTRUCTORS[classKey(node)];
    // A registered native class without an own constructor inherits its
    // super's through Bind, so keep walking until the bound pointer's row.
    if(!row||row.internalCtor!==bound)continue;
    if(row.unresolved)
      throw new Error(`SpawnActor ${classKey(cls)} native constructor ${classKey(node)} is not recovered: ${row.unresolved.split(';')[0]}`);
    return {classKey:classKey(cls),nativeClass:classKey(node),inherited:node!==cls,constructor:bound,
      nativeVtable:row.vtable,memberBytes:row.memberBytes??null,
      ...(row.conditionalFlagBase?{conditionalFlagBase:row.conditionalFlagBase}:{})};
  }
  throw new Error(`SpawnActor ${classKey(cls)} ClassConstructor 0x${bound.toString(16)} is outside the native Actor constructor family`);
}

/**
 * The recovered `ULevel::SpawnActor` prologue gates at
 * `0x10394f81`-`0x103950b0`, before any actor-array mutation: null class, the
 * `Class+0x484` bit 0 abstract test (`0x10394fc2`), the
 * `AActor::PrivateStaticClass` ancestry walk, and the non-editor
 * `bStatic`/`bNoDelete` class-default test. Each logs and returns null.
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

/**
 * `ULevel::SpawnActor` (Engine.dll `0x10394f60`) for any concrete Actor class,
 * in the recovered instruction order (docs/script-spawn.md). No class is
 * named: construction is the class's bound ClassConstructor, and every branch
 * — FindSpot placement, collision-hash registration, the Pawn head/foot
 * regions, CheckEncroachment, the FindBase tail and SpawnNotify — is the
 * original gate evaluated on the spawned actor. Editor/undo, spawn tracking,
 * remote-owned role swapping and brush/network paths stay explicit errors.
 */
export function spawnActor(args,services) {
  const {cls,level,name,owner,instigator,rotation}=args;
  const noCollisionFail=Boolean(args.noCollisionFail);
  const location=args.location.slice();
  const {read,write,defaultRead,construct,setRegion,setOwner,initExecution,
    processEvent,setActorZone}=services;
  if(spawnActorRejectedByGates(args,services))return null;
  const selection=nativeActorConstruction(cls,services);
  if(typeof services.validate!=='function'||services.validate(args)!==true)
    throw new Error('SpawnActor requires verified native defaults and complete world bindings');
  if(!Array.isArray(level.actors)||!level.actors[0]||!level.nativeObject?.outer)
    throw new Error('SpawnActor requires LevelInfo and the native level Outer package');
  if(level.editor||level.undo!==null||level.spawnTracking!==false)
    throw new Error('SpawnActor editor, transaction and spawn-tracking paths are not implemented');
  if(typeof level.tickParity!=='boolean'||typeof level.spawnNotifyGuard?.active!=='boolean')
    throw new Error('SpawnActor requires level tick parity and the global notification guard');
  const levelInfo=level.actors[0];
  // 0x103950fb-0x103951ae: a bCollideWorld template goes straight to the
  // bNoCollisionFail test; bCollideWhenPlacing first requires LevelInfo+0x518
  // (NetMode) != 3. FindSpot (level vtable +0xb0) gets the template's
  // (radius, radius, height), the mutable Location, checkActors=0 and
  // checkFirst=1; a zero return fails the spawn before any array mutation.
  if((defaultRead(cls,'bCollideWorld')||(defaultRead(cls,'bCollideWhenPlacing')&&read(levelInfo,'NetMode')!==3))
      &&!noCollisionFail){
    if(typeof level.findSpot!=='function')throw new Error('SpawnActor placement requires ULevel::FindSpot');
    const radius=defaultRead(cls,'CollisionRadius'),height=defaultRead(cls,'CollisionHeight');
    if(!level.findSpot([radius,radius,height],location,0,1))return null;
  }
  // 0x103951bc-0x10395236: append, construct through the ClassConstructor,
  // RF_Transactional, Tag = the class name.
  const index=level.actors.length;
  level.actors.push(null);
  const actor=construct(cls,{outer:level.nativeObject.outer,name,flags:0,template:null},{constructorSelection:selection});
  level.actors[index]=actor;
  write(actor,'ObjectFlags',read(actor,'ObjectFlags')|1);
  write(actor,'Tag',cls.record.name);
  // 0x10395286-0x1039531c: Level/XLevel, Region, bTicked parity, Role warning, Brush.
  setRegion(actor,levelInfo,-1,0);
  write(actor,'Level',levelInfo);
  services.setNativeLevel(actor,level);
  write(actor,'bTicked',!level.tickParity);
  if(read(actor,'Role')!==4)services.warning?.({type:'SpawnRole',actor,role:read(actor,'Role')});
  if(read(actor,'Brush')!==null)write(actor,'Brush',null);
  // 0x10395366-0x103953b4: the transform, before hash registration.
  write(actor,'Location',location);
  write(actor,'OldLocation',location);
  write(actor,'Rotation',rotation);
  // The collision view carries the +0x1dc bitfield the native hash and
  // encroachment code read; it must exist before the registration gate.
  services.installCollisionView?.(actor);
  // 0x103953b7-0x103953cf: bCollideActors with a level hash joins it now.
  if(read(actor,'bCollideActors')&&level.hash){
    if(typeof services.installCollisionView!=='function')
      throw new Error('SpawnActor hash registration requires the native collision view');
    level.hash.addActor(actor);
  }
  // 0x1039541c-0x103954db: Region again; an APawn chain also resets
  // HeadRegion (+0x33c) and then FootRegion (+0x330).
  setRegion(actor,levelInfo,-1,0);
  const lineage=lineageOf(cls);
  if(lineage.includes(ENGINE_PAWN)){
    const region={'engine.actor.pointregion.zone':levelInfo,'engine.actor.pointregion.ileaf':-1,
      'engine.actor.pointregion.zonenumber':0};
    write(actor,'HeadRegion',{...region});
    write(actor,'FootRegion',{...region});
  }
  setOwner(actor,owner);
  write(actor,'Instigator',instigator);
  // Native vtable +0x38 InitExecution and +0x74 Spawned (the AActor bodies
  // for every row of the constructor family), then the script events.
  initExecution(actor);
  processEvent(actor,'Spawned');
  processEvent(actor,'PreBeginPlay');
  processEvent(actor,'BeginPlay');
  // 0x1039554f: the only pending-delete test in the body.
  if(read(actor,'bDeleteMe'))return null;
  // 0x10395559-0x10395572: SetActorZone(test = index==0, force=1), LastRenderTime.
  setActorZone(actor,index===0,true);
  write(actor,'LastRenderTime',-10);
  processEvent(actor,'PostBeginPlay');
  // 0x10395591-0x103955e8: CheckEncroachment (level vtable +0xb8) with the
  // actor's current Location/Rotation. Its early gate (0x1039a39a-0x1039a3a9)
  // returns false for +0x1dc & 0x0d == 0 and a null Brush without a query.
  if(!noCollisionFail&&(read(actor,'Brush')!==null||
      ['bCollideActors','bBlockActors','bBlockPlayers'].some(field=>read(actor,field)))){
    if(typeof services.checkEncroachment!=='function'||typeof services.destroyActor!=='function')
      throw new Error('SpawnActor requires the recovered CheckEncroachment and DestroyActor services');
    if(services.checkEncroachment(actor,read(actor,'Location').map(Math.fround),read(actor,'Rotation').map(v=>v|0),0)){
      services.destroyActor(actor);
      return null;
    }
  }
  processEvent(actor,'SetInitialState');
  // 0x10395612-0x1039569c: FindBase for a null Base, bCollideWorld, one of the
  // three ancestries and Physics 0 or 5.
  if(read(actor,'Base')==null&&read(actor,'bCollideWorld')&&
      FIND_BASE_ANCESTRY.some(key=>lineage.includes(key))&&
      FIND_BASE_PHYSICS.includes(Number(read(actor,'Physics')??0))){
    if(typeof services.findBase!=='function')throw new Error('SpawnActor FindBase requires the recovered level service');
    services.findBase(actor);
  }
  processEvent(actor,'PostPostBeginPlay');
  // 0x103956b9-0x103957d1: spawn tracking, then the SpawnNotify list under
  // the global reentrancy word. Each notifier whose ActorClass is in the
  // spawned actor's class chain receives SpawnNotification(actor); the native
  // passes a null result pointer, so the returned actor is discarded.
  if(level.spawnTracking!==false)throw new Error('SpawnActor tracking allocation is not implemented');
  if(!level.spawnNotifyGuard.active){
    level.spawnNotifyGuard.active=true;
    try{
      const seen=new Set();
      for(let notify=read(levelInfo,'SpawnNotify');notify;notify=read(notify,'Next')){
        if(seen.has(notify))throw new Error('SpawnNotify list is cyclic');
        seen.add(notify);
        const actorClass=read(notify,'ActorClass');
        if(actorClass&&services.isChildOf(cls,actorClass))processEvent(notify,'SpawnNotification',[actor]);
      }
    }finally{level.spawnNotifyGuard.active=false;}
  }
  return actor;
}

/**
 * The linked script-only ancestry down to a native `Engine.Weapon` or
 * `Engine.Inventory` root, or null for any other class.  This is the shape
 * Core UClass::Bind needs in order to copy the native root's ClassConstructor
 * and vtable down to a script-only subclass: the copy-down recurses through
 * however many script subclasses the chain holds, so the admitted set is an
 * ancestry, not a class name.  Returns `{chain, root}` where `chain` holds
 * the leaf through the native root and `root` is the native root's key.
 *
 * A chain whose first native class is neither recovered root returns null
 * when it never reaches Engine.Inventory — but a native node that does sit
 * above an Engine.Inventory ancestor is a different constructor family whose
 * copy-down this route must not silently reproduce, so that case throws.
 */
export function inventoryConstructorChain(cls) {
  const evidence=INVENTORY_CONSTRUCTION;
  const chain=[];
  for(let node=cls;node;node=node.base){
    const key=classKey(node);
    if(((node.metadata?.entry?.flags??0)&0x04000000)===0){
      chain.push(node);
      continue;
    }
    chain.push(node);
    // The first native class is where the copy-down stops.
    let inventory;
    if(key===evidence.engineWeapon.key){
      if(classKey(node.base)!==evidence.engineInventory.key)return null;
      inventory=node.base;
    }else if(key===evidence.engineInventory.key){
      inventory=node;
    }else{
      for(let probe=node.base;probe;probe=probe.base)
        if(classKey(probe)===evidence.engineInventory.key)
          throw new Error(`UClass::Bind native constructor family is not implemented for ${key}`);
      return null;
    }
    // Below Engine.Inventory the original chain is fixed.
    if(classKey(inventory.base)!==SCRIPTED_ACTOR_CONSTRUCTION.engineActor.key||
        classKey(inventory.base.base)!=='core.object'||inventory.base.base.base!=null)return null;
    return {chain,root:key};
  }
  return null;
}

/**
 * The pinned DataVaultImage case of the general chain: the class
 * Engine.Inventory was reached through must be DataVaultImage, so an
 * unrelated Inventory subclass does not enter the image route.  The abstract
 * DataVaultImage parent itself is rejected earlier by the shared prologue
 * abstract gate.
 */
export function inventoryImageChain(cls) {
  const selected=inventoryConstructorChain(cls);
  if(!selected)return null;
  const {chain}=selected;
  return chain.length>=3&&classKey(chain[chain.length-2])===INVENTORY_CONSTRUCTION.dataVaultImage.key
    ?chain:null;
}

/** The leaf's serialized PropertiesSize — the original UStruct::Link result
 * stored in the linked class record (+0x3c), which a subclass's own fields
 * enlarge. The spawn sequence needs it for the constructor selection check. */
function linkedPropertiesSize(cls) {
  const size=cls?.loadRecord?.nativeSlots?.get(0x3c)?.value;
  if(!Number.isInteger(size))throw new Error(`Original class ${classKey(cls)} has no linked PropertiesSize`);
  return size;
}

/**
 * Build the inherited-constructor selection for an admitted Inventory-ancestry
 * class from its linked chain, deriving each record the way UClass::Bind reads
 * it: a class carries its own ClassConstructor only when it is RF_Native
 * (0x04000000), which is the same flag the recovered Bind body tests before it
 * would reach native DLL-export resolution.  A script subclass that declares
 * its own fields (DeusExWeapon's 136) is legal here because the leaf's real
 * linked PropertiesSize is used rather than a pinned subclass size.
 */
export function inventorySelection(cls) {
  const selected=inventoryConstructorChain(cls);
  if(!selected)return null;
  const evidence=INVENTORY_CONSTRUCTION;
  const root=evidence.nativeRoots[selected.root];
  const records=[];
  for(const node of selected.chain){
    const key=classKey(node);
    if(key===selected.root){
      records.push({key,nativeConstructor:root.internalConstructor,
        nativeVtable:root.vtable});
      break;
    }
    if(((node.metadata?.entry?.flags??0)&0x04000000)!==0)
      throw new Error(`UClass::Bind native DLL-export resolution is not implemented for ${key}`);
    records.push({key,nativeConstructor:null});
  }
  return resolveInheritedInventoryConstructorChain(records,linkedPropertiesSize(cls),root);
}

/** The image route's pinned entry point, kept for the route that pinned the
 * evidence: DataVaultImage-admitted chains only. */
export function inventoryImageSelection(cls) {
  return inventoryImageChain(cls)?inventorySelection(cls):null;
}
