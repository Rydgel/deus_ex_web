/**
 * Source/native construction evidence for the shipped DataVaultImage chain
 * `DeusEx.Image02_NYC_Warehouse -> DeusEx.DataVaultImage -> Engine.Inventory
 * -> Engine.Actor -> Core.Object`.
 *
 * `DataVaultImage` and `Image02_NYC_Warehouse` have no DeusEx.dll
 * constructor.  As with DataLinkPlay, the original Core UClass::Bind path
 * recursively binds their superclass and copies the native ClassConstructor
 * pointer down the chain — here the Engine.AInventory constructor, not the
 * Engine.AActor one.  This module records that exact selection, the
 * AInventory native registration/ctor evidence, and the linked property
 * layout needed by the SpawnActor host.  It is not a generic Inventory
 * constructor or SpawnActor replacement.  See docs/script-datavault-image.md.
 */

const freeze = value => Object.freeze(value);
const freezeFields = fields => freeze(fields.map(field => freeze({...field})));

const ENGINE_DLL = freeze({
  sha256: '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  imageBase: 0x10300000,
});

const DEUSEX_PACKAGE = freeze({
  sha256: '257f5c166739b3d13884a8b8e98a47dda458b325fa929b3b3b99be056cb74480',
});

const DATAVAULTIMAGE_FIELDS = freezeFields([
  {name: 'imageTextures', kind: 'ObjectProperty', arrayDim: 4, elementSize: 4, alignment: 4},
  {name: 'SizeX', kind: 'IntProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'SizeY', kind: 'IntProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'imageDescription', kind: 'StrProperty', arrayDim: 1, elementSize: 12, alignment: 4},
  {name: 'floorDescription', kind: 'StrProperty', arrayDim: 1, elementSize: 12, alignment: 4},
  {name: 'sortKey', kind: 'IntProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'FirstNote', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'prevImage', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'nextImage', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'bPlayerViewedImage', kind: 'BoolProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'colNoteTextNormal', kind: 'StructProperty', arrayDim: 1, elementSize: 4, alignment: 4,
    structKey: 'core.object.color'},
  {name: 'colNoteTextFocus', kind: 'StructProperty', arrayDim: 1, elementSize: 4, alignment: 4,
    structKey: 'core.object.color'},
  {name: 'colNoteBackground', kind: 'StructProperty', arrayDim: 1, elementSize: 4, alignment: 4,
    structKey: 'core.object.color'},
]);

const ENGINE_INVENTORY = freeze({
  ...ENGINE_DLL,
  package: 'Engine',
  className: 'Inventory',
  key: 'engine.inventory',
  packageExport: 6,
  exportFlags: 0x040f0004,
  serializedClassFlags: 0x833,
  super: 'Engine.Actor',
  // Package object references are 1-based, matching AssetStore exportsByPath:
  // Engine.Inventory is exports[5] and its Super is the Engine.Actor export.
  superPackageExport: 2,
  registration: 0x1035fff0,
  rawRegistrationFlags: 0x04084004,
  staticClass: 0x10576f70,
  // AInventory's static parent pointer is AActor::PrivateStaticClass, the
  // same `0x1057cdf0` value the AActor registration installs.
  superStaticClass: 0x1057cdf0,
  instanceSize: 0x434,
  internalConstructor: 0x1030299b,
  constructorBody: 0x10341730,
  // The ctor body first runs the inlined AActor member construction (the
  // intermediate `movl $0x104268dc,(%esi)` store at 0x103417c4), then the
  // Inventory members, then the final AInventory vtable store at 0x10341851.
  intermediateVtable: 0x104268dc,
  vtable: 0x104286f8,
  // AInventory overrides none of the slots the SpawnActor body uses: the
  // vtable bytes at +0x10/+0x38/+0x74 are identical to AActor's.
  initExecution: freeze({slot: 0x38, thunk: 0x10302194, body: 0x103deb40}),
  spawned: freeze({slot: 0x74, thunk: 0x10303373, body: 0x1030d730}),
  processEvent: freeze({slot: 0x10, thunk: 0x10302d74}),
});

const DATAVAULTIMAGE = freeze({
  package: 'DeusEx',
  className: 'DataVaultImage',
  key: 'deusex.datavaultimage',
  packageExport: 36,
  exportFlags: 0x000f0004,
  serializedClassFlags: 0x33,
  super: 'Engine.Inventory',
  // DataVaultImage's Super crosses packages, so it is an import reference
  // (negative, 1-based): -24 is imports[23], Engine.Inventory.
  superPackageReference: -24,
  scriptDeclaration: 'class DataVaultImage extends Inventory abstract;',
  nativeConstructor: null,
  nativeVtable: null,
  fields: DATAVAULTIMAGE_FIELDS,
});

