/**
 * ConSys.ConEventTransferObject::BindActor (ConSys.dll 0x1000bc40).
 *
 * The installed body binds the event's from/to actor references by comparing
 * their authored names with one candidate actor. BarkBindName is accepted only
 * for first-person conversations; BindName is always checked as the fallback.
 * It then loads the authored Inventory class from package DeusEx into
 * giveObject, regardless of whether either actor name matched.
 */

import { scriptCaps, scriptStringText } from './script-string-operations.mjs';

const freeze = value => Object.freeze(value);

export const CONVERSATION_TRANSFER_OBJECT_BIND = freeze({
  package: 'ConSys',
  packageSha256: '3e9b10d48d5578ca7495e71a3c97540c693ac8dcc02393afe6633ba35b4c0ada',
  dllSha256: 'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa',
  classKey: 'ConSys.ConEventTransferObject',
  classExport: 381,
  scriptTextExport: 304,
  vtable: 0x10013ce8,
  vtableSlot: 0x58,
  nativeBody: 0x1000bc40,
  nativeBodySize: 0x160,
  nativeBodySha256: '745003622d0c7e1be01dc8e92ade0d049678647351e0434b9f38331e131a3a23',
  clearBody: 0x1000bda0,
  argumentBytes: 0xc,
  fields: freeze({
    objectName: 'ObjectName',
    giveObject: 'giveObject',
    fromActor: 'fromActor',
    fromName: 'fromName',
    toActor: 'toActor',
    toName: 'toName',
    candidateBindName: 'BindName',
    candidateBarkBindName: 'BarkBindName',
    conversationFirstPerson: 'bFirstPerson',
  }),
  nativeOffsets: freeze({
    objectName: 0x40,
    giveObject: 0x4c,
    fromActor: 0x54,
    fromName: 0x58,
    toActor: 0x64,
    toName: 0x68,
    candidateBindName: 0x2ac,
    candidateBarkBindName: 0x2b8,
    conversationFlags: 0x50,
  }),
  conversationFirstPersonMask: 4,
  packageName: 'DeusEx',
  staticLoadFlags: 2,
  filename: null,
  sandbox: null,
});

export class ConversationTransferObjectBindError extends Error {
  constructor(message, { kind = 'BOUNDARY', field = null, value = undefined } = {}) {
    super(message);
    this.name = 'ConversationTransferObjectBindError';
    this.code = `CONVERSATION_TRANSFER_OBJECT_BIND_${kind}`;
    this.field = field;
    this.value = value;
  }
}

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new ConversationTransferObjectBindError(
      `ConEventTransferObject::BindActor requires ${name} service`,
      { kind: 'SERVICE' },
    );
  }
  return value;
}

function requireReference(value, name) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new ConversationTransferObjectBindError(
      `ConEventTransferObject::BindActor requires canonical ${name}`,
      { kind: 'REFERENCE', value },
    );
  }
  return value;
}

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    throw new ConversationTransferObjectBindError(
      `ConEventTransferObject::BindActor ${label} service suspended; native calls are synchronous`,
      { kind: 'ASYNC' },
    );
  }
  return value;
}

function readField(object, field, read) {
  const value = sync(requireFunction(read, 'read')(object, field, { field }), `read ${field}`);
  if (value === undefined) {
    throw new ConversationTransferObjectBindError(
      `ConEventTransferObject::BindActor reached an unresolved ${field} field`,
      { kind: 'FIELD', field, value },
    );
  }
  return value;
}

function writeField(object, field, value, write) {
  return sync(requireFunction(write, 'write')(object, field, value, { field, value }), `write ${field}`);
}

function textField(value, field) {
  if (typeof value !== 'string') {
    throw new ConversationTransferObjectBindError(
      `ConEventTransferObject::BindActor requires a logical FString for ${field}`,
      { kind: 'VALUE', field, value },
    );
  }
  return scriptStringText(value);
}

/** ASCII/C-locale appStricmp equality used by the installed native body. */
export function transferObjectAsciiCaseEqual(left, right) {
  return scriptCaps(scriptStringText(left)) === scriptCaps(scriptStringText(right));
}

function compareText(compare, left, right, gate) {
  const result = sync(compare(left, right, { gate, left, right }), `equalText ${gate}`);
  if (typeof result !== 'boolean') {
    throw new ConversationTransferObjectBindError(
      `ConEventTransferObject::BindActor equalText ${gate} returned ${String(result)}`,
      { kind: 'RETURN', value: result },
    );
  }
  return result;
}

