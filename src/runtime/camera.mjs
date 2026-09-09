import { rotatorSin } from './coords.mjs';
const f = Math.fround;

/** Core execGetAxes 0x10139e90; inverse roll/pitch/yaw composition. */
export function getAxes(rotation) {
  if (!rotation || rotation.length !== 3 || rotation.some(v => !Number.isInteger(v))) throw new Error('GetAxes requires integer Unreal rotator units');
  const [pitch,yaw,roll] = rotation;
  const sr=rotatorSin(roll),cr=rotatorSin((roll+16384)|0);
  const sp=rotatorSin(pitch),cp=rotatorSin((pitch+16384)|0);
  const sy=rotatorSin(yaw),cy=rotatorSin((yaw+16384)|0);
  let axes=[[1,0,0],[0,1,0],[0,0,1]];
  for(const rows of [ [[1,0,0],[0,cr,sr],[0,-sr,cr]], [[cp,0,-sp],[0,1,0],[sp,0,cp]],
    [[cy,-sy,0],[sy,cy,0],[0,0,1]] ]) {
    axes=axes.map(a=>rows.map(b=>f(a[0]*b[0]+a[1]*b[1]+a[2]*b[2])));
  }
  return axes;
}

/** Inputs are incoming PlayerWalking state, before UpdateRotation/ProcessMove. */
export function walkingBobInputs(deltaTime, velocity, rotation) {
  const [x,y]=velocity.map(f);
  return {DeltaTime:f(deltaTime),Speed2D:f(Math.sqrt(f(f(x*x)+f(y*y)))),Y:getAxes(rotation)[1]};
}

export function decayWalkBob(walkBob,deltaTime) {
  const decay=f(1-Math.min(1,f(8*f(deltaTime))));
  return walkBob.map(v=>f(f(v)*decay));
}

/** Execute the already recovered original CheckBob VM; preserve source gates.
 * Mutates the same bobState object accepted by that function. */
export function updateWalkingBob(bobState,checkBob,{deltaTime,velocity,rotation,physics=1,animationGroup='',showMenu=false}) {
  if(showMenu) return bobState;
  if(physics===1 && String(animationGroup).toLowerCase()!=='dodge') {
    if(!checkBob) throw new Error('Walking bob requires original CheckBob bytecode');
    checkBob.run(bobState,walkingBobInputs(deltaTime,velocity,rotation));
  } else {
    bobState.bobtime=0;
    bobState.WalkBob=decayWalkBob(bobState.WalkBob,deltaTime);
  }
  return bobState;
}

/** PlayerPawn eye-height branch then DeusExPlayer jolt; docs/camera.md.
 * Return only changed camera fields, leaving actor/physics ownership outside. */
export function updateEyeHeight(state,deltaTime) {
  const dt=f(deltaTime),timeDilation=f(state.timeDilation??1);
  if(!(timeDilation>0)) throw new Error('Camera requires positive TimeDilation');
  const walking=state.physics===1 && !state.justLanded;
  const rate=f(f(10*dt)/timeDilation);
  const smooth=walking?Math.min(1,rate):Math.max(f(.35),Math.min(1,rate));
  const old=f(state.eyeHeight),target=f(f(state.shakeVert??0)+f(state.baseEyeHeight));
  const prior=walking?f(f(old-f(state.locationZ))+f(state.oldLocationZ)):old;
  let eyeHeight=f(f(prior*f(1-smooth))+f(target*smooth));
  const jolt=f(state.joltMagnitude??0);
  if(jolt!==0 && state.physics===1 && f(state.bob??0)!==0) eyeHeight=f(eyeHeight+f(jolt*5));
  return {eyeHeight,justLanded:walking?Boolean(state.justLanded):false,joltMagnitude:0};
}
