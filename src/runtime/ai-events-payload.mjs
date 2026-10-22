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

/** `ai_snapshot`'s words as a structure: types in bucket order with their senders and receivers, events named by ordinal. */
export function parseAiWords(words) {
  let at = 0;
  const next = () => words[at++];
  const manager = { currentSlot: next(), refProcessing: next() | 0, deleteCount: next() | 0, first: next(), types: [] };
  const typeCount = next();
  const senders = [], receivers = [];
  for (let t = 0; t < typeCount; t++) {
    const type = { bucket: next(), name: next(), hash: next(), senders: [], receivers: [] };
    const nSenders = next(), nReceivers = next();
    for (let s = 0; s < nSenders; s++) {
      const sender = { type, actor: next(), destroyed: next() | 0, settings: [] };
      for (let i = 0; i < SETTINGS_WORDS; i++) sender.settings.push(next());
      type.senders.push(sender); senders.push(sender);
    }
    for (let r = 0; r < nReceivers; r++) {
      const receiver = { type, actor: next(), destroyed: next() | 0, callback: next(), scoreCallback: next(), invoke: next() | 0, state: next() & 255,
        checks: [next() | 0, next() | 0, next() | 0, next() | 0], on: next() | 0, bestScore: next(), bestSender: next(), nextSlot: next() | 0,
        nextProcess: next(), prevProcess: next() };
      type.receivers.push(receiver); receivers.push(receiver);
    }
    manager.types.push(type);
  }
  if (at !== words.length) throw new Error(`The AI event snapshot has ${words.length - at} unread words`);
  return { manager, senders, receivers };
}

/**
 * The payloads of the manager and its events (the write side of decodeAiEvents).
 * @param parsed        parseAiWords()
 * @param positions     {manager, types: [..], senders: [..], receivers: [..]}: each object's export position
 * @param levelPosition the Level export's position
 * @param context       {nameIndex(text), spelling(id)}
 * @param actorRef      (handle word) => export position of the actor, 0 for none
 * @returns {{manager: (w)=>void, types: [(w)=>void], senders: [...], receivers: [...]}}
 */
export function encodeAiEvents(parsed, positions, levelPosition, { nameIndex, spelling, actorRef }) {
  const { manager, senders, receivers } = parsed;
  const typeOf = new Map(manager.types.map((type, i) => [type, i]));
  const none = w => w.compact(nameIndex('None'));
  const senderIndex = new Map(senders.map((s, i) => [s, i])), receiverIndex = new Map(receivers.map((r, i) => [r, i]));
  const bucketHeads = new Array(256).fill(0), nextType = new Map();
  const lastOfBucket = new Map();
  manager.types.forEach((type, i) => {
    if (!lastOfBucket.has(type.bucket)) bucketHeads[type.bucket] = positions.types[i]; else nextType.set(lastOfBucket.get(type.bucket), positions.types[i]);
    lastOfBucket.set(type.bucket, i);
  });
  const ord = (list, ordinal) => ordinal ? positions[list][ordinal - 1] : 0;
  return {
    manager: w => {
      none(w); w.compact(levelPosition); w.i32(manager.refProcessing); w.i32(manager.deleteCount); w.u32(manager.currentSlot);
      w.compact(ord('receivers', manager.first));
      for (const head of bucketHeads) w.compact(head);
    },
    types: manager.types.map((type, i) => w => {
      none(w); w.compact(nameIndex(spelling(type.name))); w.u32(type.hash);
      w.compact(type.senders.length ? positions.senders[senderIndex.get(type.senders[0])] : 0);
      w.compact(type.receivers.length ? positions.receivers[receiverIndex.get(type.receivers[0])] : 0);
      w.compact(nextType.get(i) ?? 0);
    }),
    senders: senders.map(sender => w => {
      none(w); w.compact(positions.types[typeOf.get(sender.type)]); w.compact(actorRef(sender.actor)); w.i32(sender.destroyed);
      const list = sender.type.senders, at = list.indexOf(sender);
      w.compact(at + 1 < list.length ? positions.senders[senderIndex.get(list[at + 1])] : 0);
      for (const word of sender.settings) w.u32(word);
    }),
    receivers: receivers.map(receiver => w => {
      none(w); w.compact(positions.types[typeOf.get(receiver.type)]); w.compact(actorRef(receiver.actor)); w.i32(receiver.destroyed);
      const list = receiver.type.receivers, at = list.indexOf(receiver);
      w.compact(at + 1 < list.length ? positions.receivers[receiverIndex.get(list[at + 1])] : 0);
      w.compact(nameIndex(spelling(receiver.callback))); w.compact(nameIndex(spelling(receiver.scoreCallback)));
      w.i32(receiver.invoke); w.u8(receiver.state);
      for (const check of receiver.checks) w.i32(check);
      w.i32(receiver.on); w.u32(receiver.bestScore); w.compact(ord('senders', receiver.bestSender)); w.i32(receiver.nextSlot);
      w.compact(ord('receivers', receiver.nextProcess)); w.compact(ord('receivers', receiver.prevProcess));
    }),
  };
}
