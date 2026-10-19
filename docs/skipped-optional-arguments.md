# Skipped optional arguments (EX_Nothing) at native calls

Audit of 2026-10-19. It checks every native that a shipped script calls with a skipped optional argument, such as
`PlayAnim('Attack',,0.1)` or `SetBool(flagName, value,, expiration)`. For each one it compares the exec thunk's pre-stored slot
values with Play's JavaScript body and the Rust lowering. The audit followed the AICanSee finding: `execAICanSee` (Engine.dll
`0x103c8270`) pre-stores visibility 1.0f, so `AICanSee(x, , false, ...)` sees with 1.0, while Play read the skipped visibility as
NaN and returned 0. Commit `2ea38c3` fixed that.

## The original rule

A native's exec thunk reads each argument with the `P_GET_*_OPTX(var, default)` shape. It stores `default` into the argument's
slot (`mov [slot], default`, or a copy of a live field), then steps the caller's next token into that slot (`Stack.Step`, an
inline `call [GNatives + token*4]`). A skipped argument is the token EX_Nothing (0x0b), and stepping it writes nothing. So a
skipped argument keeps the pre-stored default, exactly as an omitted trailing argument does. A default that copies a field is
sampled at that point in the argument sequence, after the earlier arguments have been evaluated.

The compiler (as shipped) never emits EX_Nothing for omitted trailing arguments. It ends the list with EX_EndFunctionParms
instead, and `scripts/census-skipped-arguments.mjs` finds no trailing EX_Nothing in any package. So only a hole before a given
argument reaches a native. In Play, such a hole reaches the native body as `undefined` (`script-vm.mjs` `case 0x0b`). In the Rust
lowering it is a cleared presence word. Each native body must map that to the thunk's default, never to `Number(undefined)` (NaN)
or `Boolean(undefined)` (false).

Authorities: Core.dll `8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`, Engine.dll
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`, Extension.dll
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`. Exec bodies were resolved from each DLL's exported
`?exec…@@QAEXAAUFFrame@@QAX@Z` symbol (following the E9 thunk), then disassembled with capstone up to the last argument step.

## Call sites

`node scripts/census-skipped-arguments.mjs` decodes every function and state in Core, Engine, Extension, ConSys, DeusEx,
UWindow, Fire, IpDrv and UBrowser. It lists each call that has an EX_Nothing argument as hole positions / argument count ×
sites. A scan of the embedded `.uc` sources found the same 14 natives.

| Native | Holes / argc × sites |
| --- | --- |
| `Actor.Spawn` (278) | 1,2/4×158, 2/5×51, 1,2/5×37, 2/4×15, 2,3/5×3, 1/5×1 (265) |
| `FlagBase.SetBool` (1100) | 2/4×188 |
| `Actor.PlaySound` (264) | 2,3/5×65, 3/5×29, 3/6×21, 3,4/6×10, 2,3,4/6×9, 1,2,3/5×7, 2,3/6×7, 1,2,3/6×6, 1/3×2, 2/4×2 (158) |
| `Actor.PlayAnim` (259) | 1/3×49 |
| `Pawn.AICanSee` (705) | 1/6×9 |
| `Actor.LoopAnim` (260) | 1/3×8 |
| `Actor.AISendEvent` (713) | 2/4×7 |
| `Actor.PlayOwnedSound` (no index) | 2,3/5×5, 3/5×1 |
| `Actor.AISetEventCallback` (710) | 2/7×4 |
| `Object.GotoState` (113) | 0/2×3 (Mover) |
| `Actor.PlayBlendAnim` (1010) | 2/4×2 |
| `Actor.AIStartEvent` (714) | 2/4×1 |
| `ButtonWindow.SetButtonTextures` (1592) | 0/4×1 (ConWindowActive.DisplayChoice) |
| `ButtonWindow.SetButtonColors` (1593) | 0/4×1 (ConWindowActive.DisplayChoice) |
| EX_New (0x11, Core execNew) | 1,2/4×22, 0,1,2/4×15, 2/4×2 |

Every other hole is at a script function (`LoopAnimPivot`, `PlayAnimPivot`, `SetEnemy`, `TryLocation`, `SetOrders`, `AddNote`,
`AISafeToShoot`, `FindTaggedActor`, and UWindow/UBrowser/TestInfo functions). None of those names is native in any package. The
two `MenuChoice_*Volume` calls `PlaySound(…, SLOT_None,, True)` are `Player.PlaySound` (264), not `Window.PlaySound` (1473), which
has no skipped-argument site.

## Thunk defaults and Play

