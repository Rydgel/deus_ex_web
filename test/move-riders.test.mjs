import test from'node:test';import assert from'node:assert/strict';
import{moveActorRiders}from'../src/runtime/move-riders.mjs';
import{x87load,x87add,x87neg,x87mul,x87store}from'../src/runtime/script-vm.mjs';
import{rotatorSin}from'../src/runtime/coords.mjs';

// Riders are identified by `Base === actor` — the mover's host identity —
// against a live actors array scanned by index, matching 0x103998a0-0x10399bb0.
const fixture=({actorPos=[0,0,0],actorRot=[0,0,0],riders=[]}={})=>{
 const actor={name:'base'};
 const all=[actor,...riders];
 const calls=[];
 const services={
  actors:all,
  baseOf:o=>o.base??null,
  location:o=>o.position,
  rotation:o=>o.rotation,
  isPawn:o=>Boolean(o.pawn),
  addViewRotationYaw:(o,dy)=>{o.viewYaw=(o.viewYaw??0)+dy;},
  moveActor:(o,d,r)=>calls.push({o,delta:d,rotation:r}),
  actorLocation:()=>actorPos,
  actorRotation:()=>actorRot,
 };
 return{actor,calls,services};
};

test('yaw 16384 rotates the rider offset: delta gains the RotMotion term',()=>{
 const rider={name:'rider',base:null,position:[10,0,0],rotation:[0,0,0]};
 const{actor,calls,services}=fixture({riders:[rider]});
 rider.base=actor;
 // Base at origin, rider 10u ahead on +X; committed move (1,2,3) with a
 // quarter-turn yaw: RotMotion = v - R*v, v = base-rider = (-10,0,0),
 // R(16384) maps (x,y)->(y,-x) so t=(0,-10,0), RotMotion=(-10,10,0).
 moveActorRiders(actor,[1,2,3],[0,16384,0],services);
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0].delta,[-9,12,3]);
 assert.deepEqual(calls[0].rotation,[0,16384,0]);
});

test('unchanged rotation carries no RotMotion and leaves rider yaw alone',()=>{
 const rider={name:'rider',base:null,position:[10,0,0],rotation:[0,100,0]};
 const{actor,calls,services}=fixture({actorRot:[0,100,0],riders:[rider]});
 rider.base=actor;
 moveActorRiders(actor,[1,2,3],[0,100,0],services);
 assert.deepEqual(calls[0].delta,[1,2,3]);
 assert.deepEqual(calls[0].rotation,[0,100,0]);
});

test('yaw difference below the 0xfffc mask still rotates the rider yaw only',()=>{
 const rider={name:'rider',base:null,position:[10,0,0],rotation:[0,7,0]};
 const{actor,calls,services}=fixture({actorRot:[0,4,0],riders:[rider]});
 rider.base=actor;
 // dyaw = 7-4 = 3, but the reduced rotation masks to (4)-(4) = 0, so
 // RotMotion stays zero while Rotation.Yaw still gains the unmasked 3.
 moveActorRiders(actor,[1,2,3],[0,7,0],services);
 assert.deepEqual(calls[0].delta,[1,2,3]);
 assert.deepEqual(calls[0].rotation,[0,10,0]);
});

test('pawn riders gain the yaw difference in ViewRotation.Yaw',()=>{
 const rider={name:'pawnrider',base:null,position:[0,0,0],rotation:[0,0,0],pawn:true,viewYaw:1000};
 const{actor,calls,services}=fixture({riders:[rider]});
 rider.base=actor;
 moveActorRiders(actor,[0,0,0],[0,16384,0],services);
 assert.equal(rider.viewYaw,1000+16384);
});

test('actors not based on the mover are not moved',()=>{
 const stray={name:'stray',base:{name:'other'},position:[5,5,5],rotation:[0,0,0]};
 const orphan={name:'orphan',base:null,position:[1,1,1],rotation:[0,0,0]};
 const{actor,calls,services}=fixture({riders:[stray,orphan]});
 moveActorRiders(actor,[1,2,3],[0,16384,0],services);
 assert.equal(calls.length,0);
});

test('fractional offsets keep the x87 store granularity',()=>{
 const f=Math.fround;
 const rider={name:'rider',base:null,position:[f(0.1),f(0.2),0],rotation:[0,0,0]};
 const{actor,calls,services}=fixture({riders:[rider]});
 rider.base=actor;
 // v = -(offset) = (-0.1f, -0.2f, 0); the sine table's cos(16384) is the
 // stored double ~1.22e-16, not exact 0, so derive the expected values
 // through the same x87 load/mul/add/store chain the body uses:
 // t_i = st((v.x*A_i.x + v.y*A_i.y) + v.z*A_i.z) for A = X'=(c,-s,0),
 // Y'=(s,c,0), Z'=(0,0,1); RotMotion = v - t; delta = finalDelta + RotMotion.
 moveActorRiders(actor,[0,0,0],[0,16384,0],services);
 const ld=x87load,st=x87store,mul=x87mul,add=x87add,neg=x87neg;
 const s=rotatorSin(16384),c=rotatorSin((16384+0x4000)|0);
 const v=[-f(0.1),-f(0.2),0];
 const dot=(a,b,w)=>st(add(add(mul(ld(v[0]),ld(a)),mul(ld(v[1]),ld(b))),mul(ld(v[2]),ld(w))));
 const t=[dot(c,-s,0),dot(s,c,0),dot(0,0,1)];
 const rot=[st(add(ld(v[0]),neg(ld(t[0])))),st(add(ld(v[1]),neg(ld(t[1])))),st(add(ld(v[2]),neg(ld(t[2]))))];
 const expected=[st(add(ld(0),ld(rot[0]))),st(add(ld(0),ld(rot[1]))),st(add(ld(0),ld(rot[2])))];
 assert.deepEqual(calls[0].delta,expected);
});

test('a missing rider MoveActor service is an explicit boundary',()=>{
 const{actor,services}=fixture();
 assert.throws(()=>moveActorRiders(actor,[0,0,0],[0,0,0],{...services,moveActor:null}),/based passengers/);
});
