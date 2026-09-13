/**
 * Native DConversationList binding and purge services.
 *
 * ConversationList is a native/noexport ConSys class, so these operations do
 * not have an UnrealScript body to translate.  The two synchronous services
 * below follow the recovered C++ bodies at 0x10010b70 and 0x10010cf0.  All
 * object fields and UObject lifetime operations are supplied by the caller;
 * this module never turns an unresolved reached pointer into a null object or
 * fabricates a ConListItem.
 *
 * Evidence: docs/script-native-conversation-list.md and the construction
 * records in script-conversation-construction.mjs.  The callbacks are kept
 * deliberately narrow so a live host can connect its canonical object table,
 * StaticAllocateObject/class constructor path, and deleting destructor.
 */

import { conSysNativeConstruction } from './script-conversation-construction.mjs';
import { scriptCaps, scriptStringText } from './script-string-operations.mjs';

const freeze = value => Object.freeze(value);

const CONSYS_BINDING = conSysNativeConstruction('ConListItem');
/** Flags passed/stored by the recovered bind and purge calls. */
export const CONVERSATION_LIST_NATIVE_FLAGS = freeze({
  objectFlagsAfterBindOr: 0x4,
  deletingDestructorFlags: 0x1,
});
const CONSYS_NATIVE_FLAGS = CONVERSATION_LIST_NATIVE_FLAGS;

/** Recovered function bodies (image base 0x10000000). */
export const CONVERSATION_LIST_NATIVE_ADDRESSES = freeze({
  BindConversations: 0x10010b70,
  PurgeBoundConversations: 0x10010cf0,
});

/** Exact reflected/native field names used by the recovered bodies. */
export const CONVERSATION_LIST_FIELDS = freeze({
  conversationHead: 'conversations',
  sourceConversation: 'ConObject',
  sourceNext: 'Next',
  actorHead: 'ConListItems',
  actorBindName: 'BindName',
  actorBarkBindName: 'BarkBindName',
  conversationName: 'conName',
  conversationOwnerName: 'conOwnerName',
  conversationOwnerRefCount: 'ownerRefCount',
  itemConversation: 'con',
  itemNext: 'next',
  objectFlags: 'ObjectFlags',
  outer: 'Outer',
});

export const CONVERSATION_LIST_NATIVE_CONTRACT = freeze({
  BindConversations: freeze({
    name: 'DConversationList::BindConversations',
    address: CONVERSATION_LIST_NATIVE_ADDRESSES.BindConversations,
    argumentCount: 1,
    argument: 'Actor actor',
  }),
  PurgeBoundConversations: freeze({
    name: 'DConversationList::PurgeBoundConversations',
    address: CONVERSATION_LIST_NATIVE_ADDRESSES.PurgeBoundConversations,
    argumentCount: 1,
    argument: 'Actor actor',
  }),
});

/** A reached pointer, field, callback, or lifetime operation is unresolved. */
export class ConversationListNativeBoundaryError extends Error {
  constructor(message, {
    nativeIndex = null,
    kind = 'BOUNDARY',
    value = undefined,
    field = null,
  } = {}) {
    super(message);
    this.name = 'ConversationListNativeBoundaryError';
    this.code = `CONVERSATION_LIST_${kind}`;
    this.nativeIndex = nativeIndex;
    this.value = value;
    this.field = field;
  }
}

function contractFor(index) {
  for (const contract of Object.values(CONVERSATION_LIST_NATIVE_CONTRACT)) {
    if (contract.address === index) return contract;
  }
  return null;
}

/** Return one recovered native method record by body address. */
export function conversationListNativeContract(index) {
  const contract = contractFor(index);
  if (!contract) throw new RangeError(`Unknown ConSys conversation-list native ${index}`);
  return contract;
}

function requireFunction(service, name, nativeIndex) {
  if (typeof service !== 'function') {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} requires ${name} service`,
      { nativeIndex, kind: 'SERVICE' },
    );
  }
  return service;
}

function syncResult(value, nativeIndex, label) {
  if (value && typeof value.then === 'function') {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} ${label} service suspended; native calls are synchronous`,
      { nativeIndex, kind: 'ASYNC' },
    );
  }
  return value;
}

