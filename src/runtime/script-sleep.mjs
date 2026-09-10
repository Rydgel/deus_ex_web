const f=Math.fround;

/** Engine.dll execSleep103dfef0 stores Actor.SleepTimeLeft and always
 * installs latent384, including a zero or negative requested duration. */
export function sleepActor(actor,state,seconds) {
  state.latent=384;
  actor.sleepTimeLeft=f(seconds);
}

/** PollSleep103e0020 stores the rounded difference but compares its retained
 * value against half DeltaSeconds. Equality does not wake the actor. */
export function pollActorSleep(actor,state,seconds) {
  const delta=f(seconds),remaining=f(actor.sleepTimeLeft)-delta;
  actor.sleepTimeLeft=f(remaining);
  if(remaining<0.5*delta)state.latent=0;
}
