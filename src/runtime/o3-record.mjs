/**
 * O3 recording: the inputs and outputs of the native physics bodies as Play runs them (docs/stage-5-exit-criteria.md "O3").
 *
 * OFF by default and an observer when on: a body's call sites ask `o3.on` (a plain property read) and, only then, run the body through
 * `o3Body`, which hands the SAME arguments to the SAME function. The recorder adds nothing to the pawn but wrappers around its service
 * functions (MoveActor, line checks, events and the nested bodies), installed for the duration of one call and restored after, and
 * never changes an argument or a result. The adapters that know what a body reads, which services it calls and what it writes live with
 * the oracle drivers they feed (scripts/o3-adapters.mjs): this module is the generic machinery.
 *
 * A recorded call is {name, depth, args, before, events, after}:
 *   before   the input state the adapter reads when the body is entered,
 *   events   the body's service calls in order (an adapter's wrapper pushes through `rec.event`), nested recorded bodies among them,
 *   after    the output state when the body returns (or the error it threw).
 * An adapter marked `standalone` is a body whose caller does not see it as a call of its own (MoveActor's query inside the `move` service): it is recorded as
 * a case and is no event of the call it ran under.
 * Wrappers log into the INNERMOST open call only, so a service a nested body calls is the nested call's event, and the outer call
 * sees the nested body as one event (the oracle stubs the nested native the same way and replays it as its own case).
 *
 * Switches that keep a body in its JavaScript reference while recording (a Rust kernel has no JS service boundary to observe) are the
 * caller's: the validator sets them (PAWN_PHYSICS=js ACTOR_PHYSICS=js ...) and proves with a digest that they change nothing.
 */
export const o3 = {on: false, recorder: null};

/** Whether the call site's pawn or actor is one being recorded (the recorder's `accept`, e.g. the player alone). */
export const o3Wants = target => o3.on && o3.recorder.accept(target);

class Recorder {
  constructor(adapters, accept, context) {
    this.adapters = adapters;
    this.accept = accept;
    this.context = context;
    this.calls = [];
    this.stack = [];
    this.errors = [];
  }
  top() { return this.stack[this.stack.length - 1] ?? null; }
}

/** Start recording with `adapters` ({bodyName: {before, wrap, after, nested}}) for the targets `accept(target)` admits;
 * `context` is the adapters' own (actor identities). */
export function o3Start(adapters, accept = () => true, context = {}) {
  o3.recorder = new Recorder(adapters, accept, context);
  o3.on = true;
  return o3.recorder;
}

/** Stop and return {calls, errors}; unfinished calls (a throw past the recorder) are an error each. */
export function o3Stop() {
  const recorder = o3.recorder;
  o3.on = false;
  o3.recorder = null;
  if (recorder?.stack.length) recorder.errors.push(`${recorder.stack.length} calls still open at stop: ${recorder.stack.map(rec => rec.name).join(' > ')}`);
  return recorder ? {calls: recorder.calls, errors: recorder.errors} : {calls: [], errors: []};
}

/** Run `body(...args)` on `target` as the recorded body `name`. Returns exactly what the body returns. */
export function o3Body(name, target, args, body) {
  const recorder = o3.recorder;
  const adapter = recorder?.adapters[name];
  if (!adapter) return body();
  const parent = recorder.top();
  const rec = {name, depth: recorder.stack.length, index: recorder.calls.length, args: args.map(arg => arg), target, before: null, events: [], after: null, error: null};
  recorder.calls.push(rec);
  rec.before = adapter.before(target, args, rec, recorder);
  // The caller's event for this nested body (the adapter of the caller decides its shape), completed by `nestedDone` when the body has returned.
  const nested = parent && !adapter.standalone ? recorder.adapters[parent.name] : null;
  nested?.nested?.(parent, rec, recorder);
  recorder.stack.push(rec);
  const restore = adapter.wrap?.(target, rec, recorder) ?? null;
  let result;
  try {
    result = body();
    return result;
  } catch (error) {
    rec.error = String(error?.message ?? error);
    throw error;
  } finally {
    restore?.();
    recorder.stack.pop();
    rec.result = result;
    rec.after = adapter.after(target, rec, result, recorder);
    nested?.nestedDone?.(parent, rec, recorder);
  }
}

/** The service wrapper adapters use: `fn` wrapped so that, when `rec` is the innermost open call, `pre(args)` reads the state before the
 * call and `log(args, result, before)` records it after (an adapter wants both: the original's event carries the pre-call Velocity, the
 * response the post-call Position). Nothing else about the call changes. */
export function o3Service(rec, recorder, fn, {pre = null, log}) {
  return function (...args) {
    const mine = recorder.top() === rec;
    const before = mine && pre ? pre(args) : undefined;
    const result = fn.apply(this, args);
    if (mine) log(args, result, before);
    return result;
  };
}
