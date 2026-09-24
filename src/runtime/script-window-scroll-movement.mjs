/** Original Extension scroll movement. Evidence: docs/script-window-scroll-movement.md. */
import * as C from './script-window-scroll-children.mjs';
import {clipChild} from './script-window-scroll-layout.mjs';
import {x87load as X,x87int32 as I,x87add as A,x87neg as N,x87mul as M,x87div as D,x87store as S} from './script-vm.mjs';
const sub=(a,b)=>A(a,N(b));
const script=(W,win,event,args)=>W.processScript(win,event,args,{result:false});
export function tickToValue(W,win,tick){
  const n=(W.i32(win,0x1c4)-((W.u8(win,0x164)&16)?0:1))|0;
  const lo=X(W.f32(win,0x1d4)),delta=sub(X(W.f32(win,0x1d8)),lo);
  return A(lo,n>0?D(M(delta,I(tick)),I(n)):M(delta,X(0.5)));
}
export function changeScalePosition(W,win,notify){
  const position=W.i32(win,0x1c8),range=Boolean(W.u8(win,0x164)&16);
  const end=range?(position+W.i32(win,0x1cc))|0:0;
  const value=S(tickToValue(W,win,position)),endValue=range?S(tickToValue(W,win,end)):0;
  for(let ancestor=win;ancestor;ancestor=W.ptr(ancestor,0x138)){
    const handled=range?W.v.scaleRangeChanged(ancestor,win,position,end,value,endValue,notify):
      W.v.scalePositionChanged(ancestor,win,position,value,notify);
    if(handled)return;
  }
}
export function setTickPosition(W,win,position){C.changeThumbPosition(W,win,position,0,1);}
export function moveThumb(W,win,mode){
  const pos=W.i32(win,0x1c8),step=W.i32(win,0x1d0),span=W.u8(win,0x164)&16?W.i32(win,0x1cc):4;
  const next=[0,W.i32(win,0x1c4),(pos-1)|0,(pos+1)|0,(pos-step)|0,(pos+step)|0,(pos-span)|0,(pos+span)|0];
  C.changeThumbPosition(W,win,next[mode|0]??0,0,1);
}
export function setClipPosition(W,win,col,row){
  col|=0;row|=0;
  if(W.i32(win,0x174)===col&&W.i32(win,0x178)===row)return;
  W.setI32(win,0x174,col);W.setI32(win,0x178,row);
  const child=clipChild(W,win);if(!child)return;
  const flags=W.u32(win,0x184);
  let x=flags&1?0:S(M(N(X(W.f32(win,0x198))),I(W.i32(win,0x174))));
  let y=flags&2?0:S(M(N(X(W.f32(win,0x19c))),I(W.i32(win,0x178))));
  const clamp=(position,view,extent)=>{
    const limit=sub(X(view),X(extent));
    // The original compares retained viewport-content before storing it.
    const d=sub(limit,X(position));if(d.nan===undefined&&!d.neg&&Boolean(d.inf||d.sig))position=S(limit);
    if(position>0)position=0;return position;
  };
  x=clamp(x,W.f32(win,0x80),W.f32(child,0x80));y=clamp(y,W.f32(win,0x84),W.f32(child,0x84));
  const saved=W.global('global100aeafc');W.setGlobal('global100aeafc',win);
  W.native.configureChild(child,x,y,W.f32(child,0x80),W.f32(child,0x84));
  W.setGlobal('global100aeafc',saved);
  for(let ancestor=win;ancestor;ancestor=W.ptr(ancestor,0x138))
    if(W.v.clipPositionChanged(ancestor,win,W.i32(win,0x174),W.i32(win,0x178)))return;
}
export function scrollScaleRange(W,win,source,start,end,startValue,endValue,notify){
  let result=script(W,win,'ScaleRangeChanged',[source,start,end,startValue,endValue,notify]);
  const clip=W.ptr(win,0x16c);if(!clip)return result;
  let col=W.i32(clip,0x174),row=W.i32(clip,0x178);
  if(source===W.ptr(win,0x154)){col=start;result=true;}
  else if(source===W.ptr(win,0x158)){row=start;result=true;}
  setClipPosition(W,W.ptr(win,0x16c),col,row);return result;
}
export function scrollClipPosition(W,win,source,col,row){
  const result=script(W,win,'ClipPositionChanged',[source,col,row]);
  if(source!==W.ptr(win,0x16c))return result;
  let scale=W.ptr(win,0x154);if(scale)setTickPosition(W,scale,col);
  scale=W.ptr(win,0x158);if(scale)setTickPosition(W,scale,row);
  return true;
}
export function managerButtonActivated(W,win,source){
  const result=script(W,win,'ButtonActivated',[source]),scale=W.ptr(win,0x158);
  if(!scale)return result;
  if(source===W.ptr(win,0x150)){moveThumb(W,scale,5);return true;}
  if(source===W.ptr(win,0x14c)){moveThumb(W,scale,4);return true;}
  return result;
}
export function managerScalePosition(W,win,source,position,value,notify){
  const result=script(W,win,'ScalePositionChanged',[source,position,value,notify]);
  if(source===W.ptr(win,0x158)&&W.ptr(win,0x154)&&W.ptr(win,0x158)){
    const text=W.native.getScaleValueString(W.ptr(win,0x158));
    W.v.setText(W.ptr(win,0x154),text);
  }
  return result;
}
export function scrollMousePressed(W,win,x,y,key,count){
  const result=script(W,win,'MouseButtonPressed',[x,y,key&255,count]);
  if(key!==236&&key!==237)return result;
  const scale=W.ptr(win,0x158);if(!scale)return true;
  for(let ancestor=scale;ancestor;ancestor=W.ptr(ancestor,0x138))if(!(W.u8(ancestor,0x30)&1))return true;
  moveThumb(W,W.ptr(win,0x158),key===236?4:5);return true;
}
