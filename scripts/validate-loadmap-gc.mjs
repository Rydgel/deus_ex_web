/** Player start as UGameEngine::LoadMap reloads the map: the old player is
 * dissociated and destroyed before the load, and the load's collection
 * releases everything the old level spawned (docs/script-loadmap-gc.md).
 *
 * 1. Original evidence: hash-pinned DLLs, pinned instruction ranges, the
 *    semantic anchors inside them, the imports they call and the vtable slots
 *    that select each Destroy override (the render iterators' live Player
 *    start is validate-island-player-start.mjs).
 * 2. Live Play over 22 resets: the retirement order and effects, the purge of
 *    the whole old generation with GObjAvailable reuse, and bounded memory
 *    (registry length and live count, window heap high-water mark, JS heap).
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {liveHandleCount} from '../src/runtime/script-object-handles.mjs';
import {gameDirectory} from './game-directory.mjs';

v8.setFlagsFromString('--expose_gc');
const fullGc = vm.runInNewContext('gc');
const root = gameDirectory();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// ---- 1. Original evidence ----------------------------------------------------
const DLL_SHA256 = {
  Core: '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
  Engine: '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  Extension: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  DeusEx: 'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04',
  ConSys: 'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa',
};
const BODIES = {
  notifyLevelChange: ['Engine', 0x1038c110, 0x1038c180, '113bea179a8def708e125996ba57f19e7baaa310b23b47e5601792344e8ff023'],
  dissociateViewports: ['Engine', 0x1038c6c4, 0x1038c733, 'ba97e65e83cce7528317220c587a9c9fc7359ab0887614fa0d354f1715ea4931'],
  unloadLevel: ['Engine', 0x1038c799, 0x1038c8a0, 'f74eda25fdcc4ebb7a9ea9cb6b61dc2c3b8bd9f062c0af982767bd5f5fed607e'],
  loadLevel: ['Engine', 0x1038c8a0, 0x1038c914, '3ec599cdfbc6fc71b32ce8cef617fd6f0335dfea28634b3a8dc0585763be3a21'],
  tagAndCollect: ['Engine', 0x1038d0ee, 0x1038d1e7, '9ba4d48bfbab2be554f672d40e2cdc13edb8e450068d4ebe51a52fc35f421588'],
  destroyActorPlayerGate: ['Engine', 0x10395c59, 0x10395cda, '54ea5b8d75697a14af4a44fa5801d4c32686f391bbbfa34f8ee18fa0f828fe1c'],
  purgeGarbage: ['Core', 0x101581f0, 0x101584ce, 'ef2a3e4804f09462bf12ff9f9441c2c0406b816ec91f1fa4e608133547998922'],
  collectGarbage: ['Core', 0x10158500, 0x10158574, 'd4c12ed53ae454491bf1611365432e2e6a5e74314710bea346893d205c8e6899'],
  resetLoaders: ['Core', 0x10155750, 0x1015589c, 'a9e82f913c33bd376805db6805fae766b9d6b0f6cf8b4da97a07c3c34397595f'],
  replaceExisting: ['Core', 0x10157c51, 0x10157e9e, 'fb2896b96df47a4edb9ceba6a7339b1cb95a9631835ef377786b746698f09296'],
  rootTransientPackage: ['Core', 0x1015282c, 0x10152848, 'd4f1ecfce80a5efff100fc84638091d7114261c6a4393f86cf0dc87a10b191fa'],
  rootCleanUp: ['Extension', 0x10039240, 0x100392e1, 'bb0e8de00f030ce48ca2daac6c060fe504e9d5ea68145a6d916130217655e740'],
  rootDestroy: ['Extension', 0x10039320, 0x1003935e, '3459dbd7b2d493fc23436352af9ca07aa6b991757e3ea1a4f48007e566f1f3e6'],
  rootDestructor: ['Extension', 0x100059c0, 0x10005b7f, 'cfafb638f78144b30cb1f820b28a10a3d295c89b0cca327a05bc83cdd07cba3b'],
  rootDeletingDestructor: ['Extension', 0x100067b0, 0x10006811, '2c8318fdee97796498f28be9aa4a80c04c6aaf668a73100edc9954658dee06da'],
  playerPawnExtDestroy: ['Extension', 0x10037d40, 0x10037db9, 'dc37888220620571db8b2467047b732b2382f27b7c068ce02f8c035eb95f653f'],
  flagBaseDestroy: ['Extension', 0x100239f0, 0x10023a7d, 'a395f35b6916de09920117e2428f532a0b12d852027d67bcb8db38a225aa177c'],
  removeFlag: ['Extension', 0x10023a80, 0x10023ae1, '4be86194d019745133d272a544d252e77a789e72b96b423113ec244a71ff282e'],
  deusExPlayerDestroy: ['DeusEx', 0x100141f0, 0x1001423f, '0b066bd34564a4ec4fc0b2cb3c1b9db61cdac241830f2df9636bf2adb8bc4b5f'],
  dumpLocationDestroy: ['DeusEx', 0x10015120, 0x100151c9, '1b36559c7ff7a7db4d9a1bce10aac85751ddbb635dec4fb7c004c0b265a2417e'],
  closeDumpFile: ['DeusEx', 0x100159d0, 0x10015a06, '180393440adc3cbe2738afcf26c90c20b45135e16fefd40f2434fab5594ac86f'],
  conHistoryDestroy: ['ConSys', 0x1000ca20, 0x1000ca78, 'ad2fb0f6338bdf5a9e55e3f4e20878e3cb583925725192fa3e5ef43e885605b2'],
  // AActor::Destroy and the render iterators SetupDynamics builds
  // (script-render-iterator.mjs).
  actorDestroy: ['Engine', 0x10368f60, 0x10368fbd, '0a7ac6fac610fe75b82dad4354bbe89d9eaf8bcfa18d6480552f2b561b761b14'],
  renderIteratorConstructor: ['Engine', 0x103d9cf0, 0x103d9da6, '7f525bd47bfc1183e630b2923dc39cb628ac16c89ba10876cee7b1febd945f2d'],
  laserIteratorConstructor: ['DeusEx', 0x1001a780, 0x1001a7a3, '67ef4dd7084755d58d22b9bc70e353550dc45f77f4338621d4b63100432fb089'],
  particleIteratorConstructor: ['DeusEx', 0x1000d360, 0x1000d383, '5591d42510f9db2e313202318db4164a8b5ec248dac940322728fa9660d4d0dd'],
  laserIteratorDestructor: ['DeusEx', 0x1001a710, 0x1001a778, '3f4449f849c25b16f3bad487d36b69e758639173be862e42c7809455b4ab3c7f'],
  particleIteratorDestructor: ['DeusEx', 0x1000d2f0, 0x1000d358, '91b3c55cb7e179c1165bf8d398c67d1b8e6c17c24fcaa57bb7e9fa4a2b45110c'],
  laserIteratorDeletingDestructor: ['DeusEx', 0x1001a9c0, 0x1001aa22, '597a442d127cc92abe9beb0e0e48109f1ebafbcec2f2d0cf64bd83bd35b83673'],
  particleIteratorDeletingDestructor: ['DeusEx', 0x1000d540, 0x1000d5a2, '9b6dc3ebe837458f80f797d7a5f0141d66ceda594e606b1ad33eb2ef3c885302'],
};
// The instructions the model rests on, inside the pinned ranges.
const ANCHORS = [
  ['Engine', 0x1038c6cf, 'ff92c4000000', 'GEngine->NotifyLevelChange (vtable +0xc4)'],
  ['Engine', 0x1038c70e, 'c780d405000000000000', 'Actor.Player (+0x5d4) = 0'],
  ['Engine', 0x1038c721, 'c7423000000000', 'Viewport.Actor (+0x30) = 0'],
  ['Engine', 0x1038c72a, 'ff9294000000', 'Actor.XLevel->DestroyActor(Actor, 0) (vtable +0x94)'],
  ['Engine', 0x1038c7ba, 'ff15309f5910', 'ResetLoaders(GLevel.Outer, 1, 0)'],
  ['Engine', 0x1038d17a, '80cd04', 'IsIn(GLevel.Outer) actors |= 0x400'],
  ['Engine', 0x1038d1bf, 'bafffbffff', 'GLevel->Actors &= ~0x400 mask'],
  ['Engine', 0x1038d1d6, '21501c', 'GLevel->Actors &= ~0x400'],
  ['Engine', 0x1038d1dc, '6800000004ff15489f5910', 'CollectGarbage(RF_Native)'],
  ['Core', 0x1015826c, '893d4c262a10', 'GObjInGarbageCollection = 1'],
  ['Core', 0x101582b6, 'e8b59ffaff', 'pass 1: ConditionalDestroy'],
  ['Core', 0x10158367, '6a01ff520c', 'pass 2: vtable +0x0c (scalar deleting destructor) with 1'],
  ['Core', 0x10157db9, 'ff520c', 'replace an existing object in place: vtable +0x0c with 0'],
  ['Core', 0x10157e99, 'e8d596faff', 'reclaim the replaced object index: GObjAvailable.Remove'],
  ['Extension', 0x10037d7d, 'ff1578900510', 'ConditionalDestroy(flagBase) outside a collection'],
  ['Extension', 0x10037d95, 'e816430100', 'rootWindow SafeDestroy'],
  ['Extension', 0x10037da2, 'ff1540930510', 'AActor::Destroy'],
  ['Extension', 0x100392c3, 'ff155c910510', 'XRootWindow::CleanUp RemoveFromRoot'],
  ['Engine', 0x10368f8a, '8b8e14030000', 'AActor::Destroy reads RenderInterface (+0x314)'],
  ['Engine', 0x10368f94, 'ff15089b5910', 'AActor::Destroy: RenderInterface->ConditionalDestroy()'],
  ['Engine', 0x10368f9a, 'c7861403000000000000', 'AActor::Destroy: RenderInterface = NULL'],
  ['Engine', 0x10368fa6, 'ff15e09a5910', 'AActor::Destroy: UObject::Destroy'],
  ['Engine', 0x103d9d24, '894e2c', 'URenderIterator(): Index (+0x2c) = 0'],
  ['Engine', 0x103d9d27, '894e30', 'URenderIterator(): Observer (+0x30) = NULL'],
  ['Engine', 0x103d9d2a, 'c706dc964210', 'URenderIterator(): its vtable 0x104296dc'],
  ['Engine', 0x103d9d3b, '3df0cd5710', 'URenderIterator(): check(GetOuter()->IsA(AActor::StaticClass()))'],
  ['DeusEx', 0x1001a793, 'ff15d0720210c706d0830210', 'ULaserIterator(): URenderIterator(), then vtable 0x100283d0'],
  ['DeusEx', 0x1000d373, 'ff15d0720210c706147a0210', 'UParticleIterator(): URenderIterator(), then vtable 0x10027a14'],
  ['DeusEx', 0x1001aec0, 'ff25dc700210', 'iterator Destroy (+0x24): jmp UObject::Destroy'],
];
const IMPORTS = [
  ['Engine', 0x10599f48, 'Core.dll!?CollectGarbage@UObject@@SAXK@Z'],
  ['Engine', 0x10599f30, 'Core.dll!?ResetLoaders@UObject@@SAXPAV1@HH@Z'],
  ['Engine', 0x10599b08, 'Core.dll!?ConditionalDestroy@UObject@@QAEHXZ'],
  ['Extension', 0x10059078, 'Core.dll!?ConditionalDestroy@UObject@@QAEHXZ'],
  ['Extension', 0x10059340, 'Engine.dll!?Destroy@AActor@@UAEXXZ'],
  ['Extension', 0x1005915c, 'Core.dll!?RemoveFromRoot@UObject@@QAEXXZ'],
  ['Extension', 0x1005914c, 'Core.dll!?GObjInGarbageCollection@UObject@@0HA'],
  ['DeusEx', 0x10027404, 'Extension.dll!?Destroy@APlayerPawnExt@@UAEXXZ'],
  ['DeusEx', 0x10027008, 'CONSYS.dll!?Destroy@DConHistory@@UAEXXZ'],
  ['DeusEx', 0x100270dc, 'Core.dll!?Destroy@UObject@@UAEXXZ'],
  ['Engine', 0x10599ae0, 'Core.dll!?Destroy@UObject@@UAEXXZ'],
  ['Engine', 0x10599b58, 'Core.dll!??0UObject@@QAE@XZ'],
  ['DeusEx', 0x100272d0, 'Engine.dll!??0URenderIterator@@QAE@XZ'],
  ['DeusEx', 0x1002707c, 'Core.dll!?ConditionalDestroy@UObject@@QAEHXZ'],
  ['DeusEx', 0x100272cc, 'Engine.dll!??_7URenderIterator@@6B@'],
  ['DeusEx', 0x100270a0, 'Core.dll!??1UObject@@UAE@XZ'],
  ['DeusEx', 0x1002709c, 'Core.dll!??3UObject@@SAXPAXI@Z'],
];
// Retail vtable slots: [dll, vtable, slot, target].
const SLOTS = [
  ['Engine', 0x10428dfc, 0xc4, 0x10301e47],   // UGameEngine::NotifyLevelChange
  ['Engine', 0x10428afc, 0x94, 0x10302568],   // ULevel::DestroyActor
  ['DeusEx', 0x10027568, 0x24, 0x100141f0],   // ADeusExPlayer::Destroy
  ['Extension', 0x1005c32c, 0x24, 0x10037d40], // APlayerPawnExt::Destroy
  ['Extension', 0x1005c20c, 0x24, 0x100239f0], // XFlagBase::Destroy
  ['Extension', 0x10059cc4, 0x0c, 0x100067b0], // XRootWindow scalar deleting destructor
  ['Extension', 0x10059cc4, 0x24, 0x10039320], // XRootWindow::Destroy
  ['Extension', 0x10059cc4, 0x58, 0x10039240], // XRootWindow::CleanUp
  ['DeusEx', 0x10027f94, 0x24, 0x10015120],   // UDumpLocation::Destroy
  ['DeusEx', 0x10027fe8, 0x24, 0x1001ae60],   // ConHistory: jmp DConHistory::Destroy
  ['DeusEx', 0x1002803c, 0x24, 0x1001aec0],   // ConHistoryEvent: jmp UObject::Destroy
  ['DeusEx', 0x10027ad0, 0x24, 0x1001aec0],   // DeusExLog: jmp UObject::Destroy
  ['DeusEx', 0x100283d0, 0x24, 0x1001aec0],   // LaserIterator: jmp UObject::Destroy
  ['DeusEx', 0x100283d0, 0x0c, 0x1001a9c0],   // LaserIterator scalar deleting destructor
  ['DeusEx', 0x10027a14, 0x24, 0x1001aec0],   // ParticleIterator: jmp UObject::Destroy
  ['DeusEx', 0x10027a14, 0x0c, 0x1000d540],   // ParticleIterator scalar deleting destructor
];

function peImage(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = view.getUint32(60, true), optional = pe + 24, base = view.getUint32(optional + 28, true);
  const sections = [], table = optional + view.getUint16(pe + 20, true);
  for (let i = 0; i < view.getUint16(pe + 6, true); i++) {
    const at = table + i * 40;
    sections.push({rva: view.getUint32(at + 12, true), size: Math.max(view.getUint32(at + 8, true), view.getUint32(at + 16, true)),
      raw: view.getUint32(at + 20, true)});
  }
  const offset = va => {
    const rva = va - base, section = sections.find(s => rva >= s.rva && rva < s.rva + s.size);
    if (!section) throw new Error(`VA 0x${va.toString(16)} is outside the image`);
    return section.raw + rva - section.rva;
  };
  const u32 = va => view.getUint32(offset(va), true);
  const cstring = at => { let end = at; while (bytes[end]) end++; return Buffer.from(bytes.subarray(at, end)).toString('latin1'); };
  const imports = new Map();
  for (let at = offset(base + view.getUint32(optional + 104, true)); view.getUint32(at + 16, true); at += 20) {
    const dll = cstring(offset(base + view.getUint32(at + 12, true)));
    const thunks = view.getUint32(at, true) || view.getUint32(at + 16, true), slots = view.getUint32(at + 16, true);
    for (let i = 0; ; i++) {
      const entry = u32(base + thunks + 4 * i);
      if (!entry) break;
      imports.set(base + slots + 4 * i, `${dll}!${entry & 0x80000000 ? `#${entry & 0xffff}` : cstring(offset(base + entry) + 2)}`);
    }
  }
  return {bytes: (start, end) => bytes.subarray(offset(start), offset(start) + (end - start)), u32, imports};
}

const images = {};
for (const [name, digest] of Object.entries(DLL_SHA256)) {
  const bytes = await readFile(path.join(root, 'System', `${name}.dll`));
  assert.equal(sha256(bytes), digest, `${name}.dll is not the hash-pinned GOTY image`);
  images[name] = peImage(bytes);
}
for (const [name, [dll, start, end, digest]] of Object.entries(BODIES))
  assert.equal(sha256(images[dll].bytes(start, end)), digest, `${name} body changed`);
for (const [dll, at, hex, meaning] of ANCHORS)
  assert.equal(Buffer.from(images[dll].bytes(at, at + hex.length / 2)).toString('hex'), hex, meaning);
for (const [dll, slot, name] of IMPORTS) assert.equal(images[dll].imports.get(slot), name, `${dll} IAT 0x${slot.toString(16)}`);
for (const [dll, vtable, slot, target] of SLOTS)
  assert.equal(images[dll].u32(vtable + slot), target, `${dll} vtable 0x${vtable.toString(16)} slot +0x${slot.toString(16)}`);

// ---- 2. Live Play reload ------------------------------------------------------
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const events = [];
const processEvent = ScriptRuntime.prototype.processEvent;
ScriptRuntime.prototype.processEvent = function (actor, name, ...rest) {
  if (name === 'NotifyLevelChange' || name === 'Destroyed') events.push({actor, name});
  return processEvent.call(this, actor, name, ...rest);
};
const {createGame} = await import('../src/viewer/game.mjs');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const scene = game.doors.scriptRuntime, runtime = scene.runtime, host = scene.windowHost;
const registry = runtime.actorLifecycle.construction.registry;
const level = runtime.levelFor(game.player.collisionActor);
const idle = {forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false};
const read = (object, name) => runtime.namedReference(object, name).get();
const live = () => registry.objects.reduce((count, object) => count + (object ? 1 : 0), 0);
const rootList = () => {
  const roots = [];
  for (let at = host.globals.get('rootWindowList'); at; at = host.W.ptr(at, 0x58c)) roots.push(at);
  return roots;
};
const RESETS = 22;
// Old space holds the JS objects; code space only follows V8's compilation.
const oldSpace = () => v8.getHeapSpaceStatistics().find(space => space.space_name === 'old_space').space_used_size;
const names = runtime.actorLifecycle.construction.names;
const liveNames = () => names.names.reduce((count, entry) => count + (entry ? 1 : 0), 0);
let shape = null, oldAfterWarmup = 0, namesAfterWarmup = 0;
for (let reset = 1; reset <= RESETS; reset++) {
  const oldPlayer = game.player.collisionActor;
  const oldRoot = read(oldPlayer, 'rootWindow'), oldFlagBase = read(oldPlayer, 'FlagBase');
  const gameConsole = read(level.engine.client.viewports[0], 'Console');
  const oldObjects = registry.objects.filter(Boolean);
  assert.ok(oldRoot && oldFlagBase?.entries instanceof Map, 'the Login player owns a root window and a FlagBase');
  events.length = 0;
  game.reset();
  for (let frame = 0; frame < 30; frame++) game.tick(1 / 30, idle);
  const label = `reset ${reset}`;

  // LoadMap 0x1038c6c4..0x1038c731: NotifyLevelChange, then the old player's
  // DestroyActor with its Destroyed event, before anything reloads.
  const notify = events.findIndex(event => event.actor === gameConsole && event.name === 'NotifyLevelChange');
  const destroyed = events.findIndex(event => event.actor === oldPlayer && event.name === 'Destroyed');
  assert.ok(notify >= 0 && destroyed > notify, `${label}: NotifyLevelChange precedes the old player's Destroyed`);
  // ADeusExPlayer::Destroy -> APlayerPawnExt::Destroy outside a collection:
  // the FlagBase is drained, the root window tree is destroyed and its
  // XRootWindow::CleanUp unlinked it from the root-window list.
  assert.equal(oldFlagBase.entries.size, 0, `${label}: XFlagBase::Destroy drained the old FlagBase`);
  assert.equal(host.isDestroyed(oldRoot), true, `${label}: the old root window tree was destroyed`);
  assert.deepEqual(rootList(), [read(game.player.collisionActor, 'rootWindow')], `${label}: only the new root is listed`);

  // LoadMap 0x1038d0ee..0x1038d1e1: every object of the old generation is
  // released; the five persistent stand-ins survive (DeusEx is the package
  // record CreateConCamera's CreatePackage finds, docs/conversation-camera.md).
  const collection = scene.lastCollection;
  assert.ok(collection.eliminated.length > 0, `${label}: the old level's actors were tagged`);
  assert.equal(collection.excluded.length, 0, `${label}: no reloaded object still referenced the old level`);
  const survivors = oldObjects.filter(object => !object.released);
  assert.deepEqual(survivors.map(object => object.name).sort(), ['DeusEx', 'DeusExConText', 'MyLevel', 'TrainingRuntime', 'Transient'],
    `${label}: only the persistent package and level records survive`);
  assert.throws(() => runtime.instance(oldPlayer), /released/, `${label}: the old player was released`);
  // PurgeGarbage's second pass appends each freed slot in index order, and
  // AddObject reuses the last one first: the reload's GameInfo takes the
  // highest freed slot.
  assert.ok(collection.available.every((index, at, list) => !at || list[at - 1] < index), `${label}: GObjAvailable is in index order`);
  const gameInfo = read(level.actors[0], 'Game');
  assert.equal(runtime.instance(gameInfo).nativeObject.index, collection.available.at(-1),
    `${label}: the reload's GameInfo reused the highest freed slot`);

  // R1a (docs/rust-core.md): every handle of the old generation ended with
  // its object, so the handle table does not grow.
  const now = {length: registry.objects.length, live: live(), heap: host.heap.used, handles: liveHandleCount()};
  if (!shape) shape = now;
  else assert.deepEqual(now, shape, `${label}: registry length, live objects, window heap and handles are unchanged`);
  if (reset === 3) { fullGc(); oldAfterWarmup = oldSpace(); namesAfterWarmup = liveNames(); }
  // PurgeGarbage's name pass deleted the old generation's unique names.
  if (reset > 3) assert.ok(liveNames() <= namesAfterWarmup + 2, `${label}: the FName table stays bounded`);
}
fullGc();
const growthMiB = (oldSpace() - oldAfterWarmup) / 1048576;
assert.ok(growthMiB < 4, `JS old space grew ${growthMiB.toFixed(1)} MiB over ${RESETS - 3} resets`);
ScriptRuntime.prototype.processEvent = processEvent;

console.log(`LoadMap retirement and collection validated: ${Object.keys(BODIES).length} pinned bodies, ` +
  `${ANCHORS.length} anchors, ${IMPORTS.length} imports, ${SLOTS.length} vtable slots; ${RESETS} Player starts each ` +
  `destroyed the old player, drained its FlagBase and root window, and released the old generation ` +
  `(${scene.lastCollection.released} objects, ${scene.lastCollection.eliminated.length} tagged actors); ` +
  `registry ${shape.live}/${shape.length}, ${liveNames()} FNames, ${shape.handles} handles, window heap 0x${shape.heap.toString(16)}, ` +
  `JS old space +${growthMiB.toFixed(2)} MiB over ${RESETS - 3} resets.`);
