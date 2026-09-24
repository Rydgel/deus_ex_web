/** Extension Scale/ScaleManager/Clip recovered bodies. Evidence and gates:
 * docs/script-window-scroll-children.md. No fallback for unrecovered virtuals. */
import {x87load as X,x87int32 as I,x87add as A,x87neg as N,x87mul as M,x87div as D,x87store as S,x87ftol as T} from './script-vm.mjs';
const sub=(a,b)=>A(a,N(b)),add=(...v)=>v.map(X).reduce(A);
const below=(a,b)=>{
  if(a.nan!==undefined||b.nan!==undefined)return true;
  if(a.inf||b.inf){if(a.inf&&b.inf)return Boolean(a.neg&&!b.neg);return a.inf?Boolean(a.neg):!b.neg;}
  const d=sub(a,b);return Boolean(d.neg&&d.sig);
};
const positive=a=>a.nan===undefined&&!a.neg&&Boolean(a.inf||a.sig);
const f=Math.fround,nonnegative=v=>v>=0?f(v):0;
export const CHILD_VTABLES={scale:0x1005bab4,manager:0x1005bbd0,clip:0x1005aff0};
/** 0x10042480: script first, then clear the first live matching slot only.
 * Evidence: docs/script-window-scroll-removal.md. */
export function managerChildRemoved(W,win,child,processScript){
  processScript(win,'ChildRemoved',[child]);
  for(const off of [0x14c,0x150,0x158,0x154]){
    if(W.ptr(win,off)===child){W.setPtr(win,off,null);return;}
  }
}
export function constructScrollChild(W,win,family){
  W.uobjectConstructor(win);
  if(family==='scale')W.setU32(win,0,0x10059888);
  for(let off=0xd4;off<=0xe8;off+=4)W.setU32(win,off,0);
  if(family==='clip')for(let off=0x14c;off<=0x160;off+=4)W.setU32(win,off,0);
  if(family==='scale')for(let off=0x268;off<=0x270;off+=4)W.setU32(win,off,0);
  W.setU32(win,0,CHILD_VTABLES[family]);
}
export function initScaleManager(W,win,parent){
  W.initWindow(win,parent);
  for(let off=0x14c;off<=0x15c;off+=4)W.setU32(win,off,0);
  W.setU32(win,0x160,((W.u32(win,0x160)&~1)|2)>>>0);
  for(let off=0x164;off<=0x16c;off+=4)W.setU32(win,off,0);
  W.setU8(win,0x170,1);W.setU8(win,0x171,1);
}
export function initClip(W,win,parent){
  W.initTabGroup(win,parent);
  W.setI32(win,0x17c,-1);W.setI32(win,0x180,-1);
  W.setF32(win,0x198,1);W.setF32(win,0x19c,1);
  W.setU32(win,0x174,0);W.setU32(win,0x178,0);
  W.setU32(win,0x184,((W.u32(win,0x184)&~3)|12)>>>0);
  for(let off=0x188;off<=0x194;off+=4)W.setU32(win,off,0);
  W.setU32(win,0x164,(W.u32(win,0x164)&~4)>>>0);
}
export function initScale(W,win,parent){
  W.initWindow(win,parent);
  W.setU8(win,0x14c,0);
  for(let off=0x150;off<=0x160;off+=4)W.setU32(win,off,0);
  W.setU32(win,0x164,((W.u32(win,0x164)&0xffffffe4)|4)>>>0);
  W.setU32(win,0x16c,0);W.setU32(win,0x170,0);
  const white=((W.addressOf(parent)&0xff000000)|0xffffff)>>>0;
  for(const off of [0x174,0x178,0x17f,0x183,0x187])W.setU32(win,off,white);
  for(const off of [0x17c,0x17d,0x17e])W.setU8(win,off,2);
  for(let off=0x18c;off<=0x1c0;off+=4)W.setU32(win,off,0);
  W.setI32(win,0x1c4,10);W.setI32(win,0x1c8,0);W.setI32(win,0x1cc,1);W.setI32(win,0x1d0,1);
  W.setF32(win,0x1d4,0);W.setF32(win,0x1d8,1);
  W.heap.write(win,0x1dc,'string','%1.2f');
  W.setF32(win,0x1e8,0.5);W.setF32(win,0x1ec,f(0.1));W.setI32(win,0x1f0,-1);
  for(let off=0x1f4;off<=0x254;off+=4)W.setU32(win,off,0);
  W.setU32(win,0x258,(W.u32(win,0x258)&~1)>>>0);W.setU8(win,0x260,0);W.setU32(win,0x264,0);
}
export function forceClipChildSize(W,win,h,v){
  const flags=W.u32(win,0x184);
  if((flags&1)!==h||((flags>>>1)&1)!==v){
    W.setU32(win,0x184,((flags&~3)|(h&1)|((v&1)<<1))>>>0);W.native.askParentForReconfigure(win);
  }
}
function managerDescendant(W,win,child){for(let w=child;w;w=W.ptr(w,0x138))if(w===win)return true;return false;}
export function managerSetButtons(W,win,first,last){
  const a=managerDescendant(W,win,first)?first:null,b=managerDescendant(W,win,last)?last:null;
  W.setPtr(win,0x150,b);W.setPtr(win,0x14c,a);
}
export function managerSetScale(W,win,scale){
  if(!managerDescendant(W,win,scale))scale=null;
  if(W.ptr(win,0x158)===scale)return;
  W.setPtr(win,0x158,scale);W.native.askParentForReconfigure(win);
  if(W.ptr(win,0x154)&&W.ptr(win,0x158))W.boundary('ScaleManager.ChangeValueField text formatting is not recovered');
}
export function scaleOrientation(W,win,value){W.setU8(win,0x14c,value&255);W.native.askParentForReconfigure(win);}
export function stretchScale(W,win,value){
  const flags=W.u32(win,0x164);
  if(((flags>>>3)&1)===value)return;
  W.setU32(win,0x164,((flags&~9)|((value&1)?9:0))>>>0);W.native.askParentForReconfigure(win);
}
export function changeScaleAttributes(W,win){
  for(let w=win;w;w=W.ptr(w,0x138))if(!(W.u8(w,0x30)&1))return;
  for(let w=win;w;w=W.ptr(w,0x138))
    if(W.v.scaleAttributesChanged(w,win,W.i32(win,0x1c8),W.i32(win,0x1cc),W.i32(win,0x1c4)))return;
}
export function changeThumbPosition(W,win,value,attributes,notify){
  const count=W.i32(win,0x1c4),span=W.i32(win,0x1cc),spanning=W.u8(win,0x164)&16;
  let pos=value|0;
  if(spanning){const limit=(count-span)|0;if(pos>limit)pos=limit;}
  else if(pos>=count)pos=(count-1)|0;
  if(pos<0)pos=0;
  if(W.i32(win,0x1c8)!==pos){
    W.setI32(win,0x1c8,pos);computeThumbConfig(W,win);
    W.native.changeScalePosition(win,notify);attributes=1;
  }
  if(attributes){changeScaleAttributes(W,win);computeThumbConfig(W,win);}
}
export function scaleNumTicks(W,win,count){
  count=Math.max(1,count|0);if(W.i32(win,0x1c4)===count)return;
  W.setI32(win,0x1c4,count);changeThumbPosition(W,win,W.i32(win,0x1c8),1,1);
}
export function scaleThumbSpan(W,win,range){
  range|=0;const enabled=range>=1?1:0,flags=W.u32(win,0x164);
  if(W.i32(win,0x1cc)===range&&((flags>>>4)&1)===enabled)return;
  W.setU32(win,0x164,((flags&~18)|(enabled?18:0))>>>0);
  if(enabled)W.setI32(win,0x1cc,range);
  changeThumbPosition(W,win,W.i32(win,0x1c8),1,1);
}
export function textureSize(W,texture,width,height,border){
  let w=width>0?width:texture?W.i32(texture,0x34):0,h=height>0?height:texture?W.i32(texture,0x38):0;
  const twice=M(X(border),I(2));return [S(A(twice,X(f(w)))),S(A(twice,X(f(h))))];
}
export function tickToPixel(W,win,tick){
  const start=W.f32(win,0x250);let length=sub(X(W.f32(win,0x254)),X(start)),den;
  if(W.u8(win,0x164)&16){
    length=sub(A(length,I(1)),X(W.f32(win,W.u8(win,0x14c)===1?0x21c:0x218)));
    den=(W.i32(win,0x1c4)-W.i32(win,0x1cc))|0;
  }else den=(W.i32(win,0x1c4)-1)|0;
  return f(T(A(A(D(M(I(tick),length),I(Math.max(1,den))),X(start)),X(0.5))));
}
export function computeThumbConfig(W,win){
  const read=off=>W.f32(win,off),put=(off,v)=>W.setF32(win,off,v);
  for(const [textureOff,widthOff,heightOff,border,out] of
    [[0x154,0x194,0x198,read(0x170),0x218],[0x15c,0x1a4,0x1a8,0,0x238],[0x160,0x1ac,0x1b0,0,0x248]]){
    if(out===0x238)for(const off of [0x230,0x234,0x240,0x244])W.setU32(win,off,0);
    const [w,h]=textureSize(W,W.ptr(win,textureOff),read(widthOff),read(heightOff),border);put(out,w);put(out+4,h);
  }
  const vertical=W.u8(win,0x14c)===1,along=vertical?4:0,cross=vertical?0:4;
  put(0x218+along,S(add(read(0x238+along),read(0x248+along),read(0x218+along))));
  const capCross=S(sub(X(read(0x218+cross)),M(X(read(0x170)),I(2))));
  put(0x238+cross,capCross);put(0x248+cross,capCross);
  put(0x210,f(T(M(sub(X(read(0x80)),X(read(0x218))),X(0.5)))));
  put(0x214,f(T(M(sub(X(read(0x84)),X(read(0x21c))),X(0.5)))));
  if(W.u8(win,0x164)&16){
    // The twice-border value stays on x87's stack through the span branch.
    const span=D(M(sub(A(X(read(0x254)),I(1)),X(read(0x250))),I(W.i32(win,0x1cc))),I(Math.max(1,W.i32(win,0x1c4))));
    put(0x218+along,f(T(A(span,X(0.5)))));
    if(below(X(read(0x218+along)),I(6)))put(0x218+along,6);
    const available=A(sub(X(read(0x254)),X(read(0x250))),I(1));
    if(below(available,X(read(0x218+along))))put(0x218+along,S(available));
    const excess=sub(A(A(M(X(read(0x170)),I(2)),X(read(0x238+along))),X(read(0x248+along))),X(read(0x218+along)));
    if(positive(excess)){
      const half=I(T(M(excess,X(0.5)))),rest=sub(excess,half);
      put(0x238+along,S(sub(X(read(0x238+along)),rest)));
      put(0x248+along,S(sub(X(read(0x248+along)),half)));
      put(0x240+along,S(A(half,X(read(0x240+along)))));
    }
    put(0x210+along,tickToPixel(W,win,W.i32(win,0x1c8)));
  }else{
    const pixel=tickToPixel(W,win,W.i32(win,0x1c8));
    put(0x210+along,f(T(A(sub(X(pixel),M(X(read(0x218+along)),X(0.5))),X(0.5)))));
  }
}

