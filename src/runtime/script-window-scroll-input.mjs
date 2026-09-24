/** Original Scale input/repeat bodies; docs/script-window-scroll-input.md. */
import {changeThumbPosition} from './script-window-scroll-children.mjs';
import {moveThumb,changeScalePosition} from './script-window-scroll-movement.mjs';
import {getRootWindow} from './script-window-tree-natives.mjs';
import {x87load as X,x87int32 as I,x87add as A,x87neg as N,x87mul as M,x87div as D,x87store as S,x87ftol as F} from './script-vm.mjs';
const sub=(a,b)=>A(a,N(b));
const lt=(a,b)=>{
 if(a.nan!==undefined||b.nan!==undefined)return true;
 if(a.inf||b.inf){if(a.inf&&b.inf)return Boolean(a.neg&&!b.neg);return a.inf?Boolean(a.neg):!b.neg;}
 const d=sub(a,b);return Boolean(d.neg&&d.sig);
};
const le=(a,b)=>lt(a,b)||(!lt(b,a));
export function pixelToTick(W,win,pixel){
 let count=W.i32(win,0x1c4),length=sub(X(W.f32(win,0x254)),X(W.f32(win,0x250)));
 if(W.u8(win,0x164)&16){count=(count-W.i32(win,0x1cc))|0;length=sub(A(length,I(1)),X(W.f32(win,W.u8(win,0x14c)===1?0x21c:0x218)));}
 else count=(count-1)|0;
 if(lt(length,I(1)))length=I(1);
 return F(A(D(M(sub(X(pixel),X(W.f32(win,0x250))),I(count)),length),X(0.5)));
}
export function playScaleSound(W,win,sound,volume=-1,pitch=1){
 const y=S(A(M(X(W.f32(win,0x21c)),X(0.5)),X(W.f32(win,0x214))));
 const x=S(A(M(X(W.f32(win,0x218)),X(0.5)),X(W.f32(win,0x210))));
 W.native.playSound(win,sound,volume,pitch,x,y);
}
const sound=(W,w,off)=>playScaleSound(W,w,W.ptr(w,off));
export function scaleMousePressed(W,win,x,y,key,count){
 const result=W.processScript(win,'MouseButtonPressed',[x,y,key&255,count],{result:false});
 if(key!==1)return result;
 const read=off=>X(W.f32(win,off));
 const inside=!lt(X(x),read(0x210))&&!le(A(read(0x210),read(0x218)),X(x))&&
  !lt(X(y),read(0x214))&&!le(A(read(0x214),read(0x21c)),X(y));
 if(inside){
  W.setU32(win,0x258,W.u32(win,0x258)|1);W.setI32(win,0x1f0,W.i32(win,0x1c8));
  W.setF32(win,0x25c,subStore(W.u8(win,0x14c)===1?y:x,W.f32(win,W.u8(win,0x14c)===1?0x214:0x210)));
  sound(W,win,0x1f8);
 }else if(W.u8(win,0x164)&16){
  const vertical=W.u8(win,0x14c)===1;
  W.setU8(win,0x260,lt(X(vertical?y:x),read(vertical?0x214:0x210))?2:1);
  moveThumb(W,win,W.u8(win,0x260)===2?6:7);sound(W,win,0x1f4);
  const timer=A(X(W.tickOffset()),read(0x1e8));W.setF32(win,0x264,S(timer));
  if(le(timer,I(0)))W.setF32(win,0x264,W.f32(win,0x1ec));
  if(le(read(0x264),I(0)))W.setU8(win,0x260,0);
 }else{
  W.setI32(win,0x1f0,W.i32(win,0x1c8));W.setU32(win,0x258,W.u32(win,0x258)|1);
  changeThumbPosition(W,win,pixelToTick(W,win,W.u8(win,0x14c)===1?y:x),0,0);sound(W,win,0x1f4);
 }
 return true;
}
const subStore=(a,b)=>S(sub(X(a),X(b)));
export function scaleMouseMoved(W,win,x,y){
 W.processScript(win,'MouseMoved',[x,y]);if(!(W.u8(win,0x258)&1))return;
 let pixel=W.u8(win,0x14c)===1?y:x;
 if(W.u8(win,0x164)&16)pixel=subStore(pixel,W.f32(win,0x25c));
 const before=W.i32(win,0x1c8);changeThumbPosition(W,win,pixelToTick(W,win,pixel),0,0);
 if(before!==W.i32(win,0x1c8))sound(W,win,0x1fc);
}
export function scaleMouseReleased(W,win,x,y,key,count){
 const result=W.processScript(win,'MouseButtonReleased',[x,y,key&255,count],{result:false});if(key!==1)return result;
 if((W.u8(win,0x258)&1)&&W.i32(win,0x1c8)!==W.i32(win,0x1f0)){changeScalePosition(W,win,1);sound(W,win,0x1f4);}
 const flags=W.u32(win,0x258);W.setU8(win,0x260,0);W.setU32(win,0x258,flags&~1);return true;
}
export function scaleTick(W,win,delta){
 if(!W.u8(win,0x260))return;
 const read=off=>X(W.f32(win,off)),timer=sub(read(0x264),X(delta));W.setF32(win,0x264,S(timer));
 if(!lt(timer,I(0)))return;
 const {x,y}=W.native.getCursorPos(win);
 if(!lt(X(x),I(0))&&lt(X(x),read(0x80))&&!lt(X(y),I(0))&&lt(X(y),read(0x84))){
  const vertical=W.u8(win,0x14c)===1,pixel=X(vertical?y:x),off=vertical?0x214:0x210,before=W.i32(win,0x1c8);
  if(lt(pixel,read(off))&&W.u8(win,0x260)===2)moveThumb(W,win,6);
  // Original horizontal branch also reads +21c (height), not +218.
  if(le(A(read(off),read(0x21c)),pixel)&&W.u8(win,0x260)===1)moveThumb(W,win,7);
  if(before!==W.i32(win,0x1c8))sound(W,win,0x1f4);
 }
 const next=A(read(0x1ec),read(0x264));W.setF32(win,0x264,S(next));
 if(lt(next,I(0)))W.setF32(win,0x264,Math.fround(0.05));
}
export function getCursorPos(W,win){
 const root=getRootWindow(W,win);
 if(!root)return W.boundary('Scale repeat on a detached window has undefined cursor outputs');
 return {x:subStore(W.f32(root,0x590),W.f32(win,0xd4)),y:subStore(W.f32(root,0x594),W.f32(win,0xd8))};
}
