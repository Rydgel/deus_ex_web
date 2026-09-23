/**
 * Build the verified HUDInfoLinkDisplay shell and all six authored controls.
 *
 * The recovered native Window and ComputerWindow constructor/Init paths run
 * under the installed HUDInfoLinkDisplay -> HUDBaseWindow -> Window event
 * chain. The original CreateControls bytecode constructs and configures
 * winPortrait, winStatic, winName, winQueued, winText and winLine. Rendering,
 * allocator ownership and several internal child-window callbacks remain host
 * leaves documented in docs/script-window-computer.md.
 */
import {constructTileWindow,initTileWindow} from './script-window-tile.mjs';
import {prepareDataLinkFunctions} from './script-datalink-transmission.mjs';
import {
  constructWindowNative, constructWindowGcNative, setWindowGcFontsNative,
} from './script-window-construction.mjs';
import {initWindowNative} from './script-window-init.mjs';
import {addWindowChildNative,getRootWindowNative} from './script-window-hierarchy.mjs';
import {askParentForReconfigureNative,WINDOW_RECONFIGURE_GLOBALS} from './script-window-reconfigure.mjs';
import {WINDOW_CONFIGURE_CHILD_GLOBALS} from './script-window-configure-child.mjs';
import {boundsUpdateNative,sortWindowListsNative} from './script-window-bounds-update.mjs';
import {setWindowSizeNative,WINDOW_SIZE_OFFSETS} from './script-window-size.mjs';
import {setVisibilityNative} from './script-window-visibility.mjs';
import {WINDOW_POSITION_OFFSETS} from './script-window-position.mjs';
import {WINDOW_BACKGROUND_STYLE_OFFSETS} from './script-window-background-style.mjs';
import {loadInfoLinkPreviewAudio} from './script-infolink-audio.mjs';
import {loadInfoLinkPreviewContent} from './script-infolink-content.mjs';
import {initTextWindowNative,WINDOW_TEXT_OFFSETS} from './script-window-text.mjs';
import {
  constructComputerWindowNative,initComputerWindowNative,COMPUTER_WINDOW_OFFSETS,
} from './script-window-computer.mjs';
import {WINDOW_SURFACE_OFFSETS} from './script-window-surface.mjs';

const O=Object.freeze({type:0x28,flags:0x30,lock:0x34,backgroundStyle:0x3c,normalFont:0x54,boldFont:0x58,
  gc:0x130,
  originX:0xd4,originY:0xd8,parent:0x138,firstChild:0x13c,lastChild:0x140,
  previousSibling:0x144,nextSibling:0x148});
const colorChannels=['r','g','b','a'];

function color(value){
  if(!value||typeof value!=='object')throw new Error('InfoLink shell reached an unresolved authored Color');
  const result={};
  for(const channel of colorChannels){
    const key=`core.object.color.${channel}`;
    const component=value[key];
    if(!Number.isInteger(component)||component<0||component>255)
      throw new Error(`InfoLink shell reached invalid Color.${channel}`);
    result[channel]=component;
  }
  return result;
}

function packedColor(value){
  if(!Number.isInteger(value))throw new Error('InfoLink shell reached an invalid native packed Color');
  const bits=value>>>0;
  return {r:bits&255,g:(bits>>>8)&255,b:(bits>>>16)&255,a:(bits>>>24)&255};
}

function createRawMemory(){
  const storage=new WeakMap(),addresses=new WeakMap();
  let nextAddress=0x21000000;
  const allocate=object=>{
    if(!storage.has(object)){storage.set(object,new Map());addresses.set(object,nextAddress);nextAddress+=0x1000;}
    return object;
  };
  const read=(object,offset,kind)=>{
    const fields=storage.get(object);
    if(!fields)throw new Error('InfoLink shell read an unallocated native object');
    if(fields.has(offset))return fields.get(offset);
    return kind==='ptr'?null:0;
  };
  const write=(object,offset,kind,value)=>{
    const fields=storage.get(object);
    if(!fields)throw new Error('InfoLink shell wrote an unallocated native object');
    fields.set(offset,kind==='ptr'&&(value===0||value===undefined)?null:value);
  };
  const addressOf=object=>{
    if(!addresses.has(object))throw new Error('InfoLink shell has no native address for object');
    return addresses.get(object);
  };
  return {allocate,read,write,addressOf};
}

function requireControlBoundary(error){
  if(error?.code!=='INFOLINK_COMPUTER_WINDOW_BOUNDARY')throw error;
  return String(error.message);
}

