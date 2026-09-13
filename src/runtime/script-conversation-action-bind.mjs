import {scriptCaps, scriptStringText} from './script-string-operations.mjs';

const freeze = value => Object.freeze(value);

/** Recovered shared DConEventAnimation/DConEventTrade BindActor contract. */
export const CONVERSATION_ACTION_BIND = freeze({
  nativeBody: 0x100071b0,
  conversationFlagsBit: 4,
  vtables: freeze({
    animation: 0x10013884,
    trade: 0x10013c8c,
  }),
  slots: freeze({
    bindActor: 0x58,
  }),
  fields: freeze({
    eventOwner: 'eventOwner',
    eventOwnerName: 'eventOwnerName',
    candidateBindName: 'BindName',
    candidateBarkBindName: 'BarkBindName',
    conversationFirstPerson: 'bFirstPerson',
  }),
});

/** A reached field or service outside the recovered action-bind boundary. */
export class ConversationActionBindError extends Error {
  constructor(message, {kind = 'BOUNDARY', field = null, value = undefined} = {}) {
    super(message);
    this.name = 'ConversationActionBindError';
    this.code = `CONVERSATION_ACTION_BIND_${kind}`;
    this.field = field;
    this.value = value;
  }
}

function requireFunction(value, name) {
  if (typeof value !== 'function')
    throw new ConversationActionBindError(`Conversation action BindActor requires ${name} service`,
      {kind: 'SERVICE'});
  return value;
}

function sync(value, label) {
  if (value && typeof value.then === 'function')
    throw new ConversationActionBindError(
      `Conversation action BindActor ${label} service suspended; native calls are synchronous`,
      {kind: 'ASYNC'});
  return value;
}

function readField(object, field, read) {
  const value = sync(requireFunction(read, 'read')(object, field, {field}), `read ${field}`);
  if (value === undefined)
    throw new ConversationActionBindError(
      `Conversation action BindActor reached an unresolved ${field} field`,
      {kind: 'FIELD', field, value});
  return value;
}

function writeField(object, field, value, write) {
  return sync(requireFunction(write, 'write')(object, field, value, {field, value}),
    `write ${field}`);
}

function compareText(compare, left, right, gate) {
  const value = sync(compare(left, right, {gate, left, right}), `equalText ${gate}`);
  if (typeof value !== 'boolean')
    throw new ConversationActionBindError(
      `Conversation action BindActor equalText ${gate} returned ${String(value)}`,
      {kind: 'RETURN', value});
  return value;
}

function stringField(value, field) {
  if (typeof value !== 'string')
    throw new ConversationActionBindError(
      `Conversation action BindActor requires a logical FString for ${field}`,
      {kind: 'VALUE', field, value});
  // A host's zero-Num FString is the canonical empty string.  This mirrors
  // native's 0x1001e1cc storage without inventing the FName spelling None.
  return scriptStringText(value);
}

/** ASCII appStricmp equality established for the original action names. */
export function asciiCaseEqual(left, right) {
  return scriptCaps(scriptStringText(left)) === scriptCaps(scriptStringText(right));
}

/**
 * Execute shared native body 0x100071b0 for Animation and Trade events.
 *
 * `read` returns canonical logical fields.  In particular, an original
 * zero-Num FString is returned as `''`; no caller may substitute `None` for
 * the native empty TCHAR. Original property Link identifies Conversation
 * +0x50 bit4 as the typed bFirstPerson property.
 */
export function bindConversationAction({
  event,
  firstActor,
  secondActor,
  conversation,
  read,
  write,
  equalText = asciiCaseEqual,
} = {}) {
  if (event === null || event === undefined ||
      secondActor === null || secondActor === undefined ||
      conversation === null || conversation === undefined) {
    throw new ConversationActionBindError(
      'Conversation action BindActor requires event, candidate actor and conversation',
      {kind: 'REFERENCE'});
  }
  const compare = requireFunction(equalText, 'equalText');
  // firstActor is deliberately accepted as part of the native signature but
  // never read: the recovered body uses only secondActor and conversation.
  void firstActor;

  // 0x100071b9-0x100071ee: bark-name comparison.  The event string is read
  // again below if this branch does not accept, matching the native loads.
  const barkEventName = stringField(readField(event,
    CONVERSATION_ACTION_BIND.fields.eventOwnerName, read),
  CONVERSATION_ACTION_BIND.fields.eventOwnerName);
  const barkName = stringField(readField(secondActor,
    CONVERSATION_ACTION_BIND.fields.candidateBarkBindName, read),
  CONVERSATION_ACTION_BIND.fields.candidateBarkBindName);
  // The native pushes event text first and candidate text second.  At the
  // cdecl comparator entry the candidate is therefore the first operand.
  const barkMatch = compareText(compare, barkName, barkEventName, 'bark');
  if (barkMatch) {
    const firstPerson = readField(conversation,
      CONVERSATION_ACTION_BIND.fields.conversationFirstPerson, read);
    if (typeof firstPerson !== 'boolean')
      throw new ConversationActionBindError(
        'Conversation action BindActor requires the typed bFirstPerson property',
        {kind: 'VALUE', field: CONVERSATION_ACTION_BIND.fields.conversationFirstPerson, value: firstPerson});
    if (firstPerson) {
      writeField(event, CONVERSATION_ACTION_BIND.fields.eventOwner, secondActor, write);
      return true;
    }
  }

  // 0x10007201-0x10007232: normal BindName comparison after a failed or
  // non-authorized bark branch.  Both FString fields are reread in native.
  const normalEventName = stringField(readField(event,
    CONVERSATION_ACTION_BIND.fields.eventOwnerName, read),
  CONVERSATION_ACTION_BIND.fields.eventOwnerName);
  const bindName = stringField(readField(secondActor,
    CONVERSATION_ACTION_BIND.fields.candidateBindName, read),
  CONVERSATION_ACTION_BIND.fields.candidateBindName);
  const normalMatch = compareText(compare, bindName, normalEventName, 'normal');
  if (!normalMatch) return false;
  writeField(event, CONVERSATION_ACTION_BIND.fields.eventOwner, secondActor, write);
  return true;
}
