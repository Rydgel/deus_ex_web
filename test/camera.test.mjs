import test from 'node:test';
import assert from 'node:assert/strict';
import {getAxes,walkingBobInputs,updateWalkingBob,updateEyeHeight,decayWalkBob} from '../src/runtime/camera.mjs';

test('original GetAxes quantizes four rotator units, including negative wrap',()=>{
  assert.deepEqual(getAxes([0,0,0]),getAxes([0,3,0]));
  assert.deepEqual(getAxes([0,-1,0]),getAxes([0,65535,0]));
  assert.deepEqual(getAxes([0,4,0]),[[.9999999403953552,.0003834951785393059,0],[-.0003834951785393059,.9999999403953552,0],[0,0,1]]);
  assert.throws(()=>getAxes([0,.1,0]),/integer/);
});

test('original GetAxes full roll/pitch/yaw order',()=>{
  assert.deepEqual(getAxes([2049,-3191,4097]),[[.935215413570404,-.2954857647418976,.19509032368659973],
    [.34953054785728455,.8584611415863037,-.37533026933670044],[-.056572701781988144,.4192046821117401,.906127393245697]]);
});

test('CheckBob adapter passes incoming velocity and body axes without changing GroundSpeed',()=>{
  const state={GroundSpeed:320,bobtime:1,WalkBob:[1,2,3]};let calls=0;
  const checkBob={run(instance,locals){calls++;assert.equal(instance,state);assert.equal(instance.GroundSpeed,320);
    assert.deepEqual(locals,walkingBobInputs(1/120,[-123.456,72.345,31],[0,4,0]));
    assert.equal(locals.Speed2D,143.09152221679688);}};
  updateWalkingBob(state,checkBob,{deltaTime:1/120,velocity:[-123.456,72.345,31],rotation:[0,4,0]});
  assert.equal(calls,1);
});

test('menu freezes bob; Dodge and air reset phase and decay without invoking CheckBob',()=>{
  for(const options of [{physics:2},{animationGroup:'dodge'}]){
    const state={bobtime:1,WalkBob:[1,-2,3],GroundSpeed:320};
    updateWalkingBob(state,null,{deltaTime:1/120,...options});
    assert.equal(state.bobtime,0);assert.deepEqual(state.WalkBob,[.9333333373069763,-1.8666666746139526,2.799999952316284]);
  }
  const state={bobtime:1,WalkBob:[1,-2,3]};
  updateWalkingBob(state,null,{showMenu:true});assert.deepEqual(state,{bobtime:1,WalkBob:[1,-2,3]});
});

test('eye-height native stores preserve even idle rounding, landing uses separate blend',()=>{
  const state={timeDilation:1,physics:1,justLanded:false,eyeHeight:38,baseEyeHeight:38,
    locationZ:100,oldLocationZ:100,shakeVert:0,joltMagnitude:0,bob:.02};
  assert.deepEqual(updateEyeHeight(state,1/120),{eyeHeight:38.000003814697266,justLanded:false,joltMagnitude:0});
  assert.deepEqual(updateEyeHeight({...state,timeDilation:2,justLanded:true,oldLocationZ:84,
    baseEyeHeight:12,shakeVert:.75,joltMagnitude:.15},.1),{eyeHeight:26.125,justLanded:false,joltMagnitude:0});
});

test('air uses minimum eye blend, clears jolt, and airborne bob decay clamps',()=>{
  assert.deepEqual(updateEyeHeight({timeDilation:2,physics:2,justLanded:false,eyeHeight:38,baseEyeHeight:12,
    locationZ:100,oldLocationZ:100,shakeVert:.75,joltMagnitude:.15,bob:.02},.001),
    {eyeHeight:29.162498474121094,justLanded:false,joltMagnitude:0});
  assert.deepEqual(decayWalkBob([1,2,3],.2),[0,0,0]);
});
