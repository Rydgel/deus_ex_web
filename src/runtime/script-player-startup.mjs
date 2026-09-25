/**
 * Source-backed standalone player subsystem startup.
 *
 * DeusExGameInfo.Login spawns JCDentonMale and then the player's
 * PostBeginPlay -> InitializeSubSystems path creates the manager objects.
 * This module links that bytecode before Login and verifies the resulting
 * graph afterward; it runs none of it. The subsystem classes spawn through
 * general SpawnActor with their bound ClassConstructors, including
 * CreateKeyRing. NanoKeyRing is a script-only Inventory subclass; see
 * docs/script-nanokey.md and docs/script-player-login.md.
 *
 * Evidence: .cache/reference/DeusExPlayer.uc:424-550, 1249-1261;
 * AugmentationManager/CreateAugmentations and AddDefaultAugmentations in the
 * installed DeusEx.u; and .cache/original-gobjects-20260912-training-start.txt
 * slots 41705-41726.
 */

const lower = value => String(value ?? '').toLowerCase();
const freeze = value => Object.freeze(value);

export const PLAYER_AUGMENTATION_STARTUP = freeze({
  manager: 'deusex.augmentationmanager',
  augmentation: 'deusex.augmentation',
  classes: freeze([
    'deusex.augspeed', 'deusex.augtarget', 'deusex.augcloak',
    'deusex.augballistic', 'deusex.augradartrans', 'deusex.augshield',
    'deusex.augenviro', 'deusex.augemp', 'deusex.augcombat',
    'deusex.aughealing', 'deusex.augstealth', 'deusex.augiff',
    'deusex.auglight', 'deusex.augmuscle', 'deusex.augvision',
    'deusex.augdrone', 'deusex.augdefense', 'deusex.augaqualung',
    'deusex.augdatalink', 'deusex.augheartlung', 'deusex.augpower',
  ]),
  defaults: freeze(['deusex.auglight', 'deusex.augiff', 'deusex.augdatalink']),
  locationSlots: freeze([
    freeze({ numSlots: 1, augCount: 0, keyBase: 4 }),
    freeze({ numSlots: 1, augCount: 0, keyBase: 7 }),
    freeze({ numSlots: 3, augCount: 0, keyBase: 8 }),
    freeze({ numSlots: 1, augCount: 0, keyBase: 5 }),
    freeze({ numSlots: 1, augCount: 0, keyBase: 6 }),
    freeze({ numSlots: 2, augCount: 0, keyBase: 2 }),
    freeze({ numSlots: 3, augCount: 0, keyBase: 11 }),
  ]),
  // MakeUniqueObjectName continues each class counter. Play's session starts
  // at Training, so its Login creates the first of each (suffix 0). The
  // 2026-09-12 capture was a menu session: DX.dxm's player took suffix 0 and
  // Training's subsystems there are AugmentationManager1 ... AugPower1.
  defaultObjectNames: freeze([
    'AugmentationManager0',
    'AugSpeed0', 'AugTarget0', 'AugCloak0', 'AugBallistic0',
    'AugRadarTrans0', 'AugShield0', 'AugEnviro0', 'AugEMP0',
    'AugCombat0', 'AugHealing0', 'AugStealth0', 'AugIFF0',
    'AugLight0', 'AugMuscle0', 'AugVision0', 'AugDrone0',
    'AugDefense0', 'AugAqualung0', 'AugDatalink0', 'AugHeartLung0',
    'AugPower0',
  ]),
});

export class PlayerStartupBoundaryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PlayerStartupBoundaryError';
    this.code = 'PLAYER_STARTUP_BOUNDARY';
    this.details = freeze({ ...details });
  }
}

function requiredExport(asset, path, description = path) {
  const index = asset?.exportsByPath?.get(lower(path));
  if (!index) throw new Error(`Original ${description} is not exported: ${path}`);
  return index;
}

