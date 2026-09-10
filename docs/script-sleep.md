# Actor.Sleep native latent contract

This document records the original `Actor.Sleep` implementation needed by the
script VM's latent state loop. The trace covers the native wrapper, its latent
poll routine, and the handoff back to `ProcessState`. It does not establish the
world tick gates or any other latent function.

## Original evidence

The primary binary is `Deus Ex GOTY Edition/System/Engine.dll`, SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`. The
disassembly is `.cache/reference/Engine.asm`; the declaration is
`.cache/reference/Actor.uc` and the native layout reference is
`.cache/reference/UActor.h`.

`Actor.uc:692` declares:

```uc
native(256) final latent function Sleep( float Seconds );
```

`UActor.h:579` names the float field `SleepTimeLeft`. The native code addresses
and the relevant frame locations are:

| item | address or offset | evidence |
| --- | ---: | --- |
| `execSleep` thunk | `0x10303cab` | jumps to `0x103dfef0` |
| `execSleep` body | `0x103dfef0` | evaluates `Seconds`, installs latent action |
| `execPollSleep` thunk | `0x10302810` | jumps to `0x103e0020` |
| `execPollSleep` body | `0x103e0020` | decrements and tests the remaining time |
| `AActor::ProcessState` body | `0x103e5b60` | latent poll and state-code loop |
| native expression/poll table | `0x10599a38` | indexed by bytecode or latent action |
| `AActor::SleepTimeLeft` | `this+0xe0` | `UActor.h` field and direct loads/stores |
| comparison constant | `0x1042ac10` | 64-bit floating value `0.5` |
| latent slot | `FStateFrame+0x24` | existing state-frame `LatentAction` field |

The `256` in the script declaration is the native function index used to call
the wrapper. The poll action is a separate table index, `0x180` (decimal
`384`).

## Sleep wrapper

The body at `0x103dfef0` receives the actor in `ECX` and the normal native
`FFrame` argument. Its operation order is:

1. Zero a stack temporary that will receive the expression result.
2. Read the byte at `FFrame+0xc`, increment `FFrame+0xc`, and dispatch that
   expression through the table at `0x10599a38`. The expression receives
   `FFrame.Object` (`FFrame+0x8`) as its `ECX` receiver and the temporary as
   its `Result` pointer.
3. Increment `FFrame+0xc` once more after the expression returns. The wrapper
   therefore consumes the argument opcode and the argument payload through the
   ordinary frame evaluator.
4. Read `this+0xc` (`StateFrame`) and write `0x180` to
   `StateFrame+0x24`.
5. Store the temporary's float bits at `this+0xe0`.

There is no returned script value and no event call. The wrapper does not
clamp, normalize, or special-case the evaluated `Seconds` value before storing
it. A missing `StateFrame` is dereferenced by the original code and is outside
the valid actor state contract.

The relevant stores are visible directly at `0x103dff27` and `0x103dff32`:

```text
movl $0x180, 0x24(%StateFrame)
movl %edx,    0xe0(%Actor)
```

The source order is latent-slot installation first, then the float field store
in the machine code. A runtime adapter should preserve the observable result
of both writes and the frame-code advancement; it should not run the poll from
inside the wrapper.

## Poll action and comparison

`ProcessState` calls a nonzero `FStateFrame+0x24` entry before ordinary state
bytecode. At `0x103e5c05–0x103e5c13` it passes the state frame and a pointer to
its `DeltaSeconds` local to `table[LatentAction]`, with the actor in `ECX`.
Consequently, `execPollSleep` reads `DeltaSeconds` from the pointer at
`[esp+8]`; it does not use the state-frame argument directly.

The body at `0x103e0020` is an x87 sequence. Let `D` be the float32 value read
from `DeltaSeconds` and let `S` be the float32 value loaded from
`Actor+0xe0`:

```text
R = x87_extended(S - D)
store_float32(Actor+0xe0, R)
compare (D * 0.5) against R       // 0.5 is loaded from 0x1042ac10
if (D * 0.5) > R, ordered:
    StateFrame+0x24 = 0
```

`fsts` at `0x103e002e` rounds the new field to float32, but the x87 register
still holds the extended `R` for the comparison. `fcompp` at `0x103e003c`
sets the x87 condition flags; `testb $0x41,%ah` at `0x103e0040` tests C0 and
C3. The clear at `0x103e0045–0x103e004c` is therefore reached only for an
ordered strict greater-than comparison of `D*0.5` over `R`, equivalently
`R < D*0.5`.

Equality keeps the latent action for another poll. A less-than comparison in
the other direction also keeps it. An unordered comparison (for example a
NaN) sets the tested flag and keeps it. For ordinary positive finite values,
completion occurs when the post-decrement remainder is below half the current
frame delta, so the stored remainder can still be positive by less than half a
frame.

The routine changes only `Actor+0xe0` and, on completion, the state frame's
latent slot. It does not advance `FStateFrame+0xc`, call an event, or execute
state bytecode itself.

## Resume timing

After the latent table call returns, `ProcessState` continues at
`0x103e5c16`. It reloads `FStateFrame+0x24` at `0x103e5c2e` and suppresses the
normal state-code dispatch if the slot is still nonzero. If the poll cleared
the slot, the state-code loop reads and dispatches the next opcode at
`0x103e5c39` onward during that same `ProcessState` invocation.

Thus a completed `Sleep` resumes state code in the same `ProcessState` call
that performed the finishing poll. Calling `Sleep` from state bytecode cannot
resume immediately in that call: the pre-bytecode poll phase has already run,
and the wrapper always installs `0x180`. Even `Seconds == 0` (or a negative
value) waits for the next eligible `ProcessState` call; with a positive finite
delta, its first poll normally clears the latent slot and then continues state
code in that call.

## Runtime-facing contract

For a valid actor state frame, the focused VM behavior is:

```text
sleep(frame, actor):
    seconds = evaluate_next_expression(frame, receiver=frame.Object)
    frame.Code = after_expression_payload(frame)
    actor.SleepTimeLeft = float32(seconds)
    actor.StateFrame.LatentAction = 0x180
    yield to ProcessState's next latent-poll phase

poll_sleep(actor, deltaSeconds):
    remainder_x87 = extended(float32(actor.SleepTimeLeft)
                             - float32(deltaSeconds))
    actor.SleepTimeLeft = float32(remainder_x87)
    if ordered(remainder_x87 < 0.5 * float32(deltaSeconds)):
        actor.StateFrame.LatentAction = 0
        // ProcessState then executes state code in this call.
```

The `frame.Object` receiver applies to evaluating `Seconds`; it is not changed
to a separate latent receiver by this native. `ProcessState` supplies the
actor's own state frame and delta pointer to the poll action.

## Unresolved or deliberately excluded behavior

- The adjacent routine at `0x103e0070` calls `0x10599e6c` with `0x180` and a
  string/data address, then stores the result, but its symbolic registration
  name and initialization timing were not recovered in this focused trace.
  The table dispatch and the two direct action writes establish the usable
  poll index.
- Invalid frame pointers, a missing state frame, negative or non-finite deltas,
  and x87 exceptional behavior outside the observed flag rules are not a
  supported gameplay contract.
- Actor tick eligibility, stasis/owner gates, state transitions, and other
  latent actions remain the responsibility of the existing `ProcessState`
  integration documented in `docs/door-state.md`.
