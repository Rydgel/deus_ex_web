# Core primitives for the Training radiation path

This slice is grounded in the installed GOTY `Core.u` declarations, the
hash-checked `Core.dll`, and the corresponding disassembly in
`.cache/reference/Core-rng.asm`. The original declarations are:

| Native | Core declaration | Export thunk | Body |
| --- | --- | --- | --- |
| 144 | `int * (int A, int B)` | `0x10102fae` | `0x10133640` |
| 169 | `float - (float A)` | `0x101014d3` | `0x10134cf0` |
| 185 | `float -= (out float A, float B)` | `0x10101645` | `0x10135b80` |
| 213 | `vector * (float A, vector B)` | `0x10102897` | `0x101378d0` |
| 223 | `vector += (out vector A, vector B)` | `0x10101447` | `0x10138b10` |

The thunk bytes and body prefixes are checked against the installed binary by
`scripts/validate-core-damage-primitives.mjs`. The validator also invokes
`scripts/native-core-damage-primitives-oracle.py`, which replaces only the
operand evaluators in an x86 emulator and executes the original operator
bodies. The original bodies advance the `FFrame` code pointer once per
operand and once for `EX_EndFunctionParms`.

The browser VM follows the same expression contract. Native 144 stores the
low signed 32-bit `IMUL` result. Native 169 applies x87 `FCHS` to a float32
operand and stores a float32 result. Native 185 and 223 evaluate the first
operand as an out-lvalue, update that storage, and return the same float32
result. Native 213 evaluates the scalar before the vector and stores each
component of the scalar/vector product as float32. The VM retains the first
operand reference for 185 and 223 so later script reads observe the original
write.

Run the focused evidence check with:

```sh
DEUS_EX_GAME_DIR='Deus Ex GOTY Edition' node scripts/validate-core-damage-primitives.mjs
```

## Training integration boundary

`DamageTrigger1.Timer` export 15220, size 80, now runs through the original
prepared chain:

```text
DamageTrigger1.Timer
  -> DeusExPlayer.TakeDamage 17205
  -> AddDamageDisplay 17835
  -> DXReduceDamage 17197
  -> StopPoison 17902
  -> UsingChargedPickup 17001
  -> SetDamagePercent 17833
  -> HealthLegLeft -= 10
  -> PlayAnim('HitLegLeft', , 0.1) -> AActor::execPlayAnim 259
  -> GenerateTotalHealth 17220
  -> GetLevelInfo 17962
  -> PlayDXTakeDamageHit 17174
  -> PlayHit 17166
  -> Human.PlayTakeHitSound 16845
  -> Actor.PlaySound 264 (explicit audio boundary)
```

The old browser host attached the Training player without its standalone
`PostBeginPlay -> InitializeSubSystems` lifecycle and therefore exposed a null
`AugmentationSystem`; that was a lifecycle gap, not an authored map state. The
current host proves the normal non-null `AugmentationManager1` path and its
capture-backed 21 augmentation objects in
`scripts/validate-player-augmentation-startup.mjs`. The default `AugEnviro`
remains unowned, so `GetAugLevelValue` returns the original `-1.0` sentinel and
live Radiation10 `DXReduceDamage` writes `adjustedDamage=10` and returns false.
The prior zero-damage/Health100 result must not be used as the Training
contract.

The original `ClientFlash` body still performs `DesiredFlashScale += Scale` and
`DesiredFlashFog += 0.001 * fog`. Radiation10 is not reduced, so
`SetDamagePercent` takes its zero-percent branch and does not call that helper
before the hit response. The current live path writes
`HealthLegLeft=90`, recomputes `Health=98`, and stores the canonical GM_Trench
`HitLegLeft` state (`AnimFrame=-0.25`, `AnimRate=2.5`, `TweenRate=2.5`,
`AnimLast=0.75`; see the original-execution correction in
[animation controls](script-animation-controls.md)). The hit response bodies are prepared from their installed
bytecode; `Human.PlayTakeHitSound` reaches the existing `Actor.PlaySound(264)`
audio boundary, where normal Play records the deferred mission-script effect
and the focused validator retains the exact caller path.

The next recovered boundary after the current prepared body is
`Human.PlayTakeHitSound -> Actor.PlaySound(264)`. `Human.uc:336-377` selects
MalePainSmall/Medium/Large from the shared original RNG and then calls
`AISendEvent('LoudNoise', EAITYPE_Audio, ...)`; that native 713 event is after
the first PlaySound call and therefore remains unexecuted in this case. Health
presentation, HUD icon rendering, mesh rendering, audible playback, and other
damage branches remain outside this bounded slice.
