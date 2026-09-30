/**
 * Play's bindings for UGameEngine::LoadMap's collection of the unloaded level
 * (script-loadmap-gc.mjs). Evidence and the modeled boundary:
 * docs/script-loadmap-gc.md.
 *
 * Roots: the transient package is in the root array (Core StaticInit
 * 0x10152832..0x10152843 AddToRoot), and the engine keeps GLevel and its
 * client viewports. Play has no UGameEngine object, so a host `engine` root
 * stands for those references. ULevel's Serialize visits its Outer package and
 * its Actors array; every other object contributes its UObject header Outer
 * and the reflected references UStruct::SerializeBin visits
 * (ScriptRuntime.serializeReferences).
 */
import { collectLoadMapGarbage } from './script-loadmap-gc.mjs';
import { destructScriptObject, freeScriptObject } from './script-object-release.mjs';
import { releaseConversationItem } from './script-conversation-item-lifecycle.mjs';
import { bumpBaseEpoch } from './base-epoch.mjs';
import { bumpReceiverEpoch } from './receiver-epoch.mjs';
import { releaseTextParserObject } from './script-text-parser-natives.mjs';
import { TEXT_PARSER_NATIVE } from './script-text-parser.mjs';

const CONVERSATION_ITEM_VTABLE = 0x1001346c;

/**
 * `packages` are the host's package/level stand-in records in the registry;
 * `level` is the live level (`nativeObject` names its ULevel record) and
 * `viewports` the client viewports. `onReleased(identity)` lets hosts drop
 * their own references to a released object.
 */
export function createLevelCollection({ runtime, level, viewports = [], transientPackage, packages = [], onReleased = null }) {
  const construction = runtime.actorLifecycle?.construction;
  const registry = construction?.registry;
  if (!registry) throw new Error('LoadMap collection requires the live object registry');
  if (!level?.nativeObject?.outer) throw new Error('LoadMap collection requires GLevel and its package');
  const levelRecord = level.nativeObject, levelPackage = levelRecord.outer;
  const standIns = new Map([levelRecord, levelPackage, transientPackage, ...packages]
    .filter(Boolean).map(record => [record.identity, record]));
  const engine = { name: 'GameEngine' };
  const attached = identity => { try { return runtime.instance(identity); } catch { return null; } };
  const recordOf = identity => standIns.get(identity) ?? attached(identity)?.nativeObject ?? null;
  const isActor = record => {
    for (let cls = attached(record.identity)?.cls; cls; cls = cls.base) if (cls === runtime.actorClass) return true;
    return false;
  };
  const header = (record, visit) => visit({
    get: () => record.outer?.identity ?? null,
    set: value => { record.outer = value === null ? null : recordOf(value); },
  });
  const archive = (visit, visitName) => ({
    objectReference: reference => visit(reference),
    nameReference: reference => visitName(reference.get()),
  });
  // UObject::Serialize visits Name before Outer; ULevel then its Actors.
  function serialize(identity, visit, visitName) {
    if (identity === engine) {
      visit({ get: () => levelRecord.identity, set: () => { throw new Error('GEngine.GLevel is not collectable'); } });
      for (const viewport of viewports) visit({ get: () => viewport, set: () => { throw new Error('Client viewports are not collectable'); } });
      return;
    }
    const standIn = standIns.get(identity);
    if (standIn) {
      visitName(standIn.name);
      header(standIn, visit);
      if (standIn === levelRecord) {
        for (let index = 0; index < level.actors.length; index++)
          visit({ get: () => level.actors[index] ?? null, set: value => { level.actors[index] = value; bumpBaseEpoch(); } });
      }
      return;
    }
    const instance = attached(identity);
    if (!instance) return;
    if (instance.nativeObject) { visitName(instance.nativeObject.name); header(instance.nativeObject, visit); }
    runtime.serializeReferences(identity, archive(visit, visitName));
  }

  const release = {
    gates: { [0x102a2644]: 1, [0x101e5550]: 0 },
    registry, isValid: object => registry.objects[object.index] === object,
    conditionalDestroy: object => runtime.conditionalDestroy(object.identity),
    // The host's FStateFrame is the ScriptState record; freeing it releases
    // nothing beyond the object record itself.
    freeStateFrame: () => {},
    freeObject: object => { runtime.releaseObjectImage?.(object.identity); object.released = true; bumpBaseEpoch(); bumpReceiverEpoch(); },
    warning: runtime.warning,
  };
  function finalDelete(record, flags) {
    const identity = record.identity;
    if (record.nativeVtable === CONVERSATION_ITEM_VTABLE) releaseConversationItem(record, flags, release);
    else if (record.nativeVtable === TEXT_PARSER_NATIVE.vtable) releaseTextParserObject(record, flags, release);
    else {
      // Other classes: their complete destructors' per-level
      // ConditionalDestroy calls are no-ops after the purge's first pass, and
      // their native member teardown frees allocator storage the host does
      // not have; ~UObject and operator delete are the observable tail.
      release.conditionalDestroy(record);
      destructScriptObject(record, release);
      if (flags & 1) freeScriptObject(record, release);
    }
  }

  return {
    engine,
    /** LoadMap 0x1038d0ee..0x1038d1e1 after the level reload. */
    collect() {
      // A Destroy override can delete other objects during the purge (e.g.
      // DConHistory::Destroy), so released records are found afterwards.
      const before = registry.objects.filter(Boolean);
      const result = collectLoadMapGarbage({
        registry, levelPackage, levelActors: level.actors, recordOf, isActor, names: construction.names ?? null,
        // The persistent packages stand for loaded packages the host never
        // unloads (their objects are restored to their load baseline
        // instead); whether the original collection unloads them is not
        // measured (docs/script-loadmap-gc.md).
        rootArray: [transientPackage?.identity ?? null, engine, ...packages.map(record => record.identity)], serialize,
        conditionalDestroy: record => runtime.conditionalDestroy(record.identity),
        finalDelete,
        setGarbageCollecting: active => { runtime.garbageCollecting = active; },
      });
      const released = before.filter(record => record.released).map(record => record.identity);
      for (const identity of released) onReleased?.(identity);
      runtime.reclaimReleased?.();
      return { ...result, released: released.length };
    },
  };
}