function classKeyMatches(classKey) {
  return typeof classKey === 'string' &&
    classKey.toLowerCase() === CONVERSATION_TRANSFER_OBJECT_BIND.classKey.toLowerCase();
}

export function isConversationTransferObjectBindClass(classKey) {
  return classKeyMatches(classKey);
}

function bindNamedActor({ event, candidate, conversation, nameField, actorField, read, write, compare }) {
  const fields = CONVERSATION_TRANSFER_OBJECT_BIND.fields;
  const barkEventName = textField(readField(event, nameField, read), nameField);
  const barkName = textField(readField(candidate, fields.candidateBarkBindName, read),
    fields.candidateBarkBindName);
  if (compareText(compare, barkName, barkEventName, `${actorField}-bark`)) {
    const firstPerson = readField(conversation, fields.conversationFirstPerson, read);
    if (typeof firstPerson !== 'boolean') {
      throw new ConversationTransferObjectBindError(
        'ConEventTransferObject::BindActor requires the typed bFirstPerson property',
        { kind: 'VALUE', field: fields.conversationFirstPerson, value: firstPerson },
      );
    }
    if (firstPerson) {
      writeField(event, actorField, candidate, write);
      return true;
    }
  }

  // Native rereads both fields after a rejected bark-name branch.
  const normalEventName = textField(readField(event, nameField, read), nameField);
  const bindName = textField(readField(candidate, fields.candidateBindName, read),
    fields.candidateBindName);
  if (!compareText(compare, bindName, normalEventName, `${actorField}-normal`)) return false;
  writeField(event, actorField, candidate, write);
  return true;
}

/** Execute the recovered 0x1000bc40 body against canonical runtime objects. */
export function bindConversationTransferObjectActor({
  classKey = CONVERSATION_TRANSFER_OBJECT_BIND.classKey,
  event,
  firstActor,
  secondActor,
  conversation,
  read,
  write,
  equalText = transferObjectAsciiCaseEqual,
  classRef,
  createPackage,
  staticLoadObject,
} = {}) {
  if (!classKeyMatches(classKey)) {
    throw new ConversationTransferObjectBindError(
      `Original conversation event BindActor is not the TransferObject class: ${String(classKey)}`,
      { kind: 'CLASS', value: classKey },
    );
  }
  if (event === null || event === undefined || secondActor === null || secondActor === undefined ||
      conversation === null || conversation === undefined) {
    throw new ConversationTransferObjectBindError(
      'ConEventTransferObject::BindActor requires event, candidate actor and conversation',
      { kind: 'REFERENCE' },
    );
  }
  // The first actor is part of the virtual signature but is never read.
  void firstActor;

  const compare = requireFunction(equalText, 'equalText');
  const packageFactory = requireFunction(createPackage, 'CreatePackage');
  const loader = requireFunction(staticLoadObject, 'StaticLoadObject');
  const classIdentity = requireReference(classRef, 'UClass::PrivateStaticClass');

  // 0x1000bc47: package creation occurs before actor-name comparisons.
  const outer = requireReference(sync(packageFactory({
    outer: null,
    name: CONVERSATION_TRANSFER_OBJECT_BIND.packageName,
  }), 'CreatePackage'), 'DeusEx package');

  const fields = CONVERSATION_TRANSFER_OBJECT_BIND.fields;
  let bound = bindNamedActor({ event, candidate: secondActor, conversation,
    nameField: fields.fromName, actorField: fields.fromActor, read, write, compare });
  if (bindNamedActor({ event, candidate: secondActor, conversation,
    nameField: fields.toName, actorField: fields.toActor, read, write, compare })) bound = true;

  // 0x1000bd64: giveObject is loaded after both actor-name branches, even on a miss.
  const objectName = textField(readField(event, fields.objectName, read), fields.objectName);
  const loaded = sync(loader({
    classRef: classIdentity,
    outer,
    name: objectName,
    filename: CONVERSATION_TRANSFER_OBJECT_BIND.filename,
    flags: CONVERSATION_TRANSFER_OBJECT_BIND.staticLoadFlags,
    sandbox: CONVERSATION_TRANSFER_OBJECT_BIND.sandbox,
  }), 'StaticLoadObject');
  writeField(event, fields.giveObject, loaded, write);
  return bound;
}
