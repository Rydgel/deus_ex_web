const f=Math.fround;

// The float both bodies address at AActor+0xe0 is Actor.LatentFloat
// (SDK 1112f EngineClasses.h AActor layout, `node scripts/sdk-layouts.mjs
// --at AActor 0xe0`; Actor.uc `var const float LatentFloat`), the field the
// pawn WaitForLanding bodies also use. `latentFloat` is that field's
// {get, set}.

/** Engine.dll execSleep103dfef0 stores Actor.LatentFloat and always
 * installs latent384, including a zero or negative requested duration. */
export function sleepActor(latentFloat,state,seconds) {
  state.latent=384;
  latentFloat.set(f(seconds));
}

/** PollSleep103e0020 stores the rounded difference but compares its retained
 * value against half DeltaSeconds. Equality does not wake the actor. */
export function pollActorSleep(latentFloat,state,seconds) {
  const delta=f(seconds),remaining=f(latentFloat.get())-delta;
  latentFloat.set(f(remaining));
  if(remaining<0.5*delta)state.latent=0;
}
