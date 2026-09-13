# Loaded logical object properties

This boundary reuses the recovered class-default and tagged-property contracts
in [map actors](script-map-actors.md), [tagged properties](script-tagged-properties.md),
[struct values](script-struct-values.md), and [resource identities](script-resources.md).
It does not introduce another serializer or a substitute native constructor.

For an existing canonical package export, the preparation sequence is: resolve
its original ClassIndex; load the inherited class/default/property metadata;
read the export's tagged overrides; resolve every authored object reference in
the export's package; merge fixed-dimension overrides with inherited defaults;
then attach typed logical storage to that same identity. The original property
type and array element remain authoritative, including generic struct decoding.
The complete property prefix must consume the export. Native payload tails and
saved state stacks are rejected here because they require their own serializers.
Actors continue to use the world host, which owns map slots and native fields.

This is preparation of loaded property values, not StaticAllocateObject,
PostLoad, native resource construction, or SpawnActor. The resource registry
supplies the canonical Outer/Class graph. Name preserves the loaded export's
spelling. Native ObjectFlags and ObjectInternal are explicit unsupported reads
until the live native object lifecycle is bound; export flags alone are not
the final runtime flags. Header mutation requires the appropriate native service.

The initial reference case is `DeusExConText.Conversation57` (export 1926),
whose authored `conName=DL_Start`, `conOwnerName=JCDenton`, `bDataLinkCon=true`,
and `bDisplayOnce=true` feed Training's `DataLinkTrigger23`. Missing properties
come from the original `Consys.Conversation` defaults, not Boolean(undefined)
or null guesses. Linked flag/event objects can be prepared separately with the
same method; reference resolution itself does not run another object's code.
