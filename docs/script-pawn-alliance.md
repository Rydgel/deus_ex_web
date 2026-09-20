# ScriptedPawn enemy and alliance queries

Training `mib1` selects BreatheLight in its first startup tick, then its second
Tick reaches `ScriptedPawn.CheckBeamPresence -> IsValidEnemy(player)`. Native
2105 was unsupported, so the Play host permanently removed him from ticking
while AnimFrame was still negative (the transition from Fighter). This caused
the reported stuck, outstretched pose. Choosing an idle pose in the renderer
would bypass the original state transition.

## Contract recovered before translation

Authority: installed GOTY DeusEx.dll SHA-256
`b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04`,
embedded ScriptedPawn declarations/CheckBeamPresence, and linked properties.
Local disassembly stays in `.cache/research/is-valid-enemy.asm` and
`pawn-alliance.asm`; property offsets were checked against the shared loader.

* Native 2105 exec `10018f80..10018ff4` evaluates Pawn (initial null), then
  optional bool (initial **true**, including EX_Nothing), advances the argument
  terminator and stores the worker's dword return. Worker `10019300..1001941e`
  rejects null, self, bDeleteMe (+28 mask80), !bDetectable (+2c mask1), and
  signed Health (+428) <=0 in that order. If alliance checking is enabled,
  GetPawnAllianceType must return Hostile (2); otherwise return 1. No writes.
* GetAllianceType worker `10019420..100194c6` defaults to Neutral (1).
  Non-None names scan exactly 16 AlliancesEx entries, first match wins. Entries
  start at +7ec, stride16: FName, float AllianceLevel, float AgitationLevel,
  permanent-bit storage. A negative **or unordered** AllianceLevel is Hostile;
  otherwise ordered AgitationLevel >= double 1 is Hostile; otherwise positive
  AllianceLevel is Friendly (0), zero is Neutral. bLikesNeutral (+6c8 mask100)
  converts Neutral to Friendly. bReverseAlliances (+8ec mask1) then swaps
  Friendly/Hostile and retains Neutral. Native 2106 exec `10019050..1001909b`
  evaluates one name and stores only the result byte.
* GetPawnAllianceType worker `100194d0..10019565` returns Neutral for null.
  For ScriptedPawn ancestry (original UClass identity +1003c020), first query
  the other pawn's opinion of the receiver's Alliance (+5c4). Then always query
  the receiver's opinion of the other's Alliance. Hostility on the first query
  overrides the second; otherwise the second wins. Native 2107 exec
  `10019000..1001904b` evaluates one Pawn and stores only the result byte.

The native exception-reporting paths require original engine failure handling
and remain outside these normal-return contracts. These functions do not
implement perception, pathfinding, combat or conversation startup.

## Focused verification and remaining MIB boundary

`node scripts/validate-pawn-alliance.mjs` compares 31 cases with the unchanged
original exec wrappers and workers: argument defaults, enemy rejection gates,
mutual hostility, first/last alliance slots, postprocessing flags, unordered
float comparisons, result width, frame advance, call order and read-only actor
memory. Original reference output was captured before the JavaScript translation
in `.cache/research/pawn-alliance-original.json`. The controlled class/actor
memory and literal evaluators are the only supplied graph boundaries.

`node scripts/validate-mib-startup-boundary.mjs` exercises the real Training Play
host, script dispatch and linked class/property storage. At seed 1 and 1/60-second
frames, the MIB passes `IsValidEnemy`, progresses through the BreatheLight
tween, lands, and — since the 2026-09-20 native-709 integration — executes
`ScriptedPawn.Wandering.PickDestination -> AIPickRandomDestination` through
the recovered exec chain and wanders (~98 u on load, ~100 u after reset,
continued successful pick episodes through 1920 ticks, zero NPC failures).
This is a runtime integration check, not an original-game visual comparison.

The former 709 boundary is resolved: exec `103029b9` -> `103c86f0`, worker
`1030181b` -> `103c7fc0`, direction helper `10301f0f` -> `1036d030`, and
destination-search helper `103011d6` -> `103c78a0` are ported and oracle-verified
in [pawn navigation](script-pawn-nav.md). The search's collision test moves run
the recovered test-mode `MoveActor` contract (`bTest=1, bIgnorePawns=1`) against
the live collision hash, with `FarMoveActor` restore after each search.