function reachedReference(value, reference, label, nativeIndex) {
  if (value === null) return null;
  if (value === undefined) {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} reached an uninitialized ${label} reference`,
      { nativeIndex, kind: 'REFERENCE', value },
    );
  }
  requireFunction(reference, 'reference', nativeIndex);
  const canonical = syncResult(reference(value, { nativeIndex, label }), nativeIndex,
    `reference ${label}`);
  if (canonical === undefined || (canonical === null && value !== null)) {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} could not resolve reached ${label} reference`,
      { nativeIndex, kind: 'REFERENCE', value },
    );
  }
  return canonical;
}

function readField(object, field, read, nativeIndex) {
  requireFunction(read, 'read', nativeIndex);
  const value = syncResult(read(object, field, { nativeIndex, field }), nativeIndex,
    `read ${field}`);
  if (value === undefined) {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} reached an unresolved ${field} field`,
      { nativeIndex, kind: 'FIELD', value, field },
    );
  }
  return value;
}

function writeField(object, field, value, write, nativeIndex) {
  requireFunction(write, 'write', nativeIndex);
  return syncResult(write(object, field, value, { nativeIndex, field, value }), nativeIndex,
    `write ${field}`);
}

function readReference(object, field, { read, reference, nativeIndex }, label = field) {
  return reachedReference(readField(object, field, read, nativeIndex), reference, label, nativeIndex);
}

function requireInteger(value, label, nativeIndex) {
  if (!Number.isInteger(value)) {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} reached a non-integer ${label}: ${String(value)}`,
      { nativeIndex, kind: 'VALUE', value },
    );
  }
  return value;
}

/** Native FString reads use the static empty text when ArrayNum is zero. */
function fStringText(value, label, nativeIndex) {
  if (typeof value !== 'string') {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} reached a non-string ${label}: ${String(value)}`,
      { nativeIndex, kind: 'VALUE', value },
    );
  }
  return value;
}

/** Core appStricmp-compatible ASCII case-folded equality. */
export function asciiCaseEqual(left, right) {
  return scriptCaps(scriptStringText(left)) === scriptCaps(scriptStringText(right));
}

/** Core appStrstr-compatible case-sensitive substring search. */
export function caseSensitiveContains(text, needle) {
  return scriptStringText(text).includes(needle);
}

function compareText(left, right, equalText, nativeIndex, label) {
  const result = syncResult(requireFunction(equalText, 'equalText', nativeIndex)(left, right, {
    nativeIndex, left, right, label,
  }), nativeIndex, `equalText ${label}`);
  if (typeof result !== 'boolean') {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} equalText(${label}) returned ${String(result)}`,
      { nativeIndex, kind: 'RETURN', value: result },
    );
  }
  return result;
}

