import { x87add, x87div, x87mul, x87sub } from './x87-nan.mjs';

const f = Math.fround;

/** Native Actor flags bit used by bTimerLoop (Actor.uc, Engine.dll). */
export const TIMER_LOOP_FLAG = 0x1000;

const rateNames = ['timerRate', 'TimerRate'];
const counterNames = ['timerCounter', 'TimerCounter'];
const loopNames = ['timerLoop', 'TimerLoop', 'bTimerLoop'];
const flagNames = ['flags', 'Flags'];

const objectLike = value => value !== null && typeof value === 'object';
const has = (object, key) => objectLike(object) && key in object;
const first = (object, names) => names.find(name => has(object, name)) ?? null;

/*
 * The browser actor adapter has used both a plain state object and a decoded
 * map actor ({ values: { TimerRate, ... } }). Keep the timer algorithm
 * independent of that choice. A state object that has no existing timer
 * fields receives the lower-case names used by the runtime API.
 */
function timerState(actor) {
  if (!objectLike(actor)) throw new TypeError('Actor timer requires an object');
  const candidates = [actor, actor.values];
  const state = candidates.find(candidate => rateNames.some(name => has(candidate, name)) ||
    counterNames.some(name => has(candidate, name)) || loopNames.some(name => has(candidate, name))) ?? actor;
  const rateKey = first(state, rateNames) ?? 'timerRate';
  const upper = rateKey === 'TimerRate';
  return {
    state,
    rateKey,
    counterKey: first(state, counterNames) ?? (upper ? 'TimerCounter' : 'timerCounter'),
    loopKey: first(state, loopNames) ?? (upper ? 'bTimerLoop' : 'timerLoop'),
    flagKey: first(state, flagNames),
  };
}

const floatField = (state, key) => f(state[key] ?? 0);

function readLoop(timer) {
  const { state, loopKey, flagKey } = timer;
  /* A native flags word is authoritative when present. bTimerLoop is kept in
   * sync by setActorTimer for adapters which expose both representations. */
  if (flagKey) return (Number(state[flagKey]) >>> 0 & TIMER_LOOP_FLAG) !== 0;
  return Boolean(state[loopKey]);
}

function writeLoop(timer, value) {
  const { state, loopKey, flagKey } = timer;
  const loop = Boolean(value);
  if (flagKey) {
    const flags = Number(state[flagKey]) || 0;
    state[flagKey] = (((flags >>> 0) & ~TIMER_LOOP_FLAG) | (loop ? TIMER_LOOP_FLAG : 0)) >>> 0;
  }
  state[loopKey] = loop;
}

/**
 * Native(280) Actor.SetTimer(NewTimerRate,bLoop).
 *
 * The arguments are already evaluated by the script VM when this helper is
 * called. Native order is preserved: TimerCounter=0, TimerRate=rate, then the
 * bTimerLoop flag is replaced while all other flags survive.
 */
export function setActorTimer(actor, newTimerRate, bLoop) {
  const timer = timerState(actor);
  timer.state[timer.counterKey] = 0;
  timer.state[timer.rateKey] = f(newTimerRate);
  writeLoop(timer, bLoop);
}

/**
 * Run the timer phase of Actor.Tick for one actor. The caller owns the
 * surrounding Tick gates and calls this after ProcessState. `dispatch` is
 * synchronous and receives the same boundary used by the other runtime
 * helpers: dispatch(actor,'Timer',[]).
 *
 * Returns true only when the native Timer event is dispatched. A large Delta
 * can account for several periods, but native Actor.Tick dispatches Timer once
 * and carries the floating-point remainder into the next tick.
 */
export function updateActorTimer(actor, deltaTime, options = {}) {
  const dispatch = typeof options === 'function' ? options : options?.dispatch;
  const timer = timerState(actor), { state } = timer;
  const rate = floatField(state, timer.rateKey);

  // fcompl 0.0 followed by testb 0x41 skips zero, negative, and unordered
  // (NaN) rates. It does not clamp or otherwise rewrite a disabled timer.
  if (!(rate > 0)) return false;

  // fld/fadds load both operands as float32, then keep their sum in the x87
  // register. fsts writes the rounded sum before the threshold branch; the
  // extended sum is still used for the quotient and remainder below.
  const delta = f(deltaTime), counter = floatField(state, timer.counterKey);
  const sum = x87add(Number(delta), Number(counter));
  state[timer.counterKey] = f(sum);

  // fcoms sets C0 for a less-than or unordered comparison. `!(sum >= rate)`
  // models both cases without turning NaN into a spurious callback.
  if (!(sum >= rate)) return false;

  // _ftol truncates toward zero. With the positive rate and due sum above,
  // this is the nonnegative elapsed-period count used by the native branch.
  // NaN results take the x87's bits (x87-nan.mjs), as tick.rs does.
  const periods = Math.trunc(x87div(sum, rate));
  state[timer.counterKey] = f(x87sub(sum, x87mul(periods, Number(rate))));

  // Native clears TimerRate before ProcessEvent for one-shot timers. Loop is
  // sampled before dispatch; a reentrant SetTimer therefore replaces this
  // state and no later write in this helper can overwrite that replacement.
  if (periods !== 0 && !readLoop(timer)) state[timer.rateKey] = 0;
  if (typeof dispatch !== 'function') throw new TypeError('Timer dispatch requires a callback');
  dispatch(actor, 'Timer', []);
  return true;
}
