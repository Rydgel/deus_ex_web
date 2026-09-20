# Full-day Stage 3 implementation prompt

Work in `/Users/gcc/Documents/deus_ex_web` on the original Deus Ex browser
reimplementation. Treat this as a full working day of autonomous implementation.
Your objective is to make as much verified progress toward the actual Stage 3
exit criteria as possible, beginning with the stuck Training MIB and continuing
through the remaining runtime blockers. Aim to complete Stage 3 if the evidence
supports it; do not assume it can be finished in one day.

Execute the work. Do not stop after producing a plan, diagnosing the first
missing native, finishing one small slice, or writing a status report. After
each verified slice, update the evidence and continue to the next dependency.
Resolve routine implementation choices yourself. Ask only when missing user
information or an external constraint truly prevents further useful work;
continue independent work while awaiting an answer. Never invent behavior to
avoid such a blocker. Keep useful progress updates concise.

## Read and establish the starting state

Read `AGENTS.md`, then these current documents:

* `docs/roadmap.md`, especially “3. Execute game behavior” and its required
  systems and completion criterion.
* `docs/stage-3-completion-audit.md`, especially the smallest blocker set and
  the latest loader integration notes.
* `docs/script-npc-startup-animation.md` and `docs/script-pawn-alliance.md`.
* `docs/play-performance.md` and `docs/script-level-tick.md`.

Check Git status and the recent commits before editing. Preserve any existing
user changes. Inspect the current source and reproduce reached boundaries;
historical documentation is evidence to reconcile, not proof that the current
code still has a particular failure. The 10,000-token cap and narrow dark-door
scope in `docs/stage-3-next-milestone.md` belonged to a completed earlier task;
they do not limit this full-day assignment.

The starting checkpoint has corrected Play's outer 120 Hz catch-up loop. Play
now advances once per browser frame using the recovered level clock, time
dilation, and 0.005–0.4-second actor delta clamp. Original physics still owns
its internal subdivisions. Exact x87/GetFrame overhead has also been reduced
without changing precision or pose sampling. Preserve these fixes. The measured
Metal-browser improvement is historical and machine-specific, not a performance
guarantee as more NPC behavior becomes active.

## First priority: unblock the Training MIB through original behavior

The MIB's stuck pose is reproducible in real Play. The original startup script
selects `BreatheLight`, but an unsupported native interrupts execution while
AnimFrame is still negative. The host records the failure in `npcFailures` and
stops ticking that actor. This is an incomplete runtime path.

Natives 2105–2107 (`IsValidEnemy`, `GetAllianceType`, `GetPawnAllianceType`) are
now implemented in `src/runtime/script-pawn-alliance.mjs` and wired into
`src/runtime/script-runtime.mjs`. They pass 31 comparisons with the original
DeusEx.dll. Reuse that evidence rather than re-deriving the subsystem.

Run `node scripts/validate-mib-startup-boundary.mjs` to reproduce the next
boundary. At seed 1 and 1/60-second frames, `mib1` passes the enemy check, lands,
and stops on tick 6 at:

`ScriptedPawn.Wandering.PickDestination -> Pawn.AIPickRandomDestination` (709).

Recover and implement that native and the dependencies actually reached by
this path. Research entry points in the hash-verified GOTY Engine.dll are:

* exec709: thunk `0x103029b9` -> body `0x103c86f0`.
* Worker: thunk `0x1030181b` -> body `0x103c7fc0`.
* Direction helper: thunk `0x10301f0f` -> body `0x1036d030`.
* Destination search: thunk `0x103011d6` -> body `0x103c78a0`.

These addresses are leads, not completed contracts. The destination search
uses collision test moves and restores actor state. Recover its RNG draws,
argument/default/out-parameter behavior, floating-point stores, loop/termination
rules, collision flags, zone gates, and restoration order before translating.
Establish original reference cases before admitting it into Play.

Reuse existing navigation, locomotion and collision work where the original
call graph justifies it: `src/runtime/script-pawn-nav.mjs`,
`src/runtime/script-pawn-locomotion.mjs`, `src/runtime/script-pawn-physics.mjs`,
`docs/script-pawn-nav.md`, `docs/script-pawn-locomotion.md`, and
`scripts/native-pawn-nav-probe.py`. Several reachability/movement workers are
already translated; determine which live service bindings are still missing.
Do not assume an isolated native validator establishes a live world binding.

Local research may still exist in `.cache/research/pawn-startup/`,
`.cache/research/ai-pick-1036d030.asm`, and
`.cache/research/ai-pick-103c78a0.asm`. Check availability and binary provenance;
regenerate from the installation if necessary. Find installed data through
`scripts/game-directory.mjs` or `DEUS_EX_GAME_DIR`. The existing native probe
environment is `.cache/native-probe-env/bin/python` when available.

After 709 works, follow the actual execution to its next dependency and keep
going. The existing MIB validator deliberately asserts the current unsupported
boundary. Update it when behavior advances; do not preserve that expected
failure or weaken it to a no-crash check. Check original state/animation
selection, continued ticking, collision/position restoration, and reset. Use a
local browser check to confirm the reported stuck pose is actually gone.
Browser appearance alone does not establish original AI correctness.

Never force an idle animation, fabricate a random destination, return a dummy
native success, bypass startup, suppress `npcFailures`, or skip original AI
statements to make the character appear functional.

## Continue through Stage 3 after the MIB slice

Keep a small, current work ledger in the completion audit. Rank work by actual
dependency and how much original script execution it unlocks. The remaining
work has three main categories:

