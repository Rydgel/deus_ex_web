/** Original DataLinkPlay preparation and read-only diagnostics.
 * Gameplay runs in installed DeusExPlayer/DataLinkPlay bytecode under Actor.Tick.
 * Evidence: docs/script-datalink-original.md. No host admission or playback timer.
 */
import {ScriptObjectRegistry,constructActorBase} from './script-object-construction.mjs';
import {createScriptNames} from './script-names.mjs';
import {createScriptObjectLookup} from './script-object-lookup.mjs';
import {prepareDataLinkFunctions} from './script-datalink-transmission.mjs';
import {
  SCRIPTED_ACTOR_CONSTRUCTION,verifyDataLinkPlayDefaults,
} from './script-scripted-actor-construction.mjs';
import {loadTrainingDataLinkCatalog} from './script-training-datalinks.mjs';
import {prepareConversationGraph} from './script-conversation-face-live.mjs';

const lower=value=>String(value??'').toLowerCase();

function requiredExport(asset,path){
  const index=asset?.exportsByPath?.get(lower(path));
  if(!index)throw new Error(`Missing original ${asset?.name??'package'}.${path}`);
  return index;
}

async function prepare(runtime,asset,path){
  return runtime.prepareFunction(asset,requiredExport(asset,path));
}

function set(runtime,object,name,value){runtime.writeNamed(object,name,value);}
function get(runtime,object,name){return runtime.readNamed(object,name);}

/** Build the exact script/native world prerequisites for DataLinkPlay Spawn
 * and the shipped DataVaultImage class the DL_Rooftops transfer event uses. */
