/** Original XComputerWindow tick/queue/paint bodies.
 * Evidence and bounded unsupported branches: docs/script-window-computer-playback.md. */
import {COMPUTER_WINDOW_OFFSETS as O} from './script-window-computer.mjs';
import {x87load as X, x87int32 as I, x87add as A, x87neg as N, x87mul as M,
  x87div as D, x87store as S, x87ftol as T, x87cmp} from './script-vm.mjs';
import {gcSetFonts} from './script-gc-set-fonts.mjs';
import {gcSetStyle} from './script-gc-set-style.mjs';
import {gcSetTileColor} from './script-gc-set-tile-color.mjs';
import {gcSetTextColor} from './script-gc-set-text-color.mjs';
import {gcDrawText} from './script-gc-draw-text.mjs';
import {gcDrawIcon} from './script-gc-draw-icon.mjs';
import {gcDrawPattern} from './script-gc-draw-pattern.mjs';
import {f32Bits} from './script-gc-draw-model.mjs';
import {windowPlaySound} from './script-window-sound.mjs';

const sub=(a,b)=>A(a,N(b)), gt=(a,b)=>x87cmp(a,b)==='gt';
const lt=(a,b)=>['lt','un'].includes(x87cmp(a,b));
const eq=(a,b)=>['eq','un'].includes(x87cmp(a,b));
const rec=(W,win,off,i)=>W.u32(win,off)+i*32;
const read=(W,p,off,kind='u32')=>W.heap.mem.read(p+off,kind);
const write=(W,p,off,kind,value)=>W.heap.mem.write(p+off,kind,value);

