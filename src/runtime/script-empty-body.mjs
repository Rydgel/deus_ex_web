/**
 * Whether a script function's whole body is a bare `return` (UnrealScript `event Name(...);`, compiled to EX_Return EX_Nothing and the end of the
 * script), so that running it has no effect: no statement, no label, no call, no write, no jump (the runaway counter is Jump's) and no result.
 *
 * Retail Engine.u declares `Pawn.WalkTexture` so (`scripts/dump-script-function.mjs Engine Pawn.WalkTexture`: `@0 return _`); no other package
 * declares a function of that name, so a walking pawn's WalkTexture event, which `physWalking`'s surface prelude sends every tick, reaches
 * nothing. ProcessEvent of such a function builds a frame and copies the parameters, and none of that outlives the call.
 */
const cache = new WeakMap();
// EX_Return, EX_Nothing, then EX_EndOfScript (UnrealScript's bytecode, unreal/bytecode.mjs).
const EX_RETURN = 0x04, EX_NOTHING = 0x0b, EX_END_OF_SCRIPT = 0x53;
// a function with a result, a native, an operator or a singular one is never "bare": FUNC_Native 0x400, FUNC_Singular 0x20
const NOT_BARE_FLAGS = 0x420;

/** True when `fn` (a prepared function: `record.function`) has nothing to run. */
export function bareReturn(fn) {
  let known = cache.get(fn);
  if (known === undefined) {
    known = false;
    const script = fn.script;
    if (!fn.result && script && (script.nativeIndex & 0xffff) === 0 && !(script.functionFlags & NOT_BARE_FLAGS)) {
      const bytes = script.bytes;
      known = bytes.length >= 2 && bytes[0] === EX_RETURN && bytes[1] === EX_NOTHING
        && (bytes.length === 2 || (bytes.length === 3 && bytes[2] === EX_END_OF_SCRIPT));
    }
    cache.set(fn, known);
  }
  return known;
}
