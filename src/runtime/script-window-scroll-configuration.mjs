/** Original Extension child placement. Evidence: docs/script-window-scroll-configuration.md. */
import * as T from './script-window-tree-natives.mjs';
import {scrollAreaPreferredSize,clipChild,clipChildPreferredSize} from './script-window-scroll-layout.mjs';
import {textureSize,computeThumbConfig,scaleRanges} from './script-window-scroll-children.mjs';
import {x87load as X,x87int32 as I,x87add as A,x87neg as N,x87mul as M,x87div as D,x87store as S,x87ftol as F} from './script-vm.mjs';
const sub=(a,b)=>A(a,N(b)),sum=(...v)=>S(v.map(X).reduce(A)),twice=v=>M(X(v),I(2));
const below=(a,b)=>{
  if(a.nan!==undefined||b.nan!==undefined)return true;
  if(a.inf||b.inf){if(a.inf&&b.inf)return Boolean(a.neg&&!b.neg);return a.inf?Boolean(a.neg):!b.neg;}
  const d=sub(a,b);return Boolean(d.neg&&d.sig);
};
const above=(a,b)=>below(b,a)&&a.nan===undefined&&b.nan===undefined;
const holds=(W,child)=>[0xa4,0xa8,0xac,0xb0].map(off=>W.f32(child,off));
export function scrollAreaConfiguration(W,win){
  scrollAreaPreferredSize(W,win,1,W.f32(win,0x80),1,W.f32(win,0x84));
  for(const off of [0x14c,0x150,0x16c]){
    const child=W.ptr(win,off);
    if(child&&(W.u8(child,0x30)&1))W.native.configureChild(child,...holds(W,child));
  }
}
function managerChildConfig(W,win,child,end,spacing){
  const size=T.queryPreferredSize(W,child,0,0,0,0);
  W.setF32(child,0xac,size.width);W.setF32(child,0xb0,size.height);
  W.setF32(child,0xa4,0);W.setF32(child,0xa8,0);
  const vertical=W.i32(win,0x15c)===1,along=vertical?4:0,cross=vertical?0:4;
  W.setF32(child,0xa4+along,sum(spacing,end));
  const align=W.u8(win,vertical?0x170:0x171),margin=W.f32(win,0x164+cross);
  const extent=W.f32(win,0x80+cross),childExtent=W.f32(child,0xac+cross);
  let position;
  if(align===0)position=margin;
  else if(align===1)position=S(M(sub(X(extent),X(childExtent)),X(0.5)));
  else if(align===2)position=S(sub(sub(X(extent),X(childExtent)),X(margin)));
  else{
    position=margin;
    // 41f7b writes +b0 even for vertical orientation; retain the original quirk.
    W.setF32(child,0xb0,S(sub(X(extent),twice(margin))));
  }
  W.setF32(child,0xa4+cross,position);
  return sum(W.f32(child,0xa4+along),W.f32(child,0xac+along));
}
export function managerConfiguration(W,win){
  const vertical=W.i32(win,0x15c)===1;
  let spacing=W.f32(win,vertical?0x168:0x164);
  const limit=S(sub(X(W.f32(win,vertical?0x84:0x80)),X(spacing)));let end=0;
  for(let child=T.bottomChild(W,win,1);child;child=T.higherSibling(W,child,1)){
    end=managerChildConfig(W,win,child,end,spacing);spacing=W.f32(win,0x16c);
  }
  const eligible=(off,bit)=>{
    const child=W.ptr(win,off);
    return child&&W.ptr(child,0x138)===win&&(W.u8(child,0x30)&1)&&(W.u32(win,0x160)&bit);
  };
  const scale=eligible(0x158,1),value=eligible(0x154,2);
  if(!T.c3(end,limit)&&(scale||value)){
    const delta=sub(X(limit),X(end));let sd=0,vd=0;
    if(scale){sd=S(value?M(delta,X(0.5)):delta);if(value)vd=S(sub(delta,X(sd)));}
    else vd=S(delta);
    let offset=0;
    for(let child=T.bottomChild(W,win,1);child;child=T.higherSibling(W,child,1)){
      const d=child===W.ptr(win,0x158)?sd:child===W.ptr(win,0x154)?vd:0;
      const along=W.i32(win,0x15c)===1?4:0;
      W.setF32(child,0xa4+along,sum(W.f32(child,0xa4+along),offset));
      W.setF32(child,0xac+along,sum(d,W.f32(child,0xac+along)));offset=sum(d,offset);
    }
  }
  for(let child=T.bottomChild(W,win,1);child;child=T.higherSibling(W,child,1))W.native.configureChild(child,...holds(W,child));
}
export function scaleConfiguration(W,win){
  const read=off=>W.f32(win,off),put=(off,v)=>W.setF32(win,off,v);
  const [w,h]=textureSize(W,W.ptr(win,0x150),read(0x18c),read(0x190),read(0x16c));put(0x208,w);put(0x20c,h);
  if(W.u8(win,0x164)&8){
    const along=W.u8(win,0x14c)===1?4:0;
    put(0x208+along,S(sub(X(read(0x80+along)),twice(read(0x1bc+along)))));
  }
  const center=(size,extent)=>I(F(M(sub(X(size),X(extent)),X(0.5))));
  const x=center(read(0x80),read(0x208)),y=S(center(read(0x84),read(0x20c)));
  put(0x200,S(x));put(0x204,y);
  const vertical=W.u8(win,0x14c)===1,origin=vertical?X(y):x;
  put(0x250,S(A(origin,X(read(0x1b4)))));
  put(0x254,S(sub(A(origin,X(read(vertical?0x20c:0x208))),A(X(read(0x1b8)),I(1)))));
  const start=A(X(read(0x250)),X(read(0x16c))),end=sub(X(read(0x254)),X(read(0x16c)));
  put(0x250,S(start));put(0x254,S(end));
  if(below(end,start)){const mid=S(A(M(sub(end,start),X(0.5)),start));put(0x250,mid);put(0x254,mid);}
  computeThumbConfig(W,win);
  const tick=textureSize(W,W.ptr(win,0x158),read(0x19c),read(0x1a0),0);put(0x228,tick[0]);put(0x22c,tick[1]);
  put(0x220,S(center(read(0x80),read(0x228))));put(0x224,S(center(read(0x84),read(0x22c))));
}
// Core.appCeil 10123300 passes float -> MSVCRT ceil(double) -> _ftol.
const ceil=value=>F(X(Math.ceil(value)));
export function reconfigureClipChild(W,win,child,col,row,width,height){
  const units=W.u8(win,0x184)&4?T.queryGranularity(W,child):{h:1,v:1};
  W.setF32(win,0x198,units.h);W.setF32(win,0x19c,units.v);
  let x=S(M(N(X(units.h)),I(col))),y=S(M(N(X(units.v)),I(row)));
  const totalW=ceil(S(D(X(width),X(units.h)))),totalH=ceil(S(D(X(height),X(units.v))));
  if(W.u8(win,0x184)&8){if(T.c0(width,W.f32(win,0x80)))width=W.f32(win,0x80);if(T.c0(height,W.f32(win,0x84)))height=W.f32(win,0x84);}
  const visibleW=(totalW-ceil(S(D(sub(X(width),X(W.f32(win,0x80))),X(units.h)))))|0;
  const visibleH=(totalH-ceil(S(D(sub(X(height),X(W.f32(win,0x84))),X(units.v)))))|0;
  const clamp=(position,viewport,content)=>{
    const lower=sub(X(viewport),X(content));if(above(lower,X(position)))position=S(lower);
    if(position>0)position=0;return position;
  };
  x=clamp(x,W.f32(win,0x80),width);y=clamp(y,W.f32(win,0x84),height);
  const values=[totalW,totalH,visibleW,visibleH],offsets=[0x190,0x194,0x188,0x18c];
  const changed=values.some((v,i)=>W.i32(win,offsets[i])!==v);
  W.native.configureChild(child,x,y,width,height);
  values.forEach((v,i)=>W.setI32(win,offsets[i],v));
  if(changed)for(let ancestor=win;ancestor;ancestor=W.ptr(ancestor,0x138)){
    if(W.v.clipAttributesChanged(ancestor,win,...[0x188,0x18c,0x190,0x194].map(off=>W.i32(win,off))))break;
  }
}
export function clipConfiguration(W,win){
  const selected=clipChild(W,win);
  for(let child=T.topChild(W,win,1);child;child=T.lowerSibling(W,child,1)){
    if(child===selected){
      clipChildPreferredSize(W,win,child,1,W.f32(win,0x80),1,W.f32(win,0x84));
      reconfigureClipChild(W,win,child,F(X(W.f32(child,0xa4))),F(X(W.f32(child,0xa8))),W.f32(child,0xac),W.f32(child,0xb0));
    }else W.native.configureChild(child,0,0,0,0);
  }
}

/** ScrollArea native override 0x10043b50, after its script event. */
export function scrollClipAttributes(W,win,source,cols,rows,totalCols,totalRows){
  const result=W.processScript(win,'ClipAttributesChanged',[source,cols,rows,totalCols,totalRows],{result:false});
  if(source!==W.ptr(win,0x16c))return result;
  totalCols=Math.max(1,totalCols|0);totalRows=Math.max(1,totalRows|0);
  let scale=W.ptr(win,0x154);if(scale)scaleRanges(W,scale,cols,totalCols);
  scale=W.ptr(win,0x158);if(scale)scaleRanges(W,scale,rows,totalRows);
  return true;
}

export function managerScaleAttributes(W,win,source,position,span,count){
  const result=W.processScript(win,'ScaleAttributesChanged',[source,position,span,count],{result:false});
  if(source===W.ptr(win,0x158)){
    let button=W.ptr(win,0x14c);if(button)W.native.setSensitivity(button,position>0);
    button=W.ptr(win,0x150);if(button)W.native.setSensitivity(button,((position+span)|0)<count);
  }
  return result;
}
