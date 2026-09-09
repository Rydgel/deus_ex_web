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
