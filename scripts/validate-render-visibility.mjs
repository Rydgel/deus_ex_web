/** Focused original-native comparison of admission gates, not BSP visibility. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {dynamicActorRoute,meshSetupRoute} from '../src/runtime/render-visibility.mjs';

const admission=[
  {},{nullActor:true},{highDetail:true,highDetailActors:false},{highDetail:true},
  {viewTarget:true},{viewTarget:true,recursion:1},{viewTarget:true,behindView:true},
  {excluded:true},{hidden:true},{hidden:true,editor:true},{hiddenEd:true,editor:true},{hiddenEd:true},
  {onlyOwnerSee:true},{onlyOwnerSee:true,owned:true,ownerDepth:2},
  {onlyOwnerSee:true,owned:true,behindView:true},{ownerNoSee:true,owned:true},{ownerNoSee:true},
  {ownerNoSee:true,owned:true,behindView:true},{isViewActor:true},{isViewActor:true,ownerNoSee:true},
  {brush:true,brushClass:true},{brush:true,brushClass:true,static:true},{brush:true},{running:false},
];
const meshSetup=[
  {},{location:[-100,0,0]},{location:[0,0,0]},
  ...[13,14,15].map(rendMap=>({location:[-100,0,0],rendMap})),
  ...[0,1,3,4,5,6,7].map(drawType=>({drawType})),
  {drawType:0,actorIcons:true},{mesh:false},
  {location:[8,-4,2],origin:[7,-6,3],zAxis:[.25,.5,-.125]},
  // The first survives cancellation in x87 but rounds to zero in binary64.
  {location:[2**60,-1,-(2**60)],zAxis:[1,1,1]},
  // Depth is negative although its float store is -0; FCOMP retains x87.
  {location:[-(2**-149),0,0],zAxis:[2**-149,0,0]},
];
const native=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-render-visibility-oracle.py',gameDirectory()],
  {input:JSON.stringify({admission,meshSetup}),encoding:'utf8'}));
for(let i=0;i<admission.length;i++) {
  const c=admission[i],viewActor={},actor=c.nullActor?null:c.isViewActor?viewActor:{};
  if(actor) {
    Object.assign(actor,{bHighDetail:c.highDetail,bHidden:c.hidden,bHiddenEd:c.hiddenEd,
      bOnlyOwnerSee:c.onlyOwnerSee,bOwnerNoSee:c.ownerNoSee,bStatic:c.static,Brush:c.brush});
    let owner=c.owned?viewActor:null;
    for(let n=0;n<(c.ownerDepth??0);n++)owner={Owner:owner};
    actor.Owner=owner;
  }
  const actual=dynamicActorRoute(actor,{...c,viewActor,excludedActor:c.excluded?actor:null,
    viewTarget:c.viewTarget?actor:null,isBrush:()=>c.brushClass});
  assert.equal(actual,native.admission[i],`admission ${i}: ${JSON.stringify(c)}`);
}
for(let i=0;i<meshSetup.length;i++) {
  const c=meshSetup[i],actor={DrawType:c.drawType??2,Mesh:c.mesh??true,Location:c.location??[100,0,0]};
  const actual=meshSetupRoute(actor,{...c,origin:c.origin??[0,0,0],zAxis:c.zAxis??[1,0,0]});
  assert.equal(actual,native.meshSetup[i].route,`mesh setup ${i}: ${JSON.stringify(c)}`);
}
assert.equal(native.meshSetup.at(-2).route,'rejected','negative extended depth survives binary64 cancellation');
assert.equal(native.meshSetup.at(-1).depthBits,0x80000000,'negative tiny depth stores as negative zero');
assert.equal(native.meshSetup.at(-1).route,'rejected','comparison must not reload rounded depth');
console.log(`${admission.length} admission and ${meshSetup.length} mesh-setup cases match original Render.dll (0x037f); Play visibility is not integrated.`);
