import {assignMeasuredObjectIndices} from './measured-object-indices.mjs';
import {staticLoadObject} from './script-static-load-object.mjs';
import {resolveNameNative} from './script-resolve-name.mjs';
/** Live ConPlay services; gameplay and scheduling execute the original bytecode.
 * Evidence and explicit rendering limits: docs/script-instructor-conversation.md. */
import {decodeSoundResource} from './script-sound-resource.mjs';
import {execActorPlaySound} from './script-sound.mjs';
import {refValue} from './script-vm.mjs';
import {createGalaxyVolumes} from './galaxy-volumes.mjs';
import {msvcrtWtoi} from './script-text-parser.mjs';

/** A loaded package (DeusEx.u, loaded since boot) as the registered Core.Package
 * object StaticFindObject finds: the same record the DeusExConText package has
 * (script-conversation-startup.mjs). The level collection keeps it as a
 * persistent package, like that one. */
export function registerLoadedPackage(runtime,asset){
  const construction=runtime.actorLifecycle.construction;
  const existing=construction.findObject(null,asset.name);
  if(existing)return existing;
  const resolved=construction.internName(asset.name);
  const record={identity:runtime.resources.packageIdentity(asset),index:-1,hashNext:null,stateFrame:null,
    linker:null,linkerIndex:-1,outer:null,flags:0,name:resolved.name,nameIndex:resolved.index,
    objectClass:runtime.resources.nativeClass('Core.Package')};
  construction.registry.add(record);
  return record;
}

/** A ConSys.ConHistory (`isEvent` false) or ConHistoryEvent object as the original's CreateHistoryObject/CreateHistoryEvent natives (3002, 3003) and the
 * travel import's StaticConstructObject leave it: allocated in `outer` (default: the loaded level's package, where a preplaced player lives), its links
 * None, the DeusEx class vtable (ConHistory 0x10027fe8, ConHistoryEvent 0x1002803c) and the Destroy it names. ConHistory's Destroy is DConHistory::Destroy
 * 0x1000ca20: it deletes each event from firstEvent through its deleting destructor (reading next first), then UObject::Destroy. */
/** The native tail of constructHistoryObject for a history object whose identity already exists and is attached (a saved level's: its
 * exports are identities before the registry exists): a registered native record, the ConSys vtable and its destroy chain. */
export function adoptHistoryObject(runtime,level,identity,cls,isEvent,entry){
  const construction=runtime.actorLifecycle.construction,fname=construction.internName(entry.name);
  const native={identity,index:-1,hashNext:null,stateFrame:runtime.instance(identity).state??null,linker:null,linkerIndex:-1,
    outer:level.nativeObject.outer,flags:0,name:fname.name,nameIndex:fname.index,objectClass:cls};
  construction.registry.add(native);
  runtime.bindNativeObject(identity,native);
  native.nativeVtable=isEvent?0x1002803c:0x10027fe8;
  const get=(o,k)=>runtime.readNamed(o,k);
  native.destroy=isEvent?receiver=>runtime.destroyObjectBase(receiver):receiver=>{
    for(let event=get(receiver,'firstEvent');event;){
      const next=get(event,'next');
      runtime.deleteObject(event);
      event=next;
    }
    runtime.destroyObjectBase(receiver);
  };
  return native;
}

