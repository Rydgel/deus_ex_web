# PawnList linkage

Original APawn.execAddPawn529 (10301f5a→103bb430) advances the argument bytecode,
then writes pawn.NextPawn+498=LevelInfo.PawnList+54c at103bb4b1–b7 and
LevelInfo.PawnList=self at103bb51c. It unconditionally prepends. Calling it twice
on the current head creates a self-loop: no membership guard is native here.

RemovePawn530 (10301c94→103bb570) replaces the head when self is head, otherwise
traverses NextPawn looking for a predecessor and replaces its link with self.NextPawn
at103bb686–8c. Absent self is a no-op. Removed self.NextPawn is not cleared.

Pawn.uc PreBeginPlay880 calls AddPawn before Super.PreBeginPlay and before its
bDeleteMe guard. PostBeginPlay929 does not add. PostNetBeginPlay936–955 scans the
current live list and adds only if self is absent. Pawn.Destroyed837–858 calls
RemovePawn before Super.Destroyed. Preserve decoded live PawnList and NextPawn
identity when restoring existing state; do not replace it with actor-array order.
A newly spawned player whose PreBeginPlay executes joins at the head of whatever
live list exists then. If rebuilding from initial startup callbacks, prepend in
the actual callback execution order, making the resulting list reverse that order.
This does not establish arbitrary subclass startup callbacks or a complete startup VM.

Ten original controlled list graphs cover empty/add/head/middle/tail/absent
removal and duplicate add. They compare full head/link fields including the stale
removed link. Helpers expose only original mutations; callers own duplicate
avoidance where PostNetBeginPlay requires it and valid acyclic input for removal.

## Loaded-level initialization audit

The initial loop is now traced and captured. UGameEngine.LoadMap103033a5→1038c1f0
skips initial startup when LevelInfo.bBegunPlay(+4f0 mask0x2) is already set at
1038d6f6–fe. For a fresh level it initializes actor script execution in ascending
array order at1038d869–83, sets begun/startup flags1038d894, calls Game.InitGame,
then dispatches all PreBeginPlay events in a separate loop1038d99a–1038d9cc.
The index starts zero; each iteration reloads engine.Level(+68).Actors(+2c) and
Num(+30), skips null, resolves name global1058364c and dispatches ProcessEvent.
The index increments at1038d9cb. The BeginPlay loop follows at1038d9ce–1038da00.
New entries appended during PreBeginPlay can therefore be visited later in the
same loop; this is not a snapshot of initial actors.

`audit-pawn-startup.mjs` decodes all Level.Actors entries and original class ancestry
without filtering bCollideActors. Training has22 Pawn descendants and Liberty63.
Neither LevelInfo properties/defaults nor pawn properties/defaults contain a
nonnull PawnList/NextPawn. All85 happen to be collidable; that fact is data, not
an iterator rule. All difficulty and single-player flags are enabled, Odds1.
Original source text extracted from every relevant superclass shows only these
PreBeginPlay overrides: ScriptedPawn431 calls Super447; PlayerPawn2972 sets
bIsPlayer and calls Super2975; Pawn878 calls AddPawn880 before Actor.PreBeginPlay.
No selected class bypasses AddPawn. Actor.PreBeginPlay may destroy irrelevant
actors through Game.IsRelevant, which causes RemovePawn in Pawn.Destroyed.
Default difficulty flags do not remove these85; custom mutators/NoMonsters and
later mission/script lifecycle effects are outside this list-order capture.

`native-pawn-startup-oracle.py` executes the original LoadMap loop with actual
pawn slot positions and null nonpawn slots. Controlled ProcessEvent bodies invoke
original AddPawn. Original loop control, null skipping, actor-slot reads and link
writes execute natively. The results exactly match the following authored-pawn
order. This explicitly isolates the order contract: nonpawn script events,
startup spawns/destruction and full Game.InitGame are not replaced with an
assertion that they have no effect. A later JC PreBeginPlay prepends to the live
result; callers must include all additional pawns actually created by startup.

**Admission correction:** the `Camera` entries below are a serialized-ancestry
census, not the live list. The standalone `ULinkerLoad::CreateExport` refuses
them (and the `Brush` exports) before construction — `RF_LoadForEdit`-only
flags and the `NAME_Camera` class gate — so they never run `AddPawn` and never
join `Level.PawnList`. See [map actors](script-map-actors.md#standalone-export-admission).
The real standalone PawnList therefore starts at the first admitted pawn
(`UNATCOTroop3` for Training), not the cameras.

Run `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node
scripts/validate-native-pawn-startup.mjs`. The audit includes actor-slot numbers,
ancestry, raw/default links and properties in ignored startup.json; native list
identities/hashes are in startup-native.json. Original script extracts remain in
ignored .cache/research/pawn-startup.

00_Training authored head→tail:

Camera7, Camera6, Camera5, Camera4, UNATCOTroop3, UNATCOTroop0, Doctor0, UNATCOTroop2, Doctor1, ScientistFemale1, RepairBot0, MedicalBot0, mib1, WaltonSimons0, Secretary0, ScientistFemale0, JosephManderley0, UNATCOTroop1, JaimeReyes2, JaimeReyes1, ScientistMale0, JaimeReyes0.

01_NYC_UNATCOIsland authored head→tail:

Camera11, Camera10, Camera9, Camera8, Camera7, TerroristCommander0, Terrorist10, Terrorist1, MedicalBot6, MedicalBot5, MedicalBot4, MedicalBot3, MedicalBot1, MedicalBot0, BumFemale0, HarleyFilben0, UNATCOTroop9, UNATCOTroop8, UNATCOTroop7, UNATCOTroop5, UNATCOTroop4, SecurityBot1, Terrorist9, Terrorist8, UNATCOTroop3, Terrorist7, Terrorist2, UNATCOTroop6, UNATCOTroop0, Terrorist36, ThugMale0, Terrorist31, Terrorist30, Terrorist35, Terrorist34, Terrorist33, Terrorist32, Terrorist29, Terrorist27, Terrorist4, UNATCOTroop1, Terrorist24, Terrorist22, Terrorist21, Terrorist20, Terrorist18, Terrorist16, Terrorist15, Terrorist14, Terrorist13, Terrorist12, Terrorist6, Terrorist3, Terrorist0, PaulDenton0, SecurityBot0, UNATCOTroop2, SecurityBot3, GuntherHermann0, ThugMale9, ThugMale7, ThugMale5, ThugMale3.