async function loadClass(runtime, asset, path) {
  return runtime.loadClass(asset, requiredExport(asset, path, `${path} class`));
}

function classKey(value) {
  return lower(value?.record?.key ?? value?.key);
}

function classChain(cls) {
  const result = [];
  for (let current = cls; current; current = current.base) result.push(classKey(current));
  return result;
}

function requireActorScriptClass(cls, label) {
  const chain = classChain(cls);
  if (!chain.includes('engine.actor') || chain.at(-1) !== 'core.object') {
    throw new Error(`${label} is not an Engine.Actor -> Core.Object script class`);
  }
  // The subsystem classes carry the same script-only class flags as the
  // capture-backed DataLinkPlay chain. Native subclass constructor selection
  // remains outside this adapter; the accepted construction uses inherited
  // Engine.Actor's verified constructor body.
  if (cls.metadata?.classFlags !== 0x32)
    throw new Error(`${label} has an unverified native class-constructor branch`);
}

function walkDecoded(node, visit, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walkDecoded(child, visit, seen);
    else if (value && typeof value === 'object') walkDecoded(value, visit, seen);
  }
}

function objectClassOperands(runtime, record) {
  const refs = [];
  const seen = new Set();
  const visit = node => {
    if (node.op !== 0x20 || !node.objectIndex) return;
    const object = runtime.objects.operand(record.function.script, node);
    if (object?.kind === 'Class' && !seen.has(object.key)) {
      seen.add(object.key);
      refs.push(object);
    }
  };
  for (const entry of record.function.compiled.decoded.statements.values())
    walkDecoded(entry.node ?? entry, visit);
  return refs;
}

function expectedClassKeys(values, label) {
  const keys = values.filter(Boolean).map(value => classKey(value));
  if (keys.some(key => !key)) throw new Error(`${label} contains an unresolved class identity`);
  return keys;
}