/** 1000ee70, after the original script event. */
export function computerVisibilityChanged(W,win,visible){
  W.processScript(win,'VisibilityChanged',[Boolean(visible)]);
  if(visible&&!(W.u32(win,O.flags)&8))W.setU32(win,O.flags,W.u32(win,O.flags)|4);
}
function bubble(W,win,event,handled){
  for(let at=win;at;at=W.ptr(at,0x138)){
    if(W.processScript(at,event,[],{result:handled?false:undefined})&&handled)break;
  }
}
/** 1000eaf0. */
export function computerScroll(W,win){
  for(let i=W.i32(win,O.displayBuffer+4)-1;i>=0;i--){
    const p=rec(W,win,O.displayBuffer,i),type=read(W,p,0),off=type===0?0x14:type===5?0x10:null;
    if(off===null)continue;
    const row=(read(W,p,off,'i32')-1)|0;write(W,p,off,'i32',row);
    if(row<0)W.farray.remove(win,O.displayBuffer,i,1,32);
  }
}
function newline(W,win){
  W.setI32(win,O.textX,0);W.setI32(win,O.textY,W.i32(win,O.textY)+1);
  if(W.i32(win,O.textY)===W.i32(win,O.textRows)){
    W.setI32(win,O.textY,W.i32(win,O.textY)-1);computerScroll(W,win);
  }
}
/** 10010710. The reference index is restored after the word scan. */
export function computerCharPosition(W,win,index){
  const p=rec(W,win,O.queuedBuffer,index);
  if(read(W,p,0x10,'i32')!==-1)return {show:true,x:0,y:0};
  let x=W.i32(win,O.textX),wrap=false;
  if(W.u32(win,O.flags)&1){
    if(x===0&&read(W,p,8,'u16')===32)return {show:false};
    W.setU32(win,O.flags,W.u32(win,O.flags)&~2);wrap=true;
    if(x<W.i32(win,O.textCols)){
      for(let scan=index;;scan++){
        if(scan===W.i32(win,O.queuedBuffer+4)){wrap=false;break;}
        const q=rec(W,win,O.queuedBuffer,scan);
        if(read(W,q,0)!==0||read(W,q,0x10,'i32')!==-1||read(W,q,8,'u16')===32){wrap=false;break;}
        x=(x+1)|0;if(x>=W.i32(win,O.textCols))break;
      }
    }
  }
  x=W.i32(win,O.textX);
  if(wrap||((x+1)|0)===W.i32(win,O.textCols)){
    newline(W,win);W.setU32(win,O.flags,W.u32(win,O.flags)|2);
    if(read(W,p,8,'u16')===32)return {show:false};
    W.setI32(win,O.textX,W.i32(win,O.textX)+1);
    return {show:true,x:0,y:W.i32(win,O.textY)};
  }
  const result={show:true,x,y:W.i32(win,O.textY)};
  W.setU32(win,O.flags,W.u32(win,O.flags)&~2);W.setI32(win,O.textX,x+1);
  return result;
}
function sound(W,win,value){
  const fw=W.i32(win,O.fontWidth),fh=W.i32(win,O.fontHeight);
  const x=S(A(I(Math.imul(W.i32(win,O.textX),fw)),M(I(fw),X(.5))));
  const y=S(A(I(Math.imul(W.i32(win,O.textY),fh)),M(I(fh),X(.5))));
  windowPlaySound(W,win,value,W.f32(win,0x114),1,x,y);
}
/** 1000fe20. Input/graphic-position branches are explicitly outside InfoLink. */
export function computerProcessQueue(W,win){
  for(let i=W.i32(win,O.queuedBufferStart);i<W.i32(win,O.queuedBuffer+4);i++){
    const p=rec(W,win,O.queuedBuffer,i);
    if(!gt(X(W.f32(win,O.timeCurrent)),X(read(W,p,4,'f32'))))break;
    switch(read(W,p,0)){
      case 0:{
        W.setU32(win,O.cursorFlags,W.u32(win,O.cursorFlags)|1);
        W.setU32(win,O.cursorNextEvent,W.u32(win,O.cursorBlinkSpeed));
        const pos=computerCharPosition(W,win,i);
        if(pos.show){
          const n=W.farray.add(win,O.displayBuffer,1,32),q=rec(W,win,O.displayBuffer,n);
          W.heap.copyBytes(q,p,32);write(W,q,0xa,'u32',W.u32(win,O.fontColor));
          write(W,q,4,'u32',read(W,q,0x18)&1?0:W.u32(win,O.fadeSpeed));
          write(W,q,0x10,'i32',pos.x);write(W,q,0x14,'i32',pos.y);
        }
        if(W.ptr(win,O.textSound))sound(W,win,W.ptr(win,O.textSound));
        break;
      }
      case 1:W.setU32(win,O.fontColor,read(W,p,8));break;
      case 2:W.setU32(win,O.textSound,read(W,p,8));break;
      case 3:W.setI32(win,O.textX,read(W,p,8,'i32'));W.setI32(win,O.textY,read(W,p,12,'i32'));break;
      case 4:newline(W,win);break;
      case 5:W.boundary('XComputerWindow graphic queue positioning 0x10010990 is not translated');break;
      case 6:
        W.setU32(win,O.inputFlags,W.u32(win,O.inputFlags)&~1);W.farray.empty(win,O.displayBuffer,32);
        W.setI32(win,O.textX,0);W.setI32(win,O.textY,0);break;
      case 7:sound(W,win,read(W,p,8,'ptr'));break;
      case 9:case 10:W.boundary('XComputerWindow terminal input queue processing is not translated');break;
      case 11:W.setU32(win,O.fadeOutStart,read(W,p,8));W.setU32(win,O.fadeOutTimer,read(W,p,8));break;
    }
    W.setI32(win,O.queuedBufferStart,W.i32(win,O.queuedBufferStart)+1);
  }
  if(W.i32(win,O.queuedBufferStart)===4096){
    W.farray.remove(win,O.queuedBuffer,0,4096,32);W.setI32(win,O.queuedBufferStart,0);
  }
}
/** 1000f7b0; every x87 fst/fstp is represented by S, retaining ST on fst. */
export function computerTick(W,win,delta){
  delta=Math.fround(delta);
  if(W.u32(win,O.inputFlags)&8)return;
  if(W.u32(win,O.flags)&16){W.setU32(win,O.flags,W.u32(win,O.flags)&~16);return;}
  if(!(W.u32(win,O.inputFlags)&32)){
    const pauser=W.computerPauser(W.ptr(win,O.player));
    const paused=pauser.length!==0&&pauser.charCodeAt(0)!==0;
    if(paused&&!(W.u32(win,O.inputFlags)&16)){
      W.setU32(win,O.inputFlags,W.u32(win,O.inputFlags)|20);return;
    }
    if(!paused&&(W.u32(win,O.inputFlags)&16))W.setU32(win,O.inputFlags,W.u32(win,O.inputFlags)&~20);
  }
  if(W.u32(win,O.flags)&4){
    W.setU32(win,O.flags,(W.u32(win,O.flags)&~4)|8);bubble(W,win,'ComputerStart',true);
  }
  const inputFlags=W.u32(win,O.inputFlags);
  if(inputFlags&16)return;
  if(gt(X(W.f32(win,O.cursorBlinkSpeed)),X(0))){
    const cursor=sub(X(W.f32(win,O.cursorNextEvent)),X(delta));W.setF32(win,O.cursorNextEvent,S(cursor));
    if(lt(cursor,X(0))){
      W.setF32(win,O.cursorNextEvent,S(A(cursor,X(W.f32(win,O.cursorBlinkSpeed)))));
      W.setU32(win,O.cursorFlags,W.u32(win,O.cursorFlags)^1);
    }
  }
  if(!(inputFlags&4)){
    const current=A(M(X(delta),X(W.f32(win,O.throttle))),X(W.f32(win,O.timeCurrent)));
    W.setF32(win,O.timeCurrent,S(current));
    if(gt(sub(current,X(W.f32(win,O.timeLastEvent))),X(W.f32(win,O.eventTimeInterval))))
      W.setF32(win,O.timeNextEvent,S(A(current,X(W.f32(win,O.eventTimeInterval)))));
    computerProcessQueue(W,win);
    if(gt(X(W.f32(win,O.fadeOutTimer)),X(0))){
      let fade=sub(X(W.f32(win,O.fadeOutTimer)),X(delta));
      if(!lt(X(0),fade))fade=X(0);W.setF32(win,O.fadeOutTimer,S(fade));
      if(eq(fade,X(0)))bubble(W,win,'ComputerFadeOutCompleted',false);
    }
  }
  if(gt(X(W.f32(win,O.fadeSpeed)),X(0))){
    for(let i=0;i<W.i32(win,O.displayBuffer+4);i++){
      const p=rec(W,win,O.displayBuffer,i);write(W,p,4,'f32',S(sub(X(read(W,p,4,'f32')),X(delta))));
      if(lt(X(read(W,p,4,'f32')),X(0)))write(W,p,4,'u32',0);
    }
  }
}
export const COMPUTER_DRAW_OPS=Object.freeze({setFonts:gcSetFonts,setStyle:gcSetStyle,
  setTileColor:gcSetTileColor,setTextColor:gcSetTextColor,drawText:gcDrawText,drawIcon:gcDrawIcon,drawPattern:gcDrawPattern});
