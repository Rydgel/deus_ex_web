/**
 * Live Training DataLink lifecycle, connected to the original script graph.
 *
 * Selection, DataLinkPlay spawning, SetConversation, SetTrigger, the
 * ConPlayBase start gate, trigger completion, and ConPlayBase termination run
 * their installed UnrealScript/native paths.  The small playback scheduler in
 * this file translates DataLinkPlay's recovered Timer/WaitForSpeech order and
 * invokes the prepared HUD controls; the speech-to-end transition executes the
 * installed PlayNextEvent -> ProcessAction -> PlayEvent.SetupEvent ->
 * ConPlayBase.SetupEventEnd chain before the original termination body. Browser
 * audio transport remains a presentation boundary.
 *
 * Evidence: .cache/reference/DeusExPlayer.uc:8192-8319,
 * .cache/reference/DataLinkTrigger.uc:56-175, and
 * .cache/reference/DataLinkPlay.uc:75-176, 330-420, 451-741, and
 * .cache/reference/ConPlayBase.uc:1162-1169.
 */
import {ScriptObjectRegistry,constructActorBase} from './script-object-construction.mjs';
import {createScriptNames} from './script-names.mjs';
import {createScriptObjectLookup} from './script-object-lookup.mjs';
import {prepareDataLinkFunctions} from './script-datalink-transmission.mjs';
import {
  SCRIPTED_ACTOR_CONSTRUCTION,resolveInheritedActorConstructor,verifyDataLinkPlayDefaults,
} from './script-scripted-actor-construction.mjs';
import {inventoryConstructorChain,inventorySelection} from './script-spawn.mjs';
import {refValue} from './script-vm.mjs';
import {setActorTimer,updateActorTimer} from './script-timers.mjs';
import {createInfoLinkTimeline,infoLinkTimelineState} from './script-infolink-timeline.mjs';
import {INFOLINK_CONTENT_REFERENCE} from './script-infolink-content.mjs';
import {loadTrainingDataLinkCatalog} from './script-training-datalinks.mjs';

const f=Math.fround;
const lower=value=>String(value??'').toLowerCase();

function requiredExport(asset,path){
  const index=asset?.exportsByPath?.get(lower(path));
  if(!index)throw new Error(`Missing original ${asset?.name??'package'}.${path}`);
  return index;
}

async function prepare(runtime,asset,path){
  return runtime.prepareFunction(asset,requiredExport(asset,path));
}

function set(runtime,object,name,value){runtime.namedReference(object,name).set(value);}
function get(runtime,object,name){return runtime.namedReference(object,name).get();}

/** Build the exact script/native world prerequisites for DataLinkPlay Spawn
 * and the shipped DataVaultImage class the DL_Rooftops transfer event uses. */
