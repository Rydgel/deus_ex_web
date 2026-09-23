/** Original CreateLogObject allocation/constructor; the installed AddLog and
 * SetLogText bytecode own list/text mutations. docs/script-player-log.md. */
export function constructPlayerLog(object){
  object.nativeVtable=0x10179dfc;
  object.nativeVtable=0x10027ad0;
  return object;
}

export async function preparePlayerLogStore({runtime,assets,player}){
  const dx=await assets.get('DeusEx'),extension=await assets.get('Extension');
  const cls=await runtime.loadClass(dx,dx.exportsByPath.get('deusexlog'));
  for(const field of cls.propertyLink??[])await runtime.field(field);
  for(const [asset,paths] of [[dx,['deusexplayer.createlogobject','deusexplayer.addlog','deusexlog.setlogtext',
    'deusexrootwindow.clientmessage','hudlogdisplay.addlog']],
    [extension,['playerpawnext.clientmessage']]])for(const path of paths)
      await runtime.prepareFunction(asset,asset.exportsByPath.get(path));
  const logs=new Set();
  const create=receiver=>{
    if(receiver!==player)throw new Error('CreateLogObject is bound only to the live player');
    const outer=runtime.playerNativeObject(player).outer;
    if(!outer)throw new Error('CreateLogObject requires the player package Outer');
    const base=runtime.actorLifecycle?.construction;
    const object=runtime.allocateObject(cls,{outer,name:'None',flags:0,template:null},{...base,
      validate:args=>args.cls===cls&&args.outer===outer&&args.template===null&&args.flags===0&&args.name==='None',
      initNativeProperties:()=>{},
    });
    constructPlayerLog(runtime.instance(object).nativeObject);
    logs.add(object);return object;
  };
  const previous=runtime.native;
  runtime.boundaryNatives.add(3010);
  runtime.native=call=>{
    if(call.index!==3010)return previous(call);
    if(call.argumentCount!==0)throw new Error('CreateLogObject accepts no arguments');
    return create(call.receiver);
  };
  return {logs,create,
    enableMessages(){runtime.boundaryFunctions.delete('extension.playerpawnext.clientmessage');},
    reset(){
      runtime.namedReference(player,'FirstLog').set(null);
      runtime.namedReference(player,'LastLog').set(null);
      // No invented CriticalDelete implementation. Final native collection of
      // these detached script log objects remains the documented boundary.
      logs.clear();
    },
  };
}
