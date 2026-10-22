/** The AI event manager as a saved level holds it (docs/travel.md "The .dxs", docs/ai-event-manager.md): the `EventManager` export and the
 * `AIEventType`, `AISenderEvent` and `AIReceiverEvent` exports it reaches. Each is a native UObject whose Serialize (Engine.dll) writes the tagged
 * property list of an object with no script properties (just the `None` name), then its members in the order below:
 *
 *   UEventManager::Serialize 0x103825f0     level (object), refProcessing (4), deleteCount (4), currentSlot (4), firstProcess (object),
 *                                           eventTable[256] (objects: the head type of each bucket)
 *   AIEventType (size 0x3c)                 eventName (name), eventHash (4), senders (object), receivers (object), nextEventType (object)
 *   AISenderEvent::Serialize 0x10384e50     eventType (object), eventActor (object), bBeingDestroyed (4), nextEvent (object), settings[16] and
 *                                           currentSettings, each XAIEventSettings<< (visual, audio, audioRadius, smell: four floats);
 *                                           holdScore (+0x38) is not serialized
 *   AIReceiverEvent::Serialize 0x10385120   eventType, eventActor, bBeingDestroyed (4), nextEvent (objects/4/object), callback (name),
 *                                           scoreCallback (name), bInvokeCallback (4), eventState (1), bCheckVisibility, bCheckDir,
 *                                           bCheckCylinder, bCheckLOS (4 each), bEventOn (4), bestScore (4), bestSender (object), nextSlot (4),
 *                                           nextProcess (object, +0x7c), prevProcess (object, +0x80); the XAIParams block is not serialized
 *
 * (An object is a compact export/import index, a name a compact index into the package's name table.) The Rust manager (aievent.rs) holds the
 * same data in tables; `ai_load` and `ai_snapshot` exchange it as u32 words, with events named by ordinal. This module converts between the
 * two. Every layout above was recovered from the instructions and confirmed against the 296 + 54 + 9 event objects of a saved Island. */
import { Reader } from '../unreal/package.mjs';

const SETTINGS_WORDS = 16 * 4 + 4;

/**
 * The words `ai_load` takes, from the saved package.
 * @param pkg, bytes       the saved package
 * @param managerIndex     the export index of the `EventManager`
 * @param nameId           (text) => the host's name id
 * @param actorWord        (exportIndex) => the actor's handle word (0 for none)
 * @returns {{words: Uint32Array, types: object[], senders: object[], receivers: object[]}}
 */
export function decodeAiEvents(pkg, bytes, managerIndex, { nameId, actorWord }) {
  const reader = index => {
    const entry = pkg.exports[index - 1];
    if (!entry) throw new Error(`Saved AI event reference ${index} is not an export`);
    const r = new Reader(bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize));
    if (pkg.names[r.compact()].name !== 'None') throw new Error(`${entry.name}: expected an empty property list`);
    return { r, entry };
  };
  const nameText = r => pkg.names[r.compact()].name;
  const float = r => r.u32();
  // the manager
  const { r: m } = reader(managerIndex);
  m.compact();                                       // level
  const refProcessing = m.i32(), deleteCount = m.i32(), currentSlot = m.u32(), firstProcess = m.compact();
  const table = Array.from({ length: 256 }, () => m.compact());
  // types in bucket order, their senders and receivers, numbered as encountered
  const types = [], senders = [], receivers = [];
  const senderOrdinal = new Map(), receiverOrdinal = new Map();
  for (let bucket = 0; bucket < 256; bucket++) {
    for (let t = table[bucket]; t; ) {
      const { r } = reader(t);
      const type = { index: t, bucket, name: nameText(r), hash: r.u32(), senders: r.compact(), receivers: r.compact(), next: r.compact(), senderList: [], receiverList: [] };
      types.push(type);
      for (let s = type.senders; s; ) {
        const { r: sr } = reader(s);
        sr.compact();                                // eventType
        const sender = { index: s, actor: sr.compact(), destroyed: sr.i32(), next: 0, words: [] };
        sender.next = sr.compact();
        for (let i = 0; i < SETTINGS_WORDS; i++) sender.words.push(float(sr));
        if (sr.offset !== sr.bytes.length) throw new Error(`AISenderEvent ${s}: ${sr.bytes.length - sr.offset} unread bytes`);
        senders.push(sender); senderOrdinal.set(s, senders.length); type.senderList.push(sender);
        s = sender.next;
      }
      for (let rc = type.receivers; rc; ) {
        const { r: rr } = reader(rc);
        rr.compact();                                // eventType
        const receiver = { index: rc, actor: rr.compact(), destroyed: rr.i32(), next: 0 };
        receiver.next = rr.compact();
        receiver.callback = nameText(rr); receiver.scoreCallback = nameText(rr);
        receiver.invoke = rr.i32(); receiver.state = rr.u8();
        receiver.checks = [rr.i32(), rr.i32(), rr.i32(), rr.i32()];
        receiver.on = rr.i32(); receiver.bestScore = float(rr); receiver.bestSender = rr.compact(); receiver.nextSlot = rr.i32();
        receiver.nextProcess = rr.compact(); receiver.prevProcess = rr.compact();
        if (rr.offset !== rr.bytes.length) throw new Error(`AIReceiverEvent ${rc}: ${rr.bytes.length - rr.offset} unread bytes`);
        receivers.push(receiver); receiverOrdinal.set(rc, receivers.length); type.receiverList.push(receiver);
        rc = receiver.next;
      }
      t = type.next;
    }
  }
  const ordinal = (map, index) => index ? map.get(index) ?? 0 : 0;
  const words = [currentSlot, refProcessing, deleteCount, ordinal(receiverOrdinal, firstProcess), types.length];
  for (const type of types) {
    words.push(type.bucket, nameId(type.name), type.hash, type.senderList.length, type.receiverList.length);
    for (const s of type.senderList) words.push(actorWord(s.actor), s.destroyed, ...s.words.slice(0, 64), ...s.words.slice(64, 68));
    for (const r of type.receiverList)
      words.push(actorWord(r.actor), r.destroyed, nameId(r.callback), nameId(r.scoreCallback), r.invoke, r.state, ...r.checks, r.on, r.bestScore,
        ordinal(senderOrdinal, r.bestSender), r.nextSlot, ordinal(receiverOrdinal, r.nextProcess), ordinal(receiverOrdinal, r.prevProcess));
  }
  return { words: Uint32Array.from(words.map(word => word >>> 0)), types, senders, receivers };
}