1. **Live object and resource lifecycle.** Broaden the shared load graph beyond
   prepared or fixture-only routes. Connect remaining DynamicLoadObject resource
   paths, resource Serialize/PostLoad services, original native registration and
   DLL inputs, and recovered EndLoad behavior while preserving canonical object
   identity. Recover missing native constructor defaults/config services and
   unsupported default-storage boundaries, including SerializeBin struct bools
   where reached. Extend native actor/resource construction, spawn/destruction,
   references, serialization, temporary/heap ownership and live-world GC through
   concrete original paths. Reuse `docs/script-load-graph.md`,
   `docs/script-end-load.md`, `docs/script-function-bind.md`,
   `docs/script-linker-imports.md`, and their implementations and validators.
2. **Native dispatch and live startup.** Resolve reached Engine, DeusEx,
   UI/Extension and ConSys dependencies with the correct event frames and
   ownership. Current visible leads include weapon spawning in
   `InitializeInventory` for UNATCO troops and Manderley,
   `PlayerReplicationInfo` startup for cameras, `FindPathToward` (517), and the
   root-window `CanStartConversation` path. Trace each current failure before
   deciding its fix. Generalize by recovered type/behavior contracts rather
   than adding actor-name exceptions. Preserve original startup passes,
   PawnList ownership, collision registration, callback order and reset.
3. **Conversation execution.** Extend beyond the verified direct Training
   Speech-to-End routes and selected MoveCamera, CheckObject and DataVaultImage
   transfer paths. Admit further original ConEvent targets through their real
   construction, loading and event execution. Preserve canonical references,
   actor binding, action/label transitions, frame ownership, spawned-object
   lifetime and cleanup. Use the existing conversation and DataLink evidence;
   select the next path based on its actual dependencies.

Stage 3 requires a documented, original-verified subset covering the required
runtime systems. It does not require every native in the whole game, and a
green door demo or a count of loaded classes is insufficient. Map remaining
work back to the roadmap's requirements and the audit; do not redefine the
completion gate to fit the code you happen to finish.

Keep Stage 4 presentation and full Stage 5 gameplay out of scope except for
specific prerequisites of the chosen Stage 3 route. Native logic needed to get
an NPC through startup is relevant; a full combat system, renderer redesign,
audio mixer, UI polish or campaign implementation is not today's objective.

## Fidelity and implementation discipline

For every new behavior, first record the original package/script/native source
and version/hash as appropriate; relevant constants, field offsets, branch
conditions, state changes and call order; unresolved branches; and original
reference cases. Then translate, compare with that evidence, and integrate the
verified boundary into Play. Preserve float32/x87 behavior where the existing
contract requires it, plus RNG consumption and identity/ownership semantics.

Use original data, embedded source/bytecode, native instructions, or reproducible
original-game measurements as authority. Public engine implementations may
inform research but cannot substitute for original evidence. Keep insufficiently
understood branches explicitly unsupported. Do not silently swallow errors,
broaden admission beyond the proven contract, or label a fixture as full support.

Retain JavaScript. Performance work is limited to basic playability and must be
driven by measurements. Do not introduce WebAssembly, approximate arithmetic,
guessed LOD, NPC throttling or animation-rate changes as a shortcut. Report how
many NPCs are actually ticking versus blocked when interpreting performance;
an actor frozen by an error is not a successful optimization.

## Focused verification

Reuse passing original evidence. Check each new translation and integration
boundary without repeatedly rerunning unrelated large corpora. Tests of our
implementation alone do not prove original-game fidelity. Visual comparison is
not a gate for nonvisual runtime logic; reserve it for the visible behavior at
issue, such as confirming the MIB pose has recovered.

Choose checks according to the changed surface. Useful existing commands include:

```sh
node scripts/validate-pawn-alliance.mjs
node scripts/validate-mib-startup-boundary.mjs
node scripts/validate-pawn-nav.mjs
node scripts/validate-pawn-locomotion.mjs
node scripts/validate-play-frame.mjs
node scripts/validate-script-runtime.mjs
node scripts/validate-gameplay.mjs
node scripts/validate-training-datalink-live.mjs
node scripts/validate-datalink-transfer-object.mjs
npm test
npm run build
```

This is a menu, not a mandatory repeated sweep. Run the relevant native oracle
and integration validators for a slice, and appropriate broader checks at a
meaningful integration checkpoint. If a full validator sweep is justified,
run exactly `npm run validate -- --jobs 4`. Record failures and skips accurately;
do not present a partial run as a full pass. Use a hardware renderer when drawing
performance conclusions; the default headless SwiftShader results are not
representative of the user's Metal browser session.

## Delivery and stopping conditions

Keep everything local. Make coherent local commits after verified milestones,
including evidence and updated scope documentation. Never commit installed game
assets, extracted original scripts, native binaries, raw disassembly, or local
captures. Do not push, deploy, create a PR, or overwrite unrelated user work.

Keep `docs/stage-3-completion-audit.md` and affected subsystem documents current.
Replace obsolete blocker descriptions with the actual remaining boundary.
Continue working through verified slices for the working day. If one branch is
externally blocked, record the exact blocker and advance another independent
Stage 3 requirement. Do not fill the day by waiting or repeating passing checks.
If context is compacted, resume from the ledger and current Git state.

At the end, report local commit hashes; concrete original behavior now working;
native/reference and integration checks performed; remaining unsupported or
unverified behavior; the current MIB status; and the highest-value next steps.
Only mark Stage 3 complete if its actual required systems and exit criteria have
been established. Otherwise explicitly leave it incomplete with a precise,
actionable handoff.
