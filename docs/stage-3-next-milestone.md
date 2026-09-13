# Next playable Stage 3 milestone

Status: implemented and focused-validation complete under the recommended 10,000-token cap. This is one
increment toward the full Stage 3 objective, not a replacement completion gate.

Make the original Training dark-room door pair usable in Play:
DeusExMover19 and DeusExMover20, Tag `darkdoor`, Event `padoor`, original
TriggerToggle state, two keys and MoveTime 2 seconds. Their locations are
`[4320,816,-128]` and `[4320,880,-128]`.

## Evidence and starting state

- Installed `00_Training.dx`, decoded through the existing ClassDefaults loader,
  supplies those values. A scan of every map actor with inherited defaults
  finds no Tag `padoor` recipient. Reproduce that assertion in the focused check.
- `src/runtime/script-doors.mjs` currently rejects every nonempty mover Event.
- Original Mover/DeusExMover script controls completion and event enumeration;
  reuse those bodies and the complete canonical map actor array. Inspect the
  actual reached event statements before changing the admission guard.
- The existing TriggerToggle timing, interpolation, collision, reversal and
  reset evidence is reusable. New verification should target event enumeration
  and admission/integration, not repeat the native physics corpus.

## Completion criteria

1. Player use in Play targets the original pair and starts their original
   opening script. Both panels reach their authored second key.
2. The original named-event enumeration executes with zero matching recipients;
   no host substitute suppresses or fabricates event behavior.
3. The player can walk through the opened doorway without collision errors.
4. A second use closes the pair; Player start reset restores original positions
   and script state. The existing starting doors continue to work.
5. A focused integration check passes, the build succeeds, and a browser check
   confirms the interaction is reachable and visibly opens the pair.

## Result

All five criteria pass. Player use now admits the pair only after scanning the
complete canonical Training actor array and proving that `padoor` has no tagged
recipients. The installed `Mover` bytecode still executes native 304
`AllActors`: each panel creates one iterator on open and close, advances it once,
and receives zero matches. Both panels reach key 1 after their authored two
seconds, the player crosses the opened doorway through normal movement, second
use closes the pair, and reset restores the initial key and offsets. The
previously supported starting-door pair remains usable.

`scripts/validate-stage3-dark-doors.mjs` records those assertions. The focused
validator, all 11 movement tests, and the production build pass. In the local
browser, **Dark door preview** uses the regular `game.use()` route and visibly
opens the pair while reporting the zero-recipient `padoor` fanout.

No percentage is assigned to this milestone. Report completed criteria and
observed blockers. Do not expand into DataLink, native UI allocation, AI, damage,
audio, unrelated doors, or broad runtime cleanup during this run.

## Usage rule

The user accepted work after the cap choice was presented, so this run used
the recommended 10,000-token working cap. Reserve part of it for validation
and handoff. All delegated work counts toward the working cap. Stop with a
truthful checkpoint if the cap is reached; do not mark this milestone or Stage 3
complete unless the corresponding criteria are proven.