export function constructHistoryObject(runtime,level,cls,isEvent,{outer=level.nativeObject.outer}={}){
  const get=(o,k)=>runtime.readNamed(o,k),set=(o,k,v)=>runtime.writeNamed(o,k,v);
  const object=runtime.allocateObject(cls,{outer,name:'None',flags:0,template:null},{
    ...runtime.actorLifecycle.construction,validate:args=>args.cls===cls&&args.outer===outer&&args.template===null,
    initNativeProperties:()=>{},
  });
  const native=runtime.instance(object).nativeObject;
  native.nativeVtable=0x10179dfc;
  native.nativeVtable=isEvent?0x100135bc:0x10013568;
  for(const field of isEvent?['next']:['firstEvent','lastEvent','next'])set(object,field,null);
  native.nativeVtable=isEvent?0x1002803c:0x10027fe8;
  // ConHistoryEvent 0x1002803c slot +0x24 is UObject::Destroy (thunk 0x1001aec0). ConHistory 0x10027fe8 slot +0x24 imports ConSys DConHistory::Destroy
  // 0x1000ca20: it deletes each event from firstEvent (+0x50) through its scalar deleting destructor, reading next (+0x44) first, leaves firstEvent set
  // and then runs UObject::Destroy.
  native.destroy=isEvent?receiver=>runtime.destroyObjectBase(receiver):receiver=>{
    for(let event=get(receiver,'firstEvent');event;){
      const next=get(event,'next');
      runtime.deleteObject(event);
      event=next;
    }
    runtime.destroyObjectBase(receiver);
  };
  return object;
}

