# Engine Actor Move / MakeNoise natives

The authority for these two natives is the installed GOTY `System/Engine.u`
and hash-pinned `System/Engine.dll`:

```text
Engine.dll SHA-256  0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4
Actor.uc            the native() declarations quoted below
```

| Index | Declaration | Exec/body | Key instructions |
| --- | --- | --- | --- |
| 266 | `final function bool Move (vector Delta)` | exec `0x103e3030` | Delta evaluated once, a 44-byte `FCheckResult` cleared (Time=1.0f, Item=-1), Rotation copied raw from `this->+0x120`, then `ULevel::MoveActor` through vtable `+0x88` with four trailing zeros; `*Result = eax` |
| 512 | `final function MakeNoise (float Loudness)` | exec `0x103bcd20`, body `0x103bfad0` (thunk `0x103031a7`), hearing gate `0x103bf7b0` (thunk `0x1030286a`) | Actors[0]/LevelInfo warns 0xf1/0xf2 on both paths, `Actors[0]->+0x518 == 3` (NetMode) skips the body; instigator noise-slot suppression/write phase, PawnList dispatch loop with two different class filters, per-pawn hearing gate with team branch |

## 266 `Move` — exec `0x103e3030`

The wrapper evaluates `Delta` into a stack vector, clears a 44-byte
`FCheckResult` (nine zeroed dwords, `Time = 1.0f` at +0x24, `Item = -1` at
+0x28), copies `Rotation` verbatim from `this->+0x120`, then calls the
receiver's `XLevel` vtable slot +0x88 as
`MoveActor(this, Delta, Rotation, &hit, 0, 0, 0, 0)` and publishes the dword
return as the bool result. `ret 8`.

Cases (`scripts/native-move-oracle.py` → `validate-native-move.mjs`, 4 cases):
the oracle installs a recording stub at the vtable slot and proves receiver
identity, `ecx == XLevel`, by-value delta/rotation, the exact hit block, the
four trailing zeros and verbatim dword result propagation (0, 1, 2,
0xffffffff). The movement service itself is a live-level boundary —
`src/runtime/script-move.mjs` raises its explicit unlinked-service error
when the scene provides no `moveActor` slot rather than approximating
movement.

### Batch 6 controlled-pawn integration

The live crouch route reaches native 266 from the original
`DeusExPlayer.SetBasedPawnSize` (`DeusExPlayer.uc:3187–3277`). Shrinking calls
SetCollisionSize before Move(centerDelta), restoring the size on failure;
growing calls Move before SetCollisionSize. The initial live check stopped
because the level service admitted only moving brushes.

The controlled pawn must take the same already-recovered `playerMove`
ULevel::MoveActor translation used by its scene collision service
([player-move.md](player-move.md)), with its canonical identity, current raw
Rotation and all four flags zero, as proved by the exec oracle above. Its
success result goes back to the unchanged script. Live Touch/UnTouch/Bump and
zone callbacks dispatch original bytecode. This is an integration of existing
native evidence, not a replacement stance calculation or a new collision
algorithm. Other receivers/flags remain bounded by their existing adapters.

## 512 `MakeNoise`

### Exec `0x103bcd20`

Evaluates `Loudness` into a zero-initialized local, then reads
`Level->Actors[0]`:

- null → `appWarnf` code `0xf1`;
- class chain that does not reach `LevelInfo` (`0x1057bf00`) → warn `0xf2`;
- both warns **continue** — there is no early return;
- `Actors[0]->+0x518 == 3` (NetMode NM_Client) skips the body entirely;
- otherwise the evaluated float is pushed and `AActor::MakeNoise` runs via
  thunk `0x103031a7`.

### Body `0x103bfad0`

`Instigator` (`+0xbc`) null returns silently. `T = XLevel->+0xdc` is a
**double** (`fld qword`); the two noise slots live on the instigator:
`noise1spot/time/other/loudness` at `+0x464/0x470/0x474/0x478`, `noise2*` at
`+0x47c/0x488/0x48c/0x490`.

**Suppression** — either slot suppresses the whole call when, in order:
`time > T - 0.2` (strict, f64 constants `0x1042b8e8`),
`|spot - Location|² < 2500` (strict, f32 `0x1043148c`), and
`loudness >= L * 0.9` (f64 constant `0x1042f570` — an f32-rounded
`0.899999976` field fails against the exact double `0.9`).

**Slot write** — first stale slot wins (`time < T - 0.18`, f64 `0x10431480`);
with both slots fresh, a near (`< 2500`) slot1 with `loud <= L` refreshes,
else `s2.loud <= L` also refreshes **slot1**, else nothing writes. Every
write stores `time = f32(T)` — the x87 `fstp` sequence discards the compare
constants, so T itself is stored, not `T-0.2`/`T-0.18`.

**Dispatch loop** — walks `Actors[0]->+0x54c` (PawnList) via `nextPawn`
(`+0x498`). When `instigator.bIsPlayer` (`+0x318` byte `& 2`) or
`instigator.Enemy` (`+0x3cc`, read only when the instigator is not a player)
is a player, the loop **skips pawns whose class reaches `PlayerPawn`
(`0x1058c160`)** — players hear through their own channel — tested before
the instigator-skip. Otherwise the bidirectional IsA against `this->Class`
is required after the instigator/`IsProbing(0x156 = HearNoise)` checks.
Survivors run the hearing gate, then
`ProcessEvent(HearNoise, {f32 L, this})` (vtable +0x10 through the
`0x10599a88` FName lookup).

The body re-runs the exec's `0xf1`/`0xf2` warns on its own path before the
loop; a null `Actors[0]` then derefs the wild `+0x54c` pointer (the port
raises its explicit field-read error at that boundary — see the
`actors-null` validator case).

### Hearing gate `0x103bf7b0`

`dist² = |listener.Location - noiseLoc|²` stored **f32**. Only for a
`bIsPlayer` listener: the LevelInfo warns repeat on the *listener's* XLevel,
then `Game` (`+0x544`), `bTeamGame` (`+0x328 & 0x200`, `test ah,2`),
`instigator.bIsPlayer`, both `PlayerReplicationInfo` (`+0x558`) non-null and
equal `Team` bytes (`+0x340`) open the team path:
`L² * 1.6e7 >= dist²` (f32 `0x10431478`) jumps straight to the line check —
**no Stimulus write, no threshold test**.

Otherwise `L² * 4e6 >= dist²` (f32 `0x10430a5c`) gates; `dist² == 0` returns
1 with no Stimulus write and no line check. Else
`Stimulus = f32(min(t, 2) * L + min(t, 0.5) * Alertness)` with
`t = f32(1.2e6 / dist²)` written to `+0x3a0` (`fst`, keeping the unrounded
f80 for the `>= HearingThreshold` compare at `+0x3ac`); finally
`FastLineCheck(XLevel->+0x98 Model, noiseLoc, listenerLoc) & 0xff` decides.

Cases (`scripts/native-make-noise-oracle.py` →
`validate-native-make-noise.mjs`, 29 cases): both suppress paths and all
three strictness boundaries (the `T-0.2` boundary slot time `f32(99.8)`
still counts as fresh), the four write-selection branches, instigator-skip,
probe mask, unrelated/super class tests, the PlayerPawn-skip alt path from
both `bIsPlayer` sources, range/zero-dist/threshold/line gate outcomes, the
alertness stimulus term (`2.5` at `t` clamp), the same-team wide-range line
check with untouched Stimulus, diff-team/no-PRI/non-team fallthrough,
NetMode skip, null instigator and the `actors-null` warn sequence.
