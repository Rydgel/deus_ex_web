# Original `AActor::FinishAnim` (native 261)

This contract is recovered from the installed GOTY `Engine.dll`, its
disassembly in `.cache/reference/Engine.asm`, and the linked `Actor.uc`
declaration.  It covers the native exec body and its latent poll.  It does not
invent an animation clock or renderer tick; those systems are separate.

The binary used here is Engine.dll SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4` with
image base `0x10300000`.

## Entry points and fields

`Actor.uc` declares:

```text
native(261) final latent function FinishAnim();
```

The exported exec thunk at `0x103037ba` is `e9 a1 c7 0d 00` and jumps to the
body at `0x103dff60`.  The latent poll thunk at `0x1030240a` is
`e9 91 dc 0d 00` and jumps to `0x103e00a0`.  Both wrappers return with
`ret 8`, matching an `FFrame*` argument and the native result slot.

The body reads these original offsets:

| offset | logical field | use |
| ---: | --- | --- |
| `Actor+0x0c` | StateFrame | poll target |
| `Actor+0x28` | first Actor flag word | `bAnimFinished`, `bAnimLoop` |
| `Actor+0x54` | `AnimSequence` | zero means no animation |
| `Actor+0x58` | `AnimFrame` | signed/ordered progress gate |
| `Actor+0x5c` | `AnimRate` | gate when frame is nonnegative |
| `Actor+0x60` | `TweenRate` | gate when frame is negative |
| `Actor+0x220` | `AnimLast` | final progress comparison |
| `StateFrame+0x24` | latent/action word | install or clear `0x181` |

`Actor.uc` declares the first three animation flags in this word as
`bAnimFinished=0x08`, `bAnimLoop=0x10`, and `bAnimNotify=0x20`.

## `execFinishAnim` body

The first operation is unconditional:

```text
Stack.Code = Stack.Code + 1;       // FFrame +0x0c, 32-bit wraparound
```

It then reads `Actor+0x28`.  When `bAnimLoop` is set, the low byte is ANDed
with `0xe7`; this clears `bAnimFinished` and `bAnimLoop` (`flags &= ~0x18`)
while preserving the low bit, `bAnimNotify`, and all high flag bits.  If the
loop bit is clear, no flag store occurs.

If `AnimSequence` is zero (`None`), the body returns at once.  Otherwise the
x87 comparisons select one ordered nonzero rate gate:

```text
if (AnimFrame < 0 || unordered(AnimFrame, 0))
    gate = TweenRate;
else
    gate = AnimRate;

if (unordered(gate, 0) || gate == 0)
    return;

if (AnimFrame < AnimLast || unordered(AnimFrame, AnimLast))
    StateFrame.LatentAction = 0x181;
```

The first and final comparisons are `fcomps` and test C0.  C0 is set for
less-than or unordered, so a NaN `AnimFrame` selects `TweenRate` and a NaN
`AnimLast` reaches the latent store when the selected rate is ordered and
nonzero.  The rate comparisons are `fcompl` and test C3 for equality or
unordered; a NaN `AnimRate`/`TweenRate` therefore returns without installing a
latent action.  Equality and greater-than `AnimFrame`/`AnimLast` also leave an
existing latent value unchanged.

No animation field is advanced or rewritten by this native.  In particular,
the helper must not simulate `AnimFrame += DeltaSeconds`.

## `PollFinishAnim` latent action `0x181`

The poll body at `0x103e00a0` performs only:

```text
if (Actor.Flags & 0x08)
    Actor.StateFrame.LatentAction = 0;
```

It does not inspect `AnimSequence`, rates, frames, or `AnimLast`, and it does
not clear the animation flags.  If `bAnimFinished` is clear, the existing
latent value is retained.

## Isolated host helper

`src/runtime/finish-anim.mjs` exposes the recovered operations over the
existing `animationView` shape:

```js
execFinishAnim({animation, frame, state});
dispatchFinishAnim({animation, state});
pollFinishAnim({animation, state});
```

`execFinishAnim` models a raw native call and increments `frame.code`.
`dispatchFinishAnim` runs the same body after the decoded ScriptVM has already
advanced its bytecode cursor; it intentionally performs no second synthetic
increment.  `state` is the logical state-frame object containing `latent`.
The separate [animation tick](script-animation-tick.md) now sets the linked
finished flag from original frame progression; Jaime's integration check drives
the helper, tick and ProcessState poll without a synthetic completion flag.
General actor scheduling and rendering remain separate boundaries.

`test/finish-anim.test.mjs` covers flag mutation, both rate gates, exact
comparison outcomes, NaN/unordered behavior, raw Code advancement, decoded
dispatch, and the poll.  `scripts/validate-native-finish-anim.mjs` pins the
installed DLL hash, PE-resolved thunk/body bytes, zero constants, field
offsets, and the translated calls.
