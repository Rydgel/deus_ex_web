import test from 'node:test';import assert from 'node:assert/strict';
import {surfaceCases,runSurface} from '../scripts/validate-native-walking-surface.mjs';
import {walkingSurfacePrelude} from '../src/runtime/walking-surface.mjs';
test('original surface scanner emits 36 rays followed by floor and WalkTexture',()=>{
 const r=runSurface(surfaceCases()[0]);assert.equal(r.handled,false);assert.equal(r.events.length,38);
 assert.deepEqual(r.events[0].line,{start:[0,0,4.150001525878906],end:[40,0,4.150001525878906],extent:[0,0,0],flags:6});
 assert.deepEqual(r.events[36].line,{start:[0,0,45],end:[0,0,-38],extent:[0,0,0],flags:6});
 assert.equal(r.events[37].walkTexture,false);
});
test('original Ladder selection stops scanning and fails explicitly',()=>{
 for(const c of surfaceCases().filter(c=>c.group==='Ladder')){const r=runSurface(c);assert.equal(r.events.length,c.hitAt+2);assert.deepEqual(r.events.at(-1),{unsupported:'Ladder'});}
});
test('texture sliding is explicitly unsupported after WalkTexture',()=>{
 let calls=0,event=false;const texture={key:'test.floor',outerName:'Concrete',friction:.95};
 assert.throws(()=>walkingSurfacePrelude({position:[0,0,45],rotation:[0,0,0],radius:20,height:43,physics:1,lineCheck(s,e){return {texture:++calls===37?texture:null,location:e,normal:[0,0,1]};},textureForHit:h=>h.texture,walkTexture(){event=true;}}),/Unsupported original texture sliding/);
 assert.equal(event,true);
});
