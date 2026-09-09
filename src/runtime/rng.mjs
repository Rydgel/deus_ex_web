const FRAND_SCALE=Math.fround(1/32767);
function word(value){
 if(!Number.isInteger(value)||value<0||value>0xffffffff)throw Error('Original RNG requires an explicit unsigned 32-bit seed/state');
 return value>>>0;
}
/** Original GOTY MSVCRT per-thread stream. The caller supplies a captured or
 * explicitly chosen seed/state and preserves all shared-stream consumers. */
export function createNativeRng(seed){
 let state=word(seed);
 const rand=()=>{state=(Math.imul(state,214013)+2531011)>>>0;return (state>>>16)&32767;};
 return {
  get state(){return state;},
  seed(value){state=word(value);},
  rand,
  // appFrand returns ST0 without a float32 store. This exact product fits in
  // binary64; callers apply their own original store/arithmetic rounding.
  frand:()=>rand()*FRAND_SCALE,
 };
}
