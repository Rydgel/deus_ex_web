/** Original Clip.ChildRequestedShowArea; docs/script-window-scroll-show-area.md. */
import {queryGranularity} from './script-window-tree-natives.mjs';
import {setClipPosition} from './script-window-scroll-movement.mjs';
import {x87load as X,x87add as A,x87neg as N,x87div as D,x87store as S,x87ftol as F} from './script-vm.mjs';
const sub=(a,b)=>A(a,N(b));
// FISTP dword, default nearest-even control word; unlike _ftol, overflow yields
// the integer-indefinite value instead of keeping a 64-bit result's low dword.
function nearestInt(v){
 if(v.nan!==undefined||v.inf)return -2147483648;
 let n=v.sig;
 if(v.exp>=0)n<<=BigInt(v.exp);
 else{
  const shift=BigInt(-v.exp),unit=1n<<shift,half=unit>>1n,remainder=n&(unit-1n);
  n>>=shift;if(remainder>half||(remainder===half&&(n&1n)))n++;
 }
 if(v.neg)n=-n;
 return n < -2147483648n||n>2147483647n?-2147483648:Number(n);
}
export function clipShowArea(W,win,source,x,y,width,height){
 const units=source&&(W.u8(win,0x184)&4)?queryGranularity(W,source):{h:1,v:1};
 W.setF32(win,0x198,units.h);W.setF32(win,0x19c,units.v);
 if(!(units.h>0&&units.v>0))return;
 x=S(A(X(x),X(Math.fround(0.005))));y=S(A(X(y),X(Math.fround(0.005))));
 width=S(sub(X(width),X(Math.fround(0.01))));height=S(sub(X(height),X(Math.fround(0.01))));
 const first=(pos,unit)=>nearestInt(sub(X(S(D(X(pos),X(unit)))),X(0.5)));
 const last=(pos,extent,unit)=>F(X(Math.ceil(S(D(A(X(pos),X(extent)),X(unit))))));
 const col=first(x,units.h),colSpan=(last(x,width,units.h)-col)|0;
 const row=first(y,units.v),rowSpan=(last(y,height,units.v)-row)|0;
 const select=(position,start,span,visible)=>{
  const relative=(start-position)|0,room=(visible-span)|0;
  if(visible>=span){if(relative>room)return (position+((span-visible+relative)|0))|0;if(relative<0)return (position+relative)|0;}
  else{if(relative<room)return (position+((span-visible+relative)|0))|0;if(relative>0)return (position+relative)|0;}
  return position;
 };
 setClipPosition(W,win,select(W.i32(win,0x174),col,colSpan,W.i32(win,0x188)),select(W.i32(win,0x178),row,rowSpan,W.i32(win,0x18c)));
}
