import {refValue} from './script-vm.mjs';
import {
  staticLoadObject as execStaticLoadObject,
  STATIC_LOAD_OBJECT_CONTRACT,
} from './script-static-load-object.mjs';
import {createLinkerLoadArchive} from './script-linker-lazy-loader.mjs';
import {DynamicExportRecord, LinkerExports, setExportObject} from './linker-exports.mjs';

// The live DataLink capture reaches this package export before an
// InfoPortraits linker exists.  Keep that one first-load route explicit while
// retaining prepared linker construction for the other focused exports.
export const DYNAMIC_LOAD_FIRST_LOAD_PATH='infoportraits.jaimereyes';
// Packages only DynamicLoadObject reaches: their linker is built by the first
// StaticLoadObject at run time (GetPackageLinker), whichever export it asks
// for. Every prepared export of such a package waits for that linker.
export const DYNAMIC_LOAD_FIRST_LOAD_PACKAGES=Object.freeze(new Set(['infoportraits']));

/** Installed Core.dll UObject::execDynamicLoadObject wrapper. */
export const DYNAMIC_LOAD_OBJECT_NATIVE=Object.freeze({
  package:'Core',path:'Object.DynamicLoadObject',packageExport:627,
  nativeIndex:0,functionFlags:0x2401,serialSize:33,scriptSize:15,
  thunk:0x10103201,body:0x1013eb30,staticLoadThunk:0x10102a1d,
  baseLoadFlags:2,mayFailLoadFlag:0x2000,
});

export class DynamicLoadObjectBoundaryError extends Error{
  constructor(message,code='DYNAMIC_LOAD_OBJECT_BOUNDARY',details={}){
    super(message);this.name='DynamicLoadObjectBoundaryError';this.code=code;
    Object.assign(this,details);
  }
}

const fail=(message,code,details)=>{throw new DynamicLoadObjectBoundaryError(message,code,details);};

/**
 * Execute the recovered synchronous native wrapper.
 *
 * The deeper StaticLoadObject graph is supplied as one service so this helper
 * retains the installed argument order and flag translation without hiding a
 * first-load, linker-construction, or error branch behind a guessed host load.
 */
export function execDynamicLoadObject(call,{staticLoadObject,destroyString}={}){
  if(!call||typeof call.evaluateArgument!=='function')
    throw new TypeError('DynamicLoadObject requires a native call frame');
  if(call.argumentCount<2||call.argumentCount>3)
    fail('DynamicLoadObject accepts ObjectName, ObjectClass, and optional MayFail',
      'DYNAMIC_LOAD_OBJECT_ARGUMENT_COUNT',{argumentCount:call.argumentCount});

  // 0x1013eb62..0x1013ebb2 evaluates these through the FFrame native table in
  // declaration order before it consumes EX_EndFunctionParms.
  const objectName=refValue(call.evaluateArgument(0));
  const objectClass=refValue(call.evaluateArgument(1));
  const mayFail=call.argumentCount===3?Boolean(refValue(call.evaluateArgument(2))):false;
  if(typeof objectName!=='string')
    fail('DynamicLoadObject ObjectName must be an FString',
      'DYNAMIC_LOAD_OBJECT_NAME',{value:objectName});
  if(!objectClass||typeof objectClass!=='object')
    fail('DynamicLoadObject ObjectClass must be a canonical UClass',
      'DYNAMIC_LOAD_OBJECT_CLASS',{value:objectClass});
  if(typeof staticLoadObject!=='function')
    fail('DynamicLoadObject requires the synchronous StaticLoadObject service',
      'DYNAMIC_LOAD_OBJECT_SERVICE');

  const request={classRef:objectClass,outer:null,name:objectName,filename:null,
    flags:DYNAMIC_LOAD_OBJECT_NATIVE.baseLoadFlags|
      (mayFail?DYNAMIC_LOAD_OBJECT_NATIVE.mayFailLoadFlag:0),sandbox:null};
  try{
    const loaded=staticLoadObject(request);
    if(loaded&&typeof loaded.then==='function')
      fail('DynamicLoadObject StaticLoadObject service suspended inside the native frame',
        'DYNAMIC_LOAD_OBJECT_ASYNC');
    const object=loaded&&Object.hasOwn(loaded,'object')?loaded.object:loaded;
    if(object===undefined)
      fail('DynamicLoadObject StaticLoadObject service returned undefined',
        'DYNAMIC_LOAD_OBJECT_RETURN');
    return object;
  }finally{
    // Native FString destruction frees only an allocated buffer. The browser
    // string is immutable host storage, but a native-memory adapter can expose
    // the same reached lifetime edge explicitly.
    if(typeof destroyString==='function')destroyString(objectName);
  }
}