export async function prepareLiveActorSpawnWorld({runtime,engine,deusEx,level,levelInfo}){
  const [dataLinkClass,imageClass]=await Promise.all([
    runtime.loadClass(deusEx,requiredExport(deusEx,'DataLinkPlay')),
    runtime.loadClass(deusEx,requiredExport(deusEx,'Image02_NYC_Warehouse')),
  ]);
  const authored={};
  for(const name of Object.keys(SCRIPTED_ACTOR_CONSTRUCTION.dataLinkPlay.authoredDefaults))
    authored[name]=runtime.defaultValue(dataLinkClass,runtime.lookupMember(dataLinkClass,'fields',name));
  verifyDataLinkPlayDefaults(authored);

  for(const path of ['Actor.Spawn','Actor.Spawned','Actor.PreBeginPlay','Actor.BeginPlay',
    'Actor.PostBeginPlay','Actor.PostPostBeginPlay','Actor.SetInitialState','Actor.GainedChild',
    'Actor.LostChild','Actor.SetCollision','Actor.SetCollisionSize','Actor.SetPhysics',
    'Actor.SetOwner','Actor.Destroy','Actor.GetItemName',
    'Actor.SupportActor','Actor.Attach','Actor.Detach','Actor.BaseChange',
    'Actor.EncroachingOn','Actor.EncroachedBy'])await prepare(runtime,engine,path);
  // The Inventory startup/give chain reached by the transfer event:
  // Pickup's auto-state BeginState and its Begin: label call BecomePickup,
  // while SpawnCopy -> GiveTo -> AddInventory -> GotoState('Idle2') runs the
  // received half on the player.
  for(const path of ['Inventory.PostBeginPlay','Inventory.BecomePickup','Inventory.BecomeItem',
    'Inventory.GiveTo','Inventory.SpawnCopy','Pawn.AddInventory','Pawn.DeleteInventory',
    'Pawn.FindInventoryType'])await prepare(runtime,engine,path);
  // DataVaultImage.SpawnCopy (DataVaultImage.uc:41-48) shadows the Engine body
  // on Image02_NYC_Warehouse's method chain: it calls Super.SpawnCopy(Other)
  // and returns the result, so the override is the entry point the receiver's
  // class lookup resolves and the Engine body runs beneath it.
  for(const [asset,path] of [[engine,'GameInfo.IsRelevant'],[engine,'GameInfo.ShouldRespawn'],
    [engine,'Mutator.AlwaysKeep'],[engine,'Mutator.IsRelevant'],[engine,'Mutator.CheckReplacement'],
    [deusEx,'DataVaultImage.SpawnCopy'],[deusEx,'DeusExPlayer.AddInventory'],
    [deusEx,'ConPlayBase.SetupEventTransferObject'],[deusEx,'DeusExPlayer.AddImage'],
    [deusEx,'DeusExPlayer.FindInventorySlot']])await prepare(runtime,asset,path);
  await runtime.prepareState(engine,requiredExport(engine,'Inventory.Pickup'));
  await runtime.prepareState(engine,requiredExport(engine,'Inventory.Idle2'));
  // Image02_NYC_Warehouse inherits DataVaultImage's own `auto state Pickup`
  // (DataVaultImage.uc:101), which shadows Engine.Inventory.Pickup through the
  // state base chain, so GotoState('Auto') resolves the derived record.
  await runtime.prepareState(deusEx,requiredExport(deusEx,'DataVaultImage.Pickup'));
  await prepare(runtime,engine,'Inventory.Pickup.BeginState');
  await prepare(runtime,engine,'Inventory.Pickup.EndState');

  const registry=new ScriptObjectRegistry();
  // FName::StaticInit hardcodes None as entry 0 with flags 0x04000400
  // (Core 0x1014bc26..0x1014bc3d); the collector's name pass skips 0x04000000.
  const none={index:0,flags:0x04000400,hashNext:null,text:'None'};
  // FName::DeleteEntry frees the entry through GMalloc; the host entry record
  // is released with its GNames slot.
  const names=createScriptNames({names:[none],freeIndices:[],buckets:Array(0x1000).fill(null),
    allocator:{free:()=>{}}});
  names.buckets[names.hashBucket(none.text)]=none;
  const outer={identity:{},index:-1,name:'TrainingRuntime',outer:null,flags:0};
  const nativeLevel={identity:{},index:-1,name:'MyLevel',outer,flags:0};
  // UObject::GetTransientPackage (Core 0x10102450): the outer execNew uses
  // for a None Outer. Its index is this host registry's, not a measured one.
  const transientPackage={identity:{},index:-1,name:'Transient',outer:null,flags:0};
  for(const object of [outer,nativeLevel,transientPackage]){
    object.nameIndex=names.intern(object.name).index;registry.add(object);
  }
  const lookup=createScriptObjectLookup({registry,names});
  level.nativeObject=nativeLevel;level.undo=null;level.spawnTracking=false;
  level.tickParity=false;level.spawnNotifyGuard={active:false};
  level.pendingDeleted=null;level.collisionHash=null;
  level.engine.audio=null;

  // World bindings only: SpawnActor itself selects each class's bound
  // ClassConstructor (script-spawn.mjs), so no class is admitted here.
  runtime.actorLifecycle={
    validateSpawn:args=>args.level===level,
    construction:{
      validate:args=>args.outer===outer&&args.template===null,
      registry,names,findObject:lookup.findObject,internName:name=>names.intern(name),
      initNativeProperties:object=>{
        object.auxiliary=null;
        runtime.instance(object.identity).sleepTimeLeft=0;
      },
      nativeConstructor:constructActorBase,
      transientPackage,
    },
    // Final UObject release for CriticalDelete, with the live-game values of
    // the two ~UObject gates (docs/script-object-release.md).
    objectRelease:{
      gates:{[0x102a2644]:1,[0x101e5550]:0},
      registry,isValid:object=>registry.objects[object.index]===object,
      freeStateFrame:()=>{throw new Error('CriticalDelete reached an object with a state frame');},
      freeObject:object=>{object.released=true;},
    },
  };
  runtime.nameServices={internName:text=>names.intern(text).name};
  return {dataLinkClass,imageClass,registry,names};
}