| Native | Exec body | Pre-stored slots, in step order | Play | Result |
| --- | --- | --- | --- | --- |
| Spawn 278 | Engine `0x103e36d0` | class 0, owner 0, tag None, Location = `this+0x114` (copied at `0x103e373f`, after the tag step), Rotation = `this+0x120` (`0x103e377a`) | `script-spawn.mjs:12` `argument(i)` undefined keeps the default; Location/Rotation read between argument evaluations | matches |
| SetBool 1100 | Extension `0x10024fc0` | name None, value 0, bAdd 1, expiration `0xffffffff` (-1) | `script-triggers.mjs:360` passes `undefined` to `setBool` (`:154`): bAdd true, expiration -1 | matches |
| PlaySound 264 | Engine `0x103e1f60` | Sound 0, Slot 1 (SLOT_Misc), Volume = `this+0x1cc` TransientSoundVolume, bNoOverride 0, Radius = `this+0x1d0` TransientSoundRadius, Pitch 1.0f. After P_FINISH, a Radius ≤ 0.0 or unordered becomes 800.0f (`0x103e2122`) | `script-sound.mjs:76`: `argument(i, initial)` reads each live default before its step | matches |
| PlayAnim 259 | Engine `0x103e0160` | Sequence None, Rate 1.0f, TweenTime **-1.0f** (`0xbf800000`) | `script-runtime.mjs:3816`: rate 1, tween -1 | matches |
| LoopAnim 260 | Engine `0x103e05e0` | Sequence None, Rate 1.0f, TweenTime -1.0f, MinRate 0 | `script-runtime.mjs:3816`: MinRate `?? 0` | matches |
| PlayBlendAnim 1010 | Engine `0x103e0d80` | Sequence None, Rate 1.0f, TweenTime -1.0f, BlendSlot 0 | `script-runtime.mjs:3849` | matches |
| AICanSee 705 | Engine `0x103c8270` | other 0, visibility 1.0f, flags 1, 1, 0, 1 | `script-pawn-perception.mjs:577` and `percep.rs` `ai_can_see` | fixed in `2ea38c3` (see below) |
| AISetEventCallback 710 | Engine `0x1036d440` | event, callback, scoreCallback None; bCheckVisibility 1, bCheckDir 1, bCheckCylinder 0, bCheckLOS 1 | `script-runtime.mjs:1920` `aiEventNative`: score `''` gives name id 0 (None), checks true, true, false, true | matches |
| AISendEvent 713 / AIStartEvent 714 | Engine `0x1036d750` / `0x1036d8e0` | event None, type 0, Value 1.0f, Radius 800.0f (`0x44480000`) | `aiEventNative`: value 1, radius 800 | matches |
| GotoState 113 | Core `0x1013dd00` | NewState = the current state's name (StateFrame's StateNode when it is not the class, else None), read before either step (`0x1013dd02`–`0x1013dd2b`); Label None | `script-runtime.mjs:4047` reads `current` before evaluating either argument | matches |
| SetButtonTextures 1592 | Extension `0x10008690` | all six textures None | `script-window-host-natives.mjs:185`: `arg(i, null)` (`:37` maps `undefined` to the fallback) | matches |
| SetButtonColors 1593 | Extension `0x100087b0` | each colour R = G = B = 0xff; alpha never written (a stale stack byte for the first, the FFrame* slot's top byte for the rest) | `script-window-host-natives.mjs:187`: `0x00ffffff` | matches RGB; alpha 0 is the recorded approximation at `script-window-host-natives.mjs:24` |
| PlayOwnedSound (no index) | Engine `0x103e29d0` | same as PlaySound: Slot 1, Volume `this+0x1cc`, bNoOverride 0, Radius `this+0x1d0`, Pitch 1.0f | not bound | unsupported (multiplayer): every site is `DeusExWeapon.PlaySimSound` or `SpawnEffectSounds`, reached only when `Level.NetMode != NM_Standalone` |
| EX_New | Core `0x1013d9f0` | Outer = `this` when `this->Index != INDEX_NONE`, else NULL (`0x1013d9f3`–`0x1013da08`); Name None, Flags 0, Class NULL. Afterwards a NULL Outer becomes GetTransientPackage (`0x10102450`) | `script-vm.mjs:1173` / `:1416`: a skipped name is None and skipped flags are 0 | matches for every DeusEx site (all `1,2/4`, Outer given). A skipped Outer throws in `newObject` (`script-runtime.mjs:884`); only UWindow, UBrowser and `Engine.TestInfo` skip it |

`Window.PlaySound` (1473, Extension `0x10053820`) has no skipped-argument site. Its omitted trailing defaults are volume -1.0f,
pitch 1.0f, posX = width (`+0x80`) × 0.5, and posY = height (`+0x84`) × 0.5. `windowPlaySound` (`script-window-sound.mjs:22`)
gives the same.

### AICanSee

AICanSee is the one mismatch. Its fix, `2ea38c3`, is on `claude/wizardly-almeida-b07768`, not on master as of `4ef4a2c`. Until
that branch merges, `execAICanSee` reads the skipped visibility as `Number(undefined)` (NaN), and the Rust path
(`percep.rs` `ai_can_see`, whose `argc > 1` branch takes `values[1]`, the UNDEF_F64 NaN) returns 0. The pre-fix code affects all
nine sites: `FindBestEnemy`'s `CheckEnemyParams`, the order and beam tests in ScriptedPawn, and `Animal`'s food test.

## Rust lowering

- `perception()` in `script-vm-lower.mjs` (natives 2105, 2107 and 705) is the only native lowering that carries presence words.
  Of those three natives, only 705 has a skipped-argument site.
- `gcEffect` gives a call with an EX_Nothing argument to JavaScript.
- Script calls (`call()`, K.CALL) lower a hole to `P_SKIP` (`interp.rs:1470`), which leaves the callee's slot untouched. Both
  frame allocators zero the block first: `vm_frame_push` (`interp.rs:550`, `write_bytes` 0) and `FrameStack.push`
  (`script-frame-locals.mjs:53`). That matches CallFunction's zeroed temporary block (docs/script-execution.md). `callFunction`
  in JavaScript likewise leaves the zero local for an `undefined` argument. So a skipped script optional parameter reads 0, and a
  native receives `undefined` only from a literal EX_Nothing at its own call.
- `beginCall` (`script-vm-rust.mjs:1007`) returns -1 for a native target, so the whole call runs in JavaScript with its
  `undefined` arguments.

## Open

- SetButtonColors' omitted alpha is not recoverable. The existing note gives why no script observes it.
- EX_New with a skipped Outer, and PlayOwnedSound, stay unsupported. No single-player site reaches either one.