/**
 * Synchronous ULinkerLoad view built from package tables whose asynchronous
 * AssetStore and canonical object preparation has already completed.
 */
export class PreparedDynamicLoadGraph{
  constructor({objects,resources,onEvent=null}={}){
    if(!objects?.objects||!resources?.resources)
      throw new TypeError('Prepared DynamicLoadObject graph requires canonical object and resource registries');
    if(onEvent!==null&&typeof onEvent!=='function')
      throw new TypeError('Prepared DynamicLoadObject onEvent must be a function');
    this.objects=objects;this.resources=resources;this.onEvent=onEvent;
    this.names=new Map();this.nextName=0x400;
    this.linkers=[];this.linkerByPackage=new Map();this.firstLoadPackages=new Map();
    this.prepared=new Map();
    this.loadState={nest:0,registrationQueueHead:null,loadedMax:0,loaderCleanupState:0};
    this.loadedObjects=[];this.logReceiver={kind:'GWarn'};this.lastEvents=[];this.lifecycleEdges=[];
  }

  nameIndex(value,{find=false}={}){
    const text=String(value??''),key=text.toLowerCase();
    if(!this.names.has(key)){
      if(find)fail(`StaticLoadObject FName is absent: ${text}`,'DYNAMIC_LOAD_OBJECT_FNAME',{value:text});
      this.names.set(key,this.nextName++);
    }
    return this.names.get(key);
  }

  async prepare(object,resource){
    if(!object?.asset||!Number.isInteger(object.index)||object.index<=0)
      throw new TypeError('Prepared DynamicLoadObject requires a canonical package export');
    if(resource?.object!==object)
      throw new Error('Prepared DynamicLoadObject resource identity diverged from ScriptObjects');
    const objectKey=object.key.toLowerCase();
    const packageKey=object.asset.name.toLowerCase();
    if(DYNAMIC_LOAD_FIRST_LOAD_PACKAGES.has(packageKey)){
      // Materialize the package identity before the synchronous native frame;
      // this is the root Outer returned by ResolveName and the constructor's
      // `root` argument.  The linker itself is deliberately deferred until
      // StaticLoadObject reaches GetPackageLinker.
      const packageOuter=resource?.outer;
      if(!packageOuter||packageOuter.materialization!=='package-identity'||
          packageOuter.asset!==object.asset)
        throw new Error(`First-load portrait package Outer is not canonical: ${object.key}`);
      const entry=this.firstLoadPackages.get(packageKey)??{asset:object.asset,outer:packageOuter,objects:[]};
      if(entry.outer!==packageOuter)throw new Error(`First-load package Outer diverged: ${object.key}`);
      entry.objects.push(object);
      this.firstLoadPackages.set(packageKey,entry);
      const linker=this.linkerByPackage.get(packageKey);
      if(linker)setExportObject(linker.exports,object.index-1,object);
    }else{
      const linker=await this.linker(object.asset);
      setExportObject(linker.exports,object.index-1,object);
    }
    this.prepared.set(objectKey,object);
    return object;
  }

  preparedObject(path){return this.prepared.get(String(path).toLowerCase())??null;}

  /** Whether a focused prepared route owns this package's linker. */
  ownsPackage(name){
    const key=String(name).toLowerCase();
    return this.linkerByPackage.has(key)||this.firstLoadPackages.has(key);
  }

  async linker(asset){
    const key=asset.name.toLowerCase();
    if(this.linkerByPackage.has(key))return this.linkerByPackage.get(key);
    const outer=await this.resources.package(asset);
    const linker=this.buildLinker(asset,outer);
    this.linkerByPackage.set(key,linker);this.linkers.push(linker);

    return linker;
  }

