# Original UnrealScript iterator execution

This note records the iterator behavior recovered from the original Deus Ex GOTY
binaries and compiled package bytecode. `script-iterators.mjs` implements the
native304 controller; `script-vm.mjs` owns its body/control-flow execution.
The runtime requires an explicit complete actor-array binding.

The native evidence is from `System/Core.dll` (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`) and
`System/Engine.dll` (SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`). The
corresponding disassemblies are `.cache/research/Core.asm` and
`.cache/reference/Engine.asm`. The declaration in `.cache/reference/Actor.uc`
lines 976–993 is:

```unrealscript
native(304) final iterator function AllActors
    ( class<actor> BaseClass, out actor Actor, optional name MatchTag );
```

## Bytecode shape and the Core marker

The compiler emits an iterator expression as an expanded-script stream of this
form:

```text
2f  <native expression for AllActors and its arguments>  16  <u16 target>
    <iterator body>
31
30
```

`0x2f` is the `Iterator` token. In the decoder AST it is the node whose child is
the native expression and whose `target` is the expanded offset encoded by the
word after the `0x16` end-of-function-parameters token. `0x31` is `IteratorNext`
and `0x30` is `IteratorPop`; neither has a payload. The body begins at the
iterator node's expanded `end` (the first byte after the target word).

The exported Core `execIterator` entry point at `0x1010219e` jumps to
`0x1013f180`, which is only `ret $8`. Core has no named `IteratorNext` or
`IteratorPop` handlers in this build. The iterator native owns the loop and
recognizes the two sentinel bytes while dispatching the body. This is why the
marker must remain a normal expression in the stream even though it performs no
work by itself.

Core `EndFunctionParms` at `0x1012f770` decrements `Frame.Code` by one byte after
`FFrame::Step` has advanced it over `0x16`. The native then explicitly advances
past `0x16` and reads the following little-endian word as its iterator target.
The ordinary Core jump handler adds a jump word to `Frame.Node->Script`, so the
compiled targets observed here are absolute offsets in the expanded script.
On iterator exhaustion, native 304 sets `Frame.Code` to
`Frame.Node->Script + target + 1`, which skips the `0x30` Pop token and resumes
at the following expression (normally `Return` or the next statement).

The target values and `Frame.Node->Script` arithmetic above are established for
the original GOTY expanded streams. A loader must keep the expanded offsets,
not the compact on-disk byte positions, because object/name references expand
while the script is loaded.

## Native 304 argument setup

`AActor::execAllActors` is exported at `0x10303788` and executes at
`0x103e43f0`. It evaluates the three declared arguments in source order by
calling the frame `Step` routine:

1. It steps `BaseClass` into a local class pointer.
2. It steps the `out actor Actor` expression. The expression evaluator publishes
   an address in Engine global `0x10599aa0` when the expression has an assignable
   lvalue. Native 304 uses that published address; otherwise it falls back to a
   temporary local slot. The chosen slot is cleared to `None` before every
   candidate scan.
3. It steps the optional `MatchTag` expression into a local name value. An
   omitted optional argument arrives as zero (`NAME_None`).

After `EndFunctionParms`, native 304 consumes the `0x16` byte and reads the
following target word. It replaces a null `BaseClass` argument with
`AActor::StaticClass` (the original Engine static-class pointer is
`0x1057cdf0`). Thus a normal omitted/null class selects actors, rather than
acting as an unrestricted wildcard. The body start is the pointer immediately
after the target word and is saved before the first scan.

The `out` value is written through the published lvalue during enumeration. The
native does not return a separate actor value and does not perform a later
copy-back operation for the body. This matters for locals and object fields: the
body sees the same reference slot that the argument expression supplied.

## Actor order and filters

The scan is equivalent to the following pseudocode, with the reload behavior
shown explicitly:

```text
i = 0
while (true) {
    outActor = None
    level = this.Level
    count = level.Actors.Num
    if (i >= count) no_match

    actor = level.Actors.Data[i]
    i += 1
    if (actor == None) continue

    if (!classIsA(actor.Class, BaseClass)) continue
    if (MatchTag != NAME_None && actor.Tag != MatchTag) continue

    outActor = actor
    run_body
}
```

The exact offsets read by this native are `this+0xac` for the level,
`Level+0x2c` for the actor-array data pointer, and `Level+0x30` for the live
actor count. The actor class pointer is at `Actor+0x24`; its superclass link is
at `Class+0x28`. The ancestry test compares pointers, accepting the actor when
its class is `BaseClass` or any superclass in that chain. The tag comparison is
an exact name comparison against `Actor+0xb0` (the `Tag` field).

