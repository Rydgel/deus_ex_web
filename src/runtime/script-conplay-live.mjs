import {TRAINING_NPC_IDENTITIES} from './training-npc-identities.mjs';
import {staticLoadObject} from './script-static-load-object.mjs';
import {resolveNameNative} from './script-resolve-name.mjs';
/** Live ConPlay services; gameplay and scheduling execute the original bytecode.
 * Evidence and explicit rendering limits: docs/script-instructor-conversation.md. */
import {decodeSoundResource} from './script-sound-resource.mjs';
import {execActorPlaySound} from './script-sound.mjs';
import {refValue} from './script-vm.mjs';

export async function createLiveConPlayRuntime({runtime,assets,level,player,shell,conversations,onSpeech,prepareClass}){
  const get=(o,k)=>runtime.readNamed(o,k);
  const set=(o,k,v)=>runtime.writeNamed(o,k,v);
  const [deus,conSys,engine]=await Promise.all(['DeusEx','ConSys','Engine'].map(x=>assets.get(x)));
  const load=(asset,path)=>runtime.loadClass(asset,asset.exportsByPath.get(path));
  const [playClass,historyClass,historyEventClass]=await Promise.all([
    load(deus,'conplay'),load(conSys,'conhistory'),load(conSys,'conhistoryevent')]);
  const paths=new Set(['deusexplayer.endconversation','deusexplayer.createhistoryobject',
    'deusexplayer.createhistoryevent','deusexplayer.getdisplayname','conhistory.addevent',
    'conlistitem.findconversationbyname']);
  for(const asset of [deus,conSys,engine])for(const [path,index] of asset.exportsByPath){
    const kind=asset.pkg.exports[index-1].className;
    if(!(path.startsWith('conplay.')||path.startsWith('conplaybase.')||path.startsWith('conversation.')||paths.has(path)))continue;
    if(kind==='Function')await runtime.prepareFunction(asset,index);
    else if(kind==='State')await runtime.prepareState(asset,index);
  }
  if(playClass.base?.record.key!=='deusex.conplaybase'||playClass.base.base?.record.key!=='engine.actor'||
    playClass.metadata.classFlags!==0x32||runtime.classLoader.graph.slotOf(playClass.loadRecord,0x3c)!==0x404)
    throw new Error('ConPlay original script-only construction layout changed');
  // ConPlay actors are whatever the original Spawn(class'ConPlay') placed in
  // Level.Actors through the general SpawnActor; this view lists them there.
  const isPlay=actor=>{try{return Boolean(actor)&&runtime.instance(actor).cls===playClass;}catch{return false;}};
  const spawned={
    has:isPlay,
    *[Symbol.iterator](){for(const actor of [...level.actors])if(isPlay(actor))yield actor;},
  };
  // Reuse the original Training object-index capture already used by GetFrame.
  // Channel IDs are computed by execPlaySound from the same captured indices.
  for(const object of level.actors){
    if(!object||object.asset?.name?.toLowerCase()!=='00_training')continue;
    const index=TRAINING_NPC_IDENTITIES[object.name];
    if(Number.isInteger(index))runtime.instance(object).globalIndex=index;
  }
  const sounds=new Map();
  for(const {conversation} of conversations){
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
      await runtime.classLoader.prepare(asset);
      const sound=await runtime.objects.resolve(asset,index);
      const resource=await runtime.prepareResource(sound);
      await runtime.dynamicLoadGraph.prepare(sound,resource);
      const decoded=decodeSoundResource({pkg:asset.pkg,bytes:asset.bytes,entry:asset.pkg.exports[index-1]});
      const format=decoded.lazy.formatName.toLowerCase();
      const start=asset.pkg.exports[index-1].serialOffset+decoded.lazy.inlineOffset;
      const bytes=decoded.bytes??asset.bytes.slice(start,start+decoded.lazy.byteCount);
      if(bytes.length!==decoded.lazy.byteCount)throw new Error('Truncated original speech payload');
      sounds.set(sound,{sound,bytes,format,mimeType:format==='mp3'?'audio/mpeg':'audio/wav',
        soundObject:name,soundId:id,soundData:{array:{data:bytes,num:bytes.length}}});
    }
  }
  const transferNames=new Set();
  for(const {conversation} of conversations)for(let event=get(conversation,'eventList');event;event=get(event,'nextEvent')){
    const key=runtime.instance(event).cls.record.key;
    if(key==='consys.coneventtransferobject'||key==='consys.coneventcheckobject')transferNames.add(get(event,'objectName'));
  }
  for(const name of transferNames)if(!name.startsWith('NK_')){
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
      return staticLoadObject(request,{...graph.services(),
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
          return linker.outer;
        },
      }).object;
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
    const cls=isEvent?historyEventClass:historyClass;
    // Preplaced player belongs to the loaded level's package, as in the map.
    const outer=level.nativeObject.outer;
    const object=runtime.allocateObject(cls,{outer,name:'None',flags:0,template:null},{
      ...runtime.actorLifecycle.construction,validate:args=>args.cls===cls&&args.outer===outer&&args.template===null,
      initNativeProperties:()=>{},
    });
    const native=runtime.instance(object).nativeObject;
    native.nativeVtable=0x10179dfc;
    native.nativeVtable=isEvent?0x100135bc:0x10013568;
    for(const field of isEvent?['next']:['firstEvent','lastEvent','next'])set(object,field,null);
    native.nativeVtable=isEvent?0x1002803c:0x10027fe8;
    // ConHistoryEvent 0x1002803c slot +0x24 is UObject::Destroy (thunk
    // 0x1001aec0). ConHistory 0x10027fe8 slot +0x24 imports ConSys
    // DConHistory::Destroy 0x1000ca20: it deletes each event from firstEvent
    // (+0x50) through its scalar deleting destructor, reading next (+0x44)
    // first, leaves firstEvent set and then runs UObject::Destroy.
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
  let activeAudio=null;
  function handleNative(call){
    if(call.index===3002||call.index===3003){
      if(call.receiver!==player||call.argumentCount!==0)throw new Error('History creation requires the live player');
      return {handled:true,value:history(call.index===3003)};
    }
    if(call.index===264&&String(call.script?.entry?.path??call.record?.entry?.path??'').toLowerCase()==='conplay.playspeech'){
      const services=runtime.soundServices(call);
      const result=execActorPlaySound(call,{...services,processNativeEvent:(receiver,name,args)=>{
        if(name!=='ClientHearSound')return services.processNativeEvent(receiver,name,args);
        if(receiver!==player)throw new Error('Conversation ClientHearSound reached another listener');
        const [emitter,id,sound,location,parameters]=args;
        const audio=sounds.get(sound);if(!audio)throw new Error('Conversation speech is not prepared');
        activeAudio={audio,emitter,id,location,parameters};onSpeech?.({kind:'speech',...activeAudio});
      }});
      return {handled:true,value:result.resultWritten?result.result:undefined};
    }
    if(call.index===265&&activeAudio){
      const id=call.argumentCount?refValue(call.evaluateArgument(0)):0;
      if(id===activeAudio.id){onSpeech?.({kind:'stop',id});activeAudio=null;}
      return {handled:true,value:undefined};
    }
    return {handled:false};
  }
  // A reload retires the whole conversation state with the old player: its
  // windows went with the old root window (APlayerPawnExt::Destroy), and the
  // ConPlay actors and ConHistory objects are purged by LoadMap's collection
  // (docs/script-loadmap-gc.md). Only the host's own tracking is dropped here.
  function reset(){
    if(activeAudio)onSpeech?.({kind:'stop',id:activeAudio.id});activeAudio=null;
  }
  return {handleNative,reset,spawned,sounds,
    // Call reset against the old player before adopting the next Login result.
    bindPlayer(next){runtime.instance(next);player=next;},
    withLifecycle:fn=>shell.withLifecycle(fn),
    active:()=>get(player,'conPlay'),
    tick:(seconds,options)=>shell.withLifecycle(()=>{
      for(const play of spawned)if(!runtime.instance(play).pendingKill)runtime.processActorTick(play,seconds,options);
    }),
  };
}
