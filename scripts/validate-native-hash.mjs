/** Hash-verified native differential driver; outputs stay in ignored reports. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createCollisionHash, collisionHashTables, collisionHashLineBounds } from '../src/runtime/collision-hash.mjs';

const root = resolve(process.argv[2] ?? 'Deus Ex GOTY Edition');
const output = resolve(process.argv[3] ?? 'reports/movement/native-hash');
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const box = (min, max = min) => ({ min, max });
const point = cells => cells.map(v => (v - 128) * 256);
const commonActors = Array.from({length: 80}, (_, i) => ({ id: `overlap-${i}`, bounds: box([-256,-256,-256],[256,256,256]), hit: i !== 7, time: i % 3 / 4, location: [i, i+1, i+2] }));
commonActors.push({id:'left',bounds:box([-768,-768,-768],[-512,-512,-512])}, {id:'right',bounds:box([512,512,512],[768,768,768])}, {id:'destroyed',objectFlags:128,bounds:box([0,0,0]),location:[1,2,3]});
const commonQueries = [
  ...[1e-12,1e-14,1e-16].map(e=>({start:[128.001953125,128.001953125,128.001953125],end:[128.001953125,128.001953125,128.001953125],extent:[e,e,e]})),
  {start:[-1024,-1024,-1024],end:[1024,1024,1024]},
  {start:[0,0,0],end:[0,0,0],extraNodeFlags:0x1234},
  {start:[0,0,0],end:[0,0,0]},
  {start:[128,384,-128],end:[128,384,-128],extent:[0.00390625,0.00390625,0.00390625]},
];
const cases = [1,123,0xabcdef01].map(seed=>({seed, actors:commonActors, queries:commonQueries}));
const edges = [-1000000,-32768,-32640,-32384,-128,0,127.999,128,128.001,384,4194176,5000000];
cases.push({seed:1,actors:edges.map((v,i)=>({id:`edge-${i}`,bounds:box([v,v,v])})),queries:edges.map(v=>({start:[v,v,v],end:[v,v,v]}))});
// These equal-tag/equal-bucket cells were found in original seed-1 tables,
// demonstrating why full-domain behavior cannot replace buckets with cell keys.
cases.push({seed:1,actors:[{id:'alias-a',bounds:box(point([8,206,128]))},{id:'alias-b',bounds:box(point([264,205,128]))}],queries:[{start:point([8,206,128]),end:point([8,206,128])},{start:point([264,205,128]),end:point([264,205,128])}]});
cases.push({seed:1,actors:[{id:'a',bounds:box([0,0,0],[256,256,256])},{id:'b',bounds:box([0,0,0],[256,256,256])}],queries:[{start:[0,0,0],end:[0,0,0]}],moves:[{id:'a',query:{start:[0,0,0],end:[0,0,0]}},{id:'a',bounds:box([512,512,512],[768,768,768]),location:[512,512,512],query:{start:[0,0,0],end:[0,0,0]}}]});
await mkdir(output,{recursive:true});
await writeFile(resolve(output,'cases.json'),JSON.stringify(cases));
const native = spawnSync(python, [resolve('scripts/native-hash-oracle.py'),root,resolve(output,'cases.json')], {encoding:'utf8',maxBuffer:32*1024*1024});
if(native.status !== 0) throw new Error(native.stderr || native.error?.message || `Native driver exit ${native.status}`);
await writeFile(resolve(output,'original.json'),native.stdout);
const reference=JSON.parse(native.stdout);
let registrations=0, queries=0, callbacks=0;
for(let i=0;i<cases.length;i++) {
  const fixture=cases[i], expected=reference.results[i];
  assert.deepEqual(collisionHashTables(fixture.seed).map(t=>[...t]),expected.tables,`case ${i} original permutations`);
  for(const mode of (i<3 || i===5) ? ['exact','independent'] : ['exact']) {
    const hash=createCollisionHash(mode==='exact'?{tables:expected.tables}:{});
    fixture.actors.forEach((actor,j)=>{
      const registration=hash.addActor(actor,actor.bounds);
      const original=expected.registrations[j];
      if(actor.objectFlags&128){assert.equal(registration,null);assert.deepEqual(original.hashLocation,[0,0,0]);return;}
      assert.deepEqual(registration.cells,{min:[original.cells[0],original.cells[2],original.cells[4]],max:[original.cells[1],original.cells[3],original.cells[5]]});
      assert.deepEqual(registration.hashLocation,original.hashLocation); registrations++;
    });
    function compareQuery(query, original, label) {
      const visited=[];
      const hits=hash.actorLineCheck(query,(actor,args)=>{
        visited.push({id:actor.id,end:args.end,start:args.start,extent:args.extent,flags:args.extraNodeFlags});
        return actor.hit===false?null:{id:actor.id,time:Math.fround(actor.time??0.5)};
      });
      assert.deepEqual(collisionHashLineBounds(query),original.cells,`${label} cells`);
      assert.deepEqual(visited,original.visited,`${label} visitation`);
      assert.deepEqual(hits,original.hits,`${label} hits`); queries++;callbacks+=visited.length;
    }
    fixture.queries.forEach((query,j)=>compareQuery(query,expected.queries[j],`case ${i} ${mode} query ${j}`));
    const updated = new Map();
    for(const [j,move] of (fixture.moves??[]).entries()) {
      const actor=fixture.actors.find(a=>a.id===move.id);
      hash.removeActor(actor,updated.get(actor)?.bounds??actor.bounds);
      const current={bounds:move.bounds??updated.get(actor)?.bounds??actor.bounds,location:move.location??updated.get(actor)?.location??actor.location};
      updated.set(actor,current);
      hash.addActor(actor,current.bounds,{location:current.location});
      compareQuery(move.query,expected.moves[j],`case ${i} ${mode} move ${j}`);
    }
  }
}
assert.deepEqual(reference.results[0].queries,reference.results[1].queries);
assert.deepEqual(reference.results[0].queries,reference.results[2].queries);
assert.equal(reference.results[0].queries[4].hits.length,79);
assert.equal(reference.results[4].queries[0].hits.length,2);
const summary={cases:cases.length,registrations,queries,callbacks,permutationEntriesCompared:cases.length*3*16384,failures:0,scope:'Controlled primitive callbacks; AddActor/RemoveActor and ActorLineCheck, three original seeds; no Play integration or startup RNG claim'};
await writeFile(resolve(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
