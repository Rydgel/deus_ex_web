/** Original native vtable +0x2c predicates. This is not the GC unreachable
 * flag or ConditionalDestroy flag: UObject returns false even after its
 * Destroy hook, while the Actor override returns bDeleteMe. Other native
 * subclass tables require their own verified binding. */
import {NATIVE_ACTOR_CONSTRUCTORS} from './script-native-actor-constructors.mjs';

const objectTables=new Set([0x10179dfc,0x101758f4,0x101753a0,0x1042672c,0x10429580,0x104290b8]);
// AActor::IsPendingKill (Engine.dll 0x1030df80). Every native Actor-class
// vtable in the generated constructor family reaches it through its +0x2c
// slot, so the actor predicate covers each of them, not a listed few.
const ACTOR_IS_PENDING_KILL=0x1030df80;
const actorTables=new Set(Object.values(NATIVE_ACTOR_CONSTRUCTORS)
  .filter(row=>row.pendingKillBody===ACTOR_IS_PENDING_KILL).map(row=>row.vtable));

export function nativeScriptPendingKill(object,readActor) {
  if(objectTables.has(object?.nativeVtable))return false;
  if(actorTables.has(object?.nativeVtable))return Boolean(readActor(object.identity,'bDeleteMe'));
  throw new Error('IsPendingKill requires a verified native class vtable');
}
