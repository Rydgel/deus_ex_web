/**
 * Source/native construction evidence for the script-only DataLinkPlay actor.
 *
 * `DataLinkPlay` and `ConPlayBase` do not have a DeusEx.dll constructor.  The
 * original Core UClass::Bind path recursively binds their superclass and
 * copies the Engine.Actor ClassConstructor pointer down the chain.  This
 * module records that exact selection and the linked property layout; it does
 * not pretend to be a generic Actor constructor or SpawnActor replacement.
 * See docs/script-scripted-actor-construction.md.
 */

const freeze = value => Object.freeze(value);
const freezeFields = fields => freeze(fields.map(field => freeze({...field})));

const CORE_DLL = freeze({
  sha256: '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
  imageBase: 0x10100000,
});

const ENGINE_DLL = freeze({
  sha256: '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  imageBase: 0x10300000,
});

const DEUSEX_PACKAGE = freeze({
  sha256: '257f5c166739b3d13884a8b8e98a47dda458b325fa929b3b3b99be056cb74480',
});

const CONPLAYBASE_FIELDS = freezeFields([
  {name: 'playMode', kind: 'ByteProperty', arrayDim: 1, elementSize: 1, alignment: 1},
  {name: 'displayMode', kind: 'ByteProperty', arrayDim: 1, elementSize: 1, alignment: 1},
  {name: 'RootWindow', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'con', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'startCon', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'Player', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'invokeActor', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'currentEvent', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'lastEvent', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'lastActor', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'playingSoundId', kind: 'IntProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'lastSpeechTextLength', kind: 'IntProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'missionNumber', kind: 'IntProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'MissionLocation', kind: 'StrProperty', arrayDim: 1, elementSize: 12, alignment: 4},
  {name: 'History', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'startActor', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'saveRadiusDistance', kind: 'IntProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'initialRadius', kind: 'IntProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'bConversationStarted', kind: 'BoolProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'bForcePlay', kind: 'BoolProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'conWinThird', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'ConActors', kind: 'ObjectProperty', arrayDim: 10, elementSize: 4, alignment: 4},
  {name: 'ConActorsBound', kind: 'ObjectProperty', arrayDim: 10, elementSize: 4, alignment: 4},
  {name: 'conActorCount', kind: 'IntProperty', arrayDim: 1, elementSize: 4, alignment: 4},
]);

const DATALINK_PLAY_FIELDS = freezeFields([
  {name: 'datalink', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'startSound', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'eventTimer', kind: 'FloatProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'bStartTransmission', kind: 'BoolProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'bEndTransmission', kind: 'BoolProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'blinkRate', kind: 'FloatProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'startDelay', kind: 'FloatProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'endDelay', kind: 'FloatProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'perCharDelay', kind: 'FloatProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'bSilent', kind: 'BoolProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'infoLinkNames', kind: 'StructProperty', arrayDim: 17, elementSize: 0x18, alignment: 4,
    structKey: 'deusex.datalinkplay.s_infolinknames'},
  {name: 'dataLinkQueue', kind: 'ObjectProperty', arrayDim: 8, elementSize: 4, alignment: 4},
  {name: 'DataLinkTrigger', kind: 'ObjectProperty', arrayDim: 1, elementSize: 4, alignment: 4},
  {name: 'EndTransmission', kind: 'StrProperty', arrayDim: 1, elementSize: 12, alignment: 4},
]);

const CORE = freeze({
  ...CORE_DLL,
  uClassBind: freeze({
    thunk: 0x10102afe,
    body: 0x10127a20,
    classConstructorOffset: 0x4e0,
    superOffset: 0x28,
    objectFlagsOffset: 0x1c,
    nativeClassFlag: 0x04000000,
    specialCoreObjectClass: 0x1029e0d0,
    superBindVirtualSlot: 0x5c,
  }),
  uStructLink: freeze({
    thunk: 0x10101933,
    body: 0x10126060,
    propertiesSizeOffset: 0x3c,
    getInheritanceSuperVirtualSlot: 0x68,
    getPropertiesSizeVirtualSlot: 0x64,
  }),
  getPropertiesSize: freeze({
    thunk: 0x101026e4,
    body: 0x1010f7c0,
    propertiesSizeOffset: 0x3c,
  }),
});

const ENGINE_ACTOR = freeze({
  ...ENGINE_DLL,
  package: 'Engine',
  className: 'Actor',
  key: 'engine.actor',
  packageExport: 2,
  exportFlags: 0x040f0004,
  serializedClassFlags: 0x833,
  super: 'Core.Object',
  superPackageReference: -3,
  registration: 0x1035ed30,
  registrationFileOffset: 0x5ed30,
  rawRegistrationFlags: 0x04084004,
  staticClass: 0x1057cdf0,
  instanceSize: 0x318,
  internalConstructor: 0x10302dab,
  constructorBody: 0x10323550,
  vtable: 0x104268dc,
  initExecution: freeze({slot: 0x38, thunk: 0x10302194, body: 0x103deb40}),
  spawned: freeze({slot: 0x74, thunk: 0x10303373, body: 0x1030d730}),
  processEventSlot: 0x10,
});

const CONPLAYBASE = freeze({
  package: 'DeusEx',
  className: 'ConPlayBase',
  key: 'deusex.conplaybase',
  packageExport: 4533,
  exportFlags: 0x000f0004,
  serializedClassFlags: 0x32,
  super: 'Engine.Actor',
  superPackageReference: -3,
  nativeConstructor: null,
  nativeVtable: null,
  fields: CONPLAYBASE_FIELDS,
});

const DATALINK_PLAY = freeze({
  package: 'DeusEx',
  className: 'DataLinkPlay',
  key: 'deusex.datalinkplay',
  packageExport: 1154,
  exportFlags: 0x000f0004,
  serializedClassFlags: 0x3a,
  super: 'DeusEx.ConPlayBase',
  superPackageExport: 4533,
  scriptDeclaration: 'class DataLinkPlay expands ConPlayBase transient;',
  nativeConstructor: null,
  nativeVtable: null,
  fields: DATALINK_PLAY_FIELDS,
  authoredDefaults: freeze({
    blinkRate: 0.5,
    startDelay: 1.5,
    endDelay: 1,
    perCharDelay: 0.029999999329447746,
    bHidden: true,
    bMovable: true,
    bDetectable: true,
    Role: 4,
    RemoteRole: 1,
    LastRenderTime: -10,
    LODBias: 1,
    bDifficulty0: true,
    bDifficulty1: true,
    bDifficulty2: true,
    bDifficulty3: true,
    bSinglePlayer: true,
    bNet: true,
    bNetSpecial: true,
    OddsOfAppearing: 1,
    DrawType: 1,
    Style: 1,
    DrawScale: 1,
    ScaleGlow: 1,
    Fatness: 128,
    SoundRadius: 32,
    SoundVolume: 128,
    SoundPitch: 64,
    TransientSoundVolume: 1,
    CollisionRadius: 22,
    CollisionHeight: 22,
    bJustTeleported: true,
    Mass: 100,
    ConStartInterval: 5,
    NetPriority: 1,
    NetUpdateFrequency: 100,
    EndTransmission: 'END TRANSMISSION...',
  }),
  // These fields are absent from the ClassDefaults scalar map.  The original
  // zeroed allocation therefore supplies false/zero before any script writes.
  zeroWhenAbsent: freeze([
    'bStatic', 'bNoDelete', 'bCollideWhenPlacing', 'bCollideActors', 'bCollideWorld',
    'bBlockActors', 'bBlockPlayers', 'bGameRelevant',
  ]),
});

export const SCRIPTED_ACTOR_CONSTRUCTION = freeze({
  binaries: freeze({core: CORE_DLL, engine: ENGINE_DLL, deusEx: DEUSEX_PACKAGE}),
  core: CORE,
  engineActor: ENGINE_ACTOR,
  conPlayBase: CONPLAYBASE,
  dataLinkPlay: DATALINK_PLAY,
  startup: freeze({
    preBeginPlay: freeze({
      netModeClient: 3,
      bGameRelevant: false,
      shrinksCollisionFor: freeze(['Decoration', 'Inventory', 'Pawn']),
      relevanceService: 'Level.Game.IsRelevant(Self)',
      destroysWhenNotRelevant: true,
    }),
  }),
  layout: freeze({
    alignment: 4,
    infoLinkNamesStructSize: 0x18,
    actorPropertiesSize: ENGINE_ACTOR.instanceSize,
    conPlayBasePropertiesSize: 0x3c0,
    dataLinkPlayPropertiesSize: 0x5ac,
    boolMergeMask: 0x7fffffff,
  }),
});

function requireClassRecord(record, expectedKey, label) {
  if (!record || typeof record !== 'object') throw new TypeError(`Missing ${label} class record`);
  if (String(record.key ?? '').toLowerCase() !== expectedKey)
    throw new Error(`${label} class identity must be ${expectedKey}`);
}

/**
 * Select the original inherited constructor for this exact chain.  The
 * script records must explicitly carry null constructors and the Actor record
 * must carry its recovered vtable; an unrelated native
 * subclass or a missing Actor registration is rejected instead of falling
 * back to a generic Actor body.
 */
export function resolveInheritedActorConstructor({dataLinkPlay, conPlayBase, actor} = {}) {
  requireClassRecord(dataLinkPlay, DATALINK_PLAY.key, 'DataLinkPlay');
  requireClassRecord(conPlayBase, CONPLAYBASE.key, 'ConPlayBase');
  requireClassRecord(actor, ENGINE_ACTOR.key, 'Engine.Actor');
  if (dataLinkPlay.nativeConstructor !== null)
    throw new Error('DataLinkPlay unexpectedly carries an independent native constructor');
  if (conPlayBase.nativeConstructor !== null)
    throw new Error('ConPlayBase unexpectedly carries an independent native constructor');
  if (actor.nativeConstructor !== ENGINE_ACTOR.internalConstructor)
    throw new Error('Engine.Actor ClassConstructor does not match the recovered registration');
  if (actor.nativeVtable !== ENGINE_ACTOR.vtable)
    throw new Error('Engine.Actor native vtable does not match the recovered constructor body');
  return freeze({
    classKey: DATALINK_PLAY.key,
    inherited: true,
    constructor: ENGINE_ACTOR.internalConstructor,
    constructorBody: ENGINE_ACTOR.constructorBody,
    nativeVtable: ENGINE_ACTOR.vtable,
    propertiesSize: SCRIPTED_ACTOR_CONSTRUCTION.layout.dataLinkPlayPropertiesSize,
    bindOrder: freeze([
      'DataLinkPlay UField::Bind',
      'ConPlayBase UClass::Bind',
      'Engine.Actor UClass::Bind',
      'copy Engine.Actor ClassConstructor to ConPlayBase',
      'copy ConPlayBase ClassConstructor to DataLinkPlay',
    ]),
  });
}

/** Alias naming the only verified scripted actor chain. */
export const resolveDataLinkPlayConstructor = resolveInheritedActorConstructor;

const requiredDefaults = DATALINK_PLAY.authoredDefaults;

/** Check the scalar ClassDefaults merge captured from DeusEx.u. */
export function verifyDataLinkPlayDefaults(defaults) {
  if (!defaults || typeof defaults !== 'object') throw new TypeError('DataLinkPlay defaults must be an object');
  for (const [name, expected] of Object.entries(requiredDefaults)) {
    const actual = defaults[name];
    if (name === 'perCharDelay') {
      if (Math.fround(actual) !== Math.fround(expected))
        throw new Error(`DataLinkPlay default ${name} does not match the original f32 value`);
    } else if (!Object.is(actual, expected)) {
      throw new Error(`DataLinkPlay default ${name} does not match the original value`);
    }
  }
  for (const name of DATALINK_PLAY.zeroWhenAbsent) {
    const actual = Object.hasOwn(defaults, name) ? defaults[name] : false;
    if (actual !== false && actual !== 0)
      throw new Error(`DataLinkPlay default ${name} must be zero/false when absent from authored defaults`);
  }
  return freeze({
    authored: freeze({...requiredDefaults}),
    zeroWhenAbsent: DATALINK_PLAY.zeroWhenAbsent,
    collisionFlagsClear: true,
    role: requiredDefaults.Role,
    remoteRole: requiredDefaults.RemoteRole,
  });
}

export const DATALINK_PLAY_CONSTRUCTION = DATALINK_PLAY;
