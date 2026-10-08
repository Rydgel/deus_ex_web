/** Original DeusExHUD tree driven by recovered Extension native layout/GC.
 * InfoLink is part of the same native window tree. */
import {TextureStore} from '../unreal/textures.mjs';
import {inRenderPass} from './render-precision.mjs';
const parts=['head','torso','armLeft','armRight','legLeft','legRight'];
const deref=value=>value?.reference?value.get():value;
export const hudColor=value=>['r','g','b'].map(key=>value[`core.object.color.${key}`]);
const unpack=value=>[value&255,(value>>>8)&255,(value>>>16)&255];
export async function createPlayHud({runtime,assets,player,shell,host}){
  if(!host?.root||!host?.hud)throw new Error('Play HUD requires the original initialized window host');
  const read=(object,name)=>runtime.readNamed(object,name);
  const invoke=(object,name,args=[])=>runtime.callFunction(runtime.lookup(object,name),object,args.length,i=>args[i]);
  const scoped=callback=>callback();
  let root=host.root,hud=host.hud,hit=read(hud,'hit'),compass=read(hud,'compass'),cross=read(hud,'cross');
  const images=new Map(),pending=new Map(),store=new TextureStore(assets);
  async function imageFor(ref){
    if(!ref)return null;if(images.has(ref.key))return images.get(ref.key);
    if(!pending.has(ref.key))pending.set(ref.key,(async()=>{
      const data=await store.get(ref.asset,ref.index,'point'),image={key:ref.key,...data.mips[0]};images.set(ref.key,image);return image;
    })());return pending.get(ref.key);
  }
  const gc={};runtime.attach(gc,host.classes.get('extension.gc'));
  function decorationCommands(object,post=false){
    const commands=[];
    scoped(()=>{
      const native=runtime.native,boundaries=runtime.boundaryNatives;
      runtime.boundaryNatives=new Set([...boundaries,1212,1230,1284,1289]);
      let style=1,color=[255,255,255];
      runtime.native=call=>{
        if(![1212,1230,1284,1289].includes(call.index))return native(call);
        const args=Array.from({length:call.argumentCount},(_,i)=>deref(call.evaluateArgument(i)));
        if(call.index===1212)style=args[0];
        else if(call.index===1230)color=hudColor(args[0]);
        else if(call.index===1284){const [x,y,width,height,u,v,texture]=args;
          commands.push({x,y,width,height,u,v,texture:texture.key,style,color});}
        else if(call.index===1289){const [x,y,width,height,l,r,t,b,borders]=args;
          if(l||r||t||b||args[9]||args[10])throw new Error('HUD border margin/stretch path is not bound');
          commands.push({x,y,width,height,borders,style,color});}
      };
      try{if(post)invoke(object,'PostDrawBackground',[gc]);
        else{invoke(object,'DrawBackground',[gc]);invoke(object,'DrawBorder',[gc]);}}
      finally{runtime.native=native;runtime.boundaryNatives=boundaries;}
    });return commands;
  }
  const raw=host.raw.read;
  const rect=object=>({x:raw(object,0x78,'f32'),y:raw(object,0x7c,'f32'),width:raw(object,0x80,'f32'),height:raw(object,0x84,'f32')});
  const tile=object=>({color:unpack(raw(object,0x60,'u32')),style:raw(object,0x3c,'u8')});
  const visible=object=>Boolean(raw(object,0x30,'u32')&1);
  const snapshot=()=>({native:true,health:Object.fromEntries(parts.map(name=>{
    const part=read(hit,name);return [name,{health:part['deusex.hudhitdisplay.bodypart.lasthealth'],displayedHealth:part['deusex.hudhitdisplay.bodypart.displayedhealth'],color:tile(part['deusex.hudhitdisplay.bodypart.partwindow']).color}];})),
    belt:read(read(hud,'belt'),'objects').map(slot=>read(slot,'item')?.name??null),energy:read(hit,'energyPercent'),compass:{yaw:read(compass,'lastPlayerYaw'),drawPos:read(compass,'drawPos'),wrapPos:read(compass,'wrapPos')},textures:images.size});
  // Decode native resources already reached by construction; new inventory
  // textures are loaded when their original DrawWindow submits them.
  await Promise.all([...host.resourceImages.values()].filter(r=>r.kind==='texture').map(r=>imageFor(r.ref)));
  return {runtime,shell,host,read,invoke,scoped,rect,tile,visible,images,imageFor,decorationCommands,snapshot,
    get player(){return player;},get root(){return root;},get hud(){return hud;},
    get hit(){return hit;},get compass(){return compass;},get cross(){return cross;},
    bindPlayer(next){
      runtime.instance(next);
      if(!host.root||!host.hud)throw new Error('Play HUD requires the new initialized root and HUD');
      player=next;root=host.root;hud=host.hud;
      hit=read(hud,'hit');compass=read(hud,'compass');cross=read(hud,'cross');
    },
    // PreRenderWindows (the PreRender event) and PostRenderWindows' paint
    // (PostRenderFlash) run inside the render pass, at x87 precision control
    // 24 (render-precision.mjs); Galaxy's Update (game.mjs) stays outside.
    commands(width,height,view){return inRenderPass(runtime,()=>scoped(()=>host.draw(root,width,height,view)));},
    renderViewport(width,height){return scoped(()=>host.renderViewport(root,width,height));},
    tick(delta){scoped(()=>host.tick(root,delta));},
    key(key,action){return scoped(()=>host.key(root,key,action));},
    inputEvent(key,action,options){return scoped(()=>host.inputEvent(key,action,options));},
    pointer(sample){return scoped(()=>host.pointer(root,sample));},
    reset(){scoped(()=>invoke(read(read(hud,'msgLog'),'winLog'),'ClearLog'));},
  };
}
