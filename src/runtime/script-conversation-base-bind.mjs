/**
 * The inherited DConEvent::BindActor body used by a verified subset of the
 * installed ConSys event classes.
 *
 * The body at 0x10002350 is only `xor al, al; ret 0xc`: it does not inspect
 * the receiver or any of its three arguments and returns false.  The selected
 * MoveCamera body at 0x100098f0 has the same five bytes at a distinct vtable
 * target.  Dispatch is keyed by the complete package/class key because other
 * ConEvent subclasses select different virtual bodies at the same vtable slot.
 *
 * The class/vtable map is pinned to the installed ConSys.u and ConSys.dll in
 * docs/script-conversation-base-bind.md and scripts/validate-conversation-base-bind.mjs.
 */

const freeze = value => Object.freeze(value);

const nativeBody = 0x10002350;
const moveCameraNativeBody = 0x100098f0;
const vtableSlot = 0x58;
const moveCameraClassKey = 'consys.coneventmovecamera';
const baseClass = freeze({
  key: 'ConSys.ConEvent',
  classExport: 2,
  vtable: 0x10013368,
  slot: vtableSlot,
  slotTarget: nativeBody,
  nativeExport: '??_7DConEvent@@6B@',
});

const classes = [
  ['ConSys.ConEventSpeech', 4, 306, 0x10013c30, 0x1000b070],
  ['ConSys.ConEventMoveCamera', 24, 312, 0x10013b08, 0x100098f0],
  ['ConSys.ConEventJump', 35, 313, 0x10013664, nativeBody],
  ['ConSys.ConEventAddCredits', 357, 325, 0x10013714, nativeBody],
  ['ConSys.ConEventAddGoal', 358, 324, 0x10013770, nativeBody],
  ['ConSys.ConEventAddNote', 359, 323, 0x100137cc, nativeBody],
  ['ConSys.ConEventAddSkillPoints', 361, 322, 0x10013828, nativeBody],
  ['ConSys.ConEventAnimation', 362, 321, 0x10013884, 0x100071b0],
  ['ConSys.ConEventCheckFlag', 364, 320, 0x100138e0, nativeBody],
  ['ConSys.ConEventCheckObject', 365, 319, 0x1001393c, 0x10007bf0],
  ['ConSys.ConEventCheckPersona', 366, 318, 0x10013998, nativeBody],
  ['ConSys.ConEventChoice', 367, 316, 0x100139f4, nativeBody],
  ['ConSys.ConEventComment', 368, 315, 0x10013a50, nativeBody],
  ['ConSys.ConEventEnd', 370, 314, 0x10013aac, nativeBody],
  ['ConSys.ConEventRandomLabel', 371, 308, 0x10013b78, nativeBody],
  ['ConSys.ConEventSetFlag', 372, 307, 0x10013bd4, nativeBody],
  ['ConSys.ConEventTrade', 373, 305, 0x10013c8c, 0x100071b0],
  ['ConSys.ConEventTransferObject', 381, 304, 0x10013ce8, 0x1000bc40],
  ['ConSys.ConEventTrigger', 382, 303, 0x10013d44, nativeBody],
].map(([key, classExport, scriptTextExport, vtable, slotTarget]) => freeze({
  key,
  classExport,
  scriptTextExport,
  vtable,
  slot: vtableSlot,
  slotTarget,
  nativeExport: `??_7D${key.split('.').at(-1)}@@6B@`,
  inherited: slotTarget === nativeBody,
}));

const classByKey = new Map(classes.map(record => [record.key.toLowerCase(), record]));
const inherited = classes.filter(record => record.inherited);
const overrides = classes.filter(record => !record.inherited);

/** Static evidence map for the installed ConSys build. */
export const CONVERSATION_BASE_BIND = freeze({
  package: 'ConSys',
  nativeBody,
  bodyBytes: freeze([0x32, 0xc0, 0xc2, 0x0c, 0x00]),
  vtableSlot,
  argumentBytes: 0xc,
  baseClass,
  classes: freeze(classes),
  inheritedClasses: freeze(inherited),
  inheritedClassKeys: freeze(inherited.map(record => record.key)),
  overrideClasses: freeze(overrides),
  overrideClassKeys: freeze(overrides.map(record => record.key)),
});

