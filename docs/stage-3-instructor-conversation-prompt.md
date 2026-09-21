# Stage 3: complete the Training instructor conversation flow

Work in `/Users/gcc/Documents/deus_ex_web`. Implement and verify a substantial
playable feature: the original Training munitions-instructor conversation flow,
entered through ordinary player interaction, with authored dialogue, speech,
camera/UI behavior, gameplay effects and reliable termination/reset. Execute the
work, fix the issues you uncover, update the evidence, and commit locally.

This is an implementation assignment. Continue through the dependencies needed
for the playable result; discovering a missing native, writing a contract, or
passing an isolated helper test is an intermediate step. Resolve routine choices
yourself. Do not replace missing original behavior with a plausible imitation.

## Establish the actual baseline

Read `AGENTS.md`, `docs/roadmap.md` section 3, and
`docs/stage-3-completion-audit.md`. Inspect Git status and recent commits. Preserve
unrelated work. In particular, `docs/stage-3-exit-criteria.md` was an untracked
proposal at handoff; do not silently adopt its criteria or include it in your
commit. Historical task-specific limits in other prompts do not constrain this
assignment. The roadmap remains the Stage 3 authority.

Recent completed work includes NPC startup, inventory creation, wandering,
Secretary patrol, shared LoadMap passes, and the GetFrame Rust/Wasm kernel with
a JavaScript fallback. The subsequent review corrected all four Touching slots,
reset's authored startup order, and render timestamp ownership. Actual mesh draw
submissions update actor LastRenderTime. Simulation ticks never stamp all actors.
Model-zone timestamps are separate from ZoneInfo actor timestamps; original
BSP/portal visibility remains unsupported. Preserve those corrections. Headless
fixtures that require continuous observation must declare their visibility
input explicitly. Do not disable stasis to make a test pass.

Keep this work in JavaScript. Retain the existing Wasm boundary and fallback.
Do not start a performance rewrite, broad architecture cleanup, combat system,
or general renderer project. Follow necessary dependencies of this feature.

## Use the real authored conversation owners

Start with `docs/script-conversation-binding.md` and
`docs/script-native-conversation-list.md`. Existing original-game evidence says
Training `UNATCOTroop0` and `UNATCOTroop3`, both with
`BindName=MunitionsTrooper`, bind `MunitionsTrooperFrob` (`Conversation3`) followed
by `MunitionsTrooperTake` (`Conversation4`) from Mission00. Verify these canonical
identities and the current live binding before implementing. Do not attach an
invented conversation to Jaime or assume every visible NPC owns one.

The first acceptance path is a full `MunitionsTrooperFrob` conversation reached
through ordinary Play targeting/use. Then implement the authored selection and
effects needed to reach and complete `MunitionsTrooperTake` under its real
conditions. Recover those conditions from the data and scripts; the name alone
does not establish a weapon pickup or transfer contract. Both instructors share
a bind name, so verify that the invoking actor remains the correct participant.

The four Training guards currently fail mesh preview on environment-mapped
materials. A conversation with an invisible instructor is not the intended
playable deliverable. If this still blocks the selected participants, recover
and implement the necessary shared material path, using
`docs/npc-mesh-preview.md`, `docs/script-lodmesh-materials.md` and original Render
instructions as starting evidence. Do not drop the reflective flag, substitute
another character model, or invent a skin. Keep unrelated rendering work outside
scope and record any remaining presentation mismatch honestly.

## Recover the contract before changing behavior

Use the installed map/packages, embedded UnrealScript/bytecode and hash-verified
native instructions. Find the installation through `scripts/game-directory.mjs`
or `DEUS_EX_GAME_DIR`. Reuse the existing `.cache/native-probe-env/bin/python`
and focused original-DLL probes when native recovery is necessary. Keep original
assets, extracted source, binaries and captures outside Git.

Write a concise evidence document before implementing each new dependency. Trace:

1. Player targeting and use into the actor's actual `Frob` body, the player
   `StartConversation`/`CanStartConversation` gates, invocation-method filtering,
   ordered ConListItems selection, flag/item tests and participant binding.
2. The real conversation-play class, its constructor ancestry, owner/outer,
   registry membership, startup order, participant state changes and cleanup.
3. Both selected conversations' event chains, labels, branches and actions.
   Record every reached event type and the original transition order. Recover
   choices, checks, flags, transfer/action events or other dependencies if the
   authored paths reach them. Do not flatten a graph into a dialogue array.