Indices are visited in ascending zero-based array order. Null array slots are
skipped. The native reloads the level, data pointer, and count after each body
execution, so the bound is live rather than a copied snapshot. If a body changes
the actor array, subsequent reads use the current array at the already advanced
index; the native does not define a stable snapshot or a separate ordering.

There is no `bDeleteMe` read and no object-flag/deleted test in this native. A
slot that is already null is skipped, but an otherwise non-null actor is filtered
only by class ancestry and optional exact tag. The native also does not sort or
deduplicate actors.

## Body control flow and unwind

Once a matching actor is published, native 304 dispatches body bytes beginning at
the saved body start. It repeatedly loads `Frame.Code`:

- For any byte other than `0x30` or `0x31`, it advances `Frame.Code` over the
  opcode and dispatches that opcode through the normal Engine opcode table. The
  resulting expression may contain ordinary jumps or nested calls; native 304
  resumes sentinel inspection at the resulting `Frame.Code`.
- For `0x31` (`IteratorNext`), it consumes the byte, resets `Frame.Code` to the
  saved body start, and returns to the actor scan. The scan cursor remains
  advanced, so this continues with the next live array index.
- For `0x30` (`IteratorPop`), it consumes the byte and returns from native 304.
  The caller continues with the `Frame.Code` immediately after Pop.

The normal compiled tail is therefore `0x31, 0x30`: each matching actor runs the
body and Next starts another scan; Pop is reached only when the body explicitly
breaks or the scan is exhausted. When no candidate is found, including before
the first body execution, native 304 sets `Frame.Code` to one byte after the
saved target (`scriptBase + target + 1`), consuming the Pop logically without
executing it.

A regular `break` is compiled as a Core jump whose target is the Pop offset. For
example, `DeusExPlayer.GetLevelInfo` has a body jump at expanded offset 16 to
Pop at offset 20, followed by the outer Return at 21. The jump handler uses
`scriptBase + target`, so the body reaches `0x30`; native 304 consumes Pop and
returns to the outer interpreter.

A `return` from inside an iterator body is compiled with Pop immediately before
Return. `Engine.Trigger.FindTriggerActor` has early exits at Pop/Return offsets
70/71 and 109/110. Native 304 consumes Pop and returns; the outer
`ProcessInternal` then handles the Return token and its value expression. This
ordering is required for the iterator's native stack locals to unwind before the
function return is interpreted.

## Original bytecode checks

These offsets are from the local GOTY package reader and expanded-script
decoder; they are useful regression cases for a runtime:

| Export | Expanded size | Iterator | Body start (`end`) | Next (`0x31`) | Pop (`0x30`) | Evidence |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `DeusEx.DeusExMover.Frob` (export 15897) | 1324 | 911 | 932 | 996 | 997 | First Frob fanout; serialized bytes include `2f ... 16 e5 03` (`997`) |
| `DeusEx.DeusExMover.Frob` (export 15897) | 1324 | 1263 | 1284 | 1320 | 1321 | Second Frob fanout |
| `Engine.Trigger.FindTriggerActor` (export 4533) | 116 | 14 | 30 | 112 | 113 | Pop/Return early exits at 70/71 and 109/110 |
| `Engine.Mover.FindTriggerActor` (export 3006) | 407 | 14 | 30 | 198 | 199 | Iterator with the same native 304 shape |
| `DeusEx.DeusExPlayer.GetLevelInfo` (export 17962) | 29 | 0 | 16 | 19 | 20 | Body jump to Pop at 20; outer Return at 21 |

`DeusExPlayer.UpdatePlayerSkin` (export 17963, expanded size 194) supplies four
additional short cases at iterator offsets 0, 48, 96, and 144, with Pop offsets
20, 68, 116, and 164. Each body begins with a jump to its Pop, confirming the
compiled `break` shape independently of `GetLevelInfo`.

## Scope and unresolved cases

This contract is verified against the original GOTY Core/Engine binaries and
locally loaded GOTY script streams for native 304 (`AllActors`). Native 305+
iterator families (`ChildActors`, `BasedActors`, and others), other game
versions, and malformed streams were not analyzed here. Their ordering,
filtering, and sentinel handling must remain unsupported until separately
traced. No claim is made that a different UE1 build shares these offsets or
native details.