/** Static evidence map for ConEventMoveCamera's distinct false-return body. */
export const CONVERSATION_MOVE_CAMERA_BIND = freeze({
  package: 'ConSys',
  classKey: 'ConSys.ConEventMoveCamera',
  nativeBody: moveCameraNativeBody,
  bodyBytes: freeze([0x32, 0xc0, 0xc2, 0x0c, 0x00]),
  vtableSlot,
  argumentBytes: 0xc,
  result: false,
});

/** A class key or native target outside this exact recovered boundary. */
export class ConversationBaseBindError extends Error {
  constructor(message, {kind = 'BOUNDARY', classKey = null, slotTarget = null} = {}) {
    super(message);
    this.name = 'ConversationBaseBindError';
    this.code = `CONVERSATION_BASE_BIND_${kind}`;
    this.classKey = classKey;
    this.slotTarget = slotTarget;
  }
}

function classRecord(classKey) {
  if (typeof classKey !== 'string' || classKey.length === 0) {
    throw new ConversationBaseBindError(
      'Inherited conversation BindActor requires an exact ConSys class key',
      {kind: 'CLASS_KEY', classKey},
    );
  }
  const record = classByKey.get(classKey.toLowerCase());
  if (!record) {
    throw new ConversationBaseBindError(
      `Original conversation event BindActor class is unsupported: ${classKey}`,
      {kind: 'CLASS', classKey},
    );
  }
  return record;
}

/** Return the recovered vtable/slot record for one exact ConSys event class. */
export function conversationBaseBindNativeContract(classKey) {
  return classRecord(classKey);
}

/** Whether the complete key selects the recovered inherited false body. */
export function isConversationBaseBindClass(classKey) {
  if (typeof classKey !== 'string' || classKey.length === 0) return false;
  return classByKey.get(classKey.toLowerCase())?.inherited === true;
}

/** Whether the complete key selects ConEventMoveCamera's recovered body. */
export function isConversationMoveCameraBindClass(classKey) {
  return typeof classKey === 'string' && classKey.length > 0 &&
    classKey.toLowerCase() === moveCameraClassKey;
}

/** Return the exact recovered MoveCamera vtable/body contract. */
export function conversationMoveCameraBindNativeContract(classKey) {
  const record = classRecord(classKey);
  if (!isConversationMoveCameraBindClass(record.key)) {
    throw new ConversationBaseBindError(
      `Original conversation event BindActor is not the MoveCamera class: ${record.key}`,
      {kind: 'MOVE_CAMERA_CLASS', classKey: record.key, slotTarget: record.slotTarget},
    );
  }
  return freeze({...CONVERSATION_MOVE_CAMERA_BIND, classRecord: record});
}

/**
 * Execute DConEvent::BindActor for one verified class.  The original body
 * ignores receiver and arguments, so this service intentionally performs no
 * field or reference reads and accepts no substitute event adapter.
 */
export function bindConversationBaseActor({classKey} = {}) {
  const record = classRecord(classKey);
  if (!record.inherited) {
    throw new ConversationBaseBindError(
      `Original conversation event BindActor selects native body 0x${record.slotTarget.toString(16)} for ${record.key}`,
      {kind: 'OVERRIDE', classKey: record.key, slotTarget: record.slotTarget},
    );
  }
  return false;
}

/**
 * Execute the recovered ConEventMoveCamera::BindActor body.  Its installed
 * body is byte-for-byte the same no-read false result as DConEvent::BindActor,
 * but the vtable selects a distinct address, so it has a separate dispatch
 * boundary here.
 */
export function bindConversationMoveCameraActor({classKey} = {}) {
  const record = classRecord(classKey);
  if (!isConversationMoveCameraBindClass(record.key)) {
    throw new ConversationBaseBindError(
      `Original conversation event BindActor selects native body 0x${record.slotTarget.toString(16)} for ${record.key}`,
      {kind: 'MOVE_CAMERA_CLASS', classKey: record.key, slotTarget: record.slotTarget},
    );
  }
  return false;
}
