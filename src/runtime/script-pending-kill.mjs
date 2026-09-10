/** Original native vtable +0x2c predicates. This is not the GC unreachable
 * flag or ConditionalDestroy flag: UObject returns false even after its
 * Destroy hook, while the Actor override returns bDeleteMe. Other native
 * subclass tables require their own verified binding. */
const objectTables=new Set([0x10179dfc,0x101758f4,0x101753a0,0x1042672c,0x10429580,0x104290b8]);
const actorTables=new Set([0x104268dc,0x10427178,0x10427a34]);

export function nativeScriptPendingKill(object,readActor) {
  if(objectTables.has(object?.nativeVtable))return false;
  if(actorTables.has(object?.nativeVtable))return Boolean(readActor(object.identity,'bDeleteMe'));
  throw new Error('IsPendingKill requires a verified native class vtable');
}
