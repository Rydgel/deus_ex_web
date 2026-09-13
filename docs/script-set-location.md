# `Actor.SetLocation` native 267

`Engine.u` declares `final function bool SetLocation(vector NewLocation)` as
native 267.  The recovered Engine.dll has SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`.
The exported thunk at `0x10302bb2` enters `execSetLocation` at
`0x103e3120`.

## Wrapper contract

The native wrapper evaluates exactly one vector expression and advances the
caller FFrame.  It then loads `Actor+0xac`, the actor's `ULevel`, and calls the
level virtual at `+0x8c`.  That slot is `ULevel::FarMoveActor`; the recovered
body is `0x10398ba0`.  The call receives the native actor, the evaluated
destination, `Test=0`, and `bNoCheck=0`.  The wrapper stores the callee's
Boolean result in the script ReturnValue and returns with `ret 8`.

`src/runtime/script-set-location.mjs` translates only this wrapper.  It
requires an injected `levelFor`, `actorFor`, and `farMoveActor` service.  The
runtime does not infer a player collision actor or route arbitrary script
actors through player-only callbacks.  A missing service fails explicitly at
the reached native boundary.

The injected `farMoveActor` is the existing
[`relocation.mjs`](../src/runtime/relocation.mjs) implementation when a host
has an actor identity adapter.  Its own 1,316 original native cases establish
the destination conversion, scene callback order, and Boolean result.  This
wrapper preserves its argument order and supplies the two zero flags exactly.

## Validation

`test/script-set-location.test.mjs` checks level and actor resolution order,
destination and zero flags, single vector evaluation, Boolean propagation, and
explicit failures for missing services.  The focused validator is
`node scripts/validate-script-set-location.mjs`; it does not claim a complete
actor world or a player-scene adapter.
