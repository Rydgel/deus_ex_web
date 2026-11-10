/**
 * What one Conversation.BindEvents call repeats (docs/firefox-60fps-plan.md "BindEvents in the 20 s tick").
 *
 * DConversation::BindEvents calls each event's BindActor for every Pawn, Decoration and PlayerPawn whose BindName is not empty (the
 * pairs of candidate and event, script-conversation-events.mjs bindEventsToActor). The event bodies read the same few fields in
 * every pair, and ConEventTransferObject::BindActor (0x1000bc40) and ConEventCheckObject::BindActor (0x10007bf0) load the item
 * class named by the event with StaticLoadObject in each of them, whichever actor is the candidate. The host answers those reads
 * from the property storage and runs the recovered StaticLoadObject each time (the pair's cost on the Island: 15 of the 23 ms of
 * the 20 s tick's call in Firefox).
 *
 * Within one call nothing that these services read changes except what the call writes through `write` (the event's speaker,
 * speakingTo, eventOwner, fromActor, toActor, giveObject and checkObject object links, and the bound-actor slots), so:
 *
 *  - a string, boolean or number the BindActor reader returned for an object and field is the answer to the next read of them,
 *    until `write` stores that field (the event chain's links are not read through the scope: bindEventsNative notes the events
 *    of its first walk and replays them, script-conversation-events.mjs walkRecordedChain);
 *  - a load of the same class (classRef), outer package, name, file name, flags and sandbox returns the object the first load
 *    returned: the export's `_Object` is created by the first and found by the later ones (ULinkerLoad::CreateExport's early-out
 *    at 0x1012e26c, script-static-load-object.mjs resolveExport), and a miss falls to StaticFindObject, which only reads.
 *
 * The scope is the call: `begin`/`end` bracket bindEventsNative, and nothing is kept after it, so no write from a later script
 * or a collection can be served from here. BIND_EVENTS=js (script-conversation-events.mjs bindEventsMode) keeps the reference:
 * every read and load goes through. BIND_EVENTS=verify answers from the scope and also reads and loads for real, and throws when
 * they differ.
 */
import { bindEventsMode } from './script-conversation-events.mjs';
import { scriptCaps, scriptStringText } from './script-string-operations.mjs';

export class BindScope {
  constructor({ read, write }) {
    this.rawRead = read;
    this.rawWrite = write;
    this.depth = 0;
    this.active = false;
    this.verify = false;
    this.reads = null;
    this.loads = null;
    this.folds = null;
    this.routes = null;
    // what the scope served (a validator or a scenario reads them: the caches ran when these are not zero)
    this.counts = { reads: 0, readHits: 0, loads: 0, loadHits: 0, writes: 0 };
    // (the functions the bind services hold: bound once, as the runtime's own bindRead and bindWrite were)
    this.read = (object, key) => this.cachedRead(object, key);
    this.write = (object, key, value) => this.cachedWrite(object, key, value);
    this.equalText = (left, right) => this.equal(left, right);
  }

  begin() {
    if (this.depth++ > 0) return;
    const mode = bindEventsMode();
    this.active = mode !== 'js';
    this.verify = mode === 'verify';
    if (this.active) {
      this.reads = new Map();
      this.loads = new Map();
      this.folds = new Map();
      this.routes = new Map();
    }
  }

  end() {
    if (--this.depth > 0) return;
    this.active = false;
    this.reads = null;
    this.loads = null;
    this.folds = null;
    this.routes = null;
  }

  /**
   * appStricmp equality of two FString values as the event bodies make it (scriptCaps(scriptStringText(value)) on each side,
   * their equalText defaults), the folded text of a value kept for the call: a name is compared in every pair.
   */
  equal(left, right) {
    const folds = this.folds;
    if (folds === null) return scriptCaps(scriptStringText(left)) === scriptCaps(scriptStringText(right));
    let a = folds.get(left), b = folds.get(right);
    if (a === undefined) folds.set(left, a = scriptCaps(scriptStringText(left)));
    if (b === undefined) folds.set(right, b = scriptCaps(scriptStringText(right)));
    if (this.verify && (a !== scriptCaps(scriptStringText(left)) || b !== scriptCaps(scriptStringText(right)))) {
      throw new Error('BIND_EVENTS=verify: a kept folded name differs from the fold of its value');
    }
    return a === b;
  }

  cachedRead(object, key) {
    if (!this.active) return this.rawRead(object, key);
    this.counts.reads++;
    let fields = this.reads.get(object);
    if (fields === undefined) this.reads.set(object, fields = new Map());
    else if (fields.has(key)) {
      const value = fields.get(key);
      this.counts.readHits++;
      if (this.verify) {
        const fresh = this.rawRead(object, key);
        if (!Object.is(fresh, value)) {
          throw new Error(`BIND_EVENTS=verify: read of ${String(object?.name ?? object)}.${key} was kept as ${String(value)}, now ${String(fresh)}`);
        }
      }
      return value;
    }
    const value = this.rawRead(object, key);
    const type = typeof value;
    if (type === 'string' || type === 'boolean' || type === 'number') fields.set(key, value);
    return value;
  }

  cachedWrite(object, key, value) {
    if (this.active) {
      this.counts.writes++;
      this.reads.get(object)?.delete(key);
    }
    return this.rawWrite(object, key, value);
  }

  /**
   * The StaticLoadObject request of an event body, through `services.staticLoadObject` (the host's service). The first load of a
   * name in the call is real; the later ones with the same request return what it returned.
   */
  load(services, request) {
    if (!this.active) return services.staticLoadObject(request);
    this.counts.loads++;
    const name = request.name;
    const kept = this.loads.get(name);
    if (kept !== undefined && kept.classRef === request.classRef && kept.outer === request.outer
      && kept.filename === request.filename && kept.flags === request.flags && kept.sandbox === request.sandbox) {
      this.counts.loadHits++;
      if (this.verify) {
        const fresh = services.staticLoadObject(request);
        if (fresh !== kept.object) {
          throw new Error(`BIND_EVENTS=verify: StaticLoadObject(${String(name)}) was kept as ${String(kept.object?.name ?? kept.object)}, now ${String(fresh?.name ?? fresh)}`);
        }
      }
      return kept.object;
    }
    const object = services.staticLoadObject(request);
    this.loads.set(name, { classRef: request.classRef, outer: request.outer, filename: request.filename,
      flags: request.flags, sandbox: request.sandbox, object });
    return object;
  }
}