  /**
   * Build the concrete linker tables from the already loaded package bytes.
   * The synchronous first-load adapter calls this only after the native
   * ResolveName/GetPackageLinker boundary; normal preparation may call it
   * asynchronously while the package resource graph is being assembled.
   */
  buildLinker(asset,outer,{flags=null}={}){
    // The reader is the opaque GFileManager result retained by the native
    // constructor.  Raw Serialize/Tell/Seek remain explicit reader services;
    // StaticLoadObject only needs the non-null identity for BeginLoad.
    const reader={kind:'GFileManagerReader',asset,source:'package-bytes'};
    const linker={kind:'ULinkerLoad',asset,outer,reader,exports:null,hashHeads:Array(256).fill(-1),
      loadFlags:flags,
      constructor:{thunk:STATIC_LOAD_OBJECT_CONTRACT.createLinkerLoadThunk,
        body:STATIC_LOAD_OBJECT_CONTRACT.createLinkerLoadBody},
      archive:null};
    const archive=createLinkerLoadArchive({linker,reader});
    Object.assign(archive,{
      baseVtable:STATIC_LOAD_OBJECT_CONTRACT.linkerArchiveBaseVtable,
      version:STATIC_LOAD_OBJECT_CONTRACT.linkerArchiveVersion,
      licenseeVersion:STATIC_LOAD_OBJECT_CONTRACT.linkerArchiveLicenseeVersion,
      readerOffset:STATIC_LOAD_OBJECT_CONTRACT.linkerReaderOffset,
    });
    linker.archive=archive;

    // ULinkerLoad has already expanded serialized FNames into the global table
    // by the point FindExportIndex runs. Intern every reached package name now
    // so the export hash and later FName(text,1) share one identity.
    this.nameIndex(asset.name);
    for(const entry of asset.pkg.imports)this.nameIndex(entry.name);
    const entries=asset.pkg.exports,names=new Int32Array(entries.length);
    for(let index=0;index<entries.length;index++)names[index]=this.nameIndex(entries[index].name);

    // The package's own export entries stay the package's; the table keeps this linker's names, objects and hash chain
    // (docs/live-heap.md "Steps 2 and 3's results").
    const table=linker.exports=new LinkerExports(entries,names,DynamicExportRecord);
    for(let index=0;index<entries.length;index++)
      table.objects[index]=this.objects.lookup(`${asset.name}.${entries[index].path}`.toLowerCase())??null;
    // FindExportIndex's recovered hash depends on the referenced class FName
    // pair and object FName. Link each serialized export into that exact bucket.
    for(let index=0;index<entries.length;index++){
      const identity=this.exportClassIdentity(linker,entries[index].classIndex);
      if(identity===null)continue;
      const normalizedOuter=identity.outer===0x18?0x17:identity.outer;
      const bucket=(identity.name*7+normalizedOuter*31+names[index])&0xff;
      table.hashNexts[index]=linker.hashHeads[bucket];linker.hashHeads[bucket]=index;
    }
    return linker;
  }

  createFirstLoadLinker({root,filename,flags,sandbox,guid}){
    const packageKey=String(root?.name??'').toLowerCase();
    const prepared=this.firstLoadPackages.get(packageKey);
    if(!prepared||prepared.outer!==root)
      fail(`DynamicLoadObject first-load package is not prepared: ${packageKey}`,
        'DYNAMIC_LOAD_OBJECT_FIRST_LOAD',{root,filename,flags,sandbox,guid});
    const existing=this.linkerByPackage.get(packageKey);
    if(existing)return existing;
    const linker=this.buildLinker(prepared.asset,root,{flags});
    this.linkerByPackage.set(packageKey,linker);this.linkers.push(linker);
    for(const object of prepared.objects)setExportObject(linker.exports,object.index-1,object);
    return linker;
  }

  exportClassIdentity(linker,classIndex){
    if(classIndex<0){
      const entry=linker.asset.pkg.imports[-classIndex-1];
      if(!entry||entry.outer>=0)return null;
      const outer=linker.asset.pkg.imports[-entry.outer-1];
      if(!outer)return null;
      return {name:this.nameIndex(entry.name),outer:this.nameIndex(outer.name)};
    }
    if(classIndex>0){
      const entry=linker.asset.pkg.exports[classIndex-1];
      return entry?{name:this.nameIndex(entry.name),outer:this.nameIndex(linker.asset.name)}:null;
    }
    return {name:0x29b,outer:0x14};
  }

  resourceFor(object){
    if(object?.materialization==='package-identity'||object?.materialization==='package-object'||
        object?.materialization==='native-resource'||object?.materialization==='package-export')return object;
    return object?.key?this.resources.resources.get(object.key.toLowerCase())??null:null;
  }