function containsText(text, needle, contains, nativeIndex) {
  const result = syncResult(requireFunction(contains, 'containsText', nativeIndex)(text, needle, {
    nativeIndex, text, needle,
  }), nativeIndex, 'containsText');
  if (typeof result !== 'boolean') {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} containsText returned ${String(result)}`,
      { nativeIndex, kind: 'RETURN', value: result },
    );
  }
  return result;
}

function sourceConversationMatch({ list, actor, sourceItem, conversation, read, equalText,
  containsText: contains, nativeIndex }) {
  // 10010b91–10010bb1: resolve conName through GNames and test `_Bark` with
  // the case-sensitive Core appStrstr import.
  const conNameValue = readField(conversation, CONVERSATION_LIST_FIELDS.conversationName,
    read, nativeIndex);
  if (typeof conNameValue !== 'string') {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} reached a non-string conName`,
      { nativeIndex, kind: 'VALUE', value: conNameValue, field: CONVERSATION_LIST_FIELDS.conversationName },
    );
  }
  const barkInName = containsText(conNameValue, '_Bark', contains, nativeIndex);

  // 10010bb3–10010be9: first test BarkBindName against conOwnerName.  The
  // body substitutes the static empty TCHAR for an empty ArrayNum.
  const firstOwnerName = fStringText(readField(conversation,
    CONVERSATION_LIST_FIELDS.conversationOwnerName, read, nativeIndex),
    CONVERSATION_LIST_FIELDS.conversationOwnerName, nativeIndex);
  const firstBarkBindName = fStringText(readField(actor,
    CONVERSATION_LIST_FIELDS.actorBarkBindName, read, nativeIndex),
    CONVERSATION_LIST_FIELDS.actorBarkBindName, nativeIndex);
  const barkOwnerMatch = compareText(firstBarkBindName, firstOwnerName, equalText, nativeIndex,
    'BarkBindName/conOwnerName');
  if (barkOwnerMatch && barkInName) {
    return { matched: true, gate: 'bark', conName: conNameValue, barkInName };
  }

  // 10010bf5–10010c28: normal BindName test.  conOwnerName and BindName are
  // read again, matching the original branch rather than caching a field
  // across the failed bark branch.
  const secondOwnerName = fStringText(readField(conversation,
    CONVERSATION_LIST_FIELDS.conversationOwnerName, read, nativeIndex),
    CONVERSATION_LIST_FIELDS.conversationOwnerName, nativeIndex);
  const bindName = fStringText(readField(actor, CONVERSATION_LIST_FIELDS.actorBindName, read, nativeIndex),
    CONVERSATION_LIST_FIELDS.actorBindName, nativeIndex);
  if (!compareText(bindName, secondOwnerName, equalText, nativeIndex,
    'BindName/conOwnerName')) {
    return { matched: false, gate: 'no-owner-match', conName: conNameValue, barkInName };
  }

  // 10010c30–10010c58: empty BarkBindName accepts the
  // normal conversation.  The compiler emits a second identical field read
  // and comparison on the nonempty path; retain it before the _Bark gate.
  const firstNormalBark = fStringText(readField(actor,
    CONVERSATION_LIST_FIELDS.actorBarkBindName, read, nativeIndex),
    CONVERSATION_LIST_FIELDS.actorBarkBindName, nativeIndex);
  if (compareText(firstNormalBark, '', equalText, nativeIndex, 'BarkBindName/empty')) {
    return { matched: true, gate: 'normal-empty-bark', conName: conNameValue, barkInName };
  }
  const secondNormalBark = fStringText(readField(actor,
    CONVERSATION_LIST_FIELDS.actorBarkBindName, read, nativeIndex),
    CONVERSATION_LIST_FIELDS.actorBarkBindName, nativeIndex);
  if (compareText(secondNormalBark, '', equalText, nativeIndex, 'BarkBindName/empty-repeat')) {
    return { matched: false, gate: 'normal-empty-bark-repeat', conName: conNameValue, barkInName };
  }
  if (barkInName) {
    return { matched: false, gate: 'normal-reject-bark', conName: conNameValue, barkInName };
  }
  return { matched: true, gate: 'normal', conName: conNameValue, barkInName };
}

function constructionDetails(outer, nativeIndex) {
  return {
    classRecord: CONSYS_BINDING,
    className: CONSYS_BINDING.name,
    classPackage: 'ConSys',
    size: CONSYS_BINDING.instanceSize,
    outer,
    name: 'None',
    flags: 0,
    nativeIndex,
    operatorNew: CONSYS_BINDING.operatorNew,
    constructor: CONSYS_BINDING.constructor,
    vtable: CONSYS_BINDING.vtable,
    objectFlagsOr: CONSYS_NATIVE_FLAGS.objectFlagsAfterBindOr,
  };
}

