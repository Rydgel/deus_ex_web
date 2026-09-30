# Project instructions

## Fidelity

The target is a 100% faithful, independently reverse-engineered browser
reimplementation of the original Deus Ex. Implement behavior from original game
data, embedded scripts/bytecode, native-code analysis, or reproducible measurements
against the original game. Do not invent substitutes because they look or feel
similar. Public engine implementations are research references, not the authority
or the ceiling of compatibility.

Record the evidence behind each implemented behavior and validate it against the
original. Label unverified assumptions and incomplete behavior explicitly; tests
of our own implementation alone do not establish original-game fidelity. Do not
declare a milestone complete while required behavior remains unverified.

Start each new subsystem with the original source of truth. Before implementation,
trace the relevant original data, embedded source/bytecode, and native instructions
or reproducible original-game measurements. Document the behavior, constants,
state changes, call order, and unresolved branches first. Establish original
reference cases before wiring the behavior into Play mode; use comparisons to
verify the translation. Do not begin with a guessed prototype and defer original
research until it needs correcting. Keep behavior without sufficient evidence
explicitly unsupported, and audit existing prototypes against this workflow as
their subsystems are addressed.

Keep delivery local. Do not deploy or push hosting updates unless the user asks.
Keep original assets, extracted script sources, native binaries and local captures
outside Git.

Performance target (set 2026-09-30): 120 fps in Play, that is 8.3 ms of host
work per frame on the reference machine (Apple M2 Pro, 1440×960). The Rust
core (WebAssembly over the object image) is where hot work moves. Move a
family only after a measurement names it, keep its JavaScript body as the
reference, and judge each change by interleaved A/B medians and browser
phase timings, never by isolated counts. Fidelity rules above take precedence
over any performance change.

Focus current reverse engineering on single-player. Multiplayer is the last
priority and may remain explicitly unsupported or incomplete.

During Stage 3, keep verification focused. Original bytecode/source and clearly
recovered native instructions establish the behavior contract. Visual comparison
is not a gate for nonvisual script/runtime logic. Check new translation and
integration boundaries, reuse existing original evidence, and avoid expanding
large test corpora or repeating passing checks without a concrete unresolved issue.

When a full validator sweep is needed, run it in parallel with **4 jobs**:
`npm run validate -- --jobs 4`. Four jobs is also the runner's default.
