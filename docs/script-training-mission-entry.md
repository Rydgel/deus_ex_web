# Training mission entry and the unconscious cadet

Original evidence for the standing-cadet report, established before wiring a
fresh mission entry into Play. This is separate from an empty-travel-text,
direct `SpawnPlayActor` login, which alone does not start a new mission.

## Entry contract

Installed `DeusExPlayer.StartTrainingMission` resets skills/player for Training,
sets `bStartingNewGame`, and calls `Game.SendPlayer(Self,"00_Training")`.
`Engine.GameInfo.SendPlayer` calls `ClientTravel(URL,TRAVEL_Relative,true)`.
Engine.dll's SetClientTravel tail at `0x1038fb43–0x1038fb99` walks the live
level actor array, finds each actor's `PreTravel` function by name (literal
`0x1047f080`), and dispatches it when present. Installed
`DeusExPlayer.PreTravel` sets `PlayerTraveling=True`, adds it if absent and
sets expiration **0**, then saves skill points, aborts DataLinks and
extinguishes fire. Extension.FlagBase's hash table/default expiration and
the flags themselves are declared travel properties.

On the new map, `MissionScript.Timer` calls `InitStateMachine` while its
`flags` is None. That obtains the logged-in player and FlagBase; with
PlayerTraveling true it deletes expired flags for the current mission, sets
default expiration to mission+1 and resolves the uppercase localURL. The
same Timer then calls `FirstFrame` only if PlayerTraveling is true.
`MissionScript.FirstFrame` deletes that marker, handles important-NPC death
flags, startup messages, goals and conversation history. Savegame entry
deliberately lacks the marker and must not repeat FirstFrame.

Installed `Mission00.FirstFrame` then sets player skill points to zero. For
`00_TRAINING`, it finds `UNATCOTroop` tagged `Test_Subject`, sets HealthTorso
and Health to 0, sets bStunned, and calls
`TakeDamage(1,troop,troop.Location,vect(0,0,0),'KnockedOut')`.
The map's target is `UNATCOTroop2`; `PickupDistributor0` has already given
him the NanoKey with KeyID `Body_Search_Room` and description `Medical Room`.

`ScriptedPawn.Dying` waits for landing and the death animation, calls
SpawnCarcass, then Destroy. SpawnCarcass sets bNotDead from bStunned,
initializes the original CarcassType, positions it on the floor and moves
the inventory into it. `DeusExCarcass.Frob` transfers NanoKeys through
player.PickupNanoKey; a later empty-handed frob can carry the empty body.
The original `DL_body` speech explicitly says the cadet is already lying
unconscious and instructs the player to search him and carry him to the
medical table. There is no player knockout or replacement weapon required.

## Newly reached flag operations