const IMAGE02_NYC_WAREHOUSE = freeze({
  package: 'DeusEx',
  className: 'Image02_NYC_Warehouse',
  key: 'deusex.image02_nyc_warehouse',
  packageExport: 10926,
  exportFlags: 0x000f0004,
  serializedClassFlags: 0x32,
  super: 'DeusEx.DataVaultImage',
  superPackageExport: 36,
  scriptDeclaration: 'class Image02_NYC_Warehouse expands DataVaultImage;',
  nativeConstructor: null,
  nativeVtable: null,
  fields: freezeFields([]),
  authoredDefaults: freeze({
    // Merged ClassDefaults scalar values observed for this class chain.
    CollisionRadius: 15,
    CollisionHeight: 1.4199999570846558,
    Physics: 2,
    bCollideActors: false,
    bBlockActors: true,
    bRotatingPickup: false,
    RemoteRole: 2,
    NetPriority: 1.399999976158142,
    DrawScale: 1,
    PlayerViewScale: 1,
    PickupViewScale: 1,
    SizeX: 400,
    SizeY: 400,
    imageDescription: 'NYC Warehouse',
    bMovable: true,
  }),
});

export const INVENTORY_CONSTRUCTION = freeze({
  binaries: freeze({engine: ENGINE_DLL, deusEx: DEUSEX_PACKAGE}),
  engineInventory: ENGINE_INVENTORY,
  dataVaultImage: DATAVAULTIMAGE,
  image02NycWarehouse: IMAGE02_NYC_WAREHOUSE,
  chain: freeze([
    'deusex.image02_nyc_warehouse',
    'deusex.datavaultimage',
    'engine.inventory',
    'engine.actor',
    'core.object',
  ]),
  startup: freeze({
    // ULevel::SpawnActor registers the actor in the XLevel hash before any
    // startup callback when Actor+0x1dc bit 0x1 is set and the hash pointer
    // at XLevel+0xf8 is non-null (0x103953b7-0x103953cf).  The admitted
    // class defaults keep bit 0x1 clear, so the registration is a no-op for
    // this chain but the gate stays in the sequence.
    preStartupHashMask: 0x1,
    // CheckEncroachment runs unconditionally from SpawnActor with
    // (Actor, Location, Rotation, notify=0) through level vtable +0xb8 at
    // 0x103955d6; the early return inside 0x1039a350 requires
    // Actor+0x1dc & 0x0d == 0 and a null Brush.  Encroachment failure calls
    // level vtable +0x94 (ULevel::DestroyActor, arg 0) and returns null.
    encroachmentMask: 0x0d,
    // The FindBase tail runs only when Actor+0xc4 (Base) is null, Actor+0x1dc
    // bit 0x2 (bCollideWorld) is set, the class chain matches ADecoration /
    // AInventory / APawn, and the byte at Actor+0x30 (Physics) is 0 or 5
    // (0x10395612-0x1039569c).  Image02's Falling default skips the call.
    findBaseAncestry: freeze(['engine.decoration', 'engine.inventory', 'engine.pawn']),
    findBasePhysicsValues: freeze([0, 5]),
  }),
  layout: freeze({
    alignment: 4,
    // AInventory's registration instance size doubles as Engine.Inventory's
    // PropertiesSize, the same convention the scripted-actor record uses for
    // Engine.Actor (0x318).  DataVaultImage appends 0x50 of 4-aligned script
    // fields after it (imageTextures[4] 0x10, two Int 0x8, two Str 0x18,
    // sortKey/FirstNote/prevImage/nextImage/bPlayerViewedImage 0x14, three
    // Color structs 0xc); Image02_NYC_Warehouse adds nothing.  Both sizes are
    // reproduced by the recovered UStruct::Link in
    // scripts/validate-inventory-spawn.mjs rather than asserted as magic.
    inventoryPropertiesSize: 0x434,
    dataVaultImagePropertiesSize: 0x484,
    image02PropertiesSize: 0x484,
    boolMergeMask: 0x7fffffff,
  }),
});

function requireClassRecord(record, expectedKey, label) {
  if (!record || typeof record !== 'object') throw new TypeError(`Missing ${label} class record`);
  if (String(record.key ?? '').toLowerCase() !== expectedKey)
    throw new Error(`${label} class identity must be ${expectedKey}`);
}