  read(object,field){
    if(object&&Object.hasOwn(object,field))return object[field];
    if(field==='nameIndex'&&object?.name!==undefined)return this.nameIndex(object.name);
    if(field==='outer'){
      const resource=this.resourceFor(object);
      if(resource)return resource.outer;
      if(object?.asset&&object?.entry?.outer===0)
        return this.resources.packages.get(object.asset.name.toLowerCase())??undefined;
    }
    return undefined;
  }

  resolveName(outerRef,nameRef,{create,throwOnConfigMissing}){
    if(create!==1||throwOnConfigMissing!==1)
      fail('DynamicLoadObject reached different ResolveName flags','DYNAMIC_LOAD_OBJECT_RESOLVE_FLAGS');
    const path=nameRef.get();
    if(typeof path!=='string'||path.includes('\0'))
      fail('DynamicLoadObject reached an invalid object path','DYNAMIC_LOAD_OBJECT_NAME',{value:path});
    const parts=path.split('.');
    if(parts.length<2||parts.some(part=>!part))
      fail(`DynamicLoadObject path is not Package.ObjectPath: ${path}`,
        'DYNAMIC_LOAD_OBJECT_NAME',{path});
    const packageKey=parts[0].toLowerCase();
    const linker=this.linkerByPackage.get(packageKey);
    const firstLoad=this.firstLoadPackages.get(packageKey);
    if(!linker&&!firstLoad)fail(`DynamicLoadObject package linker is not prepared: ${parts[0]}`,
      'DYNAMIC_LOAD_OBJECT_FIRST_LOAD',{path});
    const prepared=this.preparedObject(path);
    if(prepared){
      const resource=this.resourceFor(prepared);
      if(!resource?.outer)fail(`DynamicLoadObject prepared Outer is absent: ${path}`,
        'DYNAMIC_LOAD_OBJECT_OUTER',{path});
      outerRef.set(resource.outer);nameRef.set(parts.at(-1));return true;
    }
    if(parts.length!==2)
      fail(`DynamicLoadObject grouped path is not prepared: ${path}`,
        'DYNAMIC_LOAD_OBJECT_RESOLVE_GROUP',{path});
    outerRef.set(linker?.outer??firstLoad.outer);nameRef.set(parts[1]);return true;
  }

  readImportWord(linker,byteOffset){
    const index=Math.floor(byteOffset/0x1c),field=byteOffset%0x1c;
    const entry=linker.asset.pkg.imports[index];
    if(!entry)fail(`DynamicLoadObject linker import ${index} is absent`,
      'DYNAMIC_LOAD_OBJECT_IMPORT',{index,byteOffset});
    if(field===8)return entry.outer;
    if(field===12)return this.nameIndex(entry.name);
    fail(`DynamicLoadObject linker import field +0x${field.toString(16)} is unsupported`,
      'DYNAMIC_LOAD_OBJECT_IMPORT',{index,byteOffset});
  }

  services(){
    return {
      loadState:this.loadState,loadedObjects:this.loadedObjects,loaders:this.linkers,
      read:(object,field)=>this.read(object,field),
      resolveName:(outerRef,nameRef,options)=>this.resolveName(outerRef,nameRef,options),
      readPackageExtension:()=>'',copyString:({source})=>source,
      findName:(text,mode)=>{
        if(mode!==1)fail(`DynamicLoadObject reached FName mode ${mode}`,'DYNAMIC_LOAD_OBJECT_FNAME');
        return this.nameIndex(text);
      },
      readHashHead:(linker,bucket)=>linker.hashHeads[bucket],
      readExport:(linker,index)=>linker.exports.record(index),
      readImportWord:(linker,offset)=>this.readImportWord(linker,offset),
      createLinkerLoad:args=>this.createFirstLoadLinker(args),
      createExport:({record,existing})=>{
        if(record.object!==existing)return undefined;return existing;
      },
      staticFindObject:request=>fail('Prepared StaticLoadObject reached the unbound StaticFindObject fallback',
        'DYNAMIC_LOAD_OBJECT_STATIC_FIND',{request}),
      logReceiver:this.logReceiver,
      logEndLoad:event=>this.lifecycleEdges.push({op:'Logf',...event}),
      reallocLoaded:event=>this.lifecycleEdges.push({op:'FArrayRealloc',...event}),
    };
  }

  load(request){
    this.lifecycleEdges=[];
    const result=execStaticLoadObject(request,this.services());
    this.lastEvents=result.events;
    for(const event of result.events)this.onEvent?.(event);
    return result.object;
  }
}
