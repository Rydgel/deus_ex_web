/** DrawLodMesh's distance LOD against the original Render.dll ranges
 * (docs/script-lodmesh-lod.md): scripts/native-lodmesh-lod-oracle.py runs
 * the selection, post-frame morph and face/wedge selection bytes at the
 * render pass's control word 0x007f over real meshes (lodmesh-lod-cases.mjs),
 * and every result is compared with src/runtime/lodmesh-lod.mjs and, with the
 * kernel built, native/lodmesh-kernel: the float detail bits, the requested
 * count, the LOD and morph flags, the transformed Location, the morph start,
 * every byte of the 88-byte FTransTexture buffer (positions, alphas and the
 * untouched pattern), each face's admission, material, flags and vertices,
 * and every scratch wedge dword.
 *
 *   node scripts/validate-lodmesh-lod.mjs [--reference-only | --captured] [--js-only]
 *
 * --reference-only records the oracle's output under .cache/research;
 * --captured reuses it when its inputs match these cases. */
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {auditAssert,auditControlWord} from './precision-audit.mjs';
import {gameDirectory} from './game-directory.mjs';
import {buildLodMeshSamples} from './lodmesh-lod-cases.mjs';
import {bitsFloat,floatBits,lodMeshCorners,lodMeshTanArgument,morphLodMesh,selectLodMesh} from '../src/runtime/lodmesh-lod.mjs';

const assert=auditAssert(),controlWord=auditControlWord();
const root=gameDirectory(),capture='.cache/research/lodmesh-lod-original.json';
const samples=await buildLodMeshSamples(root),specs=samples.map(s=>s.spec);
let reference;
if(process.argv.includes('--captured')){
  const saved=JSON.parse(await readFile(capture,'utf8'));
  assert.deepEqual(saved.specs,specs,'the captured oracle inputs must match these cases');reference=saved.reference;
}else reference=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-lodmesh-lod-oracle.py',root,...(controlWord?[controlWord]:[])],{input:JSON.stringify(specs),encoding:'utf8',maxBuffer:256<<20}));
if(process.argv.includes('--reference-only')){
  await mkdir('.cache/research',{recursive:true});await writeFile(capture,JSON.stringify({specs,reference}));
  console.log(`Recorded ${reference.meshes.reduce((n,m)=>n+m.cases.length,0)} original LOD cases at control word ${reference.controlWord.toString(16)}.`);
  process.exit(0);
}
assert.equal(reference.controlWord,controlWord?Number(controlWord):0x007f,'the oracle runs at the render pass control word');
const kernel=process.argv.includes('--js-only')?null:await (await import('../src/runtime/lodmesh-wasm.mjs')).loadLodMeshKernel().then(k=>k.lod?k:null,()=>null);
const doubleHex=value=>{const v=new DataView(new ArrayBuffer(8));v.setFloat64(0,value,true);return v.getBigUint64(0,true).toString(16).padStart(16,'0');};
const firstDifference=(actual,expected)=>{for(let i=0;i<expected.length;i++)if(actual[i]!==expected[i])return i;return actual.length===expected.length?-1:expected.length;};
const tally={cases:0,active:0,morph:0,reduced:0,faces:0,admitted:0,interpolated:0,morphed:0,tanUnicornDiffers:0,kernelCases:0};

/** The topology the oracle's mesh holds for a case (its scalar overrides). */
function caseTopology(topology,c){
  const t={...topology};
  for(const [offset,word] of Object.entries(c.meshBits??{})){
    const at=Number(offset);
    if(at===0x18c){t.lodStrengthBits=word>>>0;t.lodStrength=bitsFloat(word);}
    else if(at===0x190)t.lodMinVerts=word|0;
    else if(at===0x194)t.lodMorph=bitsFloat(word);
    else if(at===0x198)t.lodZDisplace=bitsFloat(word);
    else throw new Error(`unmodelled mesh override ${offset}`);
  }
  if(c.noCollapse)t.collapseCount=0;
  return t;
}

/** One translation of a case: `api` is the JS reference or the kernel. */
function translate(api,sample,c,topology){
  const selection=api.select(topology,c.settings,{location:c.location,drawScale:c.drawScale,lodBias:c.lodBias},c.coords,
    {fx:c.fx,tanFactor:bitsFloat(Object.values(c.tanBits)[0])});
  const count=c.returnedCount??selection.requested;
  const buffer=Uint8Array.from(sample.vertices),view=new DataView(buffer.buffer),ordinary=topology.special*88;
  const state=api.morph(topology,selection,count,buffer,ordinary);
  const corners=api.corners(topology,state,buffer,ordinary);
  return {selection,count,buffer,state,corners,view};
}
const reference_={
  select:selectLodMesh,
  morph(topology,selection,count,buffer,ordinary){
    const view=new DataView(buffer.buffer);
    return morphLodMesh(topology,selection,count,{
      vertex:i=>[0,4,8].map(k=>view.getFloat32(ordinary+i*88+k,true)),
      setVertex:(i,xyz)=>xyz.forEach((v,k)=>view.setFloat32(ordinary+i*88+k*4,v,true)),
      setAlpha:(i,alpha)=>view.setFloat32(ordinary+i*88+0x50,alpha,true)});
  },
  corners(topology,state,buffer,ordinary){
    const view=new DataView(buffer.buffer);
    return lodMeshCorners(topology,state,vertex=>view.getUint32(ordinary+vertex*88+0x50,true));
  },
};

