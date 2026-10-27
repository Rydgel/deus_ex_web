/**
 * Source-backed catalog of the authored Training DataLink routes.
 *
 * This module only reads the original map and package data.  It does not
 * install a trigger callback, create a DataLinkPlay, or choose a presentation
 * substitute.  The returned route records are intended to be the input to a
 * later live lifecycle adapter.
 *
 * Evidence: the installed 00_Training.dx map, DeusExConText.u's
 * ConList_Mission00 linked ConItems, DeusEx/DataLinkTrigger defaults, the
 * ConEventSpeech -> ConSpeech -> ConEventEnd records, and
 * DeusExConAudioMission00.u Sound exports.  The linked source contracts are
 * recorded in docs/script-training-datalinks.md.
 */
import { decodeMap } from '../unreal/map.mjs';
import { readObject, objectAt } from '../unreal/objects.mjs';
import { ClassDefaults } from '../unreal/classes.mjs';
import { decodeSoundResource } from './script-sound-resource.mjs';
import { conversationSoundLength } from './script-conversation-sound-length.mjs';
import {
  INFOLINK_CONTENT_REFERENCE,
  loadInfoLinkPreviewContent,
} from './script-infolink-content.mjs';

const freeze = Object.freeze;
const lower = value => String(value ?? '').toLowerCase();
const integer = (value, label) => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Training DataLink requires ${label}`);
  return value;
};

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function field(values, name, fallback = undefined) {
  const wanted = lower(name);
  const key = Object.keys(values ?? {}).find(candidate => lower(candidate) === wanted);
  return key === undefined ? fallback : values[key];
}

function named(value) {
  return value === undefined || value === null || lower(value) === 'none' ? '' : String(value);
}

function bool(value, fallback = false) {
  return Boolean(value === undefined ? fallback : value);
}

function vector(value, label) {
  requireValue(Array.isArray(value) && value.length === 3,
    `Training DataLink ${label} must be a Vector`);
  return freeze(value.map(Number));
}

function readObjectValues(asset, index, label) {
  const exportIndex = integer(index, label);
  const entry = objectAt(asset.pkg, exportIndex);
  requireValue(entry?.serialSize > 0, `Training DataLink ${label} export ${exportIndex} is not serialized`);
  return { exportIndex, entry, values: readObject(asset.pkg, asset.bytes, exportIndex).values };
}

function soundLength(bytes) {
  return conversationSoundLength({
    soundData: { array: { data: bytes, num: bytes.byteLength } },
  }, {
    read: (object, key) => object[key],
    loadSpecial: () => {},
    log: () => { throw new Error('Training DataLink MP3 failed original timing recognition'); },
  });
}

async function sha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) throw new Error('Training DataLink catalog requires WebCrypto SHA-256');
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function copyBytes(value) {
  if (!(value instanceof Uint8Array) && !(value instanceof Uint8ClampedArray)) {
    throw new TypeError('Training DataLink catalog requires a byte view');
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}

/** Walk the original ConList_Mission00 linked list and retain DataLink items. */
function readMissionDataLinks(context, listIndex) {
  const list = readObjectValues(context, listIndex, 'ConList_Mission00');
  requireValue(list.entry.className === 'ConversationList',
    `Expected ConversationList at ${list.entry.path}`);
  requireValue(named(list.values.missionDescription) === 'Mission 0',
    'ConList_Mission00 mission description changed');

  const records = [];
  const seenItems = new Set();
  let itemIndex = list.values.conversations ?? 0;
  while (itemIndex) {
    integer(itemIndex, 'ConItem reference');
    if (seenItems.has(itemIndex)) throw new Error('ConList_Mission00 contains a cyclic ConItem chain');
    seenItems.add(itemIndex);
    const item = readObjectValues(context, itemIndex, 'ConItem');
    requireValue(item.entry.className === 'ConItem',
      `ConList_Mission00 reference ${itemIndex} is ${item.entry.className}`);
    const conversationIndex = integer(item.values.ConObject, `ConItem ${itemIndex} conversation`);
    const conversation = readObjectValues(context, conversationIndex, `Conversation ${conversationIndex}`);
    requireValue(conversation.entry.className === 'Conversation',
      `ConItem ${itemIndex} references ${conversation.entry.className}, not Conversation`);
    if (bool(conversation.values.bDataLinkCon)) {
      records.push({ item, conversation });
    }
    itemIndex = item.values.Next ?? 0;
  }
  requireValue(records.length > 0, 'ConList_Mission00 has no authored DataLinks');
  return freeze(records.map(record => freeze(record)));
}

function readSpeechEndChain(context, conversation) {
  const values = conversation.values;
  const event = readObjectValues(context, values.eventList, `${values.conName} first event`);
  requireValue(event.entry.className === 'ConEventSpeech',
    `${values.conName} does not begin with ConEventSpeech`);
  const speechIndex = integer(event.values.ConSpeech, `${values.conName} ConSpeech`);
  const speech = readObjectValues(context, speechIndex, `${values.conName} speech`);
  requireValue(speech.entry.className === 'ConSpeech',
    `${values.conName} references ${speech.entry.className}, not ConSpeech`);
  const endIndex = integer(event.values.nextEvent, `${values.conName} next event`);
  const end = readObjectValues(context, endIndex, `${values.conName} end event`);
  requireValue(end.entry.className === 'ConEventEnd',
    `${values.conName} Speech does not point directly to ConEventEnd`);
  requireValue(event.values.Conversation === conversation.exportIndex &&
    end.values.Conversation === conversation.exportIndex,
  `${values.conName} event ownership changed`);
  requireValue(Number(end.values.eventType) === 18,
    `${values.conName} end event type changed from ConEventEnd`);
  requireValue(typeof speech.values.Speech === 'string' && speech.values.Speech.length > 0,
    `${values.conName} speech text is empty`);
  requireValue(Number.isInteger(speech.values.soundID) && speech.values.soundID >= 0,
    `${values.conName} speech soundID is invalid`);
  return freeze({
    speechEvent: freeze({
      exportIndex: event.exportIndex,
      objectName: event.entry.path,
      className: event.entry.className,
      speakerName: named(event.values.speakerName),
      speakingToName: named(event.values.speakingToName),
      speechExport: speech.exportIndex,
      nextEventExport: end.exportIndex,
      conversationExport: conversation.exportIndex,
    }),
    speech: freeze({
      exportIndex: speech.exportIndex,
      objectName: speech.entry.path,
      className: speech.entry.className,
      text: speech.values.Speech,
      soundId: speech.values.soundID,
    }),
    endEvent: freeze({
      exportIndex: end.exportIndex,
      objectName: end.entry.path,
      className: end.entry.className,
      eventType: end.values.eventType,
      conversationExport: end.values.Conversation,
    }),
  });
}

async function readSpeechAudio(audioAsset, speech, conversationName) {
  const soundName = `ConAudioMission00_${speech.soundId}`;
  const soundIndex = audioAsset.exportsByPath.get(lower(soundName));
  integer(soundIndex, `${conversationName} ${soundName} export`);
  const entry = audioAsset.pkg.exports[soundIndex - 1];
  requireValue(entry?.className === 'Sound',
    `${conversationName} audio export ${soundIndex} is ${entry?.className ?? 'missing'}`);
  const decoded = decodeSoundResource({ pkg: audioAsset.pkg, bytes: audioAsset.bytes, entry });
  const format = lower(decoded.lazy.formatName);
  requireValue(format === 'mp3', `${conversationName} audio format is ${decoded.lazy.formatName}`);
  const start = entry.serialOffset + decoded.lazy.inlineOffset;
  const bytes = audioAsset.bytes.slice(start, start + decoded.lazy.byteCount);
  requireValue(bytes.byteLength === decoded.lazy.byteCount,
    `${conversationName} audio payload is truncated`);
  const [hash, seconds] = await Promise.all([sha256(bytes), Promise.resolve(soundLength(bytes))]);
  requireValue(Number.isFinite(seconds) && seconds > 0,
    `${conversationName} audio duration is invalid`);
  return freeze({
    packageName: audioAsset.name,
    objectName: entry.path,
    exportIndex: soundIndex,
    soundId: speech.soundId,
    format,
    mimeType: 'audio/mpeg',
    byteCount: bytes.byteLength,
    sha256: hash,
    seconds,
    // This is an owned copy of the original encoded bytes.  The native sound
    // archive/ClientHearSound transport remains outside this read catalog.
    bytes,
  });
}

function readTrigger(mapAsset, map, actor, defaults, conversation) {
  const effective = defaults;
  const authored = actor.values ?? {};
  const dataLinkTag = named(field(authored, 'datalinkTag'));
  requireValue(dataLinkTag.length > 0, `${actor.name} has no datalinkTag`);
  const initialCollision = freeze({
    bCollideActors: bool(field(effective, 'bCollideActors')),
    bCollideWorld: bool(field(effective, 'bCollideWorld')),
    bCollideWhenPlacing: bool(field(effective, 'bCollideWhenPlacing')),
    bBlockActors: bool(field(effective, 'bBlockActors')),
    bBlockPlayers: bool(field(effective, 'bBlockPlayers')),
    bProjTarget: bool(field(effective, 'bProjTarget')),
  });
  const flags = freeze({
    TriggerType: Number(field(effective, 'TriggerType', 0)),
    bInitiallyActive: bool(field(effective, 'bInitiallyActive')),
    bTriggerOnceOnly: bool(field(effective, 'bTriggerOnceOnly')),
    bHidden: bool(field(effective, 'bHidden')),
    bStatic: bool(field(effective, 'bStatic')),
    bNoDelete: bool(field(effective, 'bNoDelete')),
    bDeleteMe: bool(field(effective, 'bDeleteMe')),
    bGameRelevant: bool(field(effective, 'bGameRelevant')),
    bMovable: bool(field(effective, 'bMovable')),
    bCheckFalse: bool(field(authored, 'bCheckFalse')),
    bCheckFlagTimer: false,
    checkFlagTimer: Number(field(effective, 'checkFlagTimer', 0)),
  });
  requireValue(Number.isInteger(flags.TriggerType) && flags.TriggerType === 0,
    `${actor.name} is not the authored TT_PlayerProximity route`);
  const collision = freeze({
    radius: Number(field(effective, 'CollisionRadius', 0)),
    height: Number(field(effective, 'CollisionHeight', 0)),
    bits: (initialCollision.bCollideActors ? 1 : 0) |
      (initialCollision.bBlockActors ? 4 : 0) |
      (initialCollision.bBlockPlayers ? 8 : 0) |
      (initialCollision.bProjTarget ? 16 : 0),
  });
  requireValue(Number.isFinite(collision.radius) && collision.radius >= 0 &&
    Number.isFinite(collision.height) && collision.height >= 0,
  `${actor.name} has invalid collision extent`);
  const checkFlag = named(field(authored, 'checkFlag'));
  return freeze({
    name: actor.name,
    exportIndex: actor.index,
    actorSlot: map.level.actors.indexOf(actor.index),
    dataLinkTag,
    actorTag: named(field(authored, 'Tag')),
    location: vector(field(effective, 'Location'), `${actor.name}.Location`),
    collision,
    initialCollision,
    flags,
    checkFlag,
    playedFlag: conversation.values.bDisplayOnce ? `${conversation.values.conName}_Played` : null,
    serialized: freeze({
      radius: field(authored, 'CollisionRadius', null),
      height: field(authored, 'CollisionHeight', null),
      bCollideActors: field(authored, 'bCollideActors', null),
      bCollideWorld: field(authored, 'bCollideWorld', null),
      bCollideWhenPlacing: field(authored, 'bCollideWhenPlacing', null),
      bBlockActors: field(authored, 'bBlockActors', null),
      bBlockPlayers: field(authored, 'bBlockPlayers', null),
      bProjTarget: field(authored, 'bProjTarget', null),
      bGameRelevant: field(authored, 'bGameRelevant', null),
      checkFlag: field(authored, 'checkFlag', null) ?? field(authored, 'CheckFlag', null),
    }),
  });
}

/**
 * Load every DataLinkTrigger authored in 00_Training and its canonical
 * Mission00 Conversation/Speech/End/audio records.
 *
 * `mapAsset` and `map` are optional cache inputs for a live caller.  The
 * default path reads and decodes the original 00_Training asset itself.
 */
export async function loadTrainingDataLinkCatalog(assets, { mapAsset = null, map = null } = {}) {
  if (!assets?.get || !assets?.resolve) throw new TypeError('Training DataLink catalog requires AssetStore');
  // It depends on the package bytes only, so a store's catalog is made once: each level's DataLink runtime asks for it, and reading
  // 00_Training again would hold that map's package after LoadMap's collection unloaded it (docs/class-graph-design.md, step 4b).
  if (!mapAsset && !map) {
    let pending = catalogs.get(assets);
    if (!pending) {
      catalogs.set(assets, pending = readTrainingDataLinkCatalog(assets, {}));
      pending.catch(() => catalogs.delete(assets));
    }
    return pending;
  }
  return readTrainingDataLinkCatalog(assets, { mapAsset, map });
}
const catalogs = new WeakMap();

async function readTrainingDataLinkCatalog(assets, { mapAsset, map }) {
  mapAsset ??= await assets.get('00_Training');
  map ??= decodeMap(mapAsset.bytes);
  const [context, audioAsset, content] = await Promise.all([
    assets.get('DeusExConText'),
    assets.get('DeusExConAudioMission00'),
    loadInfoLinkPreviewContent(assets),
  ]);
  const defaults = new ClassDefaults(assets);
  const listIndex = context.exportsByPath.get('conlist_mission00');
  integer(listIndex, 'ConList_Mission00');
  const dataLinks = readMissionDataLinks(context, listIndex);
  const byName = new Map(dataLinks.map(record => [lower(record.conversation.values.conName), record.conversation]));
  requireValue(byName.size === dataLinks.length, 'Mission00 DataLink names are duplicated');

  const portraitBytes = copyBytes(content.portrait.data);
  const portraitHash = await sha256(portraitBytes);
  requireValue(portraitHash === INFOLINK_CONTENT_REFERENCE.portraitRgbaSha256,
    'Jaime Reyes portrait pixels changed from the linked original texture');
  const portrait = freeze({
    packageName: INFOLINK_CONTENT_REFERENCE.portraitPackage,
    objectName: content.portrait.key,
    exportIndex: INFOLINK_CONTENT_REFERENCE.portraitExport,
    width: content.portrait.width,
    height: content.portrait.height,
    format: content.portrait.format,
    masked: content.portrait.masked,
    rgbaSha256: portraitHash,
    data: portraitBytes,
  });
  const speaker = freeze({
    bindName: content.speakerBindName,
    displayName: content.speakerDisplayName,
    portrait,
  });

  const routes = [];
  const seenTags = new Set();
  for (const actor of map.actors.filter(item => item.className === 'DataLinkTrigger')) {
    const tag = named(field(actor.values, 'datalinkTag'));
    const conversation = byName.get(lower(tag));
    requireValue(conversation, `${actor.name} DataLink ${tag} has no Mission00 conversation`);
    requireValue(lower(conversation.values.audioPackageName) === 'mission00',
      `${conversation.values.conName} is not a Mission00 DataLink`);
    requireValue(bool(conversation.values.bDataLinkCon), `${conversation.values.conName} is not bDataLinkCon`);
    const chain = readSpeechEndChain(context, conversation);
    requireValue(chain.speechEvent.speakerName === speaker.bindName,
      `${conversation.values.conName} speaker ${chain.speechEvent.speakerName} is not JaimeReyes`);
    const route = freeze({
      dataLinkTag: tag,
      trigger: await readTrigger(mapAsset, map, actor, await defaults.forActor(mapAsset, actor), conversation),
      conversation: freeze({
        itemExport: dataLinks.find(record => record.conversation.exportIndex === conversation.exportIndex)?.item.exportIndex ?? null,
        exportIndex: conversation.exportIndex,
        objectName: conversation.entry.path,
        name: conversation.values.conName,
        ownerName: named(conversation.values.conOwnerName),
        bDataLinkCon: bool(conversation.values.bDataLinkCon),
        bDisplayOnce: bool(conversation.values.bDisplayOnce),
        flagRefList: conversation.values.flagRefList ?? 0,
        audioPackageName: named(conversation.values.audioPackageName),
      }),
      chain,
      speaker,
      audio: await readSpeechAudio(audioAsset, chain.speech, conversation.values.conName),
    });
    const key = lower(route.trigger.dataLinkTag);
    requireValue(!seenTags.has(key), `00_Training DataLink tag ${route.trigger.dataLinkTag} is duplicated`);
    seenTags.add(key);
    routes.push(route);
  }
  requireValue(routes.length > 0, '00_Training has no DataLinkTrigger actors');
  requireValue(routes.length === seenTags.size, '00_Training DataLink trigger tags are duplicated');
  const routeList = freeze(routes);
  const tagLookup = new Map(routeList.map(route => [lower(route.dataLinkTag), route]));
  const triggerLookup = new Map(routeList.map(route => [lower(route.trigger.name), route]));
  return freeze({
    source: freeze({
      mapPackage: mapAsset.name,
      mapPath: mapAsset.path,
      conversationPackage: context.name,
      conversationList: freeze({ exportIndex: listIndex, objectName: context.pkg.exports[listIndex - 1].path }),
      audioPackage: audioAsset.name,
    }),
    counts: freeze({ missionConItems: dataLinks.length, trainingTriggers: routeList.length }),
    speaker,
    routes: routeList,
    routeForTag: tag => tagLookup.get(lower(tag)) ?? null,
    routeForTrigger: name => triggerLookup.get(lower(name)) ?? null,
  });
}