export async function prepareLiveActorSpawnWorld({runtime,engine,deusEx,level,levelInfo}){
  const [dataLinkClass,imageClass,gameClass,mutatorClass]=await Promise.all([
    runtime.loadClass(deusEx,requiredExport(deusEx,'DataLinkPlay')),
    runtime.loadClass(deusEx,requiredExport(deusEx,'Image02_NYC_Warehouse')),
    runtime.loadClass(deusEx,requiredExport(deusEx,'DeusExGameInfo')),
    runtime.loadClass(engine,requiredExport(engine,'Mutator')),
  ]);
  const authored={};
  for(const name of Object.keys(SCRIPTED_ACTOR_CONSTRUCTION.dataLinkPlay.authoredDefaults))
    authored[name]=runtime.defaultValue(dataLinkClass,runtime.lookupMember(dataLinkClass,'fields',name));
  verifyDataLinkPlayDefaults(authored);

  const game={name:'DeusExGameInfo DataLink runtime'};
  const mutator={name:'Mutator DataLink runtime'};
  runtime.attach(game,gameClass);runtime.attach(mutator,mutatorClass);
  set(runtime,levelInfo,'Game',game);
  set(runtime,game,'Level',levelInfo);set(runtime,game,'BaseMutator',mutator);
  set(runtime,game,'Difficulty',0);set(runtime,game,'bNoMonsters',false);
  set(runtime,game,'SecretGoals',0);set(runtime,game,'ItemGoals',0);set(runtime,game,'KillGoals',0);
  set(runtime,mutator,'NextMutator',null);
  level.actors.push(game,mutator);

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
  const none={index:0,flags:0,hashNext:null,text:'None'};
  const names=createScriptNames({names:[none],freeIndices:[],buckets:Array(0x1000).fill(null),
    allocator:{free:()=>{throw new Error('Live DataLink FName release is outside the selected lifecycle');}}});
  names.buckets[names.hashBucket(none.text)]=none;
  const outer={identity:{},index:-1,name:'TrainingRuntime',outer:null};
  const nativeLevel={identity:{},index:-1,name:'MyLevel',outer};
  for(const object of [outer,nativeLevel]){
    object.nameIndex=names.intern(object.name).index;registry.add(object);
  }
  const lookup=createScriptObjectLookup({registry,names});
  level.nativeObject=nativeLevel;level.undo=null;level.spawnTracking=false;
  level.tickParity=false;level.spawnNotifyGuard={active:false};
  level.pendingDeleted=null;level.collisionHash=null;
  level.engine.audio=null;

  const selection=resolveInheritedActorConstructor({
    dataLinkPlay:{key:dataLinkClass.record.key,nativeConstructor:null},
    conPlayBase:{key:dataLinkClass.base.record.key,nativeConstructor:null},
    actor:{key:dataLinkClass.base.base.record.key,
      nativeConstructor:SCRIPTED_ACTOR_CONSTRUCTION.engineActor.internalConstructor,
      nativeVtable:SCRIPTED_ACTOR_CONSTRUCTION.engineActor.vtable},
  });
  // Every concrete script-only Engine.Weapon/Engine.Inventory subclass is
  // admitted by its linked native-root ancestry, so the shipped DataLink image
  // classes and the armed-NPC weapon/ammo classes share one route instead of
  // one class key each.
  const admitted=cls=>cls===dataLinkClass||inventoryConstructorChain(cls)!==null;
  runtime.actorLifecycle={
    validateSpawn:args=>admitted(args.cls)&&args.level===level,
    construction:{
      validate:args=>admitted(args.cls)&&args.outer===outer&&args.template===null,
      registry,findObject:lookup.findObject,internName:name=>names.intern(name),
      initNativeProperties:object=>{
        object.auxiliary=null;
        runtime.instance(object.identity).sleepTimeLeft=0;
      },
      nativeConstructor:constructActorBase,
    },
    resolveConstructor:cls=>{
      if(cls===dataLinkClass)return selection;
      const selected=inventorySelection(cls);
      if(selected)return selected;
      throw new Error('Live DataLink constructor received another class');
    },
  };
  runtime.nameServices={internName:text=>names.intern(text).name};
  return {dataLinkClass,imageClass,game,mutator,registry,names};
}

/**
 * Connect the source-backed Training DataLink routes to a live ScriptRuntime.
 * `shell` is the HUDInfoLinkDisplay child built by createInfoLinkShellPreview.
 */
