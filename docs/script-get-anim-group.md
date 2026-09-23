# Actor.GetAnimGroup native 293

Original GOTY Engine.dll SHA256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`:
export thunk 0x10302ea0 jumps to exec body 0x103e1640. The body evaluates one
FName, consumes the parameter terminator, initializes the result to FName None
(index zero), then reads Actor.Mesh at +0x174. A null mesh calls the original
warning leaf with `GetAnimGroup: No mesh` and leaves the result None.

For a mesh, virtual slot +0x68 looks up the sequence. Original UMesh lookup
0x1031c000 (const) / 0x1031c050 (mutable) scans +0x84 Data / +0x88 Num in order,
comparing the sequence FName at the start of each 32-byte record. The first
match wins. GetAnimGroup returns that record's group FName at +4, even if it
is None. An absent sequence warns with
`GetAnimGroup: Sequence '%s' not found in Mesh '%s'` and leaves None. It does
not alter Actor animation fields.

The shared prepared LodMesh payload already exposes the original serialized
`sequences[].name` and `.group` FNames (`script-mesh-load.mjs`). The helper uses
the existing `findAnimSeq` FName identity adapter and returns the group without
inventing a class or animation-name mapping. `execGetAnimGroup(call,{mesh,log})`
evaluates the name before calling the synchronous prepared-mesh service. An
unprepared non-null mesh must keep the runtime's explicit preparation error.

`node scripts/validate-get-anim-group.mjs` passed ten unchanged original
native/mesh-lookup cases on 2026-09-23: null and empty meshes, first/middle/last
sequence records, case-insensitive FName identity, missing sequences, None
groups, duplicate sequence names (first match), and a sequence named None.
The oracle intercepts only expression evaluation and warning output. It checks
returned FName groups, warnings, two-byte script advancement and unchanged
actor memory; the host adapter also checks argument-before-mesh service order.
Original captures remain under ignored `.cache/get-anim-group/`.
