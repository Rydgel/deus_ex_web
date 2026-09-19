/** Original HUD bytecode with a bounded browser presentation window host.
 * See docs/script-play-hud.md. This is not general native HUD construction.
 */
import {TextureStore} from '../unreal/textures.mjs';
import {WINDOW_SIZE_OFFSETS as SIZE} from './script-window-size.mjs';
import {WINDOW_POSITION_OFFSETS as POS} from './script-window-position.mjs';
import {WINDOW_SURFACE_OFFSETS as SURFACE} from './script-window-surface.mjs';
import {WINDOW_BACKGROUND_STYLE_OFFSETS as STYLE} from './script-window-background-style.mjs';

const parts=['head','torso','armLeft','armRight','legLeft','legRight'];
const deref=value=>value?.reference?value.get():value;
export const hudColor=value=>['r','g','b'].map(key=>value[`core.object.color.${key}`]);
const unpack=value=>[value&255,(value>>>8)&255,(value>>>16)&255];

export async function createPlayHud({runtime,assets,player,shell,mapNorth=0}){
  const dx=await assets.get('DeusEx'),ext=await assets.get('Extension');
  if(!shell)throw new Error('Play HUD requires the live InfoLink window host');
  const classes=new Map();
  for(const [asset,names] of [[dx,['HUDHitDisplay','HUDCompassDisplay','ProgressBarWindow','Crosshair',
    'ColorThemeManager',`ColorThemeHUD_${runtime.namedReference(player,'HUDThemeName').get()}`]],
    [ext,['Window','GC']]])for(const name of names){
    const index=asset.exportsByPath.get(name.toLowerCase());
    if(!index)throw new Error(`Unsupported HUD class ${name}`);
    const cls=await runtime.loadClass(asset,index);classes.set(cls.record.key,cls);
  }
  const prepared=new Map();
  const prepare=async(asset,path)=>{
    const index=asset.exportsByPath.get(path.toLowerCase());
    if(!index)throw new Error(`Missing original HUD function ${path}`);
    const record=await runtime.prepareFunction(asset,index);prepared.set(record.key,record);
  };
  // Prepare only this script call graph, including native declarations used as
  // final calls. New function paths must be admitted explicitly.
  for(const [asset,paths] of [[dx,[
    'hudhitdisplay.initwindow','hudhitdisplay.createbodypart','hudhitdisplay.createprogressbar',
    'hudhitdisplay.sethitcolor','hudhitdisplay.tick','hudhitdisplay.setvisibility',
    'hudhitdisplay.drawbackground','hudhitdisplay.drawborder','hudcompassdisplay.initwindow',
    'hudcompassdisplay.createcompasswindow','hudcompassdisplay.createtickwindow',
    'hudcompassdisplay.getmaptruenorth','hudcompassdisplay.tick','hudcompassdisplay.setvisibility',
    'hudcompassdisplay.drawbackground','hudcompassdisplay.drawborder','hudcompassdisplay.postdrawbackground',
    'hudbasewindow.initwindow','hudbasewindow.stylechanged','progressbarwindow.usescaledcolor',
    'hudinfolinkdisplay.drawbackground','hudinfolinkdisplay.drawborder',
    'progressbarwindow.setvalues','progressbarwindow.setcurrentvalue','progressbarwindow.setvertical',
    'progressbarwindow.updatebars','progressbarwindow.getbarcolor','crosshair.initwindow',
    'crosshair.setcrosshaircolor','colorthememanager.getcurrenthudcolortheme','colortheme.getcolorfromname',
    'deusexplayer.gethudbordersvisible','deusexplayer.gethudbordertranslucency','deusexplayer.gethudbackgroundtranslucency',
  ]],[ext,['window.initwindow','window.settilecolorrgb','window.getcolorscaled','window.newchild',
    'window.lower','window.show','window.hide','window.isvisible','window.setbackground',
    'window.setbackgroundstyle','window.getrootwindow','window.setconfiguration','window.setsize',
    'window.setpos','window.settilecolor']]])for(const path of paths)await prepare(asset,path);

  const windows=[],children=new Map(),textures=new TextureStore(assets),images=new Map();
  let nextId=0;
  const read=(object,name)=>runtime.namedReference(object,name).get();
  const write=(object,name,value)=>runtime.namedReference(object,name).set(value);
  const invoke=(object,name,args=[])=>runtime.callFunction(runtime.lookup(object,name),object,args.length,i=>args[i]);
  function allocate(classKey,parent=shell.hud){
    const cls=classes.get(classKey);if(!cls)throw new Error(`HUD child class not admitted: ${classKey}`);
    const object={name:`PlayHUD${++nextId}`,parent};runtime.attach(object,cls);
    shell.adoptWindow(object,parent);windows.push(object);children.set(object,[]);
    children.get(parent)?.push(object);
    // The script-facing Window fields refer to the same native setter storage.
    for(const [name,offset] of [['width',SIZE.width],['height',SIZE.height]]){
      const field=runtime.lookupMember(cls,'fields',name);
      runtime.instance(object).bindings.set(field.key,{get:()=>shell.readNative(object,offset,'f32'),
        set:()=>{throw new Error('HUD dimensions must use original Window setters');}});
    }
    return object;
  }
  const hit=allocate('deusex.hudhitdisplay'),compass=allocate('deusex.hudcompassdisplay'),
    cross=allocate('deusex.crosshair');
  const manager={},theme={};
  runtime.attach(manager,classes.get('deusex.colorthememanager'));
  runtime.attach(theme,[...classes.values()].find(cls=>cls.record.key.startsWith('deusex.colorthemehud_')));
  write(manager,'currentHUDTheme',theme);
  const adapters=new Set([1410,1412]);
  function scoped(callback){
    const native=runtime.native,boundaries=runtime.boundaryNatives,oldTheme=read(player,'ThemeManager');
    const northKey='deusex.hudcompassdisplay.getmaptruenorth',oldNorth=runtime.boundaryFunctions.get(northKey);
    runtime.boundaryNatives=new Set([...boundaries,...adapters]);
    runtime.boundaryFunctions.set(northKey,()=>write(compass,'mapNorth',mapNorth));
    runtime.native=call=>{
      if(!adapters.has(call.index))return native(call);
      if(call.index===1410){
        const cls=deref(call.evaluateArgument(0));
        if(!['extension.window','deusex.progressbarwindow'].includes(cls?.key))
          throw new Error(`Unsupported Play HUD NewChild: ${cls?.key}`);
        const child=allocate(cls.key,call.receiver);
        invoke(child,'InitWindow');invoke(child,'Show',[call.argumentCount>1?deref(call.evaluateArgument(1)):true]);
        return child;
      }
      const siblings=children.get(call.receiver.parent);
      if(!siblings?.includes(call.receiver))throw new Error('HUD Lower reached an unknown child');
      siblings.splice(siblings.indexOf(call.receiver),1);siblings.unshift(call.receiver);
    };
    write(player,'ThemeManager',manager);
    try{return shell.withLifecycle(callback);}
    finally{runtime.native=native;runtime.boundaryNatives=boundaries;write(player,'ThemeManager',oldTheme);
      if(oldNorth)runtime.boundaryFunctions.set(northKey,oldNorth);else runtime.boundaryFunctions.delete(northKey);}
  }
  scoped(()=>{for(const object of [hit,compass,cross])invoke(object,'InitWindow');
    // HUD layout already recovered from DeusExHUD.ConfigurationChanged.
    invoke(compass,'SetPos',[0,read(hit,'height')+4]);
    invoke(hit,'SetVisibility',[true]);invoke(compass,'SetVisibility',[true]);});
  async function imageFor(reference){
    if(!reference)return null;
    if(!images.has(reference.key)){
      const data=await textures.get(reference.asset,reference.index,true);
      images.set(reference.key,{key:reference.key,...data.mips[0]});
    }
    return images.get(reference.key);
  }
  for(const object of windows)await imageFor(shell.readNative(object,SURFACE.background,'ptr'));
  for(const object of [hit,compass])for(const name of ['texBackground','texBorder'])await imageFor(read(object,name));
  await imageFor(read(compass,'texTickBox'));
  const gc={};runtime.attach(gc,classes.get('extension.gc'));
  for(const path of ['gc.setstyle','gc.settilecolor','gc.drawtexture'])await prepare(ext,path);
  function decorationCommands(object,post=false){
    const commands=[];
    // Existing InfoLink windows now expose their native dimensions to DrawWindow.
    for(const [name,offset] of [['width',SIZE.width],['height',SIZE.height]]){
      const instance=runtime.instance(object),field=runtime.lookupMember(instance.cls,'fields',name);
      if(!instance.bindings.has(field.key))instance.bindings.set(field.key,{
        get:()=>shell.readNative(object,offset,'f32'),set:()=>{throw new Error('HUD dimensions require Window setters');}});
    }
    scoped(()=>{
      const native=runtime.native,boundaries=runtime.boundaryNatives;
      runtime.boundaryNatives=new Set([...boundaries,1212,1230,1284]);
      let style=1,color=[255,255,255];
      runtime.native=call=>{
        const args=Array.from({length:call.argumentCount},(_,i)=>deref(call.evaluateArgument(i)));
        if(call.index===1212)style=args[0];
        else if(call.index===1230)color=hudColor(args[0]);
        else if(call.index===1284){const [x,y,width,height,u,v,texture]=args;
          commands.push({x,y,width,height,u,v,texture:texture.key,style,color});}
        else return native(call);
      };
      try{if(post)invoke(object,'PostDrawBackground',[gc]);
        else{invoke(object,'DrawBackground',[gc]);invoke(object,'DrawBorder',[gc]);}}
      finally{runtime.native=native;runtime.boundaryNatives=boundaries;}
    });return commands;
  }
  const background=(object)=>shell.readNative(object,SURFACE.background,'ptr');
  const rect=object=>({x:shell.readNative(object,POS.x,'f32'),y:shell.readNative(object,POS.y,'f32'),
    width:read(object,'width'),height:read(object,'height')});
  const visible=object=>Boolean(shell.readNative(object,0x30,'u32')&1);
  const tile=(object)=>({color:unpack(shell.readNative(object,SURFACE.packedTileColor,'u32')),
    style:shell.readNative(object,STYLE.backgroundStyle,'u8')});
  const snapshot=()=>({health:Object.fromEntries(parts.map(name=>{
    const part=read(hit,name);return [name,{health:part[`deusex.hudhitdisplay.bodypart.lasthealth`],
      displayedHealth:part[`deusex.hudhitdisplay.bodypart.displayedhealth`],
      color:tile(part[`deusex.hudhitdisplay.bodypart.partwindow`]).color}];})),
    energy:read(hit,'energyPercent'),underwater:read(hit,'bUnderwater'),
    compass:{north:read(compass,'mapNorth'),yaw:read(compass,'lastPlayerYaw'),
      drawPos:read(compass,'drawPos'),wrapPos:read(compass,'wrapPos')},textures:images.size});
  return {hit,compass,cross,windows,children,images,read,rect,tile,visible,background,scoped,invoke,snapshot,
    decorationCommands,
    tick(delta){scoped(()=>{invoke(hit,'Tick',[delta]);invoke(compass,'Tick',[delta]);});},
    reset(){scoped(()=>{for(const name of parts){const part=read(hit,name);
      for(const key of Object.keys(part))if(!key.endsWith('.partwindow'))part[key]=0;
      write(hit,name,part);}
      write(hit,'bUnderwater',false);write(compass,'lastPlayerYaw',0);
      for(const name of ['winCompass1','winCompass2'])invoke(read(compass,name),'SetPos',[0,0]);});},
  };
}