function verifyExactList(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} does not match the installed original class order: actual=${actual.join(',')} expected=${expected.join(',')}`);
  }
}

async function prepareFunction(runtime, asset, path, description = path) {
  return runtime.prepareFunction(asset, requiredExport(asset, path, description));
}

async function prepareClassStorage(runtime, cls) {
  for (const field of cls.propertyLink ?? []) await runtime.field(field);
}

async function prepareClassLifecycle(runtime, cls) {
  await prepareClassStorage(runtime, cls);
  for (const name of ['Spawned', 'PreBeginPlay', 'BeginPlay', 'PostBeginPlay',
    'SetInitialState', 'PostPostBeginPlay', 'GainedChild', 'LostChild']) {
    const record = runtime.lookupMember(cls, 'methods', name);
    if (record && !record.function) await runtime.prepareFunction(record.asset, record.index);
  }
  for (const stateRecord of cls.states?.values() ?? []) {
    const state = await runtime.prepareState(stateRecord.asset, stateRecord.index);
    for (const name of ['BeginState', 'EndState']) {
      const record = runtime.lookupMember(state, 'methods', name);
      if (record && !record.function) await runtime.prepareFunction(record.asset, record.index);
    }
  }
}

async function prepareActorLineage(runtime, cls) {
  const lineage = [];
  for (let current = cls; current; current = current.base) {
    lineage.push(current);
    if (classKey(current) === 'engine.actor') break;
  }
  for (const current of lineage.reverse()) await prepareClassLifecycle(runtime, current);
}

function readStructMember(value, name) {
  if (!value || typeof value !== 'object') return undefined;
  const key = Object.keys(value).find(candidate => lower(candidate).endsWith(`.${lower(name)}`));
  return key === undefined ? undefined : value[key];
}

function verifyLocationDefaults(runtime, managerClass) {
  const field = runtime.lookupMember(managerClass, 'fields', 'AugLocs');
  if (!field) throw new Error('AugmentationManager.AugLocs is not linked');
  const slots = runtime.defaultValue(managerClass, field);
  if (!Array.isArray(slots) || slots.length !== PLAYER_AUGMENTATION_STARTUP.locationSlots.length)
    throw new Error('AugmentationManager.AugLocs default array is not linked');
  slots.forEach((slot, index) => {
    const expected = PLAYER_AUGMENTATION_STARTUP.locationSlots[index];
    for (const [name, value] of [['NumSlots', expected.numSlots], ['AugCount', expected.augCount], ['KeyBase', expected.keyBase]]) {
      if (readStructMember(slot, name) !== value)
        throw new Error(`AugmentationManager.AugLocs[${index}].${name} differs from the original default`);
    }
  });
  return slots;
}

function verifyAugmentationState(runtime, manager, augmentations) {
  const first = runtime.namedReference(manager, 'FirstAug').get();
  if (first !== augmentations[0]) throw new Error('AugmentationManager.FirstAug does not point to AugSpeed1');
  const seen = new Set(), chain = [];
  for (let current = first; current; current = runtime.namedReference(current, 'Next').get()) {
    if (seen.has(current)) throw new Error('AugmentationManager augmentation chain is cyclic');
    seen.add(current); chain.push(current);
  }
  verifyExactList(chain.map(item => classKey(runtime.instance(item).cls)), PLAYER_AUGMENTATION_STARTUP.classes,
    'AugmentationManager linked list');
  if (chain.length !== augmentations.length || chain.some((item, index) => item !== augmentations[index]))
    throw new Error('AugmentationManager linked list identities differ from Spawn order');
  for (const [index, augmentation] of augmentations.entries()) {
    const owner = runtime.namedReference(augmentation, 'Owner').get();
    const player = runtime.namedReference(augmentation, 'Player').get();
    if (owner !== manager) throw new Error(`Augmentation ${PLAYER_AUGMENTATION_STARTUP.classes[index]} has the wrong Owner`);
    if (player !== runtime.namedReference(manager, 'Player').get())
      throw new Error(`Augmentation ${PLAYER_AUGMENTATION_STARTUP.classes[index]} has the wrong Player`);
  }
  const byClass = new Map(augmentations.map(item => [classKey(runtime.instance(item).cls), item]));
  for (const key of PLAYER_AUGMENTATION_STARTUP.classes) {
    const augmentation = byClass.get(key);
    const owned = Boolean(runtime.namedReference(augmentation, 'bHasIt').get());
    const active = Boolean(runtime.namedReference(augmentation, 'bIsActive').get());
    const expectedOwned = PLAYER_AUGMENTATION_STARTUP.defaults.includes(key);
    const expectedActive = key === 'deusex.augiff' || key === 'deusex.augdatalink';
    if (owned !== expectedOwned || active !== expectedActive)
      throw new Error(`Augmentation ${key} default ownership/active state differs from the original`);
  }
  const locations = runtime.namedReference(manager, 'AugLocs').get();
  locations.forEach((slot, index) => {
    const expected = PLAYER_AUGMENTATION_STARTUP.locationSlots[index];
    if (readStructMember(slot, 'NumSlots') !== expected.numSlots ||
        readStructMember(slot, 'AugCount') !== (index === 6 ? 3 : expected.augCount))
      throw new Error(`AugmentationManager.AugLocs[${index}] count/capacity differs after defaults`);
  });
  return { chain, byClass };
}

/**
 * Prepare the original standalone subsystem graph before Login. The result's
 * complete(player) verifies the graph real Login/PostBeginPlay built.
 */
export async function createPlayerAugmentationStartup({runtime, assets, deusEx, level, player} = {}) {
  if (!runtime || !assets?.get || !deusEx || !level || !player)
    throw new TypeError('Player augmentation startup requires runtime, packages, level, and player');
  // Login may reserve the host identity before StaticAllocateObject attaches
  // script storage. Preparation needs the class, not an already-made pawn.
  const playerClass = await loadClass(runtime, deusEx, 'JCDentonMale');
  if (classKey(playerClass) !== 'deusex.jcdentonmale')
    throw new Error(`Player augmentation startup is restricted to JCDentonMale, got ${classKey(playerClass)}`);

  const managerClass = await loadClass(runtime, deusEx, 'AugmentationManager');
  const augmentationBaseClass = await loadClass(runtime, deusEx, 'Augmentation');
  const barkManagerClass = await loadClass(runtime, deusEx, 'BarkManager');
  const themeManagerClass = await loadClass(runtime, deusEx, 'ColorThemeManager');
  const skillManagerClass = await loadClass(runtime, deusEx, 'SkillManager');
  const nanoKeyRingClass = await loadClass(runtime, deusEx, 'NanoKeyRing');
  const engine = await assets.get('Engine');
  // CreateKeyRing's Spawn/GiveTo/SetBase and the later GiveKey `new` run the
  // original bodies. Prepare that call graph before InitializeSubSystems.
  await prepareActorLineage(runtime, nanoKeyRingClass);
  await loadClass(runtime, deusEx, 'NanoKeyInfo');
  for (const [packageAsset, path] of [
    [engine, 'Inventory.GiveTo'], [engine, 'Inventory.BecomeItem'], [engine, 'Pawn.AddInventory'],
    [deusEx, 'DeusExPlayer.AddInventory'], [deusEx, 'DeusExPlayer.DeleteInventory'],
    [deusEx, 'DeusExPlayer.RemoveItemFromSlot'], [deusEx, 'DeusExPlayer.SetInvSlots'],
    [deusEx, 'DeusExRootWindow.DeleteInventory'], [deusEx, 'DeusExRootWindow.AddInventory'],
    [engine, 'Pawn.DeleteInventory'],
    [deusEx, 'DeusExPlayer.CreateKeyRing'],
    [deusEx, 'NanoKeyRing.GiveKey'], [deusEx, 'NanoKeyRing.HasKey'], [deusEx, 'NanoKeyRing.GetPlayer'],
    [deusEx, 'DeusExPlayer.CreateNanoKeyInfo'], [deusEx, 'DeusExPlayer.PickupNanoKey'],
    [deusEx, 'DeusExPlayer.ParseRightClick'], [deusEx, 'DeusExPlayer.RestrictInput'],
    [deusEx, 'DeusExPlayer.PutInHand'], [deusEx, 'DeusExPlayer.UpdateInHand'],
    [deusEx, 'DeusExPlayer.SetInHand'], [deusEx, 'DeusExPlayer.SetInHandPending'],
    [deusEx, 'DeusExPlayer.UpdateCarcassEvent'],
    [deusEx, 'SkilledTool.BringUp'], [deusEx, 'SkilledTool.PlayUseAnim'],
    [deusEx, 'DeusExPickup.BaseChange'],
  ]) await prepareFunction(runtime, packageAsset, path);
  // GivePlayerAugmentation reports a newly acquired level through the
  // installed PlayerPawnExt.ClientMessage script event while the manager is
  // being built.
  const extension = await assets.get('Extension');
  await prepareFunction(runtime, extension, 'PlayerPawnExt.ClientMessage');
  const createThemes = await prepareFunction(runtime, deusEx, 'DeusExPlayer.CreateColorThemeManager');
  await prepareFunction(runtime, deusEx, 'DeusExPlayer.InitializeSubSystems');
  const createKeyRing = await prepareFunction(runtime, deusEx, 'DeusExPlayer.CreateKeyRing');
  await prepareFunction(runtime, deusEx, 'AugmentationManager.CreateAugmentations');
  await prepareFunction(runtime, deusEx, 'AugmentationManager.AddDefaultAugmentations');
  await prepareFunction(runtime, deusEx, 'AugmentationManager.GivePlayerAugmentation');
  await prepareFunction(runtime, deusEx, 'AugmentationManager.FindAugmentation');
  await prepareFunction(runtime, deusEx, 'AugmentationManager.AreSlotsFull');
  await prepareFunction(runtime, deusEx, 'AugmentationManager.GetAugLevelValue');
  // GivePlayerAugmentation shows a new, not always-active augmentation on the
  // HUD when the globalconfig bHUDShowAllAugs is set, which the installed
  // User.ini does (docs/script-config.md).
  await prepareFunction(runtime, deusEx, 'DeusExPlayer.AddAugmentationDisplay');
  // Radiation's first full player damage call recomputes Health from the six
  // body-part fields after DXReduceDamage. This small inherited player helper
  // is part of the now-live trigger integration, so prepare its exact body.
  await prepareFunction(runtime, deusEx, 'DeusExPlayer.GenerateTotalHealth');
  await prepareFunction(runtime, deusEx, 'DeusExPlayer.GetLevelInfo');
  await prepareFunction(runtime, deusEx, 'SkillManager.CreateSkills');
  await prepareFunction(runtime, deusEx, 'ColorThemeManager.AddTheme');
  await prepareActorLineage(runtime, playerClass);
  for (const cls of [managerClass, augmentationBaseClass, barkManagerClass, themeManagerClass, skillManagerClass])
    await prepareActorLineage(runtime, cls);

  const managerAugClasses = runtime.defaultValue(managerClass,
    runtime.lookupMember(managerClass, 'fields', 'augClasses'));
  verifyExactList(expectedClassKeys(managerAugClasses.slice(0, PLAYER_AUGMENTATION_STARTUP.classes.length), 'augClasses'),
    PLAYER_AUGMENTATION_STARTUP.classes, 'AugmentationManager.augClasses');
  const managerDefaultClasses = runtime.defaultValue(managerClass,
    runtime.lookupMember(managerClass, 'fields', 'defaultAugs'));
  verifyExactList(expectedClassKeys(managerDefaultClasses, 'defaultAugs'), PLAYER_AUGMENTATION_STARTUP.defaults,
    'AugmentationManager.defaultAugs');
  const locationDefaults = verifyLocationDefaults(runtime, managerClass);
  const themeClasses = objectClassOperands(runtime, createThemes)
    .filter(object => classKey(object).startsWith('deusex.colortheme'));
  const themeClassObjects = new Map(themeClasses.map(object => [classKey(object), object]));
  if (!themeClassObjects.size) throw new Error('CreateColorThemeManager has no linked ColorTheme class operands');
  const themeClassesLinked = await Promise.all([...themeClassObjects.values()].map(object =>
    runtime.loadClass(object.asset, object.index)));
  const skillClassObjects = runtime.defaultValue(skillManagerClass,
    runtime.lookupMember(skillManagerClass, 'fields', 'skillClasses'));
  const skillClassesLinked = await Promise.all(skillClassObjects.filter(Boolean).map(object =>
    runtime.loadClass(object.asset, object.index)));
  const augmentationClassesLinked = await Promise.all(managerAugClasses.filter(Boolean).map(object =>
    runtime.loadClass(object.asset, object.index)));
  const supportedClasses = new Set([
    barkManagerClass, themeManagerClass, managerClass, skillManagerClass,
    ...themeClassesLinked, ...skillClassesLinked, ...augmentationClassesLinked,
  ]);
  for (const cls of supportedClasses) {
    requireActorScriptClass(cls, cls.record.name);
    // Spawn's inherited constructor needs every field's linked metadata for
    // InitProperties and its exact Actor lifecycle needs these event records.
    await prepareActorLineage(runtime, cls);
  }
  if (!runtime.actorLifecycle?.construction || !level.nativeObject?.outer) {
    throw new PlayerStartupBoundaryError(
      'Player subsystem startup requires the linked native Actor construction host',
      { boundary: 'Actor.StaticConstructObject' },
    );
  }
  // DeusExPlayer.PostBeginPlay calls InitializeSubSystems after CreateShadow
  // (original source lines 424-445), inside Login's Spawn; complete() only
  // reads and verifies the resulting graph.
  const bindPlayer = actualPlayer => {
    if (!actualPlayer || classKey(runtime.instance(actualPlayer).cls) !== 'deusex.jcdentonmale')
      throw new Error('Player subsystem completion requires the original JCDentonMale identity');
    player = actualPlayer;
    return player;
  };
  const complete = (actualPlayer = player) => {
    bindPlayer(actualPlayer);
    for (const [field, expected] of [['BarkManager', 'deusex.barkmanager'],
      ['ThemeManager', 'deusex.colorthememanager'], ['SkillSystem', 'deusex.skillmanager']]) {
      const subsystem = runtime.namedReference(player, field).get();
      if (!subsystem || classKey(runtime.instance(subsystem).cls) !== expected)
        throw new Error(`InitializeSubSystems did not create the original ${field}`);
      if (runtime.namedReference(subsystem, 'Owner').get() !== player)
        throw new Error(`${field} Owner is not JCDentonMale`);
    }
    const manager = runtime.namedReference(player, 'AugmentationSystem').get();
    if (!manager) throw new Error('InitializeSubSystems did not create AugmentationManager');
    if (classKey(runtime.instance(manager).cls) !== PLAYER_AUGMENTATION_STARTUP.manager)
      throw new Error('Player AugmentationSystem has the wrong class');
    if (runtime.namedReference(manager, 'Owner').get() !== player)
      throw new Error('AugmentationManager Owner is not JCDentonMale');
    if (runtime.namedReference(manager, 'Player').get() !== player)
      throw new Error('AugmentationManager Player is not JCDentonMale');

    const augmentations = [], seen = new Set();
    for (let current = runtime.namedReference(manager, 'FirstAug').get(); current;
      current = runtime.namedReference(current, 'Next').get()) {
      if (seen.has(current)) throw new Error('AugmentationManager augmentation chain is cyclic');
      seen.add(current); augmentations.push(current);
    }
    verifyAugmentationState(runtime, manager, augmentations);
    const keyRing = runtime.namedReference(player, 'KeyRing').get();
    if (!keyRing || classKey(runtime.instance(keyRing).cls) !== 'deusex.nanokeyring')
      throw new Error('CreateKeyRing did not spawn the player NanoKeyRing');
    if (runtime.namedReference(keyRing, 'Owner').get() !== player)
      throw new Error('NanoKeyRing Owner is not JCDentonMale');
    return freeze({
      manager,
      augmentations: freeze(augmentations),
      classKeys: freeze(augmentations.map(item => classKey(runtime.instance(item).cls))),
      discardKeyRing,
      spawnKeyRing,
      supportedClasses: freeze([...supportedClasses].map(cls => classKey(cls))),
      locationSlots: freeze(locationDefaults.map(slot => freeze({
        numSlots: readStructMember(slot, 'NumSlots'),
        augCount: readStructMember(slot, 'AugCount'),
        keyBase: readStructMember(slot, 'KeyBase'),
      }))),
    });
  };
  const discardKeyRing = () => {
    const ring = runtime.namedReference(player, 'KeyRing').get();
    if (ring) runtime.destroyActor(ring, false);
    runtime.namedReference(player, 'KeyRing').set(null);
    runtime.namedReference(player, 'KeyList').set(null);
    if (runtime.namedReference(player, 'inHand').get() === ring) {
      runtime.namedReference(player, 'inHand').set(null);
      runtime.namedReference(player, 'inHandPending').set(null);
    }
  };
  const spawnKeyRing = () => {
    if (!runtime.namedReference(player, 'KeyRing').get()) runtime.callFunction(createKeyRing, player, 0);
  };
  return freeze({complete, bindPlayer, discardKeyRing, spawnKeyRing,
    supportedClasses: freeze([...supportedClasses].map(cls => classKey(cls)))});
}

export default createPlayerAugmentationStartup;