export async function createLiveConPlayRuntime({runtime,assets,level,player,shell,conversations,dataLinkConversations=[],onSpeech,prepareClass}){
  const get=(o,k)=>runtime.readNamed(o,k);
  const set=(o,k,v)=>runtime.writeNamed(o,k,v);
  const [deus,conSys,engine]=await Promise.all(['DeusEx','ConSys','Engine'].map(x=>assets.get(x)));
  // The engine's audio subsystem is Galaxy (DeusEx.ini AudioDevice), whose
  // MusicVolume/SoundVolume/SpeechVolume config bytes the SetInstant*Volume
  // natives read and replace (galaxy-volumes.mjs). It outlives Player-start
  // reloads, as the subsystem outlives levels. A missing key is not guessed.
  const config=await runtime.classLoader?.prepareConfig?.();
  const galaxyByte=key=>{
    const text=config?.getString('Galaxy.GalaxyAudioSubsystem',key);
    if(text==null)throw new Error(`Galaxy ${key} is not in DeusEx.ini [Galaxy.GalaxyAudioSubsystem]`);
    return msvcrtWtoi(text)&255; // UByteProperty::ImportText: appAtoi, low byte.
  };
  // Play's live audio owns the subsystem's bytes (script-audio-live.mjs), so
  // natives 268-270 reach its music and library; without it, a local copy.
  const galaxy=runtime.audio?.volumes??(config?createGalaxyVolumes({musicVolume:galaxyByte('MusicVolume'),
    soundVolume:galaxyByte('SoundVolume'),speechVolume:galaxyByte('SpeechVolume')}):null);
  const load=(asset,path)=>runtime.loadClass(asset,asset.exportsByPath.get(path));
  const [playClass,historyClass,historyEventClass,cameraClass,lightClass]=await Promise.all([
    load(deus,'conplay'),load(conSys,'conhistory'),load(conSys,'conhistoryevent'),
    load(conSys,'concamera'),load(conSys,'conlight')]);
  const paths=new Set(['deusexplayer.endconversation','deusexplayer.createhistoryobject',
    'deusexplayer.createhistoryevent','deusexplayer.getdisplayname','conhistory.addevent',
    'conlistitem.findconversationbyname']);
  for(const asset of [deus,conSys,engine])for(const [path,index] of asset.exportsByPath){
    const kind=asset.pkg.exports[index-1].className;
    if(!(path.startsWith('conplay.')||path.startsWith('conplaybase.')||path.startsWith('conversation.')||
      path.startsWith('concamera.')||path.startsWith('conlight.')||paths.has(path)))continue;
    if(kind==='Function')await runtime.prepareFunction(asset,index);
    else if(kind==='State')await runtime.prepareState(asset,index);
  }
  if(playClass.base?.record.key!=='deusex.conplaybase'||playClass.base.base?.record.key!=='engine.actor'||
    playClass.metadata.classFlags!==0x32||runtime.classLoader.graph.slotOf(playClass.loadRecord,0x3c)!==0x404)
    throw new Error('ConPlay original script-only construction layout changed');
  // ConCamera.CreateHighlights spawns two ConLights from the ConPlay actor.
  await prepareClass(lightClass);
  // CreateConCamera's CreatePackage(NULL,"DeusEx") finds the package record
  // registerLoadedPackage put in the live registry.
  const construction=runtime.actorLifecycle.construction;
  // ConPlay actors are whatever the original Spawn(class'ConPlay') placed in
  // Level.Actors through the general SpawnActor; this view lists them there.
  const isPlay=actor=>{try{return Boolean(actor)&&runtime.instance(actor).cls===playClass;}catch{return false;}};
  const spawned={
    has:isPlay,
    *[Symbol.iterator](){for(const actor of [...level.actors])if(isPlay(actor))yield actor;},
  };
  // Channel IDs are computed by execPlaySound from the measured indices.
  assignMeasuredObjectIndices(runtime,level.actors);
  const sounds=new Map();
  async function prepareSound(sound,id=null){
    if(sounds.has(sound))return;
    const {asset,index}=sound;
    await runtime.classLoader.prepare(asset);
    const resource=await runtime.prepareResource(sound);
    await runtime.dynamicLoadGraph.prepare(sound,resource);
    const decoded=decodeSoundResource({pkg:asset.pkg,bytes:asset.bytes,entry:asset.pkg.exports[index-1]});
    const format=decoded.lazy.formatName.toLowerCase();
    const start=asset.pkg.exports[index-1].serialOffset+decoded.lazy.inlineOffset;
    const bytes=decoded.bytes??asset.bytes.slice(start,start+decoded.lazy.byteCount);
    if(bytes.length!==decoded.lazy.byteCount)throw new Error('Truncated original speech payload');
    sounds.set(sound,{sound,bytes,format,mimeType:format==='mp3'?'audio/mpeg':'audio/wav',
      soundObject:sound.name,soundId:id,soundData:{array:{data:bytes,num:bytes.length}}});
  }
  // BarkManager.StartBark looks up BuildBarkName's "<BarkBindName or
  // BindName>_Bark<mode>" in the pawn's ConListItems (FindConversationByName)
  // and loads that conversation's speech through GetSpeechAudio. ConBindEvents
  // filled those lists at PostPostBeginPlay, so a bark can reach exactly the
  // bound conversations whose conName contains "_Bark" (FName comparison is
  // case-insensitive).
  const barkConversations=[],seenBarks=new Set();
  for(const actor of level.actors){
    if(!actor||!runtime.instances.has(actor))continue;
    for(let item=get(actor,'ConListItems');item;item=get(item,'next')){
      const conversation=get(item,'con');
      if(seenBarks.has(conversation)||!String(get(conversation,'conName')).toLowerCase().includes('_bark'))continue;
      seenBarks.add(conversation);barkConversations.push({conversation});
    }
  }
  for(const {conversation} of [...conversations,...dataLinkConversations,...barkConversations]){
    const suffix=get(conversation,'audioPackageName');
    const context=get(conversation,'Outer').name.replace(/Text$/i,'');
    for(let event=get(conversation,'eventList');event;event=get(event,'nextEvent')){
      const cls=runtime.instance(event).cls;
      if(!runtime.lookupMember(cls,'fields','conSpeech'))continue;
      const speech=get(event,'conSpeech');if(!speech)continue;
      const id=get(speech,'soundID');if(id===-1)continue;
      const packageName=`${context}Audio${suffix}`,name=`ConAudio${suffix}_${id}`;
      const asset=await assets.get(packageName),index=asset.exportsByPath.get(name.toLowerCase());
      if(!index)throw new Error(`Missing original speech ${packageName}.${name}`);
      const sound=await runtime.objects.resolve(asset,index);
      await prepareSound(sound,id);
    }
  }
  const dataLinkClass=await load(deus,'datalinkplay');
  await prepareSound(runtime.defaultValue(dataLinkClass,runtime.lookupMember(dataLinkClass,'fields','startSound')));
  const transferNames=new Set();
  // The InfoLinks' TransferObject events too (DL_Rooftops gives Image02_NYC_Warehouse): ConEventTransferObject.BindActor's StaticLoadObject of the item
  // class needs its package prepared before the synchronous native frame, whichever conversation list the event is on.
  for(const {conversation} of [...conversations,...dataLinkConversations])for(let event=get(conversation,'eventList');event;event=get(event,'nextEvent')){
    const key=runtime.instance(event).cls.record.key;
    if(key==='consys.coneventtransferobject'||key==='consys.coneventcheckobject')transferNames.add(get(event,'objectName'));
  }
  for(const name of transferNames)if(!name.startsWith('NK_')){
    // An authored name with no DeusEx export (08_NYC_Smug's
    // "AugmentationUpgrade") makes the original DynamicLoadObject miss and
    // return None; there is nothing to prepare for it.
    if(!deus.exportsByPath.has(String(name).toLowerCase()))continue;
    const object=await runtime.prepareDynamicLoadObject(`DeusEx.${name}`);
    const cls=await runtime.loadClass(object.asset,object.index);
    await prepareClass(cls);
    const ammoField=runtime.lookupMember(cls,'fields','AmmoName');
    const ammo=ammoField?runtime.defaultValue(cls,ammoField):null;
    if(ammo)await prepareClass(await runtime.loadClass(ammo.asset,ammo.index));
  }
  const coreOuter=await runtime.resources.package(await assets.get('Core'));
  const classRef=runtime.resources.nativeClass('Core.Class');
  const bindLoad={classRef,createPackage:({outer,name})=>{
    const value=runtime.resources.packages.get(name.toLowerCase());
    if(outer!==null||!value)throw new Error(`Unprepared conversation class package ${name}`);return value;
  },staticLoadObject:request=>{
    const graph=runtime.dynamicLoadGraph;
    return staticLoadObject(request,{...graph.services(),
      resolveName:(outer,name,options)=>resolveNameNative(outer,name,{...options,services:{}}),
      read:(o,k)=>o===classRef?(k==='nameIndex'?0x29b:k==='outer'?coreOuter:undefined)
        :o===coreOuter&&k==='nameIndex'?0x14:graph.read(o,k),
      // StaticLoadObject's fallback after DeusEx.u's linker has no such
      // export (BindActor's "DeusEx." + ObjectName, e.g. Ford Schick's
      // AugmentationUpgrade). Every Class whose Outer is the DeusEx package is
      // one of DeusEx.u's exports (classes come only from package loads and
      // native registration, and each native DeusEx class is exported), so
      // no resident object matches and the original returns None.
      staticFindObject:({classRef:requested,outer,exactClass})=>{
        if(requested!==classRef||outer!==runtime.resources.packages.get('deusex')||exactClass!==0)
          throw new Error('Conversation class StaticFindObject outside the DeusEx package Class lookup');
        return null;
      },
    }).object;
  }};
  runtime.conversationLifecycle={...runtime.conversationLifecycle,transferObject:bindLoad,checkObject:bindLoad};
  const soundClassOuter=await runtime.resources.package(engine);
  const soundClass=runtime.resources.nativeClass('Engine.Sound');
  const temporary=new WeakSet();
  const speechLookup={soundClass,
    read:(o,k)=>temporary.has(o)?o[k]:k==='Name'&&o.kind==='Package'?o.name:get(o,k),
    write:(o,k,v)=>{if(!temporary.has(o))throw new Error('Unknown speech FString');o[k]=v;},
    copyString:({source})=>source,equalText:(a,b)=>a.toUpperCase()===b.toUpperCase(),
    formatString:({format,args})=>{
      let text;if(format==='ConAudio%s_%d')text=`ConAudio${args[0]}_${args[1]}`;
      else if(format==='..\\System\\%sAudio%s.u')text=`..\\System\\${args[0]}Audio${args[1]}.u`;
      else throw new Error('Unknown speech format');
      const a={data:text,num:text.length+1,max:text.length+1};temporary.add(a);return a;
    },stringText:data=>data,
    staticLoadObject:request=>{
      const graph=runtime.dynamicLoadGraph;
      const object=staticLoadObject(request,{...graph.services(),
        read:(object,key)=>object===soundClass
          ?key==='outer'?soundClassOuter:key==='nameIndex'?graph.nameIndex('Sound'):graph.read(object,key)
          :graph.read(object,key),
        resolveName:(outer,name,options)=>resolveNameNative(outer,name,{...options,services:{}}),
        findPackageFile:({filename,guid})=>{
          const match=/^\.\.\\System\\([^\\]+)\.u$/i.exec(filename);
          if(guid!==null||!match||!graph.linkerByPackage.has(match[1].toLowerCase()))
            throw new Error(`Speech audio package is not prepared: ${filename}`);
          return {found:true,path:filename};
        },
        createPackage:({outer,name})=>{
          const linker=graph.linkerByPackage.get(name.toLowerCase());
          if(outer!==null||!linker)throw new Error(`Speech package Outer is not prepared: ${name}`);
          // The first speech load of a package the original had not loaded creates its UPackage and LinkerLoad
          // (original-object-index.mjs loadPackage; the package is prepared here, so only the slots are modeled).
          runtime.actorLifecycle?.construction?.registry?.original?.loadPackage(name);
          return linker.outer;
        },
      }).object;
      // CreateExport of the Sound itself: one slot the first time it is loaded.
      if(object)runtime.actorLifecycle?.construction?.registry?.original?.loadExport(object,'Sound',request.name);
      return object;
    },
    arrayRealloc:a=>{if(a.max!==0)throw new Error('Unexpected speech FString resize');a.data=null;},
    arrayRemove:(_a,start,count)=>{if(start!==0||count!==0)throw new Error('Unexpected speech FString remove');},
    arrayDestroy:a=>{a.data=null;temporary.delete(a);},allocatorFree:()=>{throw new Error('Speech FString was not released');},
  };
  runtime.conversationLifecycle={...runtime.conversationLifecycle,audio:{speechLookup,
    read:(o,k)=>sounds.has(o)?sounds.get(o)[k]:o[k],loadSpecial:data=>{
      if(!(data.array.data instanceof Uint8Array))throw new Error('Speech bytes are not prepared');
    },log:message=>{throw new Error(message);}}};
  function history(isEvent){
    // Preplaced player belongs to the loaded level's package, as in the map.
    return constructHistoryObject(runtime,level,isEvent?historyEventClass:historyClass,isEvent);
  }
  // ConSys execCreateConCamera 0x100106f0 (docs/conversation-camera.md): P_FINISH,
  // CreatePackage(NULL,"DeusEx"), then DConCamera's operator new 0x10003d10 =
  // StaticAllocateObject(ConCamera 0x1001e1d8, that package, NAME_None,
  // RF_Public, no template) and constructor 0x10003ce0: UObject(), vtable
  // 0x10013610, cameraActor (+0x28) = None. A null allocation returns None.
  function camera(){
    const outer=construction.findObject(null,'DeusEx');
    if(!outer)throw new Error('CreateConCamera: CreatePackage would create DeusEx (not implemented)');
    const object=runtime.allocateObject(cameraClass,{outer,name:'None',flags:4,template:null},{
      ...runtime.actorLifecycle.construction,
      validate:args=>args.cls===cameraClass&&args.outer===outer&&args.template===null,
      initNativeProperties:()=>{},
    });
    const native=runtime.instance(object).nativeObject;
    native.nativeVtable=0x10179dfc;
    native.nativeVtable=0x10013610;
    set(object,'cameraActor',null);
    // Vtable 0x10013610 slot +0x24 is thunk 0x100110c2, UObject::Destroy.
    native.destroy=receiver=>runtime.destroyObjectBase(receiver);
    return object;
  }
  // A record of the conversation sounds the player hears (validation and
  // diagnostics only): what each original PlaySound below delivered to the
  // player's ClientHearSound. The sound itself takes the original chain into
  // Galaxy (docs/galaxy-audio.md "Speech through Galaxy's voices").
  const soundRequests=[];
  function handleNative(call){
    const scriptPath=String(call.script?.entry?.path??call.record?.entry?.path??'').toLowerCase();
    if(call.index===3002||call.index===3003){
      if(call.receiver!==player||call.argumentCount!==0)throw new Error('History creation requires the live player');
      return {handled:true,value:history(call.index===3003)};
    }
    // Actor.SetInstantSoundVolume/SpeechVolume/MusicVolume (268/269/270, exec
    // 0x103e2850/0x103e28d0/0x103e2950): the byte, P_FINISH, then the engine's
    // audio subsystem vtable +0x90/+0x94/+0x98 (docs/galaxy-volumes.md).
    if(call.index>=268&&call.index<=270&&galaxy){
      if(call.argumentCount!==1)throw new Error('SetInstant*Volume requires one byte');
      const value=refValue(call.evaluateArgument(0))&255;
      if(call.index===268)galaxy.setInstantSoundVolume(value);
      else if(call.index===269)galaxy.setInstantSpeechVolume(value);
      else galaxy.setInstantMusicVolume(value);
      return {handled:true,value:undefined};
    }
    if(call.index===2051){
      if(runtime.instance(call.receiver).cls.record.key!=='consys.conversation'||call.argumentCount!==0)
        throw new Error('CreateConCamera requires a Conversation and no arguments');
      return {handled:true,value:camera()};
    }
    // Actor.PlaySound (native 264) of ConPlay/DataLinkPlay speech and the
    // DataLink start cue: the general route (script-doors.mjs nativeCall) of
    // the original execPlaySound, CheckHearSound and the player's
    // execClientHearSound into Galaxy's PlaySound (slot 5 for speech), with
    // the same measured or modeled emitter index, recorded on the way. An
    // emitter with neither takes the general route's boundary. Their
    // StopSound (native 265) is the original's (no case here): Galaxy's
    // StopSoundId.
    const soundIndex=call.index===264&&['conplay.playspeech','datalinkplay.playspeech','datalinkplay.startconversation'].includes(scriptPath)
      ?runtime.soundObjectIndex(call.receiver):null;
    if(soundIndex){
      const services=runtime.playSoundServices(call);
      if(soundIndex.source==='modeled')runtime.audio?.noteModeledId(call.receiver);
      const result=execActorPlaySound(call,{...services,processNativeEvent:(receiver,name,args)=>{
        if(name==='ClientHearSound'&&receiver===player){
          const [emitter,id,sound,location,parameters]=args;
          const request={kind:'speech',audio:sounds.get(sound)??null,sound,emitter,id,location:[...location],parameters:[...parameters]};
          soundRequests.push(request);onSpeech?.(request);
        }
        return services.processNativeEvent(receiver,name,args);
      }});
      return {handled:true,value:result.resultWritten?result.result:undefined};
    }
    return {handled:false};
  }
  // A reload retires the whole conversation state with the old player: its
  // windows went with the old root window (APlayerPawnExt::Destroy), and the
  // ConPlay actors and ConHistory objects are purged by LoadMap's collection
  // (docs/script-loadmap-gc.md). Only the host's own tracking is dropped here.
  function reset(){
    soundRequests.length=0;
  }
  return {handleNative,reset,spawned,sounds,soundRequests,galaxy,
    // Call reset against the old player before adopting the next Login result.
    bindPlayer(next){runtime.instance(next);player=next;},
    withLifecycle:fn=>shell.withLifecycle(fn),
    active:()=>get(player,'conPlay'),
    tick:(seconds,options)=>shell.withLifecycle(()=>{
      for(const play of spawned)if(!runtime.instance(play).pendingKill)runtime.processActorTick(play,seconds,options);
    }),
  };
}
