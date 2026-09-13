/**
 * ConSys.ConEventCheckObject::BindActor (ConSys.dll 0x10007bf0).
 *
 * The installed native body is a small loader bridge, rather than a
 * conversation matching predicate.  It takes the event's objectName, tests
 * the first three characters against the case-insensitive literal `NK_`, and
 * otherwise loads a class from the DeusEx package into checkObject.  The
 * native return is false in both branches.  The two UObject loader calls are
 * kept as synchronous host services because their native object/file graph
 * is a separate boundary; no inventory lookup is invented here.
 */

import { scriptLeft, scriptStringComplementEqual, scriptStringText } from './script-string-operations.mjs';

const freeze = value => Object.freeze(value);

export const CONVERSATION_CHECK_OBJECT_BIND = freeze({
  package: 'ConSys',
  packageSha256: '3e9b10d48d5578ca7495e71a3c97540c693ac8dcc02393afe6633ba35b4c0ada',
  dllSha256: 'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa',
  classKey: 'ConSys.ConEventCheckObject',
  classExport: 365,
  scriptTextExport: 319,
  vtable: 0x1001393c,
  vtableSlot: 0x58,
  nativeBody: 0x10007bf0,
  nativeBodySize: 0x110,
  nativeBodySha256: '4f92787311435bab6cf8126bbf6b1b15bae313c40e579064ea6bbf5d45a95a1a',
  argumentBytes: 0xc,
  result: false,
  fields: freeze({
    objectName: 'objectName',
    checkObject: 'checkObject',
    failLabel: 'failLabel',
  }),
  nativeOffsets: freeze({ objectName: 0x40, checkObject: 0x4c }),
  prefix: 'NK_',
  packageName: 'DeusEx',
  staticLoadFlags: 2,
  filename: null,
  sandbox: null,
});

/** A reached field/service outside the recovered CheckObject body. */
export class ConversationCheckObjectBindError extends Error {
  constructor(message, { kind = 'BOUNDARY', field = null, value = undefined } = {}) {
    super(message);
    this.name = 'ConversationCheckObjectBindError';
    this.code = `CONVERSATION_CHECK_OBJECT_BIND_${kind}`;
    this.field = field;
    this.value = value;
  }
}

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new ConversationCheckObjectBindError(
      `ConEventCheckObject::BindActor requires ${name} service`,
      { kind: 'SERVICE' },
    );
  }
  return value;
}

function requireReference(value, name) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new ConversationCheckObjectBindError(
      `ConEventCheckObject::BindActor requires canonical ${name}`,
      { kind: 'REFERENCE', value },
    );
  }
  return value;
}

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    throw new ConversationCheckObjectBindError(
      `ConEventCheckObject::BindActor ${label} service suspended; native calls are synchronous`,
      { kind: 'ASYNC' },
    );
  }
  return value;
}

function readField(event, field, read) {
  const value = sync(requireFunction(read, 'read')(event, field, { field }), `read ${field}`);
  if (value === undefined) {
    throw new ConversationCheckObjectBindError(
      `ConEventCheckObject::BindActor reached an unresolved ${field} field`,
      { kind: 'FIELD', field, value },
    );
  }
  return value;
}

function writeField(event, field, value, write) {
  return sync(requireFunction(write, 'write')(event, field, value, { field, value }), `write ${field}`);
}

function classKeyMatches(classKey) {
  return typeof classKey === 'string' &&
    classKey.toLowerCase() === CONVERSATION_CHECK_OBJECT_BIND.classKey.toLowerCase();
}

/** Whether a complete package/class key selects this exact native override. */
export function isConversationCheckObjectBindClass(classKey) {
  return classKeyMatches(classKey);
}

/**
 * Execute the recovered 0x10007bf0 body against canonical event storage.
 *
 * `createPackage` receives `{ outer: null, name: "DeusEx" }` and must return
 * the native package identity. `staticLoadObject` receives the exact
 * `UClass::PrivateStaticClass`/outer/name/null/2/null argument graph. Both
 * services must complete synchronously. A null loader result is preserved and
 * written to checkObject exactly as native does.
 */
export function bindConversationCheckObjectActor({
  classKey = CONVERSATION_CHECK_OBJECT_BIND.classKey,
  event,
  read,
  write,
  classRef,
  createPackage,
  staticLoadObject,
} = {}) {
  if (!classKeyMatches(classKey)) {
    throw new ConversationCheckObjectBindError(
      `Original conversation event BindActor is not the CheckObject class: ${String(classKey)}`,
      { kind: 'CLASS', value: classKey },
    );
  }
  if (event === null || event === undefined) {
    throw new ConversationCheckObjectBindError(
      'ConEventCheckObject::BindActor requires its event reference',
      { kind: 'REFERENCE', value: event },
    );
  }

  const objectNameValue = readField(event, CONVERSATION_CHECK_OBJECT_BIND.fields.objectName, read);
  const objectName = scriptStringText(objectNameValue);
  // Native FString::Left(event.objectName, 3) allocates a temporary FString;
  // appStricmp then compares it with NK_.  Keeping both operations explicit
  // preserves the installed ASCII/case-insensitive comparison semantics.
  const prefix = scriptLeft(objectNameValue, 3);
  const isNanoKey = scriptStringComplementEqual(prefix, CONVERSATION_CHECK_OBJECT_BIND.prefix);

  if (isNanoKey) {
    // The native NK_ branch explicitly clears checkObject before returning.
    writeField(event, CONVERSATION_CHECK_OBJECT_BIND.fields.checkObject, null, write);
    return false;
  }

  const packageFactory = requireFunction(createPackage, 'CreatePackage');
  const loader = requireFunction(staticLoadObject, 'StaticLoadObject');
  const classIdentity = requireReference(classRef, 'UClass::PrivateStaticClass');
  const outer = requireReference(sync(packageFactory({
    outer: null,
    name: CONVERSATION_CHECK_OBJECT_BIND.packageName,
  }), 'CreatePackage'), 'DeusEx package');
  const loaded = sync(loader({
    classRef: classIdentity,
    outer,
    name: objectName,
    filename: CONVERSATION_CHECK_OBJECT_BIND.filename,
    flags: CONVERSATION_CHECK_OBJECT_BIND.staticLoadFlags,
    sandbox: CONVERSATION_CHECK_OBJECT_BIND.sandbox,
  }), 'StaticLoadObject');
  writeField(event, CONVERSATION_CHECK_OBJECT_BIND.fields.checkObject, loaded, write);
  return false;
}