/** The raw f32 dword a cell coordinate becomes (f32Bits(S(I(v))) in x87 terms): fild of the int32 is exact in the extended
 * register, fstp to f32 rounds once to nearest even, which is Math.fround of the exact double. No x87 values: the HUD draws a
 * computer window one character at a time and each one took four of these (docs/live-heap.md "Cut: HUD step"). */
export const cellBits=v=>f32Bits(Math.fround(v));
/** 1000fae0. Native fixed-cell draw calls pass raw f32 dwords to the GC. */
export function computerDrawBuffer(W,win,gc,ops=COMPUTER_DRAW_OPS){
  const s=W.gc.services;ops.setFonts(gc,W.u32(win,O.textFont),W.u32(win,O.textFont),s);
  for(let i=0;i<W.i32(win,O.displayBuffer+4);i++){
    const p=rec(W,win,O.displayBuffer,i),type=read(W,p,0),fw=W.i32(win,O.fontWidth),fh=W.i32(win,O.fontHeight);
    if(type===5){
      ops.setTileColor(gc,W.u32(win,O.unknown1c8),s);
      const pixel=read(W,p,0x1c)&2,x=read(W,p,12,'i32'),y=read(W,p,16,'i32');
      ops.drawIcon(gc,cellBits(pixel?x:Math.imul(x,fw)),cellBits(pixel?y:Math.imul(y,fh)),read(W,p,8),s);
    }else if(type===0){
      let color=read(W,p,0xa),factor=null;
      // (an f32 against zero: gt(X(a),X(0)) is a>0, NaN included; the x87 values only where the fade runs)
      if(W.f32(win,O.fadeOutTimer)>0)factor=D(X(W.f32(win,O.fadeOutTimer)),X(W.f32(win,O.fadeOutStart)));
      else if(W.f32(win,O.fadeSpeed)>0&&read(W,p,4,'f32')>0)
        factor=D(sub(X(W.f32(win,O.fadeSpeed)),X(read(W,p,4,'f32'))),X(W.f32(win,O.fadeSpeed)));
      if(factor){
        let out=color&0xff000000;
        for(let c=0;c<3;c++)out|=(T(M(I((color>>>(c*8))&255),factor))&255)<<(c*8);
        color=out>>>0;
      }
      ops.setTextColor(gc,color,s);
      const ch=read(W,p,8,'u16');
      const cx=Math.imul(read(W,p,0x10,'i32'),fw),cy=Math.imul(read(W,p,0x14,'i32'),fh);
      ops.drawText(gc,cellBits(cx),cellBits(cy),cellBits(fw),cellBits(fh),ch?String.fromCharCode(ch):'',s);
    }
  }
  if(!W.u32(win,O.cursorTexture)||!W.ptr(win,O.inputWindow))return;
  let at=W.ptr(win,O.inputWindow);while(at&&(W.u8(at,0x30)&1))at=W.ptr(at,0x138);
  if(!at||(W.u32(win,O.cursorFlags)&3)!==3)return;
  ops.setStyle(gc,2,s);ops.setTileColor(gc,W.u32(win,O.cursorColor),s);
  const x=Math.imul(W.i32(win,O.textX),W.i32(win,O.fontWidth));
  const y=(Math.imul((W.i32(win,O.textY)+1)|0,W.i32(win,O.fontHeight))-W.i32(win,O.cursorHeight))|0;
  ops.drawPattern(gc,cellBits(x),cellBits(y),cellBits(W.i32(win,O.cursorWidth)),cellBits(W.i32(win,O.cursorHeight)),cellBits(0),cellBits(0),W.u32(win,O.cursorTexture),s);
}
/** 1000ed60. */
export function computerDraw(W,win,gc,ops=COMPUTER_DRAW_OPS){
  W.processScript(win,'DrawWindow',[gc]);ops.setStyle(gc,3,W.gc.services);
  if(W.u32(win,O.backgroundTextures))for(let i=0;i<6;i++)
    ops.drawIcon(gc,f32Bits((i%3)*256),f32Bits(i<3?0:256),W.u32(win,O.backgroundTextures+i*4),W.gc.services);
  computerDrawBuffer(W,win,gc,ops);
}
/** 1000d6d0 / 1000d780. XWindow::CleanUp follows in the host. */
export function computerCleanUp(W,win){
  W.setU32(win,O.inputFlags,(W.u32(win,O.inputFlags)|8)&~1);
  for(let i=0;i<W.i32(win,O.queuedBuffer+4);i++){
    const p=rec(W,win,O.queuedBuffer,i),type=read(W,p,0,'i32');
    if(type<9||type>10)continue;
    for(const off of [12,20]){const ptr=read(W,p,off);if(ptr){W.heap.freeRaw(ptr);write(W,p,off,'u32',0);}}
  }
  W.farray.empty(win,O.queuedBuffer,32);W.farray.empty(win,O.displayBuffer,32);
}
/** 10018fa8..100190e0, after ConditionalDestroy performed CleanUp. */
export function computerDestroyMembers(W,win){
  W.heap.write(win,O.inputMask,'string','');W.heap.write(win,O.inputKey,'string','');
  W.farray.empty(win,O.queuedBuffer,32);W.farray.empty(win,O.displayBuffer,32);
}
/** Read-only accessibility view of the original display buffer. */
export function computerDisplayedText(W,win){
  const rows=new Map();
  for(let i=0;i<W.i32(win,O.displayBuffer+4);i++){
    const p=rec(W,win,O.displayBuffer,i);if(read(W,p,0)!==0)continue;
    const y=read(W,p,20,'i32'),x=read(W,p,16,'i32');if(y<0||x<0)continue;
    const row=rows.get(y)??[];row[x]=String.fromCharCode(read(W,p,8,'u16'));rows.set(y,row);
  }
  return [...rows.entries()].sort((a,b)=>a[0]-b[0]).map(([,chars])=>Array.from(chars,c=>c??' ').join('').trimEnd()).join('\n');
}