export async function createLiveDataLinkRuntime({
  runtime,assets,engine,deusEx,level,levelInfo,player,shell,onLifecycle=null,spawnWorldPrepared=false,
}={}){
  if(!runtime||!assets?.get||!level||!levelInfo||!player||!shell?.object)
    throw new TypeError('Live DataLink runtime requires the linked Play world and InfoLink shell');
  if(onLifecycle!=null&&typeof onLifecycle!=='function')
    throw new TypeError('Live DataLink onLifecycle must be a function');
  let currentShell=shell;
  const [core,conSys,conText,extension]=await Promise.all([
    assets.get('Core'),assets.get('ConSys'),assets.get('DeusExConText'),assets.get('Extension'),
  ]);
  const prepared=await prepareDataLinkFunctions(runtime,{deusEx,conSys,extension});
  await prepare(runtime,extension,'ExtensionObject.StringToName');
  const baseTerminate=await prepare(runtime,deusEx,'ConPlayBase.TerminateConversation');
  await prepare(runtime,deusEx,'ConPlayBase.SetPlayedFlag');
  await prepare(runtime,deusEx,'ConPlayBase.EndConActorStates');
  // The end edge is kept on the installed script path.  These records are
  // prepared separately because the general DataLink preparation covers the
  // browser's start/HUD edges, while the selected direct Speech -> End route
  // only reaches this smaller PlayEvent slice.
  const stopSpeech=await prepare(runtime,deusEx,'ConPlayBase.StopSpeech');
  const playNextEvent=await prepare(runtime,deusEx,'DataLinkPlay.PlayNextEvent');
  const processAction=await prepare(runtime,deusEx,'DataLinkPlay.ProcessAction');
  const dataLinkTerminate=await prepare(runtime,deusEx,'DataLinkPlay.TerminateConversation');
  const notifyDataLinkTrigger=await prepare(runtime,deusEx,'DataLinkPlay.NotifyDatalinkTrigger');
  const playEventState=await runtime.prepareState(deusEx,requiredExport(deusEx,'DataLinkPlay.PlayEvent'));
  const playEventSetup=await prepare(runtime,deusEx,'DataLinkPlay.PlayEvent.SetupEvent');
  const setupEventSpeech=await prepare(runtime,deusEx,'DataLinkPlay.SetupEventSpeech');
  const setupEventEnd=await prepare(runtime,deusEx,'ConPlayBase.SetupEventEnd');
  if(!spawnWorldPrepared)await prepareLiveActorSpawnWorld({runtime,engine,deusEx,level,levelInfo});

  // The catalog is the admission/content/audio source of truth.  Resolve all
  // three original package objects for every route so the VM still receives
  // Conversation, ConEventSpeech/ConSpeech, and ConEventEnd identities rather
  // than a text/audio replacement.
  const catalog=await loadTrainingDataLinkCatalog(assets);
  const portraitAsset=await assets.get(catalog.speaker.portrait.packageName);
  const portraitTexture=await runtime.objects.resolve(portraitAsset,catalog.speaker.portrait.exportIndex);
  if(portraitTexture?.key!==lower(catalog.speaker.portrait.objectName)||portraitTexture.kind!=='Texture')
    throw new Error('Live DataLink runtime resolved a different speaker portrait object');
  const preparedPortrait=await runtime.prepareDynamicLoadObject(catalog.speaker.portrait.objectName);
  if(preparedPortrait!==portraitTexture)
    throw new Error('DynamicLoadObject preparation did not preserve the canonical portrait identity');
  const routes=[];
  for(const route of catalog.routes){
    const routeConversation=await runtime.objects.resolve(conText,route.conversation.exportIndex);
    await runtime.prepareObject(routeConversation);
    const routeSpeech=get(runtime,routeConversation,'eventList');
    await runtime.prepareObject(routeSpeech);
    const routeEndEvent=get(runtime,routeSpeech,'nextEvent');
    await runtime.prepareObject(routeEndEvent);
    // GetActiveDataLink's original CheckFlagRefs walks this linked ConFlagRef
    // chain before admission (DL_lockstr is the authored Training case).
    const seenFlagRefs=new Set();
    for(let flagRef=get(runtime,routeConversation,'flagRefList');flagRef;){
      if(seenFlagRefs.has(flagRef))throw new Error(`Live DataLink ${route.dataLinkTag} has a cyclic flag-ref chain`);
      seenFlagRefs.add(flagRef);await runtime.prepareObject(flagRef);
      flagRef=get(runtime,flagRef,'nextFlagRef');
    }
    if(routeConversation.index!==route.conversation.exportIndex||
        routeSpeech.index!==route.chain.speechEvent.exportIndex||
        routeEndEvent.index!==route.chain.endEvent.exportIndex)
      throw new Error(`Live DataLink runtime resolved a different ${route.dataLinkTag} event chain`);
    if(get(runtime,routeConversation,'conName')!==route.conversation.name)
      throw new Error(`Live DataLink runtime resolved a different ${route.dataLinkTag} conversation`);

    // The browser shell owns the original portrait/icon/timing objects.  Only
    // the authored route speech/name and its exact encoded MP3 vary here.
    const content=Object.freeze({...shell.content,
      conversationName:route.conversation.name,
      speakerBindName:route.speaker.bindName,
      speakerDisplayName:route.speaker.displayName,
      speech:route.chain.speech.text,soundId:route.chain.speech.soundId,
    });
    const audio=Object.freeze({...route.audio,
      conversationName:route.conversation.name,
      startCue:shell.audio.startCue,
      speechDelaySeconds:shell.audio.speechDelaySeconds,
      playbackBoundary:shell.audio.playbackBoundary,
    });
    routes.push({route,conversation:routeConversation,speech:routeSpeech,endEvent:routeEndEvent,
      content,audio,timeline:createInfoLinkTimeline(content,audio.seconds),trigger:null});
  }
  if(!routes.length)throw new Error('Live DataLink runtime found no authored Training routes');
  const routeByTag=new Map(routes.map(entry=>[lower(entry.route.dataLinkTag),entry]));
  const routeForConversation=con=>routes.find(entry=>entry.conversation===con)??null;
  const startRoute=routeByTag.get(lower(INFOLINK_CONTENT_REFERENCE.conversationName));
  if(!startRoute||startRoute.conversation.index!==INFOLINK_CONTENT_REFERENCE.conversationExport||
      startRoute.speech.index!==INFOLINK_CONTENT_REFERENCE.eventExport||
      startRoute.endEvent.index!==INFOLINK_CONTENT_REFERENCE.endEventExport)
    throw new Error('Live DataLink runtime resolved a different DL_Start event chain');

  // GetActiveDataLink walks this linked list.  Keep the route order authored by
  // the 00_Training map and retain all 18 canonical Training entries.
  const itemClass=await runtime.loadClass(conSys,requiredExport(conSys,'ConListItem'));
  const items=routes.map(entry=>{const item={name:`ConListItem ${entry.route.dataLinkTag}`};
    runtime.attach(item,itemClass);set(runtime,item,'con',entry.conversation);set(runtime,item,'next',null);return item;});
  for(let index=0;index+1<items.length;index++)set(runtime,items[index],'next',items[index+1]);
  set(runtime,player,'ConListItems',items[0]);set(runtime,player,'rootWindow',shell.root);
  set(runtime,shell.root,'parentPawn',player);set(runtime,shell.root,'hud',shell.hud);
  set(runtime,shell.hud,'infoLink',null);
  // SetupEventTransferObject's DataVaultImage branch ends at
  // DeusExRootWindow(player.rootWindow).hud.receivedItems.AddItem(invItemTo,1).
  // The attached HUDReceivedDisplay carries the real field storage the script
  // reads; its AddItem body reaches winTile.NewChild, which belongs to the
  // Stage-4 window lifecycle, so the call is a recorded boundary on the
  // original function key rather than a substitute implementation.
  const receivedClass=await runtime.loadClass(deusEx,requiredExport(deusEx,'HUDReceivedDisplay'));
  const receivedItems=[];
  const originalReceivedDisplay=get(runtime,shell.hud,'receivedItems');
  const receivedDisplay=originalReceivedDisplay??{name:'HUDReceivedDisplay DataLink runtime'};
  if(!originalReceivedDisplay){
    runtime.attach(receivedDisplay,receivedClass);
    shell.adoptWindow?.(receivedDisplay,shell.hud);
    set(runtime,shell.hud,'receivedItems',receivedDisplay);
  }
  runtime.boundaryFunctions.set('deusex.hudreceiveddisplay.additem',call=>{
    const item=call.argumentCount>0?refValue(call.evaluateArgument(0)):null;
    const count=call.argumentCount>1?refValue(call.evaluateArgument(1)):null;
    receivedItems.push(Object.freeze({item,count}));
  });

  const getActiveDataLink=prepared.get('deusex.deusexplayer.getactivedatalink');
  const popDataLink=prepared.get('deusex.datalinkplay.popdatalink');
  const showTextCursor=prepared.get('deusex.hudinfolinkdisplay.showtextcursor');
  const showDataLinkIcon=prepared.get('deusex.hudinfolinkdisplay.showdatalinkicon');
  const clearScreen=prepared.get('deusex.hudinfolinkdisplay.clearscreen');
  const setSpeaker=prepared.get('deusex.hudinfolinkdisplay.setspeaker');
  const showPortrait=prepared.get('deusex.hudinfolinkdisplay.showportrait');
  const displayText=prepared.get('deusex.hudinfolinkdisplay.displaytext');
  const destroyInfoLink=prepared.get('deusex.deusexhud.destroyinfolinkwindow');
  const windowShow=await prepare(runtime,extension,'Window.Show');
  const windowIsVisible=await prepare(runtime,extension,'Window.IsVisible');
  const textSet=await prepare(runtime,extension,'TextWindow.SetText');
  await prepare(runtime,core,'Object.DynamicLoadObject');
  if(!getActiveDataLink||!popDataLink||!showTextCursor||!showDataLinkIcon||!clearScreen||
      !setSpeaker||!showPortrait||!displayText||!destroyInfoLink)
    throw new Error('Live DataLink runtime did not prepare the route/HUD functions');
  const queue=[];
  let pendingAdmission=null;
  let active=null,lastPresentation=null,lastTrigger=null;

  function resolveTrigger(entry,supplied=null){
    if(supplied)return supplied;
    const route=entry.route.trigger;
    const candidate=level.actors?.[route.actorSlot];
    // The LoadMap tail partition (Engine.dll 0x1038dcd5) compacts and reorders
    // the tail of Level.Actors, so the serialized slot only resolves the actor
    // before startup partitioning; the authored route name is the identity.
    return candidate?.name===route.name?candidate
      :level.actors?.find(actor=>actor?.name===route.name)??null;
  }

  function callPrepared(record,receiver,args=[]){
    if(!record)throw new Error('Live DataLink reached an unprepared HUD function');
    return currentShell.withLifecycle(()=>runtime.callFunction(record,receiver,args.length,index=>args[index]));
  }

  function visible(window){
    return Boolean(callPrepared(windowIsVisible,window));
  }

  function setVisible(window,value){
    callPrepared(windowShow,window,[Boolean(value)]);
  }

  function setName(text){
    callPrepared(textSet,currentShell.objects.name,[text]);
  }

  function callSpeaker(entry){
    // The installed SetSpeaker body builds InfoPortraits.<Left(bind,16)> and
    // assigns the canonical package Texture through the recovered native
    // DynamicLoadObject wrapper and its focused first-load ULinkerLoad path.
    callPrepared(setSpeaker,currentShell.object,
      [entry.route.speaker.bindName,entry.route.speaker.displayName]);
    if(get(runtime,currentShell.object,'speakerPortrait')!==portraitTexture)
      throw new Error('Original HUDInfoLinkDisplay.SetSpeaker did not assign the canonical portrait');
  }

  function renderSpeech(entry){
    callPrepared(clearScreen,currentShell.object);
    callSpeaker(entry);
    callPrepared(showPortrait,currentShell.object);
    callPrepared(displayText,currentShell.object,[entry.content.speech]);
  }

  function blinkStartIcon(){
    callPrepared(showDataLinkIcon,currentShell.object,[!visible(currentShell.objects.portrait)]);
  }

  function destroyCurrentShell(){
    const old=currentShell;
    if(old.isDestroyed(old.object))return old;
    if(get(runtime,old.hud,'infoLink')!==old.object)
      throw new Error('Live DataLink HUD did not own the current InfoLink before destruction');
    callPrepared(destroyInfoLink,old.hud);
    if(get(runtime,old.hud,'infoLink')!==null)
      throw new Error('Original DeusExHUD.DescendantRemoved did not clear InfoLink');
    if(!old.isDestroyed(old.object))
      throw new Error('Original DeusExHUD.DestroyInfoLinkWindow did not destroy InfoLink');
    return old;
  }

  function recreateCurrentShell(old=currentShell){
    currentShell=old.recreate();
    return currentShell;
  }

  const resolvedValue=value=>value?.reference?value.get():value;
  const emit=(kind,record=active,details={})=>onLifecycle?.({kind,
    tag:record?.entry?.route.dataLinkTag??lastTrigger?.values?.datalinkTag??'DataLink',
    trigger:record?.trigger??lastTrigger,route:record?.entry?.route??null,
    audio:record?.entry?.audio??null,content:record?.entry?.content??null,
    player,play:record?.play??null,presentation:lastPresentation,...details});

  function publishPresentation(){
    if(!active)return lastPresentation;
    const state=infoLinkTimelineState(active.elapsed,active.entry.content,active.entry.timeline);
    lastPresentation=Object.freeze({...state,
      audio:active.entry.audio,content:active.entry.content,route:active.entry.route,
      tag:active.entry.route.dataLinkTag,
    });
    return lastPresentation;
  }

  function begin(play,newPlayer,newInvokeActor,bForcePlay){
    const con=get(runtime,play,'con');
    const entry=routeForConversation(con);
    if(!entry)return false;
    if(active){
      if(active.play!==play)throw new Error('A second DataLinkPlay object reached the live lifecycle');
      // The original DataLinkPlay.SetConversation/PushDataLink and
      // HUDInfoLinkDisplay.MessageQueued calls have already run before this
      // StartConversation boundary. Mirror only the route metadata needed by
      // the browser presentation; PopDataLink below still owns selection.
      if(pendingAdmission){
        const next=pendingAdmission;
        queue.push({entry:next.entry,conversation:next.entry.conversation,
          speech:next.entry.speech,endEvent:next.entry.endEvent,trigger:next.trigger});
      }
      return true;
    }
    // This is the exact successful branch guarded by DataLinkPlay before it
    // enters its presentation code.  The canonical root stack is empty and no
    // first-person conversation is active in Training.
    if(get(runtime,play,'dataLink')!==null||get(runtime,newPlayer,'conPlay')!==null||
        get(runtime,currentShell.root,'winCount')!==0)return true;
    const accepted=runtime.callFunction(prepared.get('deusex.conplaybase.startconversation'),play,3,
      index=>[newPlayer,newInvokeActor,bForcePlay][index]);
    if(!accepted)return false;
    const trigger=get(runtime,play,'datalinkTrigger');
    callPrepared(showTextCursor,currentShell.object,[false]);
    set(runtime,play,'lastSpeechTextLength',0);set(runtime,play,'bEndTransmission',false);
    set(runtime,play,'eventTimer',0);set(runtime,play,'dataLink',currentShell.object);
    set(runtime,currentShell.hud,'infoLink',currentShell.object);set(runtime,play,'currentEvent',entry.speech);
    set(runtime,play,'bStartTransmission',true);
    setActorTimer(runtime.timerState(play),get(runtime,play,'blinkRate'),true);
    active={play,entry,con,speech:entry.speech,endEvent:entry.endEvent,trigger:resolveTrigger(entry,trigger),
      phase:'starting',elapsed:0,sleepRemaining:0};lastTrigger=active.trigger;
    publishPresentation();emit('started');
    return true;
  }

  function startQueued(record,next){
    const {play}=record;
    set(runtime,play,'con',next.conversation);set(runtime,play,'startCon',next.conversation);
    set(runtime,play,'datalinkTrigger',next.trigger);
    set(runtime,play,'dataLink',null);set(runtime,currentShell.hud,'infoLink',null);
    set(runtime,play,'bEndTransmission',false);set(runtime,play,'eventTimer',0);
    const accepted=runtime.callFunction(prepared.get('deusex.conplaybase.startconversation'),play,3,
      index=>[player,null,false][index]);
    if(!accepted)throw new Error(`Queued Training DataLink ${next.entry.route.dataLinkTag} failed ConPlayBase.StartConversation`);
    set(runtime,play,'lastSpeechTextLength',0);set(runtime,play,'bEndTransmission',false);
    set(runtime,play,'eventTimer',0);set(runtime,play,'dataLink',currentShell.object);
    set(runtime,currentShell.hud,'infoLink',currentShell.object);set(runtime,play,'currentEvent',next.speech);
    callPrepared(showTextCursor,currentShell.object,[false]);
    set(runtime,play,'bStartTransmission',true);
    setActorTimer(runtime.timerState(play),get(runtime,play,'blinkRate'),true);
    record.entry=next.entry;record.con=next.conversation;record.speech=next.speech;record.endEvent=next.endEvent;
    record.trigger=next.trigger;record.phase='starting';record.elapsed=0;record.sleepRemaining=0;
    lastTrigger=record.trigger;publishPresentation();emit('started',record);
  }

  /**
   * Advance the authored direct Speech -> End chain through the original
   * DataLinkPlay script.  The temporary ProcessAction/TerminateConversation
   * observers only record the two native-visible state edges; both delegate
   * immediately to their prepared bodies, so the browser does not replace the
   * original action or termination semantics.
   */
  function terminate(){
    const record=active;if(!record)return;
    const {play}=record;
    record.endTrace=[];
    const actionKey=processAction.key,terminateKey=dataLinkTerminate.key;
    const previousActionBoundary=runtime.boundaryFunctions.get(actionKey);
    const previousTerminateBoundary=runtime.boundaryFunctions.get(terminateKey);
    const cacheArguments=call=>Array.from({length:call.argumentCount},(_,index)=>call.evaluateArgument(index));
    const delegate=(call,key,previous,argumentsCache=cacheArguments(call))=>{
      runtime.boundaryFunctions.delete(key);
      try{
        return runtime.callFunction(call.record,call.receiver,call.argumentCount,
          index=>argumentsCache[index],call);
      }finally{
        if(previous)runtime.boundaryFunctions.set(key,previous);
      }
    };
    const actionBoundary=call=>{
      const argumentsCache=cacheArguments(call);
      if(call.receiver!==play)return delegate(call,actionKey,previousActionBoundary,argumentsCache);
      const action=resolvedValue(argumentsCache[0]);
      const current=get(runtime,play,'currentEvent');
      if(action!==8||current!==record.endEvent)
        throw new Error('Live DataLink end setup did not produce EA_End for the resolved End event');
      record.endTrace.push(Object.freeze({stage:'end-action',action:'EA_End',actionValue:action,
        lastEvent:get(runtime,play,'lastEvent'),currentEvent:current}));
      return delegate(call,actionKey,previousActionBoundary,argumentsCache);
    };
    const terminateBoundary=call=>{
      const argumentsCache=cacheArguments(call);
      if(call.receiver!==play)return delegate(call,terminateKey,previousTerminateBoundary,argumentsCache);
      const last=get(runtime,play,'lastEvent'),current=get(runtime,play,'currentEvent');
      if(last!==record.endEvent||current!==null)
        throw new Error('Live DataLink EA_End did not clear currentEvent before termination');
      record.endTrace.push(Object.freeze({stage:'end-null',action:'EA_End',
        lastEvent:last,currentEvent:current}));
      return delegate(call,terminateKey,previousTerminateBoundary,argumentsCache);
    };
    runtime.boundaryFunctions.set(terminateKey,terminateBoundary);
    try{
      // PlayNextEvent executes StopSpeech, records lastEvent=Speech, advances
      // currentEvent to the authored End, and enters the original PlayEvent
      // state.  ProcessState then runs SetupEvent -> SetupEventEnd ->
      // ProcessAction(EA_End), all with the shell's native window services.
      currentShell.withLifecycle(()=>runtime.callFunction(playNextEvent,play,0));
      const last=get(runtime,play,'lastEvent'),current=get(runtime,play,'currentEvent');
      if(last!==record.speech||current!==record.endEvent)
        throw new Error(`Live DataLink PlayNextEvent did not advance Speech to the resolved End event (${last?.index??'null'} -> ${current?.index??'null'}, expected ${record.speech?.index} -> ${record.endEvent?.index})`);
      if(runtime.instance(play).state.stateNode?.record!==playEventState.record)
        throw new Error('Live DataLink PlayNextEvent did not enter the original PlayEvent state');
      record.endTrace.push(Object.freeze({stage:'end-setup',lastEvent:last,currentEvent:current}));
      // Install this observer only after PlayNextEvent's own EA_NextEvent
      // ProcessAction has completed; the following PlayEvent state call is
      // the one that must produce EA_End.
      runtime.boundaryFunctions.set(actionKey,actionBoundary);
      currentShell.withLifecycle(()=>runtime.processActorScript(play,0));
    }finally{
      if(previousActionBoundary)runtime.boundaryFunctions.set(actionKey,previousActionBoundary);
      else runtime.boundaryFunctions.delete(actionKey);
      if(previousTerminateBoundary)runtime.boundaryFunctions.set(terminateKey,previousTerminateBoundary);
      else runtime.boundaryFunctions.delete(terminateKey);
    }
    if(get(runtime,play,'currentEvent')!==null)
      throw new Error('Live DataLink original EA_End left currentEvent set after termination');
    record.phase='ending';
    emit('ending',record,{action:'EA_End',lastEvent:get(runtime,play,'lastEvent'),currentEvent:null,
      trace:Object.freeze(record.endTrace.slice())});
  }

  function finishPlay(){
    const record=active;if(!record)return;
    const {play}=record;
    setActorTimer(runtime.timerState(play),0,false);set(runtime,play,'bEndTransmission',false);
    if(!currentShell.isDestroyed(currentShell.object)||get(runtime,currentShell.hud,'infoLink')!==null)
      throw new Error('Live DataLink tried to remove its play actor before destroying the InfoLink window');
    set(runtime,play,'dataLink',null);
    set(runtime,player,'dataLinkPlay',null);set(runtime,play,'bDeleteMe',true);
    const index=level.actors.indexOf(play);if(index>=0)level.actors[index]=null;
    record.elapsed=Math.max(record.elapsed,record.entry.timeline.destroy);
    const state=infoLinkTimelineState(record.elapsed,record.entry.content,record.entry.timeline);
    lastPresentation=Object.freeze({...state,audio:record.entry.audio,content:record.entry.content,
      route:record.entry.route,tag:record.entry.route.dataLinkTag});
    active=null;emit('destroyed',record);
  }

  function timer(){
    const record=active;if(!record)return;
    const play=record.play;
    if(record.phase==='starting'){
      blinkStartIcon();
      const value=f(get(runtime,play,'eventTimer')+get(runtime,play,'blinkRate'));
      set(runtime,play,'eventTimer',value);
      if(value>get(runtime,play,'startDelay')){
        set(runtime,play,'bStartTransmission',false);set(runtime,play,'eventTimer',0);
        setActorTimer(runtime.timerState(play),record.entry.audio.seconds,false);
        callPrepared(showTextCursor,currentShell.object,[true]);
        renderSpeech(record.entry);
        record.phase='speech';emit('speech',record);
      }
    }else if(record.phase==='speech'){
      record.phase='post-speech';record.sleepRemaining=f(record.entry.content.timing.postSpeechDelay);
    }else if(record.phase==='ending'){
      setVisible(currentShell.objects.name,!visible(currentShell.objects.name));
      const value=f(get(runtime,play,'eventTimer')+get(runtime,play,'blinkRate'));
      set(runtime,play,'eventTimer',value);
      if(value>get(runtime,play,'endDelay')){
        setActorTimer(runtime.timerState(play),0,false);set(runtime,play,'bEndTransmission',false);
        const destroyedShell=destroyCurrentShell();
        set(runtime,play,'dataLink',null);
        if(queue.length){
          const next=queue.shift();
          const popped=runtime.callFunction(popDataLink,play,0);
          const conversationResult=popped?.reference?popped.get():popped;
          if(conversationResult!==next.conversation)
            throw new Error(`Original DataLink queue popped a different conversation for ${next.entry.route.dataLinkTag}`);
          recreateCurrentShell(destroyedShell);
          startQueued(record,next);
        }else finishPlay();
      }
    }
  }

  function tick(seconds){
    if(!active)return false;
    const delta=f(seconds);active.elapsed+=delta;
    if(active.phase==='post-speech'){
      active.sleepRemaining=f(active.sleepRemaining-delta);
      if(active.sleepRemaining<=0){
        terminate();
      }
    }else updateActorTimer(runtime.timerState(active.play),delta,timer);
    publishPresentation();return true;
  }

  function reset(){
    if(active){const index=level.actors.indexOf(active.play);if(index>=0)level.actors[index]=null;}
    if(active&&!currentShell.isDestroyed(currentShell.object)){
      if(get(runtime,currentShell.hud,'infoLink')!==currentShell.object)
        throw new Error('Live DataLink reset found an unpublished active InfoLink');
      recreateCurrentShell(destroyCurrentShell());
    }else if(currentShell.isDestroyed(currentShell.object))recreateCurrentShell();
    queue.length=0;
    pendingAdmission=null;
    set(runtime,player,'dataLinkPlay',null);set(runtime,currentShell.hud,'infoLink',null);
    const flagBase=get(runtime,player,'flagBase');
    for(const entry of routes)flagBase?.entries?.delete(lower(`${entry.route.conversation.name}_Played`));
    for(const entry of routes){
      const trigger=resolveTrigger(entry);
      if(!trigger)continue;
      for(const [name,value] of [['bStartedViaTrigger',false],['bStartedViaTouch',false],
        ['bCheckFlagTimer',false],['player',null],['triggerOther',null],['triggerInstigator',null],
        ['bCollideActors',entry.route.trigger.initialCollision.bCollideActors],
        ['bBlockActors',entry.route.trigger.initialCollision.bBlockActors],
        ['bBlockPlayers',entry.route.trigger.initialCollision.bBlockPlayers]])set(runtime,trigger,name,value);
      trigger.collideActors=entry.route.trigger.initialCollision.bCollideActors;
      trigger.blockActors=entry.route.trigger.initialCollision.bBlockActors;
      trigger.blockPlayers=entry.route.trigger.initialCollision.bBlockPlayers;
      trigger.blocking=trigger.blockPlayers;
      trigger.collisionBits=(trigger.collisionBits&~13)|
        (trigger.collideActors?1:0)|(trigger.blockActors?4:0)|(trigger.blockPlayers?8:0);
      trigger.flags=(trigger.flags&~13)|trigger.collisionBits;
    }
    active=null;lastTrigger=null;lastPresentation=null;
  }

  function handleStartConversation(call){
    const values=Array.from({length:call.argumentCount},(_,index)=>call.evaluateArgument(index));
    const resolved=values.map(value=>value?.reference?value.get():value);
    return begin(call.receiver,resolved[0]??null,resolved[1]??null,Boolean(resolved[2]));
  }

  // The exact supported call executes the installed DeusExPlayer body for the
  // first play and for active-play queue admission.  The latter is evaluated
  // inside the shell lifecycle so the original SetConversation/PushDataLink
  // and HUDInfoLinkDisplay.MessageQueued bodies can run; the active
  // StartConversation boundary only records route metadata for presentation.
  let startHandler;
  startHandler=call=>{
    const values=Array.from({length:call.argumentCount},(_,index)=>call.evaluateArgument(index));
    const resolved=values.map(value=>value?.reference?value.get():value);
    const entry=routeByTag.get(lower(resolved[0]));
    if(!entry)return false;
    if(active)pendingAdmission={entry,trigger:resolveTrigger(entry,resolved[1]??null)};
    runtime.boundaryFunctions.delete(call.record.key);
    try{
      const invoke=()=>runtime.callFunction(call.record,call.receiver,resolved.length,index=>resolved[index]);
      return active?currentShell.withLifecycle(invoke):invoke();
    }finally{pendingAdmission=null;runtime.boundaryFunctions.set(call.record.key,startHandler);}
  };

  return {shell:()=>currentShell,conversation:startRoute.conversation,speech:startRoute.speech,endEvent:startRoute.endEvent,
    timeline:startRoute.timeline,tick,reset,presentation:()=>lastPresentation,active:()=>active,
    catalog,handleStartConversation,startHandler,receivedItems,receivedDisplay};
}
