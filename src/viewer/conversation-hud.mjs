import {WINDOW_TEXT_OFFSETS as T} from '../runtime/script-window-text.mjs';
import {layoutTileDown} from '../runtime/script-window-tile.mjs';
import {WINDOW_DESTROY_OFFSETS as W} from '../runtime/script-window-destroy.mjs';
const color=v=>[v&255,(v>>>8)&255,(v>>>16)&255];
/** Selected native layout driven by the live original Window tree. */
export function conversationHudFrame(runtime,player,shell,width,height,measure){
  const get=(o,k)=>runtime.namedReference(o,k).get(),read=shell.readNative;
  const play=get(player,'conPlay');if(!play)return null;
  const window=get(play,'conWinFirst');if(!window||shell.isDestroyed(window))return null;
  if(!(read(window,W.windowFlags,'u32')&1))return null;
  const tile=get(window,'lowerConWindow'),children=[];
  if(read(tile,0x14c,'u8')!==1||read(tile,0x14d,'u8')!==0||read(tile,0x14e,'u8')!==0||
    read(tile,0x160,'u8')!==3||read(tile,0x161,'u8')!==0||(read(tile,0x164,'u32')&15)!==2)
    throw new Error('Conversation TileWindow layout configuration is not recovered');
  const margins={horizontalMargin:read(tile,0x150,'f32'),verticalMargin:read(tile,0x154,'f32'),spacing:read(tile,0x158,'f32')};
  const w=Math.min(width-100,800),inner=Math.max(0,w-2*margins.horizontalMargin);
  for(let child=read(tile,W.firstChild,'ptr');child;child=read(child,W.nextSibling,'ptr')){
    if(!(read(child,W.windowFlags,'u32')&1))continue;
    const cls=runtime.instance(child).cls.record.key;
    if(cls==='extension.textwindow'){
      if(read(child,T.minLines,'i32')!==-1||read(child,T.maxLines,'i32')!==-1)
        throw new Error('Conversation text line limits are not recovered');
      const mx=read(child,T.horizontalMargin,'f32'),my=read(child,T.verticalMargin,'f32');
      const text=read(child,T.text,'string'),font=read(child,T.normalFont,'ptr').key;
      const wrap=Boolean(read(child,T.textFlags,'u32')&1);
      const extent=measure({font,text,width:wrap?inner-2*mx:0});
      children.push({object:child,text,font,mx,my,height:extent.yExtent+2*my,
        color:color(read(child,T.packedTextColor,'u32')),hAlign:read(child,T.horizontalAlignment,'u8'),
        vAlign:read(child,T.verticalAlignment,'u8'),wrap});
    }else if(cls==='extension.window')children.push({object:child,height:read(child,0xa0,'f32')});
    else throw new Error(`Conversation child layout is not recovered: ${cls}`);
  }
  const layout=layoutTileDown(w,children.map(c=>c.height),margins);
  const h=Math.max(get(window,'minHeight'),layout.height),x=(width-w)/2,y=height-h-20;
  // The bounded renderer owns screen placement; full native ConfigureChild
  // also needs the as-yet unsupported bounds/list reconfiguration tree.
  shell.withLifecycle(()=>runtime.callFunction(runtime.lookup(window,'SetSize'),window,2,i=>[w,h][i]));
  return {window,x,y,width:w,height:h,children:children.map((c,i)=>({...c,...layout.rects[i]}))};
}
