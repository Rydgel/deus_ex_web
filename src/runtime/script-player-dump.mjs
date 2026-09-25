/** Original cold CreateDumpLocationObject/UDumpLocation construction.
 * Evidence and external config/file-manager leaves: docs/script-player-dump.md.
 * Saved-location file operations and native destruction remain unsupported. */
export function constructPlayerDump(object,{read,write,getCurrentUser,findFiles}) {
  object.nativeVtable=0x10179dfc;
  const current={...read('currentDumpLocation')};
  for(const key of Object.keys(current))if(['mapname','gameversion','title','desc'].includes(key.split('.').at(-1).toLowerCase()))current[key]='';
  write('currentDumpLocation',current);
  write('dumpFileDirectory',[]);
  write('currentDumpFileIndex',-1);write('currentDumpLocationIndex',-1);
  write('currentUser','');write('dumpFile',0);write('dumpLocationCount',0);write('player',null);
  object.nativeVtable=0x10027f94;
  // FConfigCacheIni::GetString clears the destination even on a missing key.
  write('currentUser',getCurrentUser()??'');
  // 0x100150f8 allocates an uninitialized 0x1220-byte native scratch block.
  // Keep its allocation obligation explicit; no readable script pointer or
  // fabricated initial scratch bytes are exposed by this host.
  object.dumpScratch={size:0x1220,initialized:false};
  write('dumpFileDirectory',[...findFiles('*.DMP',true,false)]);
  object.destroy=()=>{throw new Error('UDumpLocation native file/scratch destruction is not linked');};
  return object;
}

export function hasSavedDumpLocation(state){return state.savedLocationFlag&255;}

export async function preparePlayerDumpStore({runtime,assets,player,findFiles,configCache}={}) {
  const dx=await assets.get('DeusEx');
  const cls=await runtime.loadClass(dx,dx.exportsByPath.get('dumplocation'));
  for(const field of cls.propertyLink??[])await runtime.field(field);
  for(const path of ['deusexplayer.createdumplocationobject','dumplocation.haslocationbeensaved'])
    await runtime.prepareFunction(dx,dx.exportsByPath.get(path));
  const config=configCache??await runtime.classLoader?.prepareConfig();
  if(typeof config?.getString!=='function')throw new Error('DumpLocation requires the live original GConfig cache');
  if(!findFiles){
    if(!Array.isArray(assets.sourceFiles))throw new Error('DumpLocation requires the original supplied file catalog');
    // The engine starts with its working directory at the installed System
    // directory. Resolve that directory from the actual DeusEx.u entry so a
    // selected install-root prefix is retained rather than guessed away.
    const normalize=path=>String(path).replaceAll('\\','/');
    const packagePath=normalize(dx.path),directory=packagePath.slice(0,packagePath.lastIndexOf('/')+1).toLowerCase();
    findFiles=(pattern,files,dirs)=>{
      if(pattern!=='*.DMP'||files!==true||dirs!==false)throw new Error('DumpLocation file query changed');
      return assets.sourceFiles.map(file=>normalize(file.path)).filter(path=>{
        const slash=path.lastIndexOf('/');
        return path.slice(0,slash+1).toLowerCase()===directory&&/\.dmp$/i.test(path.slice(slash+1));
      }).map(path=>path.slice(path.lastIndexOf('/')+1));
    };
  }
  // Original zero-initialized byte DeusEx.dll+0x3bb05. SaveLocation is the
  // separate native writer; this cold-start store does not implement it.
  const state={savedLocationFlag:0},objects=new Set();
  const create=receiver=>{
    if(player&&receiver!==player)throw new Error('CreateDumpLocationObject requires the bound player');
    const outer=runtime.playerNativeObject(receiver).outer;
    if(!outer)throw new Error('CreateDumpLocationObject requires the player package Outer');
    const object=runtime.allocateObject(cls,{outer,name:'None',flags:0,template:null},{
      ...runtime.actorLifecycle?.construction,
      validate:args=>args.cls===cls&&args.outer===outer&&args.template===null&&args.flags===0&&args.name==='None',
      initNativeProperties:()=>{},
    });
    const native=runtime.instance(object).nativeObject;
    constructPlayerDump(native,{
      read:name=>runtime.namedReference(object,name).get(),write:(name,value)=>runtime.namedReference(object,name).set(value),
      getCurrentUser:()=>config.getString('DeusEx.DumpLocation','CurrentUser','User.ini',64),findFiles,
    });
    runtime.bindProperty(object,runtime.lookupMember(cls,'fields','currentDumpFileLocation'),{
      get(){throw new Error('DumpLocation scratch allocation has no script integer pointer representation');},
      set(){throw new Error('DumpLocation scratch pointer writes are not linked');},
    });
    objects.add(object);return object;
  };
  const previous=runtime.native;
  runtime.boundaryNatives.add(3015);runtime.boundaryNatives.add(3039);
  runtime.native=call=>{
    if(call.index!==3015&&call.index!==3039)return previous(call);
    if(call.argumentCount!==0)throw new Error('DumpLocation create/saved-state natives take no arguments');
    if(call.index===3015)return create(call.receiver);
    if(!objects.has(call.receiver))throw new Error('HasLocationBeenSaved requires a constructed DumpLocation');
    return hasSavedDumpLocation(state);
  };
  return {objects,create,state,bindPlayer(next){runtime.instance(next);player=next;}};
}