4. Speech selection, original text/audio, durations, inter-event timing, input
   advancement and interruption behavior. Recover supported skip/cancel rules
   from the original; do not guess keyboard controls or equate media-ended with
   a script transition unless the original contract supports that binding.
5. Conversation camera ownership/placement, player input restrictions, native
   window/control construction and the exact end/abort restoration sequence.
6. Authored state after completion, repeat-interaction behavior, DataLink
   coexistence, and the public Player start/reset lifecycle.

For each contract distinguish original evidence, host service inputs and
unresolved branches. Nonvisual script/runtime behavior does not need a visual
comparison gate. Presentation does need appropriate original layout/camera
evidence; a browser screenshot alone proves only our output.

## Integrate shared behavior into normal Play

Relevant starting points, not an exhaustive edit list:

* `src/viewer/game.mjs`, `src/viewer/main.mjs`, `src/viewer/hud.mjs`:
  normal targeting/use, input, rendering and presentation.
* `src/runtime/script-doors.mjs`, `src/runtime/script-runtime.mjs`,
  `src/runtime/script-conversation-startup.mjs`: shared runtime, NPC lifecycle,
  dispatch and existing live conversation-list services.
* `src/runtime/script-conversation-*.mjs` and their evidence documents:
  native binding, construction, event binding, actions, object checks/transfers,
  clearing, speech lookup and sound duration.
* `src/runtime/script-datalink-live.mjs`, `script-infolink-shell.mjs`,
  `script-infolink-audio.mjs` and `script-play-hud.mjs`: reusable lifecycle,
  audio/resource and UI services. Face-to-face conversations must follow their
  own original class/state graph; the DataLink schedule is not a substitute.

Prepare and execute installed bytecode wherever the runtime supports it. New
native translations must dispatch through the existing VM and canonical object
graph. Extend shared construction, loader, registry, window and destruction
services only where recovered call paths require it. Preserve receiver identity,
optional/out arguments, event order, flag ownership and cleanup semantics.

Do not route production behavior by actor name, conversation title, map export
number or a hardcoded list of speech lines. Such identities belong in evidence
and fixtures. Do not add a debug-only conversation button as the acceptance
path. Do not silently swallow unsupported calls, fabricate successful return
values, force a state/flag, or install whole-function no-ops to get through a
conversation. Unsupported paths outside the selected scope remain explicit.

Finish the actual user flow: walk to the instructor, target and interact,
see/hear the authored sequence, use any authored response controls, observe its
effects, and regain the correct camera and movement control. Continue through
the second authored conversation's prerequisites and termination. This may
require several linked runtime and presentation changes; that is the intended
size of the assignment.

## Focused verification and delivery

Add an integration check entering through the same public interaction path as
Play. Assert selected conversation/participant identities, event/label order,
speech identities, reached gameplay effects, termination and input restoration.
Use original-derived assertions rather than snapshots of guessed implementation
behavior. Cover both instructors where shared BindName can change binding, the
two authored routes, relevant repeat/rejection cases, and reset during an active
conversation followed by a fresh successful interaction. Check for stale
references, duplicate actors/list nodes/windows, orphaned audio and stuck input.
Do not assume object-registry counts must shrink when original deletion defers
collection; verify the recovered ownership and release contract.

Run focused original comparisons for newly translated native boundaries. Reuse
existing evidence for unchanged helpers. Check the changed integration seams
and the existing startup regression, Secretary patrol, MIB wandering, NPC weapon
startup, conversation binding and Training DataLink routes as applicable. Run
`npm test` and `npm run build`. A full validator sweep is only warranted by a
concrete broad concern; if needed use `npm run validate -- --jobs 4`.

Use a real browser to demonstrate ordinary Play interaction and the complete
visible flow, including termination and Player start. A debug reposition may
help research or test setup, but also record reproducible user-facing directions
from the Training spawn; the feature must not require a hidden API. Check page
errors and runtime boundary reports. Keep local screenshots and original-game
captures out of Git. Report exactly what visual/audio comparisons were made.

Update the feature evidence and `docs/stage-3-completion-audit.md` to describe the
final implementation and remaining gaps. Review the diff, remove temporary
instrumentation, commit the completed work locally, and leave unrelated changes
alone. Do not push or deploy.

Your final handoff must give the commit hash, exact steps to play both authored
paths, concrete visible improvements, original evidence and passing validation,
and any remaining blockers. Do not claim Stage 3 complete or assign a percentage
because these routes pass. If a required original behavior truly cannot be
established, finish independent useful work, identify the exact evidence gap,
and report the feature as incomplete; do not disguise it with a substitute.
