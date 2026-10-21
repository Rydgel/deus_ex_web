/** Original CreateLogObject allocation/constructor; the installed AddLog and
 * SetLogText bytecode own list/text mutations. docs/script-player-log.md.
 * CreateDataVaultImageNoteObject (3014, exec 0x10014be0) is the same body for
 * DataVaultImageNote: `new (GetOuter(), None, 0) DDataVaultImageNote` (size 0x44, class
 * cell 0x100391b8 against the log's 0x38 and 0x1003a5d8), whose constructor 0x1000df40
 * is UObject's then vtable 0x10027b24 (the log's 0x10027ad0 differs only in slot +0xc, the
 * deleting destructor). The installed AddNote bytecode owns the image's note list. */
function constructNativeObject(object,vtable,label,{destroyObjectBase}={}){
  if(typeof destroyObjectBase!=='function')throw new Error(`${label} construction requires UObject::Destroy`);
  object.nativeVtable=vtable;
  // Slot +0x24 of both vtables is the UObject::Destroy thunk 0x1001aec0.
  object.destroy=receiver=>destroyObjectBase(receiver);
  return object;
}
export function constructPlayerLog(object,options){
  object.nativeVtable=0x10179dfc;
  return constructNativeObject(object,0x10027ad0,'DeusExLog',options);
}
export function constructDataVaultImageNote(object,options){
  object.nativeVtable=0x10179dfc;   // UObject::UObject (0x100270c4), as for the log
  return constructNativeObject(object,0x10027b24,'DataVaultImageNote',options);
}

export async function preparePlayerLogStore({runtime,assets,player}){
  const dx=await assets.get('DeusEx'),extension=await assets.get('Extension'),core=await assets.get('Core');
  const cls=await runtime.loadClass(dx,dx.exportsByPath.get('deusexlog'));
  for(const field of cls.propertyLink??[])await runtime.field(field);
  const noteCls=await runtime.loadClass(dx,dx.exportsByPath.get('datavaultimagenote'));
  for(const field of noteCls.propertyLink??[])await runtime.field(field);
  for(const [asset,paths] of [[dx,['deusexplayer.createlogobject','deusexplayer.addlog','deusexlog.setlogtext',
    'deusexrootwindow.clientmessage','hudlogdisplay.addlog','deusexplayer.createdatavaultimagenoteobject']],
    [extension,['playerpawnext.clientmessage']],[core,['object.sprintf']]])for(const path of paths)
      await runtime.prepareFunction(asset,asset.exportsByPath.get(path));
  const createObject=(receiver,name,objectClass,construct)=>{
    if(receiver!==player)throw new Error(`${name} is bound only to the live player`);
    const outer=runtime.playerNativeObject(player).outer;
    if(!outer)throw new Error(`${name} requires the player package Outer`);
    const base=runtime.actorLifecycle?.construction;
    const object=runtime.allocateObject(objectClass,{outer,name:'None',flags:0,template:null},{...base,
      validate:args=>args.cls===objectClass&&args.outer===outer&&args.template===null&&args.flags===0&&args.name==='None',
      initNativeProperties:()=>{},
    });
    construct(runtime.instance(object).nativeObject,{destroyObjectBase:receiver=>runtime.destroyObjectBase(receiver)});
    return object;
  };
  const create=receiver=>createObject(receiver,'CreateLogObject',cls,constructPlayerLog);
  const createImageNote=receiver=>createObject(receiver,'CreateDataVaultImageNoteObject',noteCls,constructDataVaultImageNote);
  const previous=runtime.native;
  runtime.boundaryNatives.add(3010);
  runtime.boundaryNatives.add(3014);
  runtime.native=call=>{
    if(call.index!==3010&&call.index!==3014)return previous(call);
    if(call.argumentCount!==0)throw new Error(`${call.index===3010?'CreateLogObject':'CreateDataVaultImageNoteObject'} accepts no arguments`);
    return call.index===3010?create(call.receiver):createImageNote(call.receiver);
  };
  return {create,createImageNote,
    // Host identity routing only; Login/startup owns the new player's fields.
    bindPlayer(next){runtime.instance(next);player=next;},
    enableMessages(){runtime.boundaryFunctions.delete('extension.playerpawnext.clientmessage');},
  };
}
