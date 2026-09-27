# Engine Actor Trace / FastTrace / TraceActors / TraceTexture

The authority for these four natives is the installed GOTY `System/Engine.u`
and hash-pinned `System/Engine.dll`:

```text
Engine.dll SHA-256  0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4
Actor.uc            the native() declarations quoted below
```

Each thunk is the exported `UObject::exec*` entry; its `E9` jump targets the
recovered body. Native indices and `out` parameter flags come from the
Engine.u exports, not from the declaration text.

| Index | Declaration | Thunk | Body | Key instructions |
| --- | --- | --- | --- | --- |
| 277 | `final function Actor Trace (out vector HitLocation, out vector HitNormal, vector TraceEnd, optional vector TraceStart, optional bool bTraceActors, optional vector Extent)` | `0x10301005` | `0x103e3330` | `GPropAddr`/local-buffer out resolution per argument, pre-stored `this->Location` (+0x114) and `*(this+0x1dc)&1` optional defaults, zeroed 44-byte `FCheckResult` (`Time=1.0`, `Item=-1`), `call [XLevel vtable +0xc0]` `SingleLineCheck` with flags `bTraceActors ? 0x37 : 6` and `extra=0`, actor/location/normal copyback |
| 548 | `final function bool FastTrace (vector TraceEnd, optional vector TraceStart)` | `0x10302103` | `0x103e35e0` | pre-stored `this->Location` default before the optional expression, both vectors pushed by value, `call 0x10301a37` on `*(this+0xac)+0x98` (Level->Model -> `UModel::FastLineCheck` at `0x103f3280`), `movzx eax,al` byte-masked result |
| 309 | `final iterator function TraceActors (class<actor> BaseClass, out actor Actor, out vector HitLoc, out vector HitNorm, vector End, optional vector Start, optional vector Extent)` | `0x10303bd4` | `0x103e4bc0` | seven `GPropAddr`/value evaluations, BaseClass defaulted to `class'Actor'` when null and never tested against hits, `call [XLevel vtable +0xc8]` `MultiLineCheck(GMem, End, Start, Extent, checkActors=1, worldActor=this->+0xa8, extra=0)`, per-node publish loop dispatching the iterator body until `0x30`/`0x31`, Actor out cleared at exhaustion only |
| 1000 | `final iterator function TraceTexture (class<actor> BaseClass, out actor Actor, out name texName, out name texGroup, out int flags, out vector HitLoc, out vector HitNorm, vector End, optional vector Start, optional vector Extent)` | `0x10302252` | `0x1036e450` | same ten-argument/MultiLineCheck skeleton as 309; per hit, texName/texGroup/flags zero then — only when the hit actor's class ancestry reaches `LevelInfo` (`0x1057bf00`) — `hit.Item` (+0x28) indexes `Model->+0x58` node records (64 bytes, `+0x1c` = iSurf) into `Model->+0x98` surface records (64 bytes, `+0x00` = material object, `+0x04` = PolyFlags): `material->+0x20` → texName, `material->+0x18->+0x20` (Outer name) → texGroup, surface `+0x04` → flags |

## Recovered semantics

### 277 `Trace` — `0x103e3330`

The exec evaluates the six argument expressions left to right. Each `out`
vector resolves through `GPropAddr`; a non-assignable expression lands in a
private stack temporary whose writes never escape (the VM's `writeSlot`
sink reproduces that). `TraceStart`'s `this->Location` (+0x114) default and
`bTraceActors`' `*(this+0x1dc)&1` (bCollideActors) default are pre-stored
immediates written **before** the optional argument expressions run, and
`Extent` defaults to the zero vector the same way.

The query is `ULevel::SingleLineCheck` (vtable `+0xc0`) over a fully zeroed
44-byte `FCheckResult` (`Time=1.0`, `Item=-1`) with
`flags = bTraceActors ? 0x37 : 6` and `extra = 0`. The native then copies
`hit.Actor` to the return slot and the record's `Location`/`Normal` to the
out vectors — on a miss the zeroed record publishes `[0,0,0]`/`[0,0,0]`
with a null actor.

Cases (`scripts/native-script-trace-oracle.py` → `validate-native-script-trace.mjs`,
24 cases):