function compare(label,sample,c,original,result){
  const {selection,count,buffer,state,corners}=result;
  assert.equal(floatBits(selection.detail),original.selection.detailBits,`${label}: detail bits`);
  assert.equal(selection.requested,original.selection.requested,`${label}: requested count`);
  assert.equal(selection.active,Boolean(original.selection.active),`${label}: LOD flag after the selection`);
  assert.equal(selection.morph,Boolean(original.selection.morph),`${label}: morph flag after the selection`);
  if(selection.location)assert.deepEqual(selection.location.map(floatBits),original.selection.location,`${label}: transformed Location`);
  assert.equal(count,original.state.count,`${label}: returned count`);
  assert.equal(state.active,Boolean(original.state.active),`${label}: LOD flag after the morph`);
  assert.equal(state.morph,Boolean(original.state.morph),`${label}: morph flag after the morph`);
  assert.equal(state.start,original.state.start,`${label}: morph start`);
  const output=Buffer.from(original.output,'base64'),at=firstDifference(buffer,output);
  assert.equal(at,-1,`${label}: GetFrame buffer byte ${at} (vertex ${Math.floor((at-sample.topology.special*88)/88)}, offset ${at%88})`);
  const scratch=Buffer.from(original.scratch,'base64'),words=new Uint8Array(corners.scratch.buffer,corners.scratch.byteOffset,corners.scratch.byteLength);
  const sat=firstDifference(words,scratch);
  assert.equal(sat,-1,`${label}: scratch wedge dword ${sat>>2}`);
  const materials=sample.mesh.arrays.get(0x168),mview=new DataView(materials.data.buffer,materials.data.byteOffset,materials.data.byteLength);
  original.faces.forEach((face,i)=>{
    const mine=corners.faces[i];
    assert.equal(Boolean(mine),face.admitted,`${label}: face ${i} admission`);
    if(!face.admitted||!mine)return;
    assert.deepEqual(mine,face.vertices,`${label}: face ${i} vertices`);
    const material=sample.topology.faces[i*4+3];
    assert.equal(face.material,material,`${label}: face ${i} material`);
    assert.equal(face.flags>>>0,(mview.getUint32(material*8,true)|0x4000)>>>0,`${label}: face ${i} flags`);
  });
}

for(const [meshIndex,sample] of samples.entries()){
  const originalMesh=reference.meshes[meshIndex];
  assert.equal(originalMesh.name,sample.name,'mesh order');
  for(const [caseIndex,c] of sample.cases.entries()){
    const original=originalMesh.cases[caseIndex],label=`${sample.name} ${c.name}`;
    assert.equal(original.name,c.name,`${label}: case order`);
    const topology=caseTopology(sample.topology,c);
    // appTan runs only past the LOD gate (LODStrength bits, CollapsePointThus).
    const gated=topology.lodStrengthBits!==0&&(topology.collapseCount??topology.collapsePoints.length)!==0;
    assert.equal(original.selection.tan.length,gated?1:0,`${label}: appTan calls`);
    for(const tan of original.selection.tan){
      assert.equal(tan.argument,doubleHex(lodMeshTanArgument(c.fov)),`${label}: appTan argument`);
      assert.equal(tan.injected,Object.values(c.tanBits)[0],`${label}: measured appTan float`);
      if(tan.unicorn!==tan.injected)tally.tanUnicornDiffers++;
    }
    const result=translate(reference_,sample,c,topology);
    compare(label,sample,c,original,result);
    if(kernel){compare(`${label} (kernel)`,sample,c,original,translate(kernel.lod,sample,c,topology));tally.kernelCases++;}
    tally.cases++;tally.active+=result.state.active?1:0;tally.morph+=result.state.morph?1:0;
    tally.reduced+=result.count<topology.modelVerts?1:0;tally.faces+=original.faces.length;
    tally.admitted+=original.faces.filter(face=>face.admitted).length;
    // A packed dword equal to no wedge of its collapse chain moved its UVs.
    const {wedges,collapseWedges}=topology;
    result.corners.scratch.forEach((word,w)=>{
      if(!word)return;
      for(let at=w,steps=0;steps<=wedges.length;steps++){if(wedges[at]===word)return;const next=collapseWedges[at];if(next===at)break;at=next;}
      tally.interpolated++;
    });
    if(result.state.morph)tally.morphed+=result.count-1-result.state.start;
  }
}
if(assert.enabled)assert.report('validate-lodmesh-lod');
else console.log(`PASS ${tally.cases} original DrawLodMesh LOD cases on ${samples.length} meshes at control word 0x${reference.controlWord.toString(16).padStart(4,'0')}: `+
  `${tally.active} with reduced topology, ${tally.morph} morphing (${tally.morphed} vertices), ${tally.reduced} below ModelVerts; `+
  `${tally.admitted} of ${tally.faces} faces admitted, ${tally.interpolated} wedges with interpolated UVs; detail bits, counts, flags, `+
  `every buffer byte, faces and scratch equal${kernel?` (JS and the kernel, ${tally.kernelCases} kernel cases)`:' (JS reference; kernel not built)'}. `+
  `Unicorn's own appTan float differed from the measured one in ${tally.tanUnicornDiffers}.`);
