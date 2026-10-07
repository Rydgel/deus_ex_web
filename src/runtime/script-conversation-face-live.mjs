/** Live face-to-face (ConPlay) conversation preparation for ordinary Play.
 *
 * The Training munitions instructors (UNATCOTroop0/UNATCOTroop3, BindName
 * MunitionsTrooper) bind MunitionsTrooperFrob (Conversation3) then
 * MunitionsTrooperTake (Conversation4) from Mission00. Both are first-person,
 * non-interactive conversations (bFirstPerson=bNonInteractive=true), so the
 * player stays in first person and the instructor speaks a single random
 * greeting line; there is no letterbox camera.
 *
 * Ordinary use enters ScriptedPawn.Frob -> DeusExPlayer.StartConversation(Self,
 * IM_Frob) (docs/script-instructor-conversation.md). StartConversation runs
 * CanStartConversation, ScriptedPawn.CanConverse and GetActiveConversation,
 * whose CheckFlagRefs walks each candidate conversation's ConFlagRef chain and
 * whose per-event handlers walk the ConEvent chain. Those authored objects must
 * be attached to the runtime before the real bytecode can read them, and
 * Conversation.IsSpeakingActor (reached in StartConversation before the ConPlay
 * spawn) must be prepared. This module prepares exactly the conversations the
 * map's conversation-owning pawns can invoke — selected by conOwnerName ==
 * a present pawn BindName, never by a hardcoded conversation name.
 *
 * The selected graph is consumed by the original ConPlay state machine. */

import { copyValue } from './script-values.mjs';
import { loadMissionConversations } from './script-conversation-binding.mjs';

const lower = value => String(value ?? '').toLowerCase();

function readMaybe(runtime, object, key) {
  const instance=runtime.instances.get(object);
  if(!instance||!runtime.lookupMember(instance.cls,'fields',key))return undefined;
  return runtime.readNamed(object,key);
}

/** Prepare one conversation's authored object graph: its ConFlagRef chain, its
 * ConEvent chain (Conversation.eventList -> ConEvent.nextEvent, including the
 * ConEventRandomLabel head) and each event's ConSpeech. Idempotent. */
export async function prepareConversationGraph(runtime, conversation, objects = new Set()) {
  let prepared = 0;
  // prepareObject attaches the object, after which its own linked next-pointer
  // is readable; walk each chain to completion with a cycle guard.
  const seenFlags = new Set();
  for (let flagRef = readMaybe(runtime, conversation, 'flagRefList'); flagRef;) {
    if (seenFlags.has(flagRef)) throw new Error('Conversation flag-ref chain is cyclic');
    seenFlags.add(flagRef);
    await runtime.prepareObject(flagRef); objects.add(flagRef); prepared++;
    flagRef = runtime.readNamed(flagRef, 'nextFlagRef');
  }
  const seenEvents = new Set();
  for (let event = readMaybe(runtime, conversation, 'eventList'); event;) {
    if (seenEvents.has(event)) throw new Error('Conversation event chain is cyclic');
    seenEvents.add(event);
    await runtime.prepareObject(event); objects.add(event); prepared++;
    // conSpeech exists only on ConEventSpeech; other ConEvent subclasses lack it.
    const speech = readMaybe(runtime, event, 'conSpeech');
    if (speech) { await runtime.prepareObject(speech); objects.add(speech); prepared++; }
    const eventFlags = new Set();
    for (let eventFlag = readMaybe(runtime, event, 'flagRef'); eventFlag;) {
      if (eventFlags.has(eventFlag)) throw new Error('Conversation event flag-ref chain is cyclic');
      eventFlags.add(eventFlag);await runtime.prepareObject(eventFlag);objects.add(eventFlag);prepared++;
      eventFlag=runtime.readNamed(eventFlag,'nextFlagRef');
    }
    event = runtime.readNamed(event, 'nextEvent');
  }
  // Every other authored object an event reaches (ConEventChoice.ChoiceList and
  // its ConChoice.nextChoice/flagRef chains, and any further ObjectProperty of
  // the conversation package): the original reads them through the same
  // fields, so each is attached before the bytecode can read its properties.
  const queue = [conversation, ...seenFlags, ...seenEvents];
  for (const event of seenEvents) {
    const speech = readMaybe(runtime, event, 'conSpeech');
    if (speech) queue.push(speech);
    for (let flag = readMaybe(runtime, event, 'flagRef'); flag; flag = runtime.readNamed(flag, 'nextFlagRef')) queue.push(flag);
  }
  while (queue.length) {
    const object = queue.pop();
    for (const field of runtime.instance(object).cls.propertyLink) {
      if (field.metadata?.type !== 'object' || field.key.startsWith('core.object.')) continue;
      const value = runtime.fieldReference(object, field).get();
      for (const target of Array.isArray(value) ? value : [value]) {
        if (!target || target.asset !== conversation.asset || objects.has(target)) continue;
        await runtime.prepareObject(target); objects.add(target); prepared++;
        queue.push(target);
      }
    }
  }
  return prepared;
}

