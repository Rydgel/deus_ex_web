# Shared loader graph and VM integration

This integration reuses the original contracts and established reference cases
in [`script-create-export.md`](script-create-export.md),
[`script-linker-preload.md`](script-linker-preload.md),
[`script-linker-imports.md`](script-linker-imports.md) and
[`script-property-serialize-item.md`](script-property-serialize-item.md).
No new game behavior is inferred from the host graph extraction.

## Integration contract

The synchronous graph receives already fetched package bytes/parsed tables.
Asset fetching happens before native serialization starts; a script/native
call must never suspend midway through the recovered load order. Package
dependency cycles publish available bytes before traversal and linker identities
before recursive import verification. Export objects are still created lazily.

`CreateExport`, import verification, `Preload`, the Core metadata serializers,
property linking and default-tag reads retain their existing recovered bodies.
The seven-class package comparisons must use the extracted graph itself, so a
second implementation cannot hide drift between the harness and runtime.

The VM bridge treats the native-slot record as backing storage for one canonical
`ScriptObjects` identity. For serialized exports its owning linker plus export
index supplies that identity; an import's text is not used to choose a second
object. Class, superclass, field and default references preserve that mapping.
The native graph keeps numeric FNames and linked property offsets; the VM keeps
its existing named, typed cells. Conversion at this representation boundary is:

* defaults at `Offset + ElementSize * index` become the field's indexed cells;
* packed bools read only their linked mask, with no sibling-bit leakage;
* names become the graph's interned text, and object/class pointers become the
  canonical export identity, preserving null and repeated references;
* top-level floats are already coerced by the graph's destination cell;
  SerializeBin struct-member floats remain raw IEEE-754 words and must be
  reinterpreted, while signed integers use int32 interpretation;
* struct members follow their original linked metadata; Vector/Rotator retain
  the VM's ordered three-component arrays, and authored structs use
  canonical member keys. Owning values are copied by the existing typed-value
  layer when installed in instances.

## Remaining boundaries

The extracted graph is not a complete original object heap. The inherited
serialized-default prefix is copied, but native C++ constructor defaults with
no package tag, metaclass bootstrap defaults, config/localization, native
resource payloads, general EndLoad/PostLoad and collection ownership remain
explicitly incomplete. Native-slot backing records and VM identity handles are
two representations of an object, not two independently loaded objects.
The new path must not claim those unimplemented services merely because an
authored default or a focused Play route works.

## Integration finding: the top packed bool bit

The first Play class load reached mask `0x80000000`, which the tagged-default
writer rejected because its integer guard used a signed maximum. The original
`FPropertyTag::SerializeTaggedProperty` body at `0x1012aca0` reads a full dword
mask at `0x1012acd6`, asserts only that it is nonzero, and performs dword OR
(`0x1012ad09`) or NOT/AND (`0x1012ad23–0x1012ad27`). The recovered bool linker
also explicitly assigns bit 31 before moving to another word.
`native-tagged-bool-oracle.py` establishes four original-instruction cases:
setting/clearing bit 31 while preserving low bits, and setting/clearing bit 0
while preserving bit 31. This confirms that the accepted mask range must cover
the full nonzero uint32 range; no arithmetic or packing behavior is changed.

## Implemented path and focused checks

`createScriptLoadGraph` is now a browser-compatible synchronous module shared
by the preload validator and `ScriptClassLoader`. `createScriptDoors`, Play's
runtime host, enables native class loading. Isolated VM fixtures can still use
the explicitly selected decoded-metadata adapter; it is not an automatic
fallback when native loading fails.

Play class loads use recovered Children/Next order for members and properties,
read probe/ignore/class flags from the serialized records, and obtain defaults
from native linked storage. The old `readClass` result remains source metadata
for bytecode/debug consumers, but does not populate defaults in this path.
Class-default writes update both the VM cells and the native storage used by
subsequent native class-default prefix copies. Native-only metaclass descriptors
and package roots use the same canonical resource registry as Play.

