/** XTextLogWindow AddLog/ClearLog/UpdateText/ConfigurationChanged/Tick/Draw.
 * Extension.dll bodies 100476a0, 10047810, 10047dc0, 10047910, 10047c30,
 * 10047a10 respectively. FString allocation is host storage; its text value
 * and native row timeout/color live in the shared byte-addressed heap. */
import {O,c0,c3} from './script-window-tree-natives.mjs';
import {gcSetAlignments} from './script-gc-set-alignments.mjs';
import {gcEnableWordWrap} from './script-gc-enable-word-wrap.mjs';
import {gcSetTextColor} from './script-gc-set-text-color.mjs';
import {gcDrawText} from './script-gc-draw-text.mjs';
import {f32Bits} from './script-gc-draw-model.mjs';
const f=Math.fround;
const row=(W,win,i)=>W.u32(win,0x178)+20*i;
function updateText(W,win){
 const lines=[];for(let i=0;i<W.i32(win,0x17c);i++)lines.push(W.heap.read(row(W,win,i),4,'string'));
 W.heap.write(win,0x168,'string',lines.join('\n'));
 W.native.askParentForReconfigure(win);
}
export function addLog(W,win,text,color){
 const i=W.farray.add(win,0x178,1,20),at=row(W,win,i);
 W.setF32(at,0,W.tickOffset()+W.f32(win,0x174));
 W.heap.write(at,4,'string',text);W.setU32(at,16,color);updateText(W,win);
}
export function clearLog(W,win){W.farray.empty(win,0x178,20);updateText(W,win);}
export function textLogConfigurationChanged(W,win){
 const gc=W.gc.get(win);
 if(gc){const size=W.gc.textExtent(gc,f(W.f32(win,O.width)-2*W.f32(win,0x154)),W.heap.read(win,0x168,'string'));
  const overflow=c0(W.f32(win,O.height)-2*W.f32(win,0x158),size.height);
  W.setU32(win,0x184,(W.u32(win,0x184)&~1)|(overflow?1:0));W.gc.release(win,gc);}
 W.processScript(win,'ConfigurationChanged',[]);
}
export function textLogTick(W,win,delta){
 if(W.u8(win,0x184)&4)return;
 const count=W.i32(win,0x17c);
 for(let i=0;i<count;i++){const at=row(W,win,i);W.setF32(at,0,W.f32(at,0)-delta);}
 let n=0;while(n<count){const timeout=W.f32(row(W,win,n),0);if(!c0(timeout,0)&&!c3(timeout,0))break;n++;}
 if(n){W.farray.remove(win,0x178,0,n,20);updateText(W,win);}
}
export function textLogDraw(W,win,gc){
 const s=W.gc.services,overflow=Boolean(W.u8(win,0x184)&1),count=W.i32(win,0x17c);
 gcSetAlignments(gc,W.u8(win,0x14c),overflow?2:W.u8(win,0x14d),s);gcEnableWordWrap(gc,1,s);
 let y=W.f32(win,0x158);const x=W.f32(win,0x154),width=f(W.f32(win,O.width)-2*x),height=f(W.f32(win,O.height)-2*y);
 for(let i=overflow?count-1:0;i>=0&&i<count;i+=overflow?-1:1){
  const at=row(W,win,i),text=W.heap.read(at,4,'string');W.heap.write(win,0x168,'string',text);
  const size=W.gc.textExtent(gc,width,text);gcSetTextColor(gc,W.u32(at,16),s);
  gcDrawText(gc,...[x,y,width,height].map(f32Bits),text,s);
  y=f(overflow?y-size.height:y+size.height);
 }
}
