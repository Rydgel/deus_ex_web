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
 * The recovered selection then reaches `conPlay = Spawn(class'ConPlay')`. The
 * ConPlay first-person presentation (window construction, speech playback,
 * termination and player-state restoration) is the explicit remaining boundary
 * recorded in the evidence document. */

import { loadMissionConversations } from './script-conversation-binding.mjs';

const lower = value => String(value ?? '').toLowerCase();

function readMaybe(runtime, object, key) {
  try { return runtime.namedReference(object, key).get(); } catch { return undefined; }
}

/** Prepare one conversation's authored object graph: its ConFlagRef chain, its
 * ConEvent chain (Conversation.eventList -> ConEvent.nextEvent, including the
 * ConEventRandomLabel head) and each event's ConSpeech. Idempotent. */
async function prepareConversationGraph(runtime, conversation) {
  let prepared = 0;
  // prepareObject attaches the object, after which its own linked next-pointer
  // is readable; walk each chain to completion with a cycle guard.
  const seenFlags = new Set();
  for (let flagRef = readMaybe(runtime, conversation, 'flagRefList'); flagRef;) {
    if (seenFlags.has(flagRef)) throw new Error('Conversation flag-ref chain is cyclic');
    seenFlags.add(flagRef);
    await runtime.prepareObject(flagRef); prepared++;
    flagRef = runtime.namedReference(flagRef, 'nextFlagRef').get();
  }
  const seenEvents = new Set();
  for (let event = readMaybe(runtime, conversation, 'eventList'); event;) {
    if (seenEvents.has(event)) throw new Error('Conversation event chain is cyclic');
    seenEvents.add(event);
    await runtime.prepareObject(event); prepared++;
    // conSpeech exists only on ConEventSpeech; other ConEvent subclasses lack it.
    const speech = readMaybe(runtime, event, 'conSpeech');
    if (speech) { await runtime.prepareObject(speech); prepared++; }
    event = runtime.namedReference(event, 'nextEvent').get();
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

  let descriptors;
  try { descriptors = loadMissionConversations(conText, missionNumber); }
  catch { return { conversations: [], preparedObjects: 0, missionNumber }; } // no mission list -> nothing to prepare
  const conversations = [];
  let preparedObjects = 0;
  for (const descriptor of descriptors) {
    if (!descriptor.conOwnerName || !bindNames.has(lower(descriptor.conOwnerName))) continue;
    // Bark conversations are started by the AI system and skipped by
    // GetActiveConversation (DeusExPlayer.uc:7941). DataLink conversations play
    // through the separate DataLink path. Neither is reached by the frob
    // ConPlay selection, so preparing their graphs here is unnecessary.
    if (lower(descriptor.conName).startsWith(lower(`${descriptor.conOwnerName}_Bark`))) continue;
    const conversation = await runtime.objects.resolve(conText, descriptor.ref);
    await runtime.prepareObject(conversation);
    if (readMaybe(runtime, conversation, 'bDataLinkCon')) continue;
    preparedObjects += 1 + await prepareConversationGraph(runtime, conversation);
    conversations.push({ conversation, conName: descriptor.conName, conOwnerName: descriptor.conOwnerName });
  }

  // Conversation.IsSpeakingActor is reached by DeusExPlayer.StartConversation
  // (the con.IsSpeakingActor(Self) participant test) before the ConPlay spawn.
  const conSys = await assets.get('ConSys');
  const isSpeakingActor = conSys.exportsByPath.get('conversation.isspeakingactor');
  if (isSpeakingActor) await runtime.prepareFunction(conSys, isSpeakingActor);

  return { conversations, preparedObjects, missionNumber };
}
