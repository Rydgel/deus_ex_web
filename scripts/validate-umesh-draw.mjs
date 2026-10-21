/** URender::DrawMesh for a classic UMesh (Render 0x10b0d1a0) against the original: docs/umesh.md.
 *
 * The unchanged DrawMesh and face helper run in the Unicorn oracle (native-umesh-draw-oracle.py)
 * on the game's classic meshes with the camera-space points GetFrame gives for poses in front of
 * several cameras; the light manager's Light/Fog, GetFrame, GetTexture and the render device are
 * stubbed with recorders, so the comparison is of what DrawMesh asks of them and hands to the
 * device: every Light call's vertex, point, normal plane and flags, and every polygon's flags,
 * texture info and corner records (point, outcode, normal, Light, Fog, U, V), in order.
 * ORACLE_CW=0x007f is the render pass's precision control. */
import {execFileSync} from 'node:child_process';
import {auditAssert,auditControlWord} from './precision-audit.mjs';
const assert=auditAssert(),controlWord=auditControlWord();
import {drawUMesh} from '../src/runtime/umesh-draw.mjs';
import {unlitColor} from '../src/runtime/mesh-lighting.mjs';
import {cases,root,f,bitsOf,lightOf,fogOf,uncoordsOf} from './umesh-draw-cases.mjs';

const reference=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-umesh-draw-oracle.py',root,...(controlWord?[controlWord]:[])],{input:JSON.stringify(cases.map(c=>c.spec)),encoding:'utf8',maxBuffer:256*1024*1024}));

const words=values=>values.map(bitsOf);
let drawn=0,lights=0,clipped=0;
for(const [caseIndex,c] of cases.entries()) {
  const original=reference.cases[caseIndex],label=c.name;
  // The Player's Sprite replaces every mesh texture and the environment map (0x10b0de9f..0x10b0dfc0).
  const info=spec=>spec?{...spec,flags:spec.polyFlags}:null;
  const sprite=info(c.sprite),environment=sprite??info(c.environment);
  const uncoords=uncoordsOf(c.coords),unlit=unlitColor(c.ambientGlow,c.scaleGlow);
  assert.deepEqual(words(unlit),original.unlit,`${label} unlit colour`);
  const result=drawUMesh(c.mesh,Float32Array.from(c.spec.points.flat()),{frame:{mirror:c.mirror,prj:c.prj,uncoords},polyFlags:(c.polyFlags|0x4000)>>>0,
    setup:{flags:c.setupFlags},fatness:c.fatness,unlit,textureInfo:sprite?()=>sprite:index=>info(c.textureList[index]),environment,
    light:index=>lightOf(index).map(f),fog:index=>fogOf(index).map(f),snapshots:true});
  // Light calls: vertex, point, plane, flags.
  assert.equal(result.lightCalls.length,original.light.length,`${label} light call count`);
  result.lightCalls.forEach((call,i)=>{
    const want=original.light[i];lights++;
    assert.deepEqual([call.vertex,words(call.point),words(call.plane),call.flags],[want.index,want.point,want.normal,want.flags],`${label} light call ${i}`);
  });
  assert.equal(result.draws.length,original.draws.length,`${label} polygon count`);
  result.draws.forEach((draw,i)=>{
    const want=original.draws[i];drawn++;
    assert.deepEqual([draw.environment?['env']:['tex',draw.texture],draw.flags],[want.info,want.flags],`${label} polygon ${i} info/flags`);
    // The face helper clips a polygon that crosses a side plane (more than three corners, new vertices): the page's GPU
    // clips instead, so only its texture info and flags are compared.
    if(want.count!==3||want.pts.some(pt=>pt.index<0||pt.index>=c.spec.frameVerts)){clipped++;return;}
    draw.pts.forEach((pt,k)=>{
      const w=want.pts[k];
      assert.deepEqual([pt.index,words(pt.point),pt.outcode,words(pt.normal),words(pt.light??[0,0,0,0]),words(pt.fog??[0,0,0,0]),bitsOf(pt.u),bitsOf(pt.v)],
        [w.index,w.point,w.outcode,w.normal,w.light,w.fog,w.u,w.v],`${label} polygon ${i} corner ${k}`);
    });
  });
}
if(assert.enabled)assert.report('validate-umesh-draw');
else console.log(`PASS ${cases.length} complete original DrawMesh calls on the classic meshes: ${lights} Light calls and ${drawn} polygons (${clipped} of them clipped by the face helper, compared by texture and flags only), every other vertex record bit for bit (normals, outcodes, Light, Fog, U, V), polygon order, flags and texture info.`);
