# Original ClearBindEvents behavior

The installed ConSys.dll (SHA-256
`f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa`)
exports DConversation::ClearBindEvents at `10010200`. The entire body is:

```text
eax = this.eventList (+58)
if eax != 0:
    do eax = eax.nextEvent (+38) while eax != 0
return
```

It performs no event virtual call and no actor-field write. The separate
Speech.ClearBindActors body therefore must not be called as a substitute for
this routine. This distinction is observable after termination: event actor
references remain until other original behavior changes them. Native2054's
wrapper at `100108c0` advances the frame Code past EndFunctionParms and invokes
this body; it has no arguments or result.

The host preserves the canonical chain reads and rejects cycles to avoid
hanging on malformed data. Missing prepared events fail explicitly. The native
probe walks a Speech/End-shaped chain and verifies that both actor references
are retained. Original ConSys script CheckActors and CheckActorDistances then
read those same fields through the VM; the distance check skips either player
participant and compares an integer-converted VSize with 300.