- `collisionFlags ∈ {0,1} × traceActors ∈ {absent,0,1}` — the
  `*(this+0x1dc)&1` default and the explicit override both drive the
  measured `0x37`/`6` flag word (mutations inverting the gate or flipping
  the default bit are caught).
- `explicit of {false,true}` Start/Extent — the pre-stored `Location`
  default and the zero extent vs the supplied vectors, measured at the
  SingleLineCheck stack frame.
- `hit ∈ {false,true}` — null actor + zeroed vectors on a clear check vs
  the published actor/location/normal on a hit.
- A binding-level pass drives `invokeNative(277)` on a prototype runtime
  and asserts the argument evaluation order `[0..5]`, the out-slot
  copyback and the `hit.Actor` return — catching a skipped `HitNormal`
  store and a wrong `Start` default source.

### 548 `FastTrace` — `0x103e35e0`

The exec evaluates `TraceEnd`, pre-stores `this->Location` into the
`TraceStart` slot, evaluates the optional argument if present, pushes both
vectors by value and calls `Level->Model->FastLineCheck(End, Start)`
through `0x10301a37`. The result keeps only `AL` (`result & 0xff`).

Cases (`scripts/native-fast-trace-oracle.py` → `validate-native-fast-trace.mjs`,
12 cases; the oracle stubs the FastLineCheck call so the exec wrapper is
isolated, matching how `scriptFastTrace` receives an injectable check):

- absent vs explicit `TraceStart` — the pushed `Start` is the actor's
  `Location` unless the optional expression overwrites it.
- callee returns `0x100`/`0x155` — the observed native result is `0`/`0x55`,
  proving the byte mask (a mutation dropping `& 0xff` is caught).
- swapped end/start operand order is caught at the measured call frame.
- A binding-level pass asserts `invokeNative(548)` evaluates `[0,1]`, reads
  `Level->Model` plus the level's `fastLineCheck` service and returns the
  masked boolean.

### 309 `TraceActors` — `0x103e4bc0`

One `MultiLineCheck(GMemStack, End, Start, Extent, checkActors=1,
worldActor=this->+0xa8, extra=0)` runs at iterator start; the native then
walks the returned hit list, publishing `Actor`/`HitLoc`/`HitNorm` per node
and dispatching the iterator body inline until `EX_IteratorNext` (`0x31`)
advances or `EX_IteratorPop` (`0x30`) exits. `BaseClass` is evaluated and
defaulted to `class'Actor'` when null but is never tested against the hits.
At natural list exhaustion only the `Actor` out is cleared — the vector
outs keep the last published hit. On `0x30` (early break) every out keeps
its last published value.

Cases (`scripts/native-trace-actors-oracle.py` → `validate-native-trace-actors.mjs`,
15 cases) drive both the interaction helper and the VM-level
`createTraceActorsIterator` controller against the same captures:

- full hit list, `baseClass` present/absent — identical yields, proving
  the argument is non-filtering.
- `breakAfter=2` — the outs retain the second hit verbatim.
- `hits=[]` — `Actor` clears to null while `HitLoc`/`HitNorm` keep their
  seeds (`[9,9,9]`/`[8,8,8]`).
- explicit `start`/`extent` — the measured MultiLineCheck stack frame
  carries them; absent optionals carry `Location`/zero.
- mutations caught: clearing all three outs at exhaustion, `checkActors=0`.

### 1000 `TraceTexture` — `0x1036e450`

Same evaluation skeleton and `MultiLineCheck` call as 309 with three extra
outs. Per hit node the exec zeroes `texName`/`texGroup`/`flags`, then —
only when the **hit actor's own** `+0xac` XLevel matches the query level
and its class ancestry reaches `LevelInfo` — indexes `hit.Item` into
`Model->Nodes` (64-byte records, `+0x1c` = surface index), reads
`Model->Surfs[iSurf]` (`+0x00` material, `+0x04` PolyFlags) and publishes
`material->+0x20` (texture name index) → texName, `material->+0x18->+0x20`
(material Outer name) → texGroup, and the surface PolyFlags → flags. A
world hit with a null material still publishes PolyFlags with zeroed names;
non-world hits keep all three outs zeroed.

Cases (`scripts/native-trace-texture-oracle.py` →
`validate-native-trace-texture.mjs`, 5 cases):