// Original 0x1003d700 / 3d7d0 / 3d970: unconditional reconfigure.
export function scaleTexture(W,win,texture,width,height,start,end){
  W.setPtr(win,0x150,texture);W.setF32(win,0x18c,nonnegative(width));W.setF32(win,0x190,nonnegative(height));
  W.setF32(win,0x1b4,start);W.setF32(win,0x1b8,end);W.native.askParentForReconfigure(win);
}
export function thumbTexture(W,win,texture,width,height){
  W.setPtr(win,0x154,texture);W.setF32(win,0x194,nonnegative(width));W.setF32(win,0x198,nonnegative(height));
  W.native.askParentForReconfigure(win);
}
export function thumbCaps(W,win,first,last,...sizes){
  W.setPtr(win,0x15c,first);W.setPtr(win,0x160,last);
  sizes.forEach((v,i)=>W.setF32(win,0x1a4+4*i,nonnegative(v)));W.native.askParentForReconfigure(win);
}
export function scaleMargins(W,win,start,end){
  start=nonnegative(start);end=nonnegative(end);
  const differs=(a,b)=>!Number.isNaN(a)&&a!==b;
  if(differs(W.f32(win,0x1bc),start)||differs(W.f32(win,0x1c0),end)){
    W.setF32(win,0x1bc,start);W.setF32(win,0x1c0,end);W.native.askParentForReconfigure(win);
  }
}

/** XScaleWindow::SetRanges 0x1003df40, used by ScrollArea clip notifications. */
export function scaleRanges(W,win,span,count){
  span=Math.max(1,span|0);count|=0;
  if(W.i32(win,0x1cc)===span&&W.i32(win,0x1c4)===count)return;
  const position=W.i32(win,0x1c8);
  W.setI32(win,0x1cc,span);W.setI32(win,0x1c4,count);
  changeThumbPosition(W,win,position,1,1);
}