`validate-class-loader.mjs` compares **502 default values across the same seven
classes** directly with original package reads, including indexed names/class
references, vectors/rotators and string-owning structs. It checks stable class,
superclass, Class, Outer, Linker and field identities, cleared RF_NeedLoad,
repeat loads, packed-bool sibling preservation and struct write conversion.
Four original-DLL bool-write comparisons cover the bit-31 fix.

The live Training checks pass for darkdoor open/walk/close/reset, light switches,
player augmentation startup, all 18 admitted DataLink routes and all nine image
transfers. The darkdoor check explicitly requires a class loaded by this graph,
so reverting Play to the decoded-default adapter cannot silently pass it.

Still unverified: bool members inside SerializeBin struct defaults (the bridge
rejects that branch), arbitrary native-only class VM operations, native defaults
without serialized tags, config/localization, the prepared DynamicLoadObject
routes that still return prebound identities (the shared-graph route is in
[`script-font-load.md`](script-font-load.md)), the remaining native resource tails and complete
EndLoad/PostLoad/GC ownership. These are separate from the proven class-load
and representation boundaries above.

The shared StaticLoadObject helper now implements the recovered two-pass
EndLoad loop, metadata PostLoad bodies and import cleanup, with 17 original
DLL comparisons (see [`script-end-load.md`](script-end-load.md)). This graph's
loaded-object queue includes resource references whose native serializer tails
and PostLoad overrides are still missing. Running only its metadata entries
through EndLoad would violate the original all-object order, so that partial
flush is not used in Play.

The graph also exposes explicit `beginLoad`/`endLoad` scopes with metadata
PostLoad and function binding. Supplying original Core native registration
inputs finalizes the real Core.Object queue: 652 records and 164 function
pointers, including 10 named DLL exports. This closes that metadata integration
boundary, not the larger class/resource closure in Play. Unsupported resource
Serialize/PostLoad dispatch now stops before clearing its load flags; the
original UPackage serializer wrapper is explicitly admitted. See
[`script-function-bind.md`](script-function-bind.md).

With explicit clock, GLazyLoad and mip-bias services, the graph now constructs
and serializes exact Engine.Texture/Palette resources. Two real Engine textures
and their palettes match original DLL execution over nine mip levels, including
deferred reads through the same canonical archive and conditional PostLoad.
Other resource tails and subclasses still prevent a complete Play EndLoad;
Play now enables these services (see [Font loading](script-font-load.md)). See
[`script-texture-loading.md`](script-texture-loading.md) for evidence and limits.

Exact Engine.Sound instances now reuse the existing constructor, serializer,
generic lazy Load and Sound Load/LoadSpecial translations. Native registration
provides the Sound class/default tail despite the absence of a class export.
Original WAV/MP3 references check constructor/serialization state and bytes;
their complete two-object/one-object load queues finish EndLoad without filtering.
Sound aliases share native backing storage and the same canonical archive.
Registered native instance sizes and Core.Object's self-Super normalization
are retained before any export load. See
[`script-sound-load-graph.md`](script-sound-load-graph.md).

Mesh preparation now uses this same Play graph. Its narrow service admits the
original LodMesh constructor/serializer with explicit deferred loading, without
enabling unrelated Texture/Sound services. Class-default mesh references,
prepared payload views, Texture edges and later frame reads share one native
record/archive. Full Play EndLoad and resource release remain pending. See
[`script-mesh-load-graph.md`](script-mesh-load-graph.md).

The complete class-integration sweep (`npm run validate -- --jobs 4`) passed
314/314 validators with no skips in 187.9 seconds; `npm test` passed 486/486
and `npm run build` passed. That full sweep predates the EndLoad/function/resource
extensions, which use focused boundary checks. These checks establish the
documented boundaries, not completion of Stage 3.