export async function createInfoLinkShellPreview({runtime,assets,player,windowHost=null}={}){
  if(!runtime?.attach||!runtime?.prepareFunction)throw new TypeError('InfoLink shell requires ScriptRuntime');
  if(!assets?.get)throw new TypeError('InfoLink shell requires AssetStore');
  runtime.instance(player);
  const [deusEx,extension]=await Promise.all([assets.get('DeusEx'),assets.get('Extension')]);
  await prepareDataLinkFunctions(runtime,{deusEx,extension,includeTrigger:false});
  for(const path of ['deusexhud.childrequestedvisibilitychange','deusexhud.configurationchanged',
    'deusexhud.descendantremoved','deusexrootwindow.descendantremoved']){
    const index=deusEx.exportsByPath.get(path);
    if(!index)throw new Error(`Missing original DeusEx.${path}`);
    await runtime.prepareFunction(deusEx,index);
  }
  for(const path of ['window.newchild','window.childadded','window.descendantadded',
    'window.childrequestedvisibilitychange','window.childremoved','window.descendantremoved','window.destroywindow','window.destroy']){
    const index=extension.exportsByPath.get(path);
    if(!index)throw new Error(`Missing original Extension.${path}`);
    await runtime.prepareFunction(extension,index);
  }

  const load=(asset,path)=>runtime.loadClass(asset,asset.exportsByPath.get(path));
  const [rootClass,hudClass,infoClass,managerClass,themeClass,windowClass,staticWindowClass,textWindowClass,computerWindowClass,editWindowClass]=await Promise.all([
    load(deusEx,'deusexrootwindow'),load(deusEx,'deusexhud'),load(deusEx,'hudinfolinkdisplay'),
    load(deusEx,'colorthememanager'),load(deusEx,'colorthemehud_default'),
    load(extension,'window'),load(deusEx,'staticwindow'),load(extension,'textwindow'),load(extension,'computerwindow'),load(extension,'editwindow'),
  ]);
  const createControlsIndex=deusEx.exportsByPath.get('hudinfolinkdisplay.createcontrols');
  if(!createControlsIndex)throw new Error('Missing original DeusEx.HUDInfoLinkDisplay.CreateControls');
  await runtime.prepareFunction(deusEx,createControlsIndex);
  for(const path of ['staticwindow.initwindow','staticwindow.randomizestatic']){
    const index=deusEx.exportsByPath.get(path);
    if(!index)throw new Error(`Missing original DeusEx.${path}`);
    await runtime.prepareFunction(deusEx,index);
  }
  const [conWindowClass,tileWindowClass]=await Promise.all([
    load(deusEx,'hudconwindowfirst'),load(extension,'tilewindow')]);
  for(const asset of [deusEx,extension])for(const entry of asset.pkg.exports){
    if(entry.className!=='Function')continue;
    const path=entry.path.toLowerCase();
    if(path.startsWith('hudconwindowfirst.')||path.startsWith('tilewindow.')||
      path==='deusexhud.createconwindowfirst')
      await runtime.prepareFunction(asset,asset.exportsByPath.get(path));
  }
  const conversationWindows=new WeakSet();
  const root=windowHost?.root??{name:'InfoLinkPreviewRoot'},hud=windowHost?.hud??{name:'InfoLinkPreviewHUD'};
  if(windowHost&&(!windowHost.root||!windowHost.hud||!windowHost.raw))
    throw new Error('Shared InfoLink shell requires a constructed native root and HUD');
  const manager={name:'InfoLinkPreviewThemeManager'},theme={name:'ColorThemeHUD_Default'};
  if(!windowHost){runtime.attach(root,rootClass);runtime.attach(hud,hudClass);}
  runtime.attach(manager,managerClass);runtime.attach(theme,themeClass);
  runtime.namedReference(root,'parentPawn').set(player);
  runtime.namedReference(root,'hud').set(hud);
  const playerTheme=runtime.namedReference(player,'ThemeManager');
  runtime.namedReference(manager,'currentHUDTheme').set(theme);

  const owned=new WeakSet();
  const storage=windowHost?.raw??createRawMemory();
  const memory={...storage,allocate:object=>{owned.add(object);return storage.allocate(object);}};
  for(const object of windowHost?[]:[root,hud]){
    memory.allocate(object);
    constructWindowNative(object,{read:memory.read,write:memory.write,
      coreObjectConstructor:({object:target})=>memory.write(target,0,'u32',0x10179dfc)});
  }
  if(!windowHost){
    memory.write(root,O.type,'u8',3);memory.write(root,O.flags,'u32',1);memory.write(root,O.parent,'ptr',null);
    memory.write(hud,O.flags,'u32',1);memory.write(hud,O.parent,'ptr',root);
  }
  const globals=windowHost?.globals??new Map([...Object.values(WINDOW_RECONFIGURE_GLOBALS),
    ...Object.values(WINDOW_CONFIGURE_CHILD_GLOBALS)].map(name=>[name,0]));
  let events=[];
  let child=null,portrait=null,staticControl=null,nameControl=null,queuedControl=null;
  let textControl=null,lineControl=null,computerTextWindow=null,computerInputWindow=null,boundary=null;
  const computerEvents=new WeakMap();
  const destroyedWindows=new WeakSet();
  const controlName=object=>object===child?'HUDInfoLinkDisplay':object===portrait?'winPortrait':
    object===staticControl?'winStatic':object===nameControl?'winName':object===queuedControl?'winQueued':
    object===textControl?'winText':object===lineControl?'winLine':'Window';
  const rawServices={read:memory.read,write:memory.write};
  const reconfiguration={...rawServices,
    readGlobal:name=>globals.get(name),writeGlobal:(name,_kind,value)=>globals.set(name,value),
    parentRequestedReconfiguration:()=>0,configurationChanged:()=>{},resizeChild:()=>{},
  };
  // ConfigureChild shares the reconfiguration globals and leaf surface
  // (configurationChanged/resizeChild). The conditional bounds/list leaves are
  // the recovered Extension bodies: BoundsUpdate 0x10051160 propagates the
  // absolute-bounds/clip struct (and GC copy) down the subtree, and
  // SortWindowLists 0x10045140 re-sorts the type>=1 ancestor's (here empty)
  // window lists. The diagnostic and SafeDestroy leaves stay unprovided so
  // reaching them remains an explicit boundary error.
  const configureChild={...rawServices,
    readGlobal:name=>globals.get(name),writeGlobal:(name,_kind,value)=>globals.set(name,value),
    configurationChanged:()=>{},resizeChild:()=>{},
    boundsUpdate:({object})=>boundsUpdateNative(object,{read:memory.read,write:memory.write}),
    sortWindowLists:request=>windowHost
      ?windowHost.lifecycle.configureChild.sortWindowLists(request)
      :sortWindowListsNative(request.object,request.child,
        {read:memory.read,write:memory.write,addressOf:memory.addressOf}),
  };
  const visibility={...rawServices,
    readGlobal:name=>globals.get(name),writeGlobal:(name,_kind,value)=>globals.set(name,value),
    childRequestedVisibilityChange:({parent,child:requested,visible})=>
      runtime.processEvent(parent,'ChildRequestedVisibilityChange',[requested,visible]),
    checkFocusWindow:()=>{},checkGrabbedWindow:()=>{},recomputeInitTree:()=>{},
    invokeVisibilityChange:()=>{},reconfigureTree:()=>{},makeAcceleratorTableDirty:()=>{},
  };
  const backgroundStyle={...rawServices,
    generatePolyFlags:({style})=>events.push(`${style===4?'winStatic':'winPortrait'} GeneratePolyFlags`),
  };
  const surface={...rawServices,
    askParentForReconfigure:({object})=>events.push(`${controlName(object)} AskParentForReconfigure`),
  };
  const initServices={...rawServices,pointerWord:({object})=>memory.addressOf(object),fNameNone:()=>0,
    xgcOperatorNew:()=>memory.allocate({name:'InfoLinkPreviewGC'}),
    xgcConstructor:({object})=>constructWindowGcNative(object,{...rawServices,
      coreObjectConstructor:({object:target})=>memory.write(target,0,'u32',0x10179dfc),
      nativeAddress:memory.addressOf(object)}),
    addChild:({parent,child:added,flag})=>addWindowChildNative(parent,added,flag,{
      read:(object,offset)=>memory.read(object,offset,'ptr'),
      write:(object,offset,value)=>memory.write(object,offset,'ptr',value),
    }),
    childAdded:({parent,child:added})=>runtime.processEvent(parent,'ChildAdded',[added]),
    descendantAdded:({parent,child:added})=>runtime.processEvent(parent,'DescendantAdded',[added]),
    setFonts:request=>setWindowGcFontsNative(request,{write:memory.write}),
  };
  const makeComputerInternal=(details,isText)=>{
    const internal={name:isText?'InfoLinkComputerTextWindow':'InfoLinkComputerInputWindow'};
    memory.allocate(internal);runtime.attach(internal,isText?textWindowClass:editWindowClass);
    constructWindowNative(internal,{...rawServices,
      coreObjectConstructor:({object:target})=>memory.write(target,0,'u32',0x10179dfc)});
    initTextWindowNative(internal,details.parent,{...rawServices,
      initWindow:args=>initWindowNative(args,initServices),makeAcceleratorTableDirty:()=>{}});
    if(isText)computerTextWindow=internal;else computerInputWindow=internal;
    const flags=memory.read(internal,O.flags,'u32');
    memory.write(internal,O.flags,'u32',details.show?flags|1:flags&~1);
    return internal;
  };
  const computer={...rawServices,
    resize:details=>setWindowSizeNative(details.object,details.width,details.height,{...rawServices,
      askParentForReconfigure:()=>{}}),
    appendQueuedEvent:details=>{const list=computerEvents.get(details.object)??[];
      list.push(Object.freeze({...details.event}));computerEvents.set(details.object,list);return list.length-1;},
    arrayRealloc:details=>{computerEvents.set(details.object,[]);return 0;},
  };
  const destroy={...rawServices,
    onEvent:details=>events.push(`${controlName(details.object)} ${details.op}`),
    setVisibility:details=>{const flags=memory.read(details.object,O.flags,'u32');
      memory.write(details.object,O.flags,'u32',details.visible?flags|1:flags&~1);},
    setSelectability:details=>{const flags=memory.read(details.object,O.flags,'u32');
      memory.write(details.object,O.flags,'u32',details.selectable?flags|4:flags&~4);},
    processScript:details=>runtime.processEvent(details.object,details.event,[]),
    childRemoved:details=>runtime.processEvent(details.parent,'ChildRemoved',[details.child]),
    descendantRemoved:details=>runtime.processEvent(details.ancestor,'DescendantRemoved',[details.child]),
    freeGc:()=>{},destroyGc:()=>{},
    cleanUp:details=>{computerEvents.delete(details.object);return details.baseCleanUp();},
    deleteWindow:details=>{destroyedWindows.add(details.object);},
  };
  const lifecycle={
    errorDevice:{name:'InfoLinkPreviewGError'},isScriptable:()=>true,
    hierarchy:{readParent:object=>memory.read(object,O.parent,'ptr'),readType:object=>memory.read(object,O.type,'u8')},
    reconfiguration,
    configureChild,
    // GetTopChild/GetBottomChild/sibling walks (HUDConWindowFirst.DestroyChildren
    // clears the tile through GetTopChild) read the raw child/flag fields.
    sensitivity:rawServices,
    size:rawServices,
    position:rawServices,
    backgroundStyle,
    text:rawServices,
    surface,
    computer,
    tile:{...rawServices,askParentForReconfigure:surface.askParentForReconfigure},
    destroy,
    order:{...rawServices,
      addChild:({parent,child:added,flag})=>addWindowChildNative(parent,added,flag,{
        read:(object,offset)=>memory.read(object,offset,'ptr'),
        write:(object,offset,value)=>memory.write(object,offset,'ptr',value),
      }),
      checkFocusWindow:()=>{throw new Error('InfoLink shell unexpectedly reached Raise CheckFocusWindow');}},
    staticConstructObject:request=>{
      if(request.name!=='None'||request.flags!==0||request.template!==null)
        throw new Error('InfoLink shell received different StaticConstructObject arguments');
      let created,createdClass;
      if(request.classObject===infoClass.record&&request.outer===hud){
        child=created={name:'HUDInfoLinkDisplayPreview'};createdClass=infoClass;
        events.push('HUDInfoLinkDisplay StaticConstructObject');
      }else if(request.classObject===windowClass.record&&request.outer===child){
        if(!portrait){portrait=created={name:'InfoLinkPortraitPreview'};events.push('winPortrait StaticConstructObject');}
        else if(!lineControl){lineControl=created={name:'InfoLinkLinePreview'};events.push('winLine StaticConstructObject');}
        else throw new Error('InfoLink shell received an extra Window child');
        createdClass=windowClass;
      }else if(request.classObject===staticWindowClass.record&&request.outer===child){
        staticControl=created={name:'InfoLinkStaticPreview'};createdClass=staticWindowClass;
        events.push('winStatic StaticConstructObject');
      }else if(request.classObject===textWindowClass.record&&request.outer===child){
        if(!nameControl){nameControl=created={name:'InfoLinkNamePreview'};events.push('winName StaticConstructObject');}
        else if(!queuedControl){queuedControl=created={name:'InfoLinkQueuedPreview'};events.push('winQueued StaticConstructObject');}
        else throw new Error('InfoLink shell received an extra TextWindow child');
        createdClass=textWindowClass;
      }else if(request.classObject===computerWindowClass.record&&request.outer===child){
        textControl=created={name:'InfoLinkTextPreview'};createdClass=computerWindowClass;
        events.push('winText StaticConstructObject');
      }else if((request.classObject===conWindowClass.record&&request.outer===hud)||
        (conversationWindows.has(request.outer)&&
          [tileWindowClass.record,textWindowClass.record,windowClass.record].includes(request.classObject))){
        createdClass=request.classObject.linkedClass;
        created={name:createdClass.record.name};conversationWindows.add(created);
      }else throw new Error('InfoLink shell received different StaticConstructObject class/outer');
      memory.allocate(created);runtime.attach(created,createdClass);
      if(request.outer===hud)windowHost?.delegateLegacySubtree(created);
      if(createdClass===tileWindowClass)constructTileWindow(created,{...rawServices,
        coreObjectConstructor:({object:target})=>memory.write(target,0,'u32',0x10179dfc)});
      else if(created===textControl)constructComputerWindowNative(created,{...rawServices,
        constructWindow:({object:target})=>constructWindowNative(target,{...rawServices,
          coreObjectConstructor:({object:base})=>memory.write(base,0,'u32',0x10179dfc)})});
      else constructWindowNative(created,{...rawServices,
        coreObjectConstructor:({object:target})=>memory.write(target,0,'u32',0x10179dfc)});
      return created;
    },
    initVtable:request=>{
      if(runtime.instance(request.object).cls===tileWindowClass){
        initTileWindow(request.object,request.parent,{...rawServices,
          initWindow:args=>initWindowNative(args,initServices)});
      }else if(request.object===nameControl||request.object===queuedControl||
        (conversationWindows.has(request.object)&&runtime.instance(request.object).cls===textWindowClass)){
        events.push(`${request.object===nameControl?'winName':'winQueued'} XTextWindow::Init`);
        initTextWindowNative(request.object,request.parent,{...rawServices,
          initWindow:args=>initWindowNative(args,initServices),
          makeAcceleratorTableDirty:()=>{throw new Error('InfoLink winName unexpectedly dirtied the accelerator table');},
        });
      }else if(request.object===textControl){
        events.push('winText XComputerWindow::Init');
        let internalCount=0;
        initComputerWindowNative(request.object,request.parent,{...rawServices,
          initWindow:details=>initWindowNative({window:details.object,parent:details.parent},initServices),
          getRootWindow:details=>getRootWindowNative(details.object,{
            readParent:object=>memory.read(object,O.parent,'ptr'),
            readType:object=>memory.read(object,O.type,'u8'),
          }),
          getPlayerPawn:()=>player,readPlayerViewportName:()=>'',
          createNewWindow:details=>makeComputerInternal(details,internalCount++===0),
          resize:computer.resize,setWindowAlignments:()=>{},
          setTextMargins:details=>{memory.write(details.object,WINDOW_TEXT_OFFSETS.horizontalMargin,'f32',details.horizontal);
            memory.write(details.object,WINDOW_TEXT_OFFSETS.verticalMargin,'f32',details.vertical);},
          setInsertionPointBlinkRate:details=>memory.write(details.object,0x1bc,'f32',details.rate),
          setSelectability:details=>{const flags=memory.read(details.object,O.flags,'u32');
            memory.write(details.object,O.flags,'u32',details.selectable?flags|4:flags&~4);},
        });
      }else{
        events.push(`${controlName(request.object)} XWindow::Init`);
        initWindowNative({window:request.object,parent:request.parent},initServices);
      }
    },
    read:(object,key)=>memory.read(object,key==='lockCount'?O.lock:O.flags,key==='lockCount'?'i32':'u32'),
    write:(object,key,value)=>memory.write(object,key==='lockCount'?O.lock:O.flags,'u32',value),
    visibility,
    setVisibility:request=>{events.push(`${controlName(request.object)} SetVisibility`);
      return setVisibilityNative(request,visibility);},
  };
  // One player root/HUD and one byte-addressed heap serve both window paths.
  // InfoLink's ComputerWindow and the existing conversation presenter retain
  // their documented partial lifecycle. Calls on the native HUD (including
  // inventory updates during ConPlay) keep the general host's lifecycle.
  const shellConstruction=request=>(request.outer===hud&&
    [infoClass.record,conWindowClass.record].includes(request.classObject))||owned.has(request.outer);
  const requestObject=value=>owned.has(value)?value:
    value?.object??value?.window??value?.receiver??value?.parent??null;
  const mergeLifecycle=(legacy,native)=>{
    const merged={...native};
    for(const [key,value] of Object.entries(legacy)){
      const other=native?.[key];
      if(typeof value==='function'&&typeof other==='function'){
        merged[key]=(...args)=>(key==='staticConstructObject'?shellConstruction(args[0]):owned.has(requestObject(args[0])))
          ?value(...args):other(...args);
      }else if(value&&typeof value==='object'&&other&&typeof other==='object'&&key!=='errorDevice')
        merged[key]=mergeLifecycle(value,other);
      else merged[key]=value;
    }
    return merged;
  };
  const sharedLifecycle=windowHost?mergeLifecycle(lifecycle,windowHost.lifecycle):lifecycle;
  if(windowHost){
    sharedLifecycle.handleNative=call=>owned.has(call.receiver)
      ?{handled:false}:windowHost.lifecycle.handleNative(call);
    sharedLifecycle.processScript=request=>owned.has(request.object)
      ?runtime.processWindowScript(request):windowHost.lifecycle.processScript(request);
    // Keep the shell's recovered, bounded reconfiguration path for controls
    // whose layout remains owned by the specialized presenter.
    sharedLifecycle.askParentForReconfigure=request=>owned.has(request.object)
      ?askParentForReconfigureNative(request.object,reconfiguration)
      :windowHost.lifecycle.askParentForReconfigure(request);
  }
  const newChild=await runtime.prepareFunction(extension,extension.exportsByPath.get('window.newchild'));
  const [audio,content]=await Promise.all([
    loadInfoLinkPreviewAudio(assets),loadInfoLinkPreviewContent(assets),
  ]);

  function constructShell(){
    const previousTheme=playerTheme.get();
    const previousRngState=runtime.rng?.state;
    const previousLifecycle=runtime.windowLifecycle;
    events=[];
    child=portrait=staticControl=nameControl=queuedControl=null;
    textControl=lineControl=computerTextWindow=computerInputWindow=boundary=null;
    if(!windowHost)playerTheme.set(manager);
    runtime.windowLifecycle=sharedLifecycle;
  try{
    runtime.callFunction(newChild,hud,1,()=>infoClass.record);
    boundary='Original HUDInfoLinkDisplay.CreateControls completed all six authored controls';
  }catch(error){boundary=requireControlBoundary(error);events.push('winText allocation boundary');}
  finally{runtime.windowLifecycle=previousLifecycle;playerTheme.set(previousTheme);
    if(Number.isInteger(previousRngState)&&typeof runtime.rng?.seed==='function')runtime.rng.seed(previousRngState);}
  if(!child)throw new Error('InfoLink shell did not allocate HUDInfoLinkDisplay');
  if(!portrait)throw new Error('InfoLink shell did not allocate winPortrait');
  if(!staticControl)throw new Error('InfoLink shell did not allocate winStatic');
  if(!nameControl)throw new Error('InfoLink shell did not allocate winName');
  if(!queuedControl)throw new Error('InfoLink shell did not allocate winQueued');
  if(!textControl)throw new Error('InfoLink shell did not allocate winText');
  if(!lineControl)throw new Error('InfoLink shell did not allocate winLine');
  if(!computerTextWindow||!computerInputWindow)
    throw new Error('InfoLink shell did not allocate ComputerWindow internal children');
  const get=name=>runtime.namedReference(child,name).get();
  const width=memory.read(child,WINDOW_SIZE_OFFSETS.width,'f32');
  const height=memory.read(child,WINDOW_SIZE_OFFSETS.height,'f32');
  if(width!==431||height!==114)throw new Error(`InfoLink shell has unexpected size ${width}x${height}`);
  const shellObject=child;
  return Object.freeze({
    // Keep the canonical objects available to the Play host.  The preview used
    // to expose only the child for rendering diagnostics; the live DataLink
    // lifecycle also needs the original player.rootWindow -> hud -> infolink
    // publication graph and must publish this same constructed child.
    object:child,root,hud,width,height,title:get('IncomingTransmission'),audio,content,
    colors:Object.freeze({background:color(get('colBackground')),border:color(get('colBorder')),
      text:color(get('colText')),header:color(get('colName')),line:color(get('colLine'))}),
    drawBorder:Boolean(get('bDrawBorder')),borderDrawStyle:get('borderDrawStyle'),
    backgroundDrawStyle:get('backgroundDrawStyle'),
    controls:Object.freeze(['winPortrait','winStatic','winName','winQueued','winText','winLine']),
    initializedControls:Object.freeze([Object.freeze({name:'winPortrait',
      x:memory.read(portrait,WINDOW_POSITION_OFFSETS.x,'f32'),
      y:memory.read(portrait,WINDOW_POSITION_OFFSETS.y,'f32'),
      width:memory.read(portrait,WINDOW_SIZE_OFFSETS.width,'f32'),
      height:memory.read(portrait,WINDOW_SIZE_OFFSETS.height,'f32'),
      backgroundStyle:memory.read(portrait,WINDOW_BACKGROUND_STYLE_OFFSETS.backgroundStyle,'u8'),
      visible:Boolean(memory.read(portrait,O.flags,'u32')&1),
    }),Object.freeze({name:'winStatic',
      x:memory.read(staticControl,WINDOW_POSITION_OFFSETS.x,'f32'),
      y:memory.read(staticControl,WINDOW_POSITION_OFFSETS.y,'f32'),
      width:memory.read(staticControl,WINDOW_SIZE_OFFSETS.width,'f32'),
      height:memory.read(staticControl,WINDOW_SIZE_OFFSETS.height,'f32'),
      backgroundStyle:memory.read(staticControl,WINDOW_BACKGROUND_STYLE_OFFSETS.backgroundStyle,'u8'),
      visible:Boolean(memory.read(staticControl,O.flags,'u32')&1),
      bLineVisible:Boolean(runtime.namedReference(staticControl,'bLineVisible').get()),
      lineInterval:runtime.namedReference(staticControl,'lineInterval').get(),
      linePauseDelay:runtime.namedReference(staticControl,'linePauseDelay').get(),
      currentLinePosY:runtime.namedReference(staticControl,'currentLinePosY').get(),
    }),Object.freeze({name:'winName',
      x:memory.read(nameControl,WINDOW_POSITION_OFFSETS.x,'f32'),
      y:memory.read(nameControl,WINDOW_POSITION_OFFSETS.y,'f32'),
      width:memory.read(nameControl,WINDOW_SIZE_OFFSETS.width,'f32'),
      height:memory.read(nameControl,WINDOW_SIZE_OFFSETS.height,'f32'),
      visible:Boolean(memory.read(nameControl,O.flags,'u32')&1),
      horizontalAlignment:memory.read(nameControl,WINDOW_TEXT_OFFSETS.horizontalAlignment,'u8'),
      verticalAlignment:memory.read(nameControl,WINDOW_TEXT_OFFSETS.verticalAlignment,'u8'),
      horizontalMargin:memory.read(nameControl,WINDOW_TEXT_OFFSETS.horizontalMargin,'f32'),
      verticalMargin:memory.read(nameControl,WINDOW_TEXT_OFFSETS.verticalMargin,'f32'),
      text:memory.read(nameControl,WINDOW_TEXT_OFFSETS.text,'string'),
      font:memory.read(nameControl,WINDOW_TEXT_OFFSETS.normalFont,'ptr')?.key??null,
      boldFont:memory.read(nameControl,WINDOW_TEXT_OFFSETS.boldFont,'ptr')?.key??null,
      textColor:packedColor(memory.read(nameControl,WINDOW_TEXT_OFFSETS.packedTextColor,'u32')),
      wordWrap:Boolean(memory.read(nameControl,WINDOW_TEXT_OFFSETS.textFlags,'u32')&1),
      textIsAccelerator:Boolean(memory.read(nameControl,WINDOW_TEXT_OFFSETS.textFlags,'u32')&2),
      acceleratorKey:memory.read(nameControl,WINDOW_TEXT_OFFSETS.acceleratorKey,'u32'),
    }),Object.freeze({name:'winQueued',
      x:memory.read(queuedControl,WINDOW_POSITION_OFFSETS.x,'f32'),
      y:memory.read(queuedControl,WINDOW_POSITION_OFFSETS.y,'f32'),
      width:memory.read(queuedControl,WINDOW_SIZE_OFFSETS.width,'f32'),
      height:memory.read(queuedControl,WINDOW_SIZE_OFFSETS.height,'f32'),
      visible:Boolean(memory.read(queuedControl,O.flags,'u32')&1),
      horizontalAlignment:memory.read(queuedControl,WINDOW_TEXT_OFFSETS.horizontalAlignment,'u8'),
      verticalAlignment:memory.read(queuedControl,WINDOW_TEXT_OFFSETS.verticalAlignment,'u8'),
      horizontalMargin:memory.read(queuedControl,WINDOW_TEXT_OFFSETS.horizontalMargin,'f32'),
      verticalMargin:memory.read(queuedControl,WINDOW_TEXT_OFFSETS.verticalMargin,'f32'),
      text:memory.read(queuedControl,WINDOW_TEXT_OFFSETS.text,'string'),
      font:memory.read(queuedControl,WINDOW_TEXT_OFFSETS.normalFont,'ptr')?.key??null,
      boldFont:memory.read(queuedControl,WINDOW_TEXT_OFFSETS.boldFont,'ptr')?.key??null,
      textColor:packedColor(memory.read(queuedControl,WINDOW_TEXT_OFFSETS.packedTextColor,'u32')),
      wordWrap:Boolean(memory.read(queuedControl,WINDOW_TEXT_OFFSETS.textFlags,'u32')&1),
      textIsAccelerator:Boolean(memory.read(queuedControl,WINDOW_TEXT_OFFSETS.textFlags,'u32')&2),
      acceleratorKey:memory.read(queuedControl,WINDOW_TEXT_OFFSETS.acceleratorKey,'u32'),
    }),Object.freeze({name:'winText',
      x:memory.read(textControl,WINDOW_POSITION_OFFSETS.x,'f32'),
      y:memory.read(textControl,WINDOW_POSITION_OFFSETS.y,'f32'),
      width:memory.read(textControl,WINDOW_SIZE_OFFSETS.width,'f32'),
      height:memory.read(textControl,WINDOW_SIZE_OFFSETS.height,'f32'),
      visible:Boolean(memory.read(textControl,O.flags,'u32')&1),
      columns:memory.read(textControl,COMPUTER_WINDOW_OFFSETS.textCols,'i32'),
      rows:memory.read(textControl,COMPUTER_WINDOW_OFFSETS.textRows,'i32'),
      font:memory.read(textControl,COMPUTER_WINDOW_OFFSETS.textFont,'ptr')?.key??null,
      fontWidth:memory.read(textControl,COMPUTER_WINDOW_OFFSETS.fontWidth,'i32'),
      fontHeight:memory.read(textControl,COMPUTER_WINDOW_OFFSETS.fontHeight,'i32'),
      textTiming:memory.read(textControl,COMPUTER_WINDOW_OFFSETS.eventTimeInterval,'f32'),
      fadeSpeed:memory.read(textControl,COMPUTER_WINDOW_OFFSETS.fadeSpeed,'f32'),
      cursorColor:packedColor(memory.read(textControl,COMPUTER_WINDOW_OFFSETS.cursorColor,'u32')),
      wordWrap:Boolean(memory.read(textControl,COMPUTER_WINDOW_OFFSETS.flags,'u32')&1),
      queuedEvents:Object.freeze((computerEvents.get(textControl)??[]).slice()),
    }),Object.freeze({name:'winLine',
      x:memory.read(lineControl,WINDOW_POSITION_OFFSETS.x,'f32'),
      y:memory.read(lineControl,WINDOW_POSITION_OFFSETS.y,'f32'),
      width:memory.read(lineControl,WINDOW_SIZE_OFFSETS.width,'f32'),
      height:memory.read(lineControl,WINDOW_SIZE_OFFSETS.height,'f32'),
      visible:Boolean(memory.read(lineControl,O.flags,'u32')&1),
      backgroundStyle:memory.read(lineControl,WINDOW_BACKGROUND_STYLE_OFFSETS.backgroundStyle,'u8'),
      background:memory.read(lineControl,WINDOW_SURFACE_OFFSETS.background,'ptr')?.key??null,
      tileColor:packedColor(memory.read(lineControl,WINDOW_SURFACE_OFFSETS.packedTileColor,'u32')),
    })]),
    boundary,events:Object.freeze(events.slice()),
    objects:Object.freeze({portrait,static:staticControl,name:nameControl,queued:queuedControl,
      text:textControl,line:lineControl,computerText:computerTextWindow,computerInput:computerInputWindow}),
    withLifecycle(callback){const previous=runtime.windowLifecycle,themeBefore=playerTheme.get();
      runtime.windowLifecycle=sharedLifecycle;if(!windowHost)playerTheme.set(manager);
      try{return callback();}finally{runtime.windowLifecycle=previous;playerTheme.set(themeBefore);}},
    recreate(){
      if(!destroyedWindows.has(shellObject))
        throw new Error('InfoLink shell must follow Window.Destroy before recreation');
      return constructShell();
    },
    readNative:(object,offset,kind)=>memory.read(object,offset,kind),
    // Adopt a runtime-attached object (e.g. the live DataLink harness's
    // HUDReceivedDisplay) into the shell's native window storage so Window
    // natives invoked on it execute against real fields.
    adoptWindow:(object,parent=hud)=>{memory.allocate(object);
      constructWindowNative(object,{...rawServices,
        coreObjectConstructor:({object:base})=>memory.write(base,0,'u32',0x10179dfc)});
      memory.write(object,O.parent,'ptr',parent);return object;},
    isDestroyed:object=>destroyedWindows.has(object),
    native:Object.freeze({lockCount:memory.read(child,O.lock,'i32'),
      visible:Boolean(memory.read(child,O.flags,'u32')&1),parent:memory.read(child,O.parent,'ptr')===hud}),
  });
  }

  return constructShell();
}