/** Prepare package objects before synchronous script execution. */
export async function createLiveDataLinkRuntime({
  runtime,assets,engine,deusEx,level,levelInfo,player,windowHost,onLifecycle=null,spawnWorldPrepared=false,
}={}){
  if(!runtime||!assets?.get||!level||!player||!windowHost?.hud)
    throw new TypeError('DataLink requires the linked world and native window host');
  const [conSys,conText,extension]=await Promise.all(['ConSys','DeusExConText','Extension'].map(name=>assets.get(name)));
  await prepareDataLinkFunctions(runtime,{deusEx,conSys,extension});
  // Both state label streams and their local Timer overrides must be linked.
  for(const [path,index] of deusEx.exportsByPath){
    if(!path.startsWith('datalinkplay.'))continue;
    const kind=deusEx.pkg.exports[index-1].className;
    if(kind==='Function')await runtime.prepareFunction(deusEx,index);
    else if(kind==='State')await runtime.prepareState(deusEx,index);
  }
  if(!spawnWorldPrepared)await prepareLiveActorSpawnWorld({runtime,engine,deusEx,level,levelInfo});
  const catalog=await loadTrainingDataLinkCatalog(assets);
  await runtime.prepareDynamicLoadObject(catalog.speaker.portrait.objectName);
  // Login's original ConBindEvents supplies all of the player's conversations.
  // Mission00.Timer also starts DataLinks (for example DL_Lockpick after crate
  // destruction), so the map's 18 trigger routes are not a preparation boundary.
  const conversations=[],seenItems=new Set();
  for(let item=get(runtime,player,'ConListItems');item;item=get(runtime,item,'next')){
    if(seenItems.has(item))throw new Error('Player ConListItems chain is cyclic');
    seenItems.add(item);
    const conversation=get(runtime,item,'con');
    if(!get(runtime,conversation,'bDataLinkCon'))continue;
    await prepareConversationGraph(runtime,conversation);
    conversations.push({conversation});
  }
  // HUDInfoLinkDisplay.SetSpeaker loads "InfoPortraits." $ Left(bindName,16)
  // through DynamicLoadObject for each speech speaker (PaulDenton appends
  // "_" $ Chr(49 + player.PlayerSkin); BobPage on mission 15 is BobPageAug).
  // The synchronous native needs each such export prepared; a name with no
  // export is left alone (the original DynamicLoadObject returns None).
  const portraits=await assets.get('InfoPortraits');
  // DeusExPlayer.GetLevelInfo: the level's DeusExLevelInfo actor.
  const isDeusExLevelInfo=actor=>{
    try{for(let cls=runtime.instance(actor).cls;cls;cls=cls.base)if(cls.record.key==='deusex.deusexlevelinfo')return true;}catch{}
    return false;
  };
  const deusExLevelInfo=(level.actors??[]).find(actor=>actor&&isDeusExLevelInfo(actor))??null;
  const mission=deusExLevelInfo?get(runtime,deusExLevelInfo,'missionNumber'):null;
  const portraitNames=new Set();
  for(const {conversation} of conversations){
    for(let event=get(runtime,conversation,'eventList'),guard=0;event&&guard<4096;event=get(runtime,event,'nextEvent'),guard++){
      if(runtime.instance(event).cls.record.key!=='consys.coneventspeech')continue;
      const bindName=String(get(runtime,event,'speakerName')??'');
      if(!bindName)continue;
      let name=bindName.slice(0,16);
      if(bindName==='PaulDenton')name+=`_${String.fromCharCode(49+(get(runtime,player,'PlayerSkin')|0))}`;
      if(bindName==='BobPage'&&mission===15)name='BobPageAug';
      portraitNames.add(name);
    }
  }
  for(const name of portraitNames)
    if(portraits.exportsByPath.has(name.toLowerCase())&&`infoportraits.${name.toLowerCase()}`!==catalog.speaker.portrait.objectName.toLowerCase())
      await runtime.prepareDynamicLoadObject(`InfoPortraits.${name}`);
  const routes=[];
  for(const route of catalog.routes){
    const conversation=await runtime.objects.resolve(conText,route.conversation.exportIndex);
    await runtime.prepareObject(conversation);
    const speech=get(runtime,conversation,'eventList');await runtime.prepareObject(speech);
    const endEvent=get(runtime,speech,'nextEvent');await runtime.prepareObject(endEvent);
    await runtime.prepareObject(get(runtime,speech,'conSpeech'));
    for(let flag=get(runtime,conversation,'flagRefList');flag;flag=get(runtime,flag,'nextFlagRef'))
      await runtime.prepareObject(flag);
    if(conversation.index!==route.conversation.exportIndex||speech.index!==route.chain.speechEvent.exportIndex||
      endEvent.index!==route.chain.endEvent.exportIndex)throw new Error('Training DataLink original event chain changed');
    routes.push({route,conversation,speech,endEvent});
  }
  // Login builds the full ConListItem list (including non-DataLink entries).
  // Do not replace it with a host-selected subset of the map's 18 triggers.
  const receivedItems=[];
  let previous=null,lastPresentation=null;
  // ConPlayBase.TerminateConversation clears con but retains startCon;
  // FireNextDataLink replaces both. Unknown original conversations therefore
  // need no previous-route fallback, including on the same DataLinkPlay actor.
  const entryFor=play=>routes.find(entry=>entry.conversation===get(runtime,play,'startCon')||
    entry.conversation===get(runtime,play,'con'))??null;
  const phaseFor=play=>get(runtime,play,'bEndTransmission')?'ending':
    (runtime.instance(play).state.stateNode?.record.key==='deusex.datalinkplay.waitforspeech'||
      (previous?.play===play&&previous.phase==='speech'))?'speech':'starting';
  const emit=(kind,record)=>onLifecycle?.({kind,tag:record.entry?.route.dataLinkTag??'DataLink',
    route:record.entry?.route??null,trigger:record.trigger,player,play:record.play});
  // Diagnostics read original state after a scheduler/event boundary; they
  // neither call script nor write timers, states, actor arrays or HUD fields.
  function observe(){
    const play=get(runtime,player,'dataLinkPlay');
    if(!play){
      if(previous){emit('destroyed',previous);lastPresentation={...lastPresentation,phase:'destroyed',shellVisible:false};}
      previous=null;return null;
    }
    const entry=entryFor(play),phase=phaseFor(play),display=get(runtime,play,'dataLink');
    if(!display)return null; // original deferred start while a conversation/computer owns the HUD
    const record={play,entry,phase,trigger:get(runtime,play,'datalinkTrigger'),display,
      speech:entry?.speech,endEvent:entry?.endEvent};
    if(!previous||previous.play!==play||previous.display!==display)emit('started',record);
    else if(previous.phase!==phase)emit(phase==='speech'?'speech':phase,record);
    previous=record;
    lastPresentation={phase,shellVisible:Boolean(display),tag:entry?.route.dataLinkTag??null,
      // Metadata is diagnostic only. The viewer draws the native window tree
      // and transports recorded PlaySound requests; it reads no host timeline.
      route:entry?.route??null,content:entry?{speech:entry.route.chain.speech.text,
        speakerDisplayName:entry.route.speaker.displayName}:null,audio:entry?.route.audio??null};
    return record;
  }
  function shell(){
    const object=get(runtime,windowHost.hud,'infoLink');
    const objects=object?Object.fromEntries(['Portrait','Static','Name','Queued','Text','Line'].map(name=>
      [name.toLowerCase(),get(runtime,object,'win'+name)])):{};
    return {root:windowHost.root,hud:windowHost.hud,object,objects,
      readNative:windowHost.raw.read,isDestroyed:windowHost.isDestroyed,withLifecycle:fn=>fn()};
  }
  return {catalog,routes,conversations,observe,
    shell,receivedItems,active:()=>observe(),presentation:()=>{observe();return lastPresentation;},
    // LoadMap destroys the old actors/windows. Only diagnostic references are reset here.
    reset(){previous=null;lastPresentation=null;},
    bindPlayer(next){runtime.instance(next);player=next;previous=null;lastPresentation=null;},
  };
}