/** The recorded class names for the pinned chain members; an admitted subclass
 * outside the recorded evidence contributes its own linked name. */
const CHAIN_LABELS = freeze(new Map([
  [ENGINE_INVENTORY.key, `${ENGINE_INVENTORY.package}.${ENGINE_INVENTORY.className}`],
  [DATAVAULTIMAGE.key, DATAVAULTIMAGE.className],
  [IMAGE02_NYC_WAREHOUSE.key, IMAGE02_NYC_WAREHOUSE.className],
]));

const leafName = record => CHAIN_LABELS.get(String(record.key).toLowerCase()) ??
  (typeof record.name === 'string' && record.name ? record.name : String(record.key).split('.').pop());

/**
 * Select the original inherited constructor for a concrete DataVaultImage
 * subclass, given its linked `UClass::Bind` chain from the leaf down to
 * `Engine.Inventory`.
 *
 * The chain is what the original body actually walks: `UClass::Bind` recurses
 * to the superclass and copies its post-call `ClassConstructor` down
 * (`0x10127b5a`-`0x10127b60`), so any number of script-only subclasses between
 * the leaf and `Engine.Inventory` inherit the AInventory constructor.  Every
 * record above `Engine.Inventory` must therefore carry a null constructor: a
 * native subclass that declared its own would stop the copy-down, and silently
 * reusing the AInventory body for it would be wrong.  `Engine.Inventory` itself
 * must carry the recovered registration constructor and vtable.
 *
 * `propertiesSize` is the leaf's linked `UStruct::Link` result, supplied by the
 * caller rather than assumed, because a subclass that declares its own fields
 * has a larger one than `DataVaultImage`.
 */
export function resolveInheritedInventoryConstructorChain(chain, propertiesSize) {
  if (!Array.isArray(chain) || chain.length < 3)
    throw new TypeError('The inherited Inventory chain needs a leaf, DataVaultImage and Engine.Inventory');
  const inventory = chain[chain.length - 1];
  const dataVaultImage = chain[chain.length - 2];
  requireClassRecord(inventory, ENGINE_INVENTORY.key, 'Engine.Inventory');
  requireClassRecord(dataVaultImage, DATAVAULTIMAGE.key, 'DataVaultImage');
  for (const record of chain.slice(0, -1)) {
    if (!record || typeof record !== 'object' || typeof record.key !== 'string')
      throw new TypeError('The inherited Inventory chain needs linked class records');
    if (record.nativeConstructor !== null)
      throw new Error(`${leafName(record)} unexpectedly carries an independent native constructor`);
  }
  if (inventory.nativeConstructor !== ENGINE_INVENTORY.internalConstructor)
    throw new Error('Engine.Inventory ClassConstructor does not match the recovered registration');
  if (inventory.nativeVtable !== ENGINE_INVENTORY.vtable)
    throw new Error('Engine.Inventory native vtable does not match the recovered constructor body');
  if (!Number.isInteger(propertiesSize) || propertiesSize < INVENTORY_CONSTRUCTION.layout.inventoryPropertiesSize)
    throw new Error('The inherited Inventory chain needs the leaf linked PropertiesSize');
  // UField::Bind on the leaf, then one UClass::Bind per superclass visit, then
  // the copy-down in reverse visit order.
  const bindOrder = [`${leafName(chain[0])} UField::Bind`];
  for (const record of chain.slice(1)) bindOrder.push(`${leafName(record)} UClass::Bind`);
  for (let i = chain.length - 1; i > 0; i--)
    bindOrder.push(`copy ${leafName(chain[i])} ClassConstructor to ${leafName(chain[i - 1])}`);
  return freeze({
    classKey: String(chain[0].key).toLowerCase(),
    inherited: true,
    constructor: ENGINE_INVENTORY.internalConstructor,
    constructorBody: ENGINE_INVENTORY.constructorBody,
    nativeVtable: ENGINE_INVENTORY.vtable,
    propertiesSize,
    bindOrder: freeze(bindOrder),
  });
}

/**
 * The shipped Image02_NYC_Warehouse case of the chain resolver above, kept as a
 * named entry point for the route that pinned this evidence.
 */
export function resolveInheritedInventoryConstructor({image02, dataVaultImage, inventory} = {}) {
  requireClassRecord(image02, IMAGE02_NYC_WAREHOUSE.key, 'Image02_NYC_Warehouse');
  return resolveInheritedInventoryConstructorChain([image02, dataVaultImage, inventory],
    INVENTORY_CONSTRUCTION.layout.image02PropertiesSize);
}