- world hits on two surfaces — name/group/flags publish through the
  `Item → node.iSurf → surf` walk (mutations negating the LevelInfo gate
  or indexing `surfaceTexture` by `Item` are caught).
- `descendant` hit whose class's super is `LevelInfo` — the ancestry walk,
  not just direct class identity, opens the lookup.
- `surfs[1]` has `flags` but no `texture` — PolyFlags `0x200` publishes
  while the names stay `'None'` (a mutation gating flags on the material
  is caught).
- non-`LevelInfo` hits (`self`, `wrong`, `owned`) — all three outs stay
  `None`/`None`/`0`.
- `hits=[]` — the `0x11`/`0x22`/`-7` name/group/flags seeds survive; only
  `Actor` clears.
- `breakAfter=3` — the published world-hit texture values are retained.

### Optional-argument arity (all four iterator execs)

The original execs use OPTX macros: optional parameters keep their pre-stored
defaults when the caller emits no expression, so legal call frames carry
`required..max` arguments — `ScriptedPawn.GetFloorMaterial` calls
`foreach TraceTexture(..., End)` with **8** expressions, leaving `Start`/
`Extent` at the `Location`/`(0,0,0)` defaults. The VM supplies only the
emitted expressions, so `createTraceActorsIterator`,
`createTraceTextureIterator`, `createRadiusActorsIterator` and
`createVisibleActorsIterator` each accept their full required..max range and
evaluate an optional slot only when its expression exists. Focused short-call
checks in the four validators assert the omitted slots reach the query with
the recovered defaults; the oracle scenes keep emitting all arguments.

## Unverified scope

- The iterator protocol is exercised as `0x2f` start → `next()` publish →
  `0x31` advance → `0x30` pop; the oracle drives the same boundary by
  dispatching the fabricated body opcodes inside the original loop, so the
  in-VM frame layout around a *suspended* original `foreach` (locals
  surviving across a real bytecode suspension) is not separately probed.
- The `hit.Item → node.iSurf → surf` walk is proven for the fabricated
  model shapes in the oracle; the runtime reads `model.nodes[hit.item].surface`
  → `model.surfaces[i].flags` → `level.surfaceTexture[i]` where
  `surfaceTexture` is the walking-surface texture table
  (`walking-surface.mjs`). Whether `iSurf` can reference a surface slot
  without a material record in a *shipping* map is untested; the binding
  throws rather than guess when the table or node is absent.
- `MultiLineCheck`/`SingleLineCheck`/`FastLineCheck` themselves are the
  already-validated collision services (`docs/collision-hash.md`,
  `docs/fast-line-check.md`, `docs/point-check.md`); the oracles stub them
  at their call frames, so these bindings assert only the exec-level
  contract — argument order, defaults, flags, out publish and the hit-list
  walk — not the collision internals, which their own oracles pin.
- `BaseClass`'s non-filtering behavior is proven for the oracle's
  fabricated class graph (`Actor`/`Pawn`/`Mover`/`LevelInfo`); the body
  contains no per-hit class test at all, so this is a decode-backed claim,
  not just a sampled one.
- The `createIterator` dispatch (`call.index === 309|1000 → controller`)
  and `invokeNative`'s branch selection are exercised at the binding level
  for 277/548; the 309/1000 controller is driven directly rather than
  through a compiled `foreach` byte stream, which remains covered only at
  the `createAllActorsIterator` level.
- The probe establishes the GOTY Engine build only.

### Batch 5 canonical actor field adapter

The level scheduler also reaches non-colliding map actors, including
`ElectricityEmitter0` in `01_NYC_UNATCOIsland`. Its original
ElectricityEmitter.CalcTrace uses native 1000. TraceActors/TraceTexture previously
required the optional collision view's `position`/`worldActor` mirrors even
though their recovered exec bodies read Actor.Location and the receiver's
`+0xa8` Level field. ScriptRuntime now supplies those two reads from the
canonical actor's attached script storage. It does not allocate a replacement
actor or fabricate a world pointer. Direct native oracle fixtures still supply
their own corresponding memory view.

The existing five TraceTexture DLL cases remain unchanged; the optional-argument
binding check now invokes ScriptRuntime.createIterator on an actor with neither
collision mirror, verifies Location/Level read order and exact Level identity,
and retains its native Start/Extent expectations.
