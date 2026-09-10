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

Prioritize runtime implementation over performance optimization. Retain
JavaScript unless later measurements identify a specific bottleneck that
justifies WebAssembly; performance work is limited to basic playability for now.

During Stage 3, keep verification focused. Original bytecode/source and clearly
recovered native instructions establish the behavior contract. Visual comparison
is not a gate for nonvisual script/runtime logic. Check new translation and
integration boundaries, reuse existing original evidence, and avoid expanding
large test corpora or repeating passing checks without a concrete unresolved issue.

## Subagent delegation

For concrete, bounded delegated work, prefer the custom agent `luna_worker`.
Name it explicitly when spawning and wait for its result.