Authority: hash-verified Extension.dll
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`,
disassembled locally in `.cache/reference/Extension-annotated.asm`.

* Native 1121 (`execDeleteFlag 0x10025b40`) reads Name and byte EFlagType.
  `DeleteFlag 0x10024860` looks up that exact name/type; missing returns 0.
  Present calls the flag's deleting destructor (`vtable+0x0c`, argument 1)
  and returns 1. The existing live bool store projects the resulting removal;
  non-bool setters and native flag-node allocation remain outside that store.
* Native 1124 (`execDeleteExpiredFlags 0x10025d40`) reads a signed int and
  calls `0x10024ac0`. It iterates all flag types, prefetching the next entry
  before deleting the current one. At `0x10024b3b–0x10024b4d`, expiration 0
  is always retained; any other signed expiration <= criteria is deleted.
  Thus for criteria 0, negative expiration is removed, 0 and positive are
  kept; for criteria 1, -1 and 1 are removed but 0 and 2 are kept. Equality
  expires. This is a mission-number comparison, not a wall-clock timeout.

## Browser entry boundary

The previous cold login leaves PlayerTraveling absent: the cadet remains
healthy/standing with the key. A diagnostic carrying the original true/zero
marker reaches native 1124 on the first mission timer at about one second.
This confirms the skipped branch rather than a missing player weapon.

The browser's fresh mission entry must supply that original marker to the
new player's FlagBase before the first level tick, then let the original
mission, damage, animation, carcass and frob bodies run. It must not force
the cadet's state, manufacture a key, or call FirstFrame directly. This
bounded entry condition is not an implementation of menu-level travel,
arbitrary incoming travel data or savegame restoration.

The Stage 3 gate measures this input rather than trusting the comment: the
probe library records every FlagBase.SetBool that the host issues with no
script frame on the stack, and the gate prints `flag PlayerTraveling` as a
Stage 6 (travel) host input. Any other host-written flag is an unclassified
substitute and fails criterion 5.

## Carrying and dropping the body: ObjectToString

The original `DeusExCarcass.Frob` assigns `String(Class)` to
`POVCorpse.carcClassString`. `DeusExPlayer.DropItem` later passes that string
to DynamicLoadObject with `class'Class'`, spawns the resulting carcass and
copies the unconscious-body fields back. Returning only `UNATCOTroopCarcass`
from the cast made this original drop path fail at package resolution.

Core.dll `execObjectToString` body `0x10131f00` evaluates its object operand;
None selects literal `None` at `0x101aaf80`. For a non-null object,
`0x10131f31–0x10131f35` calls `GetPathName(NULL,NULL)` (thunk `0x101027ac`,
body `0x1014fc10`). That body recursively follows Outer at +0x18, appends a
dot between levels, then the object's FName at +0x20. It does not return only
GetName, prepend a class label, or lowercase the spelling. Therefore the
carcass Class export becomes `DeusEx.UNATCOTroopCarcass`. Canonical package
export paths encode this Outer chain; constructed objects use their live
native object/outer records. Native flag-object ownership remains the
separately documented projection, not part of this string conversion fix.

The ensuing `DynamicLoadObject(...,class'Class')` must use the shared native
class/linker graph, whose UClass identity, Outer, export hash and CreateExport
are already recovered. The focused resource graph may also own assets in
DeusEx, but lacks native Core.Class metadata; selecting it solely by package
name raised an unresolved class-Outer boundary. Class requests now select
the existing class graph; ordinary prepared texture/sound requests retain
their resource graph. No carcass-class lookup is hardcoded or fabricated.

## Destroyed pawn collision identity

The existing recovered `AActor.Tick` continues into physics after its state
body returns. Here the Dying state has just called Destroy. The original
hash AddActor (`0x103580b0`) skips actors with Actor+0x28 bit `0x80`, bDeleteMe
([collision hash](collision-hash.md)). The pawn physics view reads that live
field, but the registered map identity previously retained its initial
`actorFlags` word. A subsequent physics registration could therefore reinsert
the destroyed standing pawn. Bind bDeleteMe writes to that same host word as
well as script storage, preserving the native hash gate; do not filter it out
only in the interaction trace or change the recovered tick order. Since stage
1e step 1 the host word is the image's `+0x28` dword itself
([Rust core](rust-core.md) 1e-1), so no binding is needed.
Player start restores that bit from the serialized map before re-registering
each collider; otherwise one-shot triggers destroyed in the previous session
would remain absent from the rebuilt hash.

## Focused validation

`validate-training-cadet.mjs` checks the original pre-tick living pawn and
distributed key, one FirstFrame consumption, the original unconscious-body
creation and inventory transfer, visible carcass/removal of the standing mesh,
normal view tracing and public search, key-ring unlock, carry and installed
Tab drop, the medical-table trigger opening both authored exit doors, and a
fresh setup after reset. Placement isolates the exercise; it does not inject
health, flags, inventory, carcasses or door outcomes. The source/native
contracts above establish original behavior; this check tests the translation
and its integration, not a new visual comparison with the original game.
