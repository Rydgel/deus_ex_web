# Actor timer contract

This document records the recovered `Actor.SetTimer`/`Actor.Tick` timer phase
used by `src/runtime/script-timers.mjs`. The implementation is limited to the
timer state update and the synchronous `Timer` event boundary. Actor tick
eligibility, stasis/owner gates, lifespan, physics, and the event's script body
remain caller/runtime responsibilities.

## Original evidence

The extracted `Actor.uc` declares `bTimerLoop` at line 73, `TimerRate` at line
141, and `TimerCounter` at line 142. `TimerCounter` is declared `const` to
scripts even though the engine mutates it. The `Timer` event is declared at line
802. The native declaration at lines 887–888 is:

```uc
native(280) final function SetTimer( float NewTimerRate, bool bLoop );
```

The Image export lookup against the original `Engine.dll` resolves the entry
points as follows:

| symbol | address | evidence |
| --- | ---: | --- |
| `execSetTimer` | `0x103012d5` | thunk jumps to `0x103e3920` |
| `Actor::Tick` | `0x10303daa` | thunk jumps to `0x103a1aa0` |
| `eventTimer` | `0x10303364` | declared event wrapper |
| native registration `intAActorexecSetTimer` | `0x1047cbb4` | native index 280 registration |

`execSetTimer` at `0x103e3920` evaluates the two script arguments through the
frame, then performs these writes on the actor:

1. `TimerCounter` at `this+0x4c` becomes `0`.
2. `TimerRate` at `this+0x48` receives the evaluated float.
3. The flags word at `this+0x28` has bit `0x1000` (`bTimerLoop`) replaced by
   `bLoop`; all other flag bits survive.

There is no native clamping or period accumulation in `SetTimer`. The helper's
`setActorTimer(actor, rate, loop)` preserves this write order. It accepts either
a plain runtime state (`timerRate`, `timerCounter`, `timerLoop`) or a decoded
actor with `values.TimerRate`, `values.TimerCounter`, and `values.bTimerLoop`.
When a flags word is supplied, the `0x1000` bit is kept in sync without
changing unrelated bits.

## Tick phase and arithmetic

`Actor::Tick` has two control-flow copies of the timer block at
`0x103a24aa` and `0x103a269b`. Each follows its `ProcessState` virtual call at
vtable slot `+0x14`. The block runs before the later lifespan and physics paths.
The recovered sequence is:

1. Load `TimerRate` as a float32 and compare it with `0.0`. The `testb $0x41`
   branch skips the timer for zero, negative, and unordered (NaN) rates.
2. Load `DeltaTime` and `TimerCounter` as float32 values, add them in the x87
   register, and store the sum back to `TimerCounter` as float32.
3. Compare the still-extended sum with `TimerRate`. A less-than or unordered
   comparison skips the event and leaves the stored sum in the counter. Equal
   counts as due.
4. Divide the extended sum by the float32 rate and call the imported `_ftol`
   bridge at `0x10413652`. For the positive finite values covered here this is
   truncation toward zero, equivalent to a nonnegative integer period count.
5. Store `sum - count * TimerRate` as float32 in `TimerCounter`.
6. If the count is nonzero and `bTimerLoop` is clear, write `TimerRate=0`.
7. Resolve the global `Timer` function and invoke the actor's synchronous
   `ProcessEvent` vtable slot `+0x10` with no parameters.

The helper uses `Math.fround` for float32 loads/stores and retains the
unrounded intermediate sum in the closest available JavaScript number
representation of the x87 value. It dispatches once per `updateActorTimer`
call regardless of how many periods the count contains.
It returns `true` exactly when the `Timer` event was dispatched; otherwise it
returns `false`.

The JavaScript number used for the intermediate has a 53-bit significand while
the original x87 register has an extended significand. Ordinary float32 timer
values produce the same period count; a quotient within that extra precision of
an integer remains an unverified edge case.

`updateActorTimer(actor, deltaTime, { dispatch })` expects the synchronous
`dispatch(target, event, args)` boundary used by the rest of the runtime and
calls `dispatch(actor, 'Timer', [])`. A function may be passed directly as the
third argument for small adapters. A missing dispatch callback is an explicit
error only after a due timer is found, so disabled timers can be polled without
installing an event handler.

## Reentrant callback behavior

The event is dispatched only after the counter remainder and one-shot rate
clear have been written. `ProcessEvent` is synchronous and the native Tick
path performs no timer write after it. Therefore a `Timer` body that calls
`SetTimer` observes and can replace the prepared state:

- a one-shot callback normally sees `TimerRate=0`, then a reentrant
  `SetTimer(newRate, loop)` writes counter zero, the new rate, and the new loop
  flag;
- a looping callback sees the old rate and the remainder before replacing
  them, if it calls `SetTimer`;
- a callback can cancel, change the rate, or change loop mode, and that change
  persists into the next tick.

No callback is emitted once the rate is disabled. A large delta does not emit a
burst of callbacks: the native block computes a period count only to retain the
remainder and still performs one `Timer` dispatch.

## Scope and limits

The implementation does not infer whether `Actor::Tick` should run, does not
execute the `Timer` script body, and does not model lifespan or physics. Those
operations must be ordered by the actor tick caller around this helper. The
normal finite float32 rate/delta path is recovered directly from the native
instructions. `_ftol` overflow behavior for pathological nonfinite or enormous
period counts was not established and is intentionally not presented as a
compatibility guarantee.
