/**
 * Source-backed standalone player subsystem startup.
 *
 * DeusExGameInfo.Login spawns JCDentonMale and then the player's
 * PostBeginPlay -> InitializeSubSystems path creates the manager objects. The
 * browser scene already owns the player identity, so this adapter links that
 * identity to the prepared bytecode and supplies only the verified generic
 * script-Actor Spawn path needed by the subsystem classes. It deliberately
 * continues through CreateKeyRing. NanoKeyRing is a script-only Inventory
 * subclass and uses that spawn path; see docs/script-nanokey.md.
 *
 * Evidence: .cache/reference/DeusExPlayer.uc:424-550, 1249-1261;
 * AugmentationManager/CreateAugmentations and AddDefaultAugmentations in the
 * installed DeusEx.u; and .cache/original-gobjects-20260912-training-start.txt
 * slots 41705-41726.
 */
import { spawnScriptActor } from './script-spawn.mjs';

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
  defaultObjectNames: freeze([
    'AugmentationManager1',
    'AugSpeed1', 'AugTarget1', 'AugCloak1', 'AugBallistic1',
    'AugRadarTrans1', 'AugShield1', 'AugEnviro1', 'AugEMP1',
    'AugCombat1', 'AugHealing1', 'AugStealth1', 'AugIFF1',
    'AugLight1', 'AugMuscle1', 'AugVision1', 'AugDrone1',
    'AugDefense1', 'AugAqualung1', 'AugDatalink1', 'AugHeartLung1',
    'AugPower1',
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

function installSubsystemSpawn(runtime, level, supportedClasses) {
  const lifecycle = runtime.actorLifecycle;
  if (!lifecycle?.construction) {
    throw new PlayerStartupBoundaryError(
      'Player subsystem startup requires the linked native Actor construction host',
      { boundary: 'Actor.StaticConstructObject' },
    );
  }
  const priorValidate = lifecycle.validateSpawn;
  const priorConstruction = lifecycle.construction;
  const outer = level.nativeObject?.outer;
  if (!outer) throw new Error('Player subsystem startup requires the original level Outer');

  lifecycle.construction = {
    ...priorConstruction,
    validate: args => {
      if (supportedClasses.has(args.cls))
        return args.outer === outer && args.template === null;
      return typeof priorConstruction.validate === 'function' && priorConstruction.validate(args) === true;
    },
  };
  lifecycle.validateSpawn = args => {
    if (supportedClasses.has(args.cls)) return args.level === level;
    return typeof priorValidate === 'function' ? priorValidate(args) : false;
  };
  lifecycle.spawnActor = (args, services) => {
    if (!supportedClasses.has(args.cls)) {
      throw new PlayerStartupBoundaryError(
        `Player startup requested an unprepared Actor subclass: ${classKey(args.cls)}`,
        { boundary: 'Actor.Spawn', classKey: classKey(args.cls) },
      );
    }
    return spawnScriptActor(args, services, {
      kind: `Player subsystem ${args.cls.record.name}`,
      key: args.cls.record.key,
      constructorSelection: false,
    });
  };
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
 * Prepare and run the original standalone player subsystem path. The result
 * exposes the manager, exact linked augmentation identities, and the explicit
 * first unsupported boundary so validators can distinguish proven state from
 * the remaining inventory work.
 */
export async function createPlayerAugmentationStartup({runtime, assets, deusEx, level, player, warning} = {}) {
  if (!runtime || !assets?.get || !deusEx || !level || !player)
    throw new TypeError('Player augmentation startup requires runtime, packages, level, and player');
  const playerClass = runtime.instance(player).cls;
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
  // installed PlayerPawnExt.ClientMessage script event. The normal defaults
  // reach this UI path while the manager is being built. Its localized Sprintf
  // conversion (bytecode token 0x53) is outside this subsystem slice, so keep
  // the message as an explicit host boundary and continue the state mutations.
  const extension = await assets.get('Extension');
  const playerClientMessage = await runtime.objects.resolve(extension,
    requiredExport(extension, 'PlayerPawnExt.ClientMessage'));
  const createThemes = await prepareFunction(runtime, deusEx, 'DeusExPlayer.CreateColorThemeManager');
  const initialize = await prepareFunction(runtime, deusEx, 'DeusExPlayer.InitializeSubSystems');
  const createKeyRing = await prepareFunction(runtime, deusEx, 'DeusExPlayer.CreateKeyRing');
  await prepareFunction(runtime, deusEx, 'AugmentationManager.CreateAugmentations');
  await prepareFunction(runtime, deusEx, 'AugmentationManager.AddDefaultAugmentations');
  await prepareFunction(runtime, deusEx, 'AugmentationManager.GivePlayerAugmentation');
  await prepareFunction(runtime, deusEx, 'AugmentationManager.FindAugmentation');
  await prepareFunction(runtime, deusEx, 'AugmentationManager.AreSlotsFull');
  await prepareFunction(runtime, deusEx, 'AugmentationManager.GetAugLevelValue');
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
    if (cls.nameCounter === 0) cls.nameCounter = 1;
  }
  installSubsystemSpawn(runtime, level, supportedClasses);
  runtime.boundaryFunctions.set(playerClientMessage.key, ({ warning: ignoredWarning } = {}) => {
    // The original event's only effect in this startup path is UI delivery;
    // do not evaluate its Sprintf argument or fabricate a viewport message.
    ignoredWarning?.({ type: 'PlayerClientMessageBoundary', function: playerClientMessage.key });
    warning?.({ type: 'PlayerClientMessageBoundary', function: playerClientMessage.key });
    return undefined;
  });

  let boundary = null;
  try {
    runtime.callFunction(initialize, player, 0);
  } catch (error) {
    if (!(error instanceof PlayerStartupBoundaryError)) throw error;
    boundary = freeze({ ...error.details, message: error.message });
    warning?.({ type: 'PlayerStartupBoundary', ...boundary });
  }
  const manager = runtime.namedReference(player, 'AugmentationSystem').get();
  if (!manager) throw new Error('InitializeSubSystems did not create AugmentationManager');
  if (classKey(runtime.instance(manager).cls) !== PLAYER_AUGMENTATION_STARTUP.manager)
    throw new Error('Player AugmentationSystem has the wrong class');
  if (runtime.namedReference(manager, 'Owner').get() !== player)
    throw new Error('AugmentationManager Owner is not JCDentonMale');
  if (runtime.namedReference(manager, 'Player').get() !== player)
    throw new Error('AugmentationManager Player is not JCDentonMale');

  const augmentations = [];
  for (let current = runtime.namedReference(manager, 'FirstAug').get(); current;
    current = runtime.namedReference(current, 'Next').get()) augmentations.push(current);
  const linked = verifyAugmentationState(runtime, manager, augmentations);
  const names = [manager, ...augmentations].map(item => runtime.namedReference(item, 'Name').get());
  verifyExactList(names, PLAYER_AUGMENTATION_STARTUP.defaultObjectNames, 'Player subsystem object names');
  void linked;
  void locationDefaults;
  const keyRing = runtime.namedReference(player, 'KeyRing').get();
  if (!keyRing || classKey(runtime.instance(keyRing).cls) !== 'deusex.nanokeyring')
    throw new Error('CreateKeyRing did not spawn the player NanoKeyRing');
  if (runtime.namedReference(keyRing, 'Owner').get() !== player)
    throw new Error('NanoKeyRing Owner is not JCDentonMale');
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
  return freeze({
    manager,
    augmentations: freeze(augmentations),
    classKeys: freeze(augmentations.map(item => classKey(runtime.instance(item).cls))),
    boundary,
    discardKeyRing,
    spawnKeyRing,
    supportedClasses: freeze([...supportedClasses].map(cls => classKey(cls))),
    locationSlots: freeze(locationDefaults.map(slot => freeze({
      numSlots: readStructMember(slot, 'NumSlots'),
      augCount: readStructMember(slot, 'AugCount'),
      keyBase: readStructMember(slot, 'KeyBase'),
    }))),
  });
}

export default createPlayerAugmentationStartup;