/**
 * Prepare the live face-to-face conversations for the current map. Returns
 * { conversations, preparedObjects } where `conversations` are the canonical
 * Conversation objects (with conName/conOwnerName) that a present pawn can
 * invoke through the real StartConversation path.
 */
export async function prepareFaceConversations(runtime, { assets, level, packageName = 'DeusExConText' } = {}) {
  if (typeof runtime?.prepareConversations !== 'function' || typeof runtime?.prepareObject !== 'function')
    throw new TypeError('Face conversation preparation requires the linked ScriptRuntime');
  const conText = await assets.get(packageName);

  // Mission number from the serialized DeusExLevelInfo (Training -> 0). Read
  // the class through the actor's own instance only when it is attached; at
  // door-setup time some serialized slots are not yet live.
  const instanceOf = actor => { try { return runtime.instance(actor); } catch { return null; } };
  const isLevelInfo = actor => {
    if (String(actor?.className ?? '').toLowerCase() === 'deusexlevelinfo') return true;
    for (let cls = instanceOf(actor)?.cls; cls; cls = cls.base)
      if (cls.record.key === 'deusex.deusexlevelinfo') return true;
    return false;
  };
  const levelInfoActor = (level?.actors ?? []).find(actor => actor && isLevelInfo(actor));
  const missionNumber = levelInfoActor
    ? (readMaybe(runtime, levelInfoActor, 'missionNumber') ?? levelInfoActor.values?.missionNumber ?? 0) | 0 : 0;

  // The BindNames present in the live map — every conversation-owning pawn.
  const bindNames = new Set();
  for (const actor of level?.actors ?? []) {
    if (!actor) continue;
    const bindName = lower(actor.values?.BindName ?? readMaybe(runtime, actor, 'BindName'));
    if (bindName && bindName !== 'none') bindNames.add(bindName);
  }

  // The recovered ConBindEvents binds nothing without a DeusExLevelInfo or
  // for a negative missionNumber (DX -2, DXOnly -1), so no face
  // conversation can start there (script-conversation-wrapper.mjs).
  const descriptors = levelInfoActor && missionNumber >= 0 ? loadMissionConversations(conText, missionNumber) : [];
  const conversations = [];
  const objects = new Set();
  let preparedObjects = 0;
  for (const descriptor of descriptors) {
    if (!descriptor.conOwnerName || !bindNames.has(lower(descriptor.conOwnerName))) continue;
    // Bark conversations are started by the AI system and skipped by
    // GetActiveConversation (DeusExPlayer.uc:7941). DataLink conversations play
    // through the separate DataLink path. Neither is a frob ConPlay candidate;
    // their graphs were attached with the mission list's load
    // (ScriptRuntime.prepareConversations), where ConPlayBark and DataLinkPlay
    // read them.
    if (lower(descriptor.conName).startsWith(lower(`${descriptor.conOwnerName}_Bark`))) continue;
    const conversation = await runtime.objects.resolve(conText, descriptor.ref);
    await runtime.prepareObject(conversation);
    if (readMaybe(runtime, conversation, 'bDataLinkCon')) continue;
    objects.add(conversation);
    preparedObjects += 1 + await prepareConversationGraph(runtime, conversation, objects);
    conversations.push({ conversation, conName: descriptor.conName, conOwnerName: descriptor.conOwnerName });
  }

  // Conversation.IsSpeakingActor is reached by DeusExPlayer.StartConversation
  // (the con.IsSpeakingActor(Self) participant test) before the ConPlay spawn.
  const conSys = await assets.get('ConSys');
  const isSpeakingActor = conSys.exportsByPath.get('conversation.isspeakingactor');
  if (isSpeakingActor) await runtime.prepareFunction(conSys, isSpeakingActor);

  // Player start restores the conversation package's objects to their load
  // baseline (docs/script-loadmap-gc.md): the face graphs above and every
  // other object the mission list's load attached, such as the bark
  // ConEventRandomLabel cycle state GetRandomLabel advances.
  const restored = new Set(objects);
  for (const loaded of runtime.conversationListObjects?.values() ?? []) for (const object of loaded) restored.add(object);
  // Preserve canonical ObjectProperty identities, copying owned typed values.
  const baseline = [...restored].map(object => ({ object, fields:
    runtime.instance(object).cls.propertyLink.filter(field => !field.key.startsWith('core.object.'))
      .map(field => [field, copyValue(field, runtime.fieldReference(object, field).get())]) }));
  const reset = () => {
    for (const {object, fields} of baseline)
      for (const [field, value] of fields) runtime.fieldReference(object, field).set(copyValue(field, value));
  };
  return { conversations, preparedObjects, missionNumber, reset };
}