function allocateListItem({ outer, allocate, construct, nativeIndex, conversation, actor }) {
  const details = constructionDetails(outer, nativeIndex);
  const allocated = syncResult(requireFunction(allocate, 'allocate', nativeIndex)({
    ...details,
    conversation,
    actor,
  }), nativeIndex, 'allocate');
  if (allocated === null || allocated === undefined) {
    // Native code falls through to a null dereference at +0x1c.  Expose the
    // reached allocation failure while retaining the already incremented
    // ownerRefCount; callers must decide how their allocator reports it.
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} ConListItem allocation returned null`,
      { nativeIndex, kind: 'ALLOCATE', value: allocated },
    );
  }
  syncResult(requireFunction(construct, 'construct', nativeIndex)({
    ...details,
    object: allocated,
    conversation,
    actor,
  }), nativeIndex, 'construct');
  return allocated;
}

/**
 * DConversationList::PurgeBoundConversations (0x10010cf0).
 *
 * It decrements each linked Conversation before invoking that ConListItem's
 * deleting-destructor virtual slot with flags=1, and only then clears the
 * actor head.  The returned report is diagnostic; the native method is void.
 */
export function purgeBoundConversationsNative({
  actor,
  read,
  write,
  reference,
  deleteObject,
  nativeIndex = CONVERSATION_LIST_NATIVE_ADDRESSES.PurgeBoundConversations,
} = {}) {
  requireFunction(read, 'read', nativeIndex);
  requireFunction(write, 'write', nativeIndex);
  requireFunction(reference, 'reference', nativeIndex);
  const canonicalActor = reachedReference(actor, reference, 'actor', nativeIndex);
  if (canonicalActor === null) {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} received a null actor`,
      { nativeIndex, kind: 'REFERENCE', value: actor },
    );
  }

  let item = readReference(canonicalActor, CONVERSATION_LIST_FIELDS.actorHead,
    { read, reference, nativeIndex }, 'actor.ConListItems');
  const deleted = [];
  const seen = new Set();
  while (item !== null) {
    if (seen.has(item)) {
      throw new ConversationListNativeBoundaryError(
        `Conversation-list native ${nativeIndex} encountered a cyclic ConListItems chain`,
        { nativeIndex, kind: 'CYCLE', value: item },
      );
    }
    seen.add(item);

    // 10010cff–10010d0a: con.ownerRefCount--.
    const conversation = readReference(item, CONVERSATION_LIST_FIELDS.itemConversation,
      { read, reference, nativeIndex }, 'ConListItem.con');
    if (conversation === null) {
      throw new ConversationListNativeBoundaryError(
        `Conversation-list native ${nativeIndex} reached a null ConListItem.con`,
        { nativeIndex, kind: 'REFERENCE', value: conversation },
      );
    }
    const currentCount = requireInteger(readField(conversation,
      CONVERSATION_LIST_FIELDS.conversationOwnerRefCount, read, nativeIndex),
      'Conversation.ownerRefCount', nativeIndex);
    const nextCount = (currentCount - 1) | 0;
    writeField(conversation, CONVERSATION_LIST_FIELDS.conversationOwnerRefCount,
      nextCount, write, nativeIndex);

    // Save next before the deleting destructor, exactly as the native body.
    const next = readReference(item, CONVERSATION_LIST_FIELDS.itemNext,
      { read, reference, nativeIndex }, 'ConListItem.next');
    const destroy = requireFunction(deleteObject, 'deleteObject', nativeIndex);
    syncResult(destroy({
      object: item,
      flags: CONSYS_NATIVE_FLAGS.deletingDestructorFlags,
      nativeIndex,
      virtualSlot: 0x0c,
      kind: 'deleting-destructor',
      conversation,
      next,
    }), nativeIndex, 'deleteObject');
    deleted.push({ item, conversation, next, ownerRefCount: nextCount });
    item = next;
  }

  // 10010d1e–10010d34: clear the actor head, including the initially empty
  // path.  Do not clear it early: a destructor failure leaves native state at
  // the same point as the original call.
  writeField(canonicalActor, CONVERSATION_LIST_FIELDS.actorHead, null, write, nativeIndex);
  return { nativeIndex, actor: canonicalActor, deleted };
}

/**
 * DConversationList::BindConversations (0x10010b70).
 *
 * The source ConItem head is saved before purge.  Matching source items are
 * traversed in mission order and each allocated ConListItem is prepended to
 * the actor chain, so the published chain is the reverse of matching order.
 */
