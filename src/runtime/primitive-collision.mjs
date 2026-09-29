// Original GOTY UPrimitive, Engine103d87e0/103d8af0. See docs/primitive-collision.md.
import { safeNormal } from './steps.mjs';
const f=Math.fround;
const clean=()=>({outside:true,location:[0,0,0],normal:[0,0,0],time:1});
export function primitivePointCheck(actor,position,extent=[0,0,0]) {
 const h=clean();if(!actor)return h;
 const p=position.map(f),e=extent.map(f),l=actor.location.map(f),r=f(actor.radius),z=f(actor.height);
 if((l[2]-p[2])**2 >= (e[2]+z)**2 || (l[0]-p[0])**2+(l[1]-p[1])**2 >= (e[0]+r)**2)return h;
 h.outside=false;h.normal=safeNormal(p.map((v,i)=>f(v-l[i])));
 if(h.normal[2]<-.5 || h.normal[2]>.5) h.location=[p[0],p[1],f(l[2]-e[2])];
 else {const n=safeNormal([h.normal[0],h.normal[1],0]);h.location=[f(l[0]-e[0]*n[0]),f(l[1]-f(e[0]*n[1])),f(l[2]+p[2])];}
 return h;
}
export function primitiveLineCheck(actor,start,end,extent=[0,0,0]) {
 const h=clean();if(!actor)return h;
 const s=start.map(f),t=end.map(f),e=extent.map(f),l=actor.location.map(f),r=f(actor.radius),z=f(actor.height);
 const rx=f(r+e[0]),ry=f(r+e[1]),rz=f(z+e[2]),top=f(l[2]+rz),bottom=f(l[2]-rz);
 for(let i=0;i<3;i++){const hi=i===2?top:l[i]+[rx,ry][i],lo=i===2?bottom:l[i]-[rx,ry][i];if(s[i]>hi&&t[i]>hi||s[i]<lo&&t[i]<lo)return h;}
 let enter=0,exit=1;
 if(s[2]>top&&t[2]<top){enter=f((top-s[2])/(t[2]-s[2]));h.normal=[0,0,1];}
 else if(s[2]<top&&t[2]>top)exit=f((top-s[2])/(t[2]-s[2]));
 if(s[2]<bottom&&t[2]>bottom){const a=(bottom-s[2])/(t[2]-s[2]);if(a>enter){enter=f(a);h.normal=[0,0,-1];}}
 else if(s[2]>bottom&&t[2]<bottom)exit=f(Math.min(exit,(bottom-s[2])/(t[2]-s[2])));
 if(enter>=exit)return h;
 const dx=t[0]-s[0],dy=t[1]-s[1],x=s[0]-l[0],y=s[1]-l[1];
 const A=f(dx*dx+dy*dy),B=f(2*(dx*x+dy*y)),C=f(x*x+y*y-rx*rx),D=f(B*B-4*C*A);
 if(C<1&&s[2]>bottom&&s[2]<top){if(f(dx)*x+f(dy)*y>=-.1)return h;h.outside=false;h.time=0;h.location=s;h.normal=safeNormal([f(x),f(y),0]);return h;}
 if(D<0)return h;
 if(A<1e-8){if(C>0)return h;}
 else {
  const root=Math.sqrt(D),inv=.5/A;
  exit=f(Math.min(exit,(root-B)*inv));
  const a=-(root+B)*inv;
  if(a>enter){enter=f(a);const n=[f(f(f(f(dx)*a)+s[0])-l[0]),f(f(f(f(dy)*a)+s[1])-l[1]),0];const sq=n[0]*n[0]+n[1]*n[1];h.normal=sq>=1e-8?n.map(v=>f(v/Math.sqrt(sq))):n;}
  if(enter>=exit)return h;
 }
 const time=Math.max(0,Math.min(1,enter-.001));h.time=f(time);h.outside=false;
 h.location=[f(s[0]+f(f(dx)*time)),f(s[1]+f(f(dy)*time)),f(s[2]+f(t[2]-s[2])*time)];
 return h;
}
/** primitiveLineCheck's arithmetic for the level query path, without its
 * temporaries: the same f32 stores, double intermediates and comparisons.
 * Returns null where primitiveLineCheck reports outside, else a fresh result
 * with the same fields. */
export function primitiveLineHit(location,radius,height,start,end,extent) {
 const sx=f(start[0]),sy=f(start[1]),sz=f(start[2]),tx=f(end[0]),ty=f(end[1]),tz=f(end[2]);
 const lx=f(location[0]),ly=f(location[1]),lz=f(location[2]),r=f(radius),z=f(height);
 const rx=f(r+f(extent[0])),ry=f(r+f(extent[1])),rz=f(z+f(extent[2])),top=f(lz+rz),bottom=f(lz-rz);
 let hi=lx+rx,lo=lx-rx;if(sx>hi&&tx>hi||sx<lo&&tx<lo)return null;
 hi=ly+ry;lo=ly-ry;if(sy>hi&&ty>hi||sy<lo&&ty<lo)return null;
 if(sz>top&&tz>top||sz<bottom&&tz<bottom)return null;
 let enter=0,exit=1,nx=0,ny=0,nz=0;
 if(sz>top&&tz<top){enter=f((top-sz)/(tz-sz));nz=1;}
 else if(sz<top&&tz>top)exit=f((top-sz)/(tz-sz));
 if(sz<bottom&&tz>bottom){const a=(bottom-sz)/(tz-sz);if(a>enter){enter=f(a);nx=0;ny=0;nz=-1;}}
 else if(sz>bottom&&tz<bottom)exit=f(Math.min(exit,(bottom-sz)/(tz-sz)));
 if(enter>=exit)return null;
 const dx=tx-sx,dy=ty-sy,x=sx-lx,y=sy-ly;
 const A=f(dx*dx+dy*dy),B=f(2*(dx*x+dy*y)),C=f(x*x+y*y-rx*rx),D=f(B*B-4*C*A);
 if(C<1&&sz>bottom&&sz<top){
  if(f(dx)*x+f(dy)*y>=-.1)return null;
  return {outside:false,location:[sx,sy,sz],normal:safeNormal([f(x),f(y),0]),time:0};
 }
 if(D<0)return null;
 if(A<1e-8){if(C>0)return null;}
 else {
  const root=Math.sqrt(D),inv=.5/A;
  exit=f(Math.min(exit,(root-B)*inv));
  const a=-(root+B)*inv;
  if(a>enter){
   enter=f(a);
   const px=f(f(f(f(dx)*a)+sx)-lx),py=f(f(f(f(dy)*a)+sy)-ly),sq=px*px+py*py;
   if(sq>=1e-8){const length=Math.sqrt(sq);nx=f(px/length);ny=f(py/length);nz=f(0/length);}
   else{nx=px;ny=py;nz=0;}
  }
  if(enter>=exit)return null;
 }
 const time=Math.max(0,Math.min(1,enter-.001));
 return {outside:false,location:[f(sx+f(f(dx)*time)),f(sy+f(f(dy)*time)),f(sz+f(tz-sz)*time)],normal:[nx,ny,nz],time:f(time)};
}
