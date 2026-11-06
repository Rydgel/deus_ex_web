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
import { bumpBaseMoveEpoch, bumpBaseEpochFor } from './base-epoch.mjs';
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
  const attached = identity => runtime.attachedInstance(identity);
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
          visit({ get: () => level.actors[index] ?? null, set: value => { level.actors[index] = value; bumpBaseMoveEpoch(); } });
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
    freeObject: object => { runtime.releaseObjectImage?.(object.identity); object.released = true; bumpBaseEpochFor(object.identity); bumpReceiverEpoch(); },
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

  // A loaded package resource (texture, sound, mesh, class): a host object
  // with its export key, registered for the host's life since the persistent
  // packages are never unloaded.
  const isResource = value => typeof value?.key === 'string' && Boolean(value.record || value.asset || value.linkedClass);
  return {
    engine,
    /** UObject::IsValid (registered at its GObjObjects index) and
     * IsPendingKill (UObject 0x1010ab80 returns 0; AActor 0x1030df80 reads
     * bDeleteMe, the only override in the SDK headers) for ULevel's
     * CleanupDestroyed reference pass (docs/script-cleanup.md). */
    references: {
      isValid: identity => {
        const record = recordOf(identity);
        if (record) {
          if (record.released) return false;
          // A pre-placed map export is registered with its level; `null` is
          // its unmeasured slot (ScriptRuntime.bindNativeObject).
          return record.index === null || registry.objects[record.index] === record;
        }
        // Host-owned natives the registry has no record for (the root window
        // and its windows, the client viewport behind Player): registered in
        // the original until the GC purges them, which the host does not.
        if (attached(identity) || viewports.includes(identity)) return true;
        // The player's FlagBase when the host holds it as a bare store (script-triggers.mjs createFlagBase, bound to the property of a pawn that did not run
        // ResetPlayerToDefaults: a restored one): the original's FlagBase is a registered UObject until the player is destroyed.
        if (identity !== null && typeof identity === 'object' && identity.entries instanceof Map && typeof identity.getBool === 'function' && typeof identity.setBool === 'function') return true;
        return isResource(identity);
      },
      isPendingKill: identity => {
        const record = recordOf(identity);
        return Boolean(record && isActor(record) && runtime.readNamed(identity, 'bDeleteMe'));
      },
    },
    /** ULevel::CleanupDestroyed's final release (0x103967a7): the pending
     * actor's deleting destructor, virtual +0x0c with `flags`, through the
     * same final delete as the collection. A pre-placed export is outside the
     * host registry, which models only runtime-created objects (its slot in
     * the original GObjObjects is unmeasured and it has no FName hash entry
     * here): ~UObject's ConditionalDestroy is a no-op after DestroyActor's,
     * the slot release and unhash have no host counterpart, and its storage
     * stays with the level's reload, which replaces every map export in place
     * (the reference pass has already cleared every reference to it;
     * docs/script-cleanup.md). */
    release(identity, flags) {
      const record = recordOf(identity);
      if (!record) throw new Error('CleanupDestroyed release requires the actor native record');
      const live = registry.objects.filter(object => object && !object.released);
      if (record.index === null) {
        release.conditionalDestroy(record);
        // ~UObject appends the actor's own slot to GObjAvailable: a pre-placed
        // actor's is its measured index, when it has one; the model otherwise
        // counts a slot it cannot name.
        const model = registry.original;
        if (model) {
          const measured = runtime.measuredObjectIndex(identity);
          if (measured === null) model.unattributed++;
          else model.release(measured);   // a measured slot the model never handed out (a pre-placed actor) is the original's own
        }
      } else finalDelete(record, flags);
      for (const object of live) if (object.released) onReleased?.(object.identity);
      runtime.reclaimReleased?.();
    },
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