export function bindConversationsNative({
  list,
  actor,
  read,
  write,
  reference,
  equalText = asciiCaseEqual,
  containsText: contains = caseSensitiveContains,
  allocate,
  construct,
  deleteObject,
  nativeIndex = CONVERSATION_LIST_NATIVE_ADDRESSES.BindConversations,
  purgeNativeIndex = CONVERSATION_LIST_NATIVE_ADDRESSES.PurgeBoundConversations,
} = {}) {
  requireFunction(read, 'read', nativeIndex);
  requireFunction(write, 'write', nativeIndex);
  requireFunction(reference, 'reference', nativeIndex);
  const canonicalList = reachedReference(list, reference, 'conversation list', nativeIndex);
  if (canonicalList === null) {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} received a null conversation list`,
      { nativeIndex, kind: 'REFERENCE', value: list },
    );
  }

  // 10010b73 saves this head before PurgeBoundConversations mutates actor.
  const savedHead = readReference(canonicalList, CONVERSATION_LIST_FIELDS.conversationHead,
    { read, reference, nativeIndex }, 'ConversationList.conversations');
  // The native has loaded the actor argument by the time it calls Purge, but
  // the list-head read above remains first in its observable memory order.
  const canonicalActor = reachedReference(actor, reference, 'actor', nativeIndex);
  if (canonicalActor === null) {
    throw new ConversationListNativeBoundaryError(
      `Conversation-list native ${nativeIndex} received a null actor`,
      { nativeIndex, kind: 'REFERENCE', value: actor },
    );
  }
  const purge = purgeBoundConversationsNative({
    actor: canonicalActor,
    read,
    write,
    reference,
    deleteObject,
    nativeIndex: purgeNativeIndex,
  });

  const matched = [];
  const skipped = [];
  const seen = new Set();
  let sourceItem = savedHead;
  while (sourceItem !== null) {
    if (seen.has(sourceItem)) {
      throw new ConversationListNativeBoundaryError(
        `Conversation-list native ${nativeIndex} encountered a cyclic source ConItem chain`,
        { nativeIndex, kind: 'CYCLE', value: sourceItem },
      );
    }
    seen.add(sourceItem);
    const conversation = readReference(sourceItem, CONVERSATION_LIST_FIELDS.sourceConversation,
      { read, reference, nativeIndex }, 'ConItem.ConObject');
    if (conversation === null) {
      throw new ConversationListNativeBoundaryError(
        `Conversation-list native ${nativeIndex} reached a null ConItem.ConObject`,
        { nativeIndex, kind: 'REFERENCE', value: conversation },
      );
    }
    const match = sourceConversationMatch({
      list: canonicalList,
      actor: canonicalActor,
      sourceItem,
      conversation,
      read,
      equalText,
      containsText: contains,
      nativeIndex,
    });
    if (!match.matched) {
      skipped.push({ sourceItem, conversation, ...match });
    } else {
      // 10010c88: ownerRefCount is incremented before NAME_None/Outer/allocation.
      const currentCount = requireInteger(readField(conversation,
        CONVERSATION_LIST_FIELDS.conversationOwnerRefCount, read, nativeIndex),
        'Conversation.ownerRefCount', nativeIndex);
      const nextCount = (currentCount + 1) | 0;
      writeField(conversation, CONVERSATION_LIST_FIELDS.conversationOwnerRefCount,
        nextCount, write, nativeIndex);

      // 10010c92–10010ca0: FName(EName_None), then UObject::GetOuter(this).
      const outer = readReference(canonicalList, CONVERSATION_LIST_FIELDS.outer,
        { read, reference, nativeIndex }, 'ConversationList.Outer');
      const item = allocateListItem({
        outer,
        allocate,
        construct,
        nativeIndex,
        conversation,
        actor: canonicalActor,
      });

      // 10010cc0–10010cc9: read flags, store con, OR RF_Public, store flags.
      const oldFlags = requireInteger(readField(item, CONVERSATION_LIST_FIELDS.objectFlags,
        read, nativeIndex), 'ConListItem.ObjectFlags', nativeIndex);
      writeField(item, CONVERSATION_LIST_FIELDS.itemConversation, conversation, write, nativeIndex);
      const flags = (oldFlags | CONSYS_NATIVE_FLAGS.objectFlagsAfterBindOr) >>> 0;
      writeField(item, CONVERSATION_LIST_FIELDS.objectFlags, flags, write, nativeIndex);

      // 10010ccc–10010cd5: prepend to actor.ConListItems.
      const oldHead = readReference(canonicalActor, CONVERSATION_LIST_FIELDS.actorHead,
        { read, reference, nativeIndex }, 'actor.ConListItems');
      writeField(item, CONVERSATION_LIST_FIELDS.itemNext, oldHead, write, nativeIndex);
      writeField(canonicalActor, CONVERSATION_LIST_FIELDS.actorHead, item, write, nativeIndex);
      matched.push({ sourceItem, conversation, item, ...match, ownerRefCount: nextCount,
        objectFlags: flags, next: oldHead });
    }
    sourceItem = readReference(sourceItem, CONVERSATION_LIST_FIELDS.sourceNext,
      { read, reference, nativeIndex }, 'ConItem.Next');
  }

  return {
    nativeIndex,
    list: canonicalList,
    actor: canonicalActor,
    savedHead,
    purge,
    matched,
    skipped,
    // Matching is source order; published actor chain is prepended order.
    publishedOrder: matched.map(entry => entry.item).reverse(),
  };
}

/** Bind direct methods while retaining one explicit service boundary. */
export function createConversationListNativeService(services = {}) {
  return Object.freeze({
    bindConversations: (options = {}) => bindConversationsNative({ ...services, ...options }),
    purgeBoundConversations: (options = {}) => purgeBoundConversationsNative({ ...services, ...options }),
  });
}
