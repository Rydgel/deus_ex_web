/**
 * Original native construction records for ConSys conversation objects.
 *
 * These are evidence records, not a generic UObject/Actor constructor. The
 * class-selected constructor still has to be dispatched by the host's
 * StaticConstructObject path after class registration and defaults have run.
 * DataLinkPlay is a script-only DeusEx class; its inherited Actor constructor
 * is recovered separately in script-scripted-actor-construction.mjs.
 */

const freeze = value => Object.freeze(value);

const CONSYS_COMMON = freeze({
  package: 'ConSys',
  dllSha256: 'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa',
  imageBase: 0x10000000,
  rawObjectFlags: 0x04084004,
  inputClassFlags: 0,
  within: 'Core.Object',
  config: 'System',
  packageText: 'ConSys',
  guid: freeze([0, 0, 0, 0]),
  staticConstructorIat: 0x10013008,
  uclassConstructorIat: 0x100130d8,
  objectConstructorIat: 0x10013080,
});

/**
 * The native classes registered by ConSys that are reached by conversation
 * loading and actor binding. `writes` records stores made by the concrete C++
 * default constructor after the UObject base constructor returns.
 */
export const CONSYS_NATIVE_CONSTRUCTION = freeze({
  ...CONSYS_COMMON,
  classes: freeze({
    ConObject: freeze({
      name: 'ConObject',
      serializedClassFlags: 0x113,
      packageExport: 6,
      super: 'Core.Object',
      registration: 0x1000ecf0,
      staticClass: 0x10026de0,
      instanceSize: 0x28,
      internalConstructor: 0x10001370,
      constructor: 0x10001380,
      vtable: 0x100131c4,
      writes: freeze([{ offset: 0, value: 0x100131c4 }]),
    }),
    Conversation: freeze({
      name: 'Conversation',
      serializedClassFlags: 0x112,
      packageExport: 30,
      super: 'ConSys.ConObject',
      registration: 0x1000f070,
      staticClass: 0x100277e8,
      instanceSize: 0x78,
      internalConstructor: 0x100026d0,
      constructor: 0x1000f120,
      vtable: 0x100133c4,
      writes: freeze([{ offset: 0, value: 0x100133c4 }]),
    }),
    ConListItem: freeze({
      name: 'ConListItem',
      serializedClassFlags: 0x112,
      packageExport: 83,
      super: 'ConSys.ConObject',
      registration: 0x1000ec10,
      staticClass: 0x100268e0,
      instanceSize: 0x30,
      internalConstructor: 0x10002e60,
      constructor: 0x1000ecc0,
      vtable: 0x1001346c,
      writes: freeze([
        { offset: 0, value: 0x1001346c },
        { offset: 0x28, value: 0 },
        { offset: 0x2c, value: 0 },
      ]),
      operatorNew: 0x10002dc0,
      fields: freeze({ con: 0x28, next: 0x2c }),
    }),
  }),
  binding: freeze({
    bindConversations: 0x10010b70,
    purgeBoundConversations: 0x10010cf0,
    actorConListItems: 0x2dc,
    objectFlagsAfterBindOr: 0x4,
    objectFlagsAfterBindName: 'RF_Public',
  }),
});

/**
 * DataLinkPlay has no independent native registration in the installed
 * DeusEx.dll. Keep this record explicit so callers cannot silently select the
 * AActor constructor for a script subclass whose class-selected native
 * constructor has not been recovered.
 */
export const DATALINK_PLAY_CONSTRUCTION = freeze({
  package: 'DeusEx',
  className: 'DataLinkPlay',
  packageExport: 1154,
  exportFlags: 0x000f0004,
  serializedClassFlags: 0x3a,
  super: 'DeusEx.ConPlayBase',
  superPackageExport: 4533,
  scriptDeclaration: 'class DataLinkPlay expands ConPlayBase transient;',
  nativeConstructor: null,
  nativeVtable: null,
  inheritedConstructor: 0x10302dab,
  inheritedVtable: 0x104268dc,
  status: 'source-backed-inherited-actor-constructor',
});

export function conSysNativeConstruction(name) {
  const record = CONSYS_NATIVE_CONSTRUCTION.classes[name];
  if (!record) throw new RangeError(`Unknown ConSys native class: ${String(name)}`);
  return record;
}

export function dataLinkPlayConstruction() {
  return DATALINK_PLAY_CONSTRUCTION;
}
