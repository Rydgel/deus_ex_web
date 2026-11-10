/**
 * Recovered ConSys Conversation.BindEvents/BindActorEvents services.
 *
 * The two UFunctions are original VM/native declarations.  Their C++ bodies
 * are modelled here as synchronous host services; event-specific virtual
 * BindActor implementations remain an explicit callback because they have
 * separate native bodies and object-field layouts.
 *
 * Evidence: installed ConSys.u metadata and ConSys.dll (image base
 * 0x10000000), DConversation::BindEvents +0xfec0,
 * DConversation::BindEventsToActor +0x100f0,
 * DConversation::AddBoundActor +0x101a0,
 * DConversation::BindActorEvents +0x101d0, and the corresponding exec
 * wrappers +0x10780/+0x10840.
 */

import { readFunctionMetadata } from '../unreal/script-metadata.mjs';
import { refValue } from './script-vm.mjs';
import { arrayReference } from './script-values.mjs';
import { scriptCaps, scriptStringText } from './script-string-operations.mjs';
import { switchReader } from './switch-reader.mjs';

const freeze = value => Object.freeze(value);

/**
 * BIND_EVENTS (DEUS_EX_BIND_EVENTS, `?bindEvents=`): 'rust' (default) runs BindEvents' three class passes in the Rust core over the
 * image's class rows (`scan` below) and the conversation lifecycle's per-call caches (script-conversation-bind-scope.mjs); 'js' keeps
 * the reference passes (every GObjObjects entry through `reference` and `isA`, the list reloaded after each candidate) and
 * no caches; 'verify' runs the Rust scan beside the reference's own selection and the caches beside real reads and loads,
 * and throws at the first difference. docs/firefox-60fps-plan.md "BindEvents in the 20 s tick".
 */
export const bindEventsMode = switchReader('BIND_EVENTS', 'DEUS_EX_BIND_EVENTS', 'rust');

/** Native indices registered by ConSys.u's Conversation class. */
export const CONVERSATION_EVENT_NATIVE_INDICES = freeze({
  BindEvents: 2052,
  BindActorEvents: 2053,
});

/** The three exact class passes in DConversation::BindEvents. */
export const CONVERSATION_ACTOR_CLASS_ORDER = freeze([
  'Pawn',
  'Decoration',
  'PlayerPawn',
]);

/** Original function records used when preparing the native wrappers. */
export const CONVERSATION_EVENT_FUNCTIONS = freeze([
  freeze({
    asset: 'ConSys',
    path: 'conversation.bindevents',
    nativeIndex: CONVERSATION_EVENT_NATIVE_INDICES.BindEvents,
    size: 10,
    parameters: freeze(['Actor[10] out conBoundActors', 'Actor invokeActor']),
  }),
  freeze({
    asset: 'ConSys',
    path: 'conversation.bindactorevents',
    nativeIndex: CONVERSATION_EVENT_NATIVE_INDICES.BindActorEvents,
    size: 5,
    parameters: freeze(['Actor actorToBind']),
  }),
]);

const nativeContract = new Map(CONVERSATION_EVENT_FUNCTIONS.map(item => [
  item.nativeIndex,
  freeze({
    name: item.path.replace(/^conversation\./, 'Conversation.'),
    arguments: item.parameters.length,
    parameters: item.parameters,
  }),
]));

/** Return one recovered native declaration by index. */
export function conversationEventNativeContract(index) {
  const contract = nativeContract.get(index);
  if (!contract) throw new RangeError(`Unknown ConSys conversation native ${index}`);
  return contract;
}

/**
 * A reached object/reference or service call that the host cannot resolve.
 * Native C++ would dereference/call it; silently turning it into null/false
 * would change control flow, so the boundary is explicit.
 */
export class ConversationEventBoundaryError extends Error {
  constructor(message, { nativeIndex = null, kind = 'BOUNDARY', value = undefined } = {}) {
    super(message);
    this.name = 'ConversationEventBoundaryError';
    this.code = `CONVERSATION_EVENT_${kind}`;
    this.nativeIndex = nativeIndex;
    this.value = value;
  }
}

function requireFunction(service, name, nativeIndex = null) {
  if (typeof service !== 'function') {
    throw new ConversationEventBoundaryError(
      `Conversation event native${nativeIndex == null ? '' : ` ${nativeIndex}`} requires ${name} service`,
      { nativeIndex, kind: 'SERVICE' },
    );
  }
  return service;
}

function syncResult(result, nativeIndex, label) {
  if (result && typeof result.then === 'function') {
    throw new ConversationEventBoundaryError(
      `Conversation event native ${nativeIndex} ${label} service suspended; native calls are synchronous`,
      { nativeIndex, kind: 'ASYNC' },
    );
  }
  return result;
}

function reachedReference(value, reference, label, nativeIndex) {
  if (value === null) return null;
  if (value === undefined) {
    throw new ConversationEventBoundaryError(
      `Conversation event native ${nativeIndex} reached an uninitialized ${label} reference`,
      { nativeIndex, kind: 'REFERENCE', value },
    );
  }
  requireFunction(reference, 'reference', nativeIndex);
  const canonical = syncResult(reference(value, label), nativeIndex, 'reference');
  if (canonical === undefined || (canonical === null && value !== null)) {
    throw new ConversationEventBoundaryError(
      `Conversation event native ${nativeIndex} could not resolve reached ${label} reference`,
      { nativeIndex, kind: 'REFERENCE', value },
    );
  }
  return canonical;
}

function readField(object, field, read, nativeIndex) {
  requireFunction(read, 'read', nativeIndex);
  const value = syncResult(read(object, field, { nativeIndex, field }), nativeIndex, `read ${field}`);
  if (value === undefined) {
    throw new ConversationEventBoundaryError(
      `Conversation event native ${nativeIndex} reached an unresolved ${field} field`,
      { nativeIndex, kind: 'FIELD', value },
    );
  }
  return value;
}

function readReference(object, field, { read, reference, nativeIndex }, label = field) {
  return reachedReference(readField(object, field, read, nativeIndex), reference, label, nativeIndex);
}

function arrayRead(array, index, readArray, nativeIndex) {
  requireFunction(readArray, 'readArray', nativeIndex);
  const value = syncResult(readArray(array, index, { nativeIndex, index }), nativeIndex,
    `readArray[${index}]`);
  if (value === undefined) {
    throw new ConversationEventBoundaryError(
      `Conversation event native ${nativeIndex} reached an unresolved fixed-array slot ${index}`,
      { nativeIndex, kind: 'ARRAY', value },
    );
  }
  return value;
}

function arrayWrite(array, index, value, writeArray, nativeIndex) {
  requireFunction(writeArray, 'writeArray', nativeIndex);
  return syncResult(writeArray(array, index, value, { nativeIndex, index, value }), nativeIndex,
    `writeArray[${index}]`);
}

/**
 * Zero the ten Actor slots exactly as DConversation::BindEvents does with its
 * `appMemset(conBoundActors, 0, 0x28)` call.
 */
export function zeroBoundActors(conBoundActors, {
  writeArray,
  max = 10,
  nativeIndex = CONVERSATION_EVENT_NATIVE_INDICES.BindEvents,
} = {}) {
  if (!Number.isInteger(max) || max <= 0) throw new RangeError('Fixed actor array size must be positive');
  for (let index = 0; index < max; index++) arrayWrite(conBoundActors, index, null, writeArray, nativeIndex);
  return conBoundActors;
}

/**
 * DConversation::AddBoundActor: duplicate guard, first empty slot, then a
 * bounded no-write result after exactly ten slots. The returned report is for
 * diagnostics; the native method itself is void.
 */
export function addBoundActor(conBoundActors, actor, {
  readArray,
  writeArray,
  max = 10,
  nativeIndex = CONVERSATION_EVENT_NATIVE_INDICES.BindEvents,
} = {}) {
  if (actor === null || actor === undefined) {
    throw new ConversationEventBoundaryError(
      `Conversation event native ${nativeIndex} cannot add an unresolved actor`,
      { nativeIndex, kind: 'REFERENCE', value: actor },
    );
  }
  if (!Number.isInteger(max) || max <= 0) throw new RangeError('Fixed actor array size must be positive');
  for (let index = 0; index < max; index++) {
    const current = arrayRead(conBoundActors, index, readArray, nativeIndex);
    if (current === actor) return { added: false, index, full: false };
    if (current === null) {
      arrayWrite(conBoundActors, index, actor, writeArray, nativeIndex);
      return { added: true, index, full: false };
    }
  }
  return { added: false, index: -1, full: true };
}

/**
 * Walk Conversation.eventList / ConEvent.nextEvent in source order. The
 * original has no cycle guard; the host rejects a cycle to keep malformed
 * package data from hanging the browser.
 */
export function walkConversationEvents(conversation, {
  read,
  reference,
  onEvent,
  nativeIndex = CONVERSATION_EVENT_NATIVE_INDICES.BindActorEvents,
} = {}) {
  const event = readReference(conversation, 'eventList', { read, reference, nativeIndex }, 'eventList');
  return walkConversationEventChain(event, { conversation, read, reference, onEvent, nativeIndex });
}

function walkConversationEventChain(event, {
  conversation = null,
  read,
  reference,
  onEvent,
  nativeIndex = CONVERSATION_EVENT_NATIVE_INDICES.BindActorEvents,
} = {}) {
  requireFunction(onEvent, 'onEvent', nativeIndex);
  const seen = new Set();
  let index = 0;
  while (event !== null) {
    if (seen.has(event)) {
      throw new ConversationEventBoundaryError(
        `Conversation event native ${nativeIndex} encountered a cyclic event chain at index ${index}`,
        { nativeIndex, kind: 'CYCLE', value: event },
      );
    }
    seen.add(event);
    syncResult(onEvent(event, index, { nativeIndex, conversation }), nativeIndex, 'onEvent');
    event = readReference(event, 'nextEvent', { read, reference, nativeIndex }, 'nextEvent');
    index++;
  }
  return index;
}

function asciiFold(value) {
  return scriptCaps(scriptStringText(value));
}

/** appStricmp-compatible equality for authored FString actor names. */
export function asciiCaseEqual(left, right) {
  return asciiFold(left) === asciiFold(right);
}

function actorName(actor, { read, reference, nativeIndex }, label) {
  const canonical = reachedReference(actor, reference, label, nativeIndex);
  if (canonical === null) return { actor: null, name: '' };
  const value = readField(canonical, 'BindName', read, nativeIndex);
  return {
    actor: canonical,
    // The native reads FString.ArrayNum first and substitutes the static
    // empty TCHAR at1001e1cc for a zero-length field.
    name: scriptStringText(value),
  };
}

function compareText(left, right, compare, nativeIndex, label) {
  const comparator = requireFunction(compare, 'equalText', nativeIndex);
  const result = syncResult(comparator(left, right, { nativeIndex, left, right, label }), nativeIndex,
    `equalText ${label}`);
  if (typeof result !== 'boolean') {
    throw new ConversationEventBoundaryError(
      `Conversation event native ${nativeIndex} equalText(${label}) returned ${String(result)}`,
      { nativeIndex, kind: 'RETURN', value: result },
    );
  }
  return result;
}

function bindEventsToActor(conversation, conBoundActors, invokeActor, candidateActor, services, report) {
  const { read, reference, bindActor, equalText, nativeIndex, chain, collect } = services;
  const candidate = reachedReference(candidateActor, reference, 'candidate actor', nativeIndex);
  if (candidate === null) return { selected: false, reason: 'null-candidate', events: 0 };
  const invoke = reachedReference(invokeActor, reference, 'invoke actor', nativeIndex);
  const candidateName = actorName(candidate, services, 'candidate actor').name;
  if (compareText(candidateName, '', equalText, nativeIndex, 'candidate/empty'))
    return { selected: false, reason: 'empty-bind-name', events: 0 };
  if (invoke !== null && invoke !== candidate) {
    const invokeName = actorName(invoke, services, 'invoke actor').name;
    if (compareText(invokeName, candidateName, equalText, nativeIndex, 'invoke/candidate')) {
      return { selected: false, reason: 'duplicate-invoke-name', events: 0 };
    }
  }

  let events = 0, bound = 0;
  const onEvent = (event, eventIndex) => {
    const binder = requireFunction(bindActor, 'bindActor', nativeIndex);
    const result = syncResult(binder({
      event,
      firstActor: invoke,
      secondActor: candidate,
      conversation,
      eventIndex,
      nativeIndex,
      mode: 'BindEvents',
    }), nativeIndex, 'BindActor');
    // The C++ body tests AL from the virtual bool. An omitted value is not
    // an original false; it means the reached event service is incomplete.
    if (typeof result !== 'boolean') {
      throw new ConversationEventBoundaryError(
        `Conversation event native ${nativeIndex} BindActor returned ${String(result)}; expected bool`,
        { nativeIndex, kind: 'RETURN', value: result },
      );
    }
    events++;
    if (collect) report.eventCalls.push({ event, eventIndex, firstActor: invoke,
      secondActor: candidate, result });
    if (result) {
      const added = addBoundActor(conBoundActors, candidate, services);
      if (added.added) bound++;
      if (collect) report.addedActors.push({ candidate, event, eventIndex, ...added });
    }
  };
  if (chain === null) walkConversationEvents(conversation, { read, reference, nativeIndex, onEvent });
  else walkRecordedChain(conversation, chain, services, onEvent);
  return { selected: true, reason: 'bound', events, bound };
}

/**
 * The event chain of one BindEvents call (BIND_EVENTS=rust|verify): the first candidate that reaches the events walks it as the
 * reference does, link read by link read, and notes the events in order; the later candidates take the notes. Nothing writes
 * Conversation.eventList or ConEvent.nextEvent while the call runs (the event bodies write the speaker, owner and object
 * links, never the chain), so the walk would reach the same events, and one that failed or was cut short is not noted: the
 * next candidate walks again and fails where it did. BIND_EVENTS=verify also walks for real and compares.
 */
function walkRecordedChain(conversation, chain, services, onEvent) {
  const { read, reference, nativeIndex } = services;
  if (chain.events === null) {
    const noted = [];
    walkConversationEvents(conversation, { read, reference, nativeIndex, onEvent: (event, eventIndex, info) => {
      noted.push(event);
      return onEvent(event, eventIndex, info);
    } });
    chain.events = noted;
    return;
  }
  const events = chain.events;
  if (chain.verify) {
    let at = 0;
    walkConversationEvents(conversation, { read, reference, nativeIndex, onEvent: event => {
      if (events[at++] !== event) throw new Error(`BIND_EVENTS=verify: event ${at - 1} of the chain is not the event the first walk noted`);
    } });
    if (at !== events.length) throw new Error(`BIND_EVENTS=verify: the chain has ${at} events, the first walk noted ${events.length}`);
  }
  for (let index = 0; index < events.length; index++) onEvent(events[index], index, { nativeIndex, conversation });
}

function actorObjects(objects, nativeIndex) {
  const result = typeof objects === 'function' ? syncResult(objects(), nativeIndex, 'objects') : objects;
  if (!Array.isArray(result)) {
    throw new ConversationEventBoundaryError(
      `Conversation event native ${nativeIndex} requires the canonical GObjObjects array`,
      { nativeIndex, kind: 'SERVICE' },
    );
  }
  return result;
}

/**
 * Execute the recovered DConversation::BindEvents body. The report is useful
 * to validators; callers routing a VM native should discard it and return
 * `undefined`, matching the void C++ function.
 */
export function bindEventsNative({
  conversation,
  conBoundActors,
  invokeActor,
  read,
  write,
  isA,
  reference,
  objects,
  scan = null,
  scope = null,
  collect = true,
  bindActor,
  readArray,
  writeArray,
  equalText = asciiCaseEqual,
  actorClassOrder = CONVERSATION_ACTOR_CLASS_ORDER,
  nativeIndex = CONVERSATION_EVENT_NATIVE_INDICES.BindEvents,
  call = null,
} = {}) {
  requireFunction(read, 'read', nativeIndex);
  requireFunction(write, 'write', nativeIndex);
  requireFunction(reference, 'reference', nativeIndex);
  if (!Array.isArray(actorClassOrder) || actorClassOrder.length !== 3)
    throw new ConversationEventBoundaryError(
      `Conversation event native ${nativeIndex} requires exactly three actor class passes`,
      { nativeIndex, kind: 'SERVICE' },
    );
  const canonicalConversation = reachedReference(conversation, reference, 'conversation', nativeIndex);
  if (canonicalConversation === null)
    throw new ConversationEventBoundaryError(
      `Conversation event native ${nativeIndex} received a null conversation`,
      { nativeIndex, kind: 'REFERENCE', value: conversation },
    );
  if (conBoundActors === null || conBoundActors === undefined)
    throw new ConversationEventBoundaryError(
      `Conversation event native ${nativeIndex} received an unresolved conBoundActors array`,
      { nativeIndex, kind: 'ARRAY', value: conBoundActors },
    );

  const service = {
    read,
    write,
    isA,
    reference,
    bindActor,
    equalText,
    readArray,
    writeArray,
    nativeIndex,
    call,
    chain: null,
    collect,
  };
  zeroBoundActors(conBoundActors, service);
  const report = {
    nativeIndex,
    conversation: canonicalConversation,
    invokeActor: reachedReference(invokeActor, reference, 'invoke actor', nativeIndex),
    classPasses: [],
    candidates: [],
    eventCalls: [],
    addedActors: [],
  };
  const selectedByClass = (object, classToken) => {
    const classTest = requireFunction(isA, 'isA', nativeIndex);
    const matches = syncResult(classTest(object, classToken, { nativeIndex, classToken }), nativeIndex,
      `isA ${classToken}`);
    if (typeof matches !== 'boolean') {
      throw new ConversationEventBoundaryError(
        `Conversation event native ${nativeIndex} isA(${classToken}) returned ${String(matches)}`,
        { nativeIndex, kind: 'RETURN', value: matches },
      );
    }
    return matches;
  };
  // One selected object: BindEventsToActor, then the pass's and the report's figures.
  const bindCandidate = (classToken, pass, object) => {
    pass.candidates++;
    const candidateReport = bindEventsToActor(
      canonicalConversation,
      conBoundActors,
      report.invokeActor,
      object,
      service,
      report,
    );
    if (collect) report.candidates.push({ classToken, actor: object, ...candidateReport });
    if (candidateReport.selected) {
      pass.selected++;
      pass.events += candidateReport.events;
      pass.bound += candidateReport.bound;
    }
  };
  // The reference pass (BIND_EVENTS=js, and where the scan hands a pass back): the GObjObjects entries one by one from `from`.
  const referencePass = (classToken, pass, from) => {
    let globalObjects = null;
    for (let index = from; ; index++) {
      // The original iterator reloads the global array and its count when
      // advancing. Native callbacks can change that storage between visits;
      // only a matching candidate's binding runs any (reference and isA are
      // reads), so the array is reloaded at the start and after each one.
      globalObjects ??= actorObjects(objects, nativeIndex);
      if (index >= globalObjects.length) break;
      const raw = globalObjects[index];
      if (raw === null) continue;
      const object = reachedReference(raw, reference, 'GObjObjects entry', nativeIndex);
      if (object === null) continue;
      if (!selectedByClass(object, classToken)) continue;
      bindCandidate(classToken, pass, object);
      globalObjects = null;
    }
  };
  // BIND_EVENTS=verify: the first slot of `array` from `from` that the reference pass selects, or -1.
  const referenceStop = (array, from, length, classToken) => {
    for (let at = from; at < length; at++) {
      const raw = array[at];
      if (raw === null || raw === undefined) continue;
      const object = reachedReference(raw, reference, 'GObjObjects entry', nativeIndex);
      if (object !== null && selectedByClass(object, classToken)) return at;
    }
    return -1;
  };
  // The pass with the class tests in the Rust core (script-vm-render.mjs cycleScan over the image's class rows, the scan
  // CycleActors uses). It walks the level's actor array in order and stops at each object of the class: the entries it
  // passes are answered by the image and cost no script or host read. An entry it cannot answer for (kind 2: no class row)
  // is tested here as the reference tests it. The reference reloads GObjObjects after every candidate it binds; while the
  // array, its length and the actors epoch are as the scan began, the next entry is the one the reload shows, and a change
  // hands the pass back to the reference at the index the reload would continue from. Returns -1 when the pass is done,
  // else the reference's index to continue at.
  const scannedPass = (classToken, pass, scanner) => {
    const array = scanner.actors(), length = array.length, epoch = scanner.epoch();
    // (the reference's index of a slot is the number of non-empty slots before it)
    let cursor = 0, steps = 0, counted = 0, countedTo = 0;
    const filteredBefore = to => {
      for (; countedTo < to; countedTo++) if (array[countedTo]) counted++;
      return counted;
    };
    for (;;) {
      const from = cursor;
      const found = scanner.step(array, cursor, steps, length, classToken);
      if (found === null) return filteredBefore(from);
      cursor = found.cursor;
      steps = found.steps;
      if (scanner.verify) {
        const expected = referenceStop(array, from, length, classToken);
        // (a kind 2 stop is an entry the image could not test: the reference's test of it decides, below)
        const agrees = found.kind === 0 ? expected === -1 : found.kind === 1 ? expected === cursor - 1 : expected === -1 || expected >= cursor - 1;
        if (!agrees) {
          throw new Error(`BIND_EVENTS=verify: ${classToken} pass from slot ${from}: the scan ${['ran out', 'stopped at', 'left to the reference'][found.kind]} ${found.kind ? `slot ${cursor - 1}` : ''}, the reference stops at ${expected}`);
        }
      }
      if (found.kind === 0) return -1;
      const at = cursor - 1;
      const object = reachedReference(array[at], reference, 'GObjObjects entry', nativeIndex);
      if (object === null) continue;
      if (found.kind === 2 && !selectedByClass(object, classToken)) continue;
      const index = filteredBefore(at);
      bindCandidate(classToken, pass, object);
      if (scanner.actors() !== array || array.length !== length || scanner.epoch() !== epoch) return index + 1;
    }
  };
  // `scope` brackets the binding of one call: the host's reads and loads of the candidates and events it repeats in the call
  // (script-conversation-bind-scope.mjs) are kept for that call only.
  scope?.begin();
  if (scope?.active) service.chain = { events: null, verify: scope.verify };
  try {
    for (const classToken of actorClassOrder) {
      const pass = { classToken, candidates: 0, selected: 0, events: 0, bound: 0 };
      report.classPasses.push(pass);
      const scanner = scan === null ? null : scan();
      const resume = scanner === null ? 0 : scannedPass(classToken, pass, scanner);
      if (resume >= 0) referencePass(classToken, pass, resume);
    }
  } finally {
    scope?.end();
  }
  return report;
}

/** Execute the recovered DConversation::BindActorEvents body. */
export function bindActorEventsNative({
  conversation,
  actorToBind,
  read,
  write,
  reference,
  bindActor,
  readArray = null,
  writeArray = null,
  nativeIndex = CONVERSATION_EVENT_NATIVE_INDICES.BindActorEvents,
  call = null,
} = {}) {
  requireFunction(read, 'read', nativeIndex);
  requireFunction(write, 'write', nativeIndex);
  requireFunction(reference, 'reference', nativeIndex);
  const canonicalConversation = reachedReference(conversation, reference, 'conversation', nativeIndex);
  if (canonicalConversation === null)
    throw new ConversationEventBoundaryError(
      `Conversation event native ${nativeIndex} received a null conversation`,
      { nativeIndex, kind: 'REFERENCE', value: conversation },
    );
  const canonicalActor = reachedReference(actorToBind, reference, 'actorToBind', nativeIndex);
  const report = {
    nativeIndex,
    conversation: canonicalConversation,
    actorToBind: canonicalActor,
    eventCalls: [],
  };
  walkConversationEvents(canonicalConversation, {
    read,
    reference,
    nativeIndex,
    onEvent: (event, eventIndex) => {
      // The original pushes actorToBind twice and the conversation once, then
      // ignores the virtual bool. Keep the duplicate actor identity visible.
      const binder = requireFunction(bindActor, 'bindActor', nativeIndex);
      const result = syncResult(binder({
        event,
        firstActor: canonicalActor,
        secondActor: canonicalActor,
        conversation: canonicalConversation,
        eventIndex,
        nativeIndex,
        mode: 'BindActorEvents',
        call,
      }), nativeIndex, 'BindActor');
      report.eventCalls.push({ event, eventIndex, firstActor: canonicalActor,
        secondActor: canonicalActor, result });
    },
  });
  return report;
}

function argument(call, index, label) {
  if (typeof call?.evaluateArgument !== 'function') {
    throw new ConversationEventBoundaryError(
      `Conversation event native ${call?.index ?? '<unknown>'} has no argument evaluator`,
      { nativeIndex: call?.index ?? null, kind: 'SERVICE' },
    );
  }
  return syncResult(call.evaluateArgument(index), call.index, `argument ${label}`);
}

function validateCall(call) {
  const contract = conversationEventNativeContract(call?.index);
  if (call.argumentCount !== contract.arguments) {
    throw new Error(`${contract.name} native ${call.index} received ${call.argumentCount} arguments; ` +
      `expected ${contract.arguments}`);
  }
  return contract;
}

/**
 * Build a VM-native callback. `bindActor` is the explicit virtual event
 * service; all object/array access remains supplied by the caller.
 */
export function createConversationEventsNativeService({
  read,
  write,
  isA,
  reference,
  objects,
  scan = null,
  scope = null,
  bindActor,
  readArray,
  writeArray,
  equalText = asciiCaseEqual,
  actorClassOrder = CONVERSATION_ACTOR_CLASS_ORDER,
} = {}) {
  return call => {
    const contract = validateCall(call);
    const values = Array.from({ length: contract.arguments }, (_, index) => argument(call, index, contract.name));
    if (call.index === CONVERSATION_EVENT_NATIVE_INDICES.BindEvents) {
      const out = values[0];
      // A fixed-array property get() copies its complete value. Retain the
      // lvalue and publish each original slot write before the next callback.
      const slots = out?.reference ? {
        readArray: (_array, index) => arrayReference(index, out).get(),
        writeArray: (_array, index, value) => arrayReference(index, out).set(value),
      } : { readArray, writeArray };
      bindEventsNative({
        conversation: call.receiver,
        conBoundActors: refValue(values[0]),
        invokeActor: refValue(values[1]),
        read,
        write,
        isA,
        reference,
        objects,
        scan,
        scope,
        // (the report is for validators: the VM native discards it, and BIND_EVENTS=rust does not build it)
        collect: bindEventsMode() !== 'rust',
        bindActor,
        ...slots,
        equalText,
        actorClassOrder,
        nativeIndex: call.index,
        call,
      });
      return undefined;
    }
    bindActorEventsNative({
      conversation: call.receiver,
      actorToBind: refValue(values[0]),
      read,
      write,
      reference,
      bindActor,
      readArray,
      writeArray,
      nativeIndex: call.index,
      call,
    });
    return undefined;
  };
}

function assetFor(assets, explicit) {
  if (explicit) return explicit;
  if (!assets || typeof assets.get !== 'function') throw new TypeError('ConSys asset is required');
  return assets.get('ConSys');
}

/**
 * Prepare the original native UFunction wrappers and verify metadata. The
 * C++ implementations are supplied separately through the native callback.
 */
export async function prepareConversationEventFunctions(runtime, { assets = runtime?.objects?.assets, conSys = null } = {}) {
  if (!runtime || typeof runtime.prepareFunction !== 'function')
    throw new TypeError('Conversation event preparation requires ScriptRuntime.prepareFunction');
  const asset = await assetFor(assets, conSys);
  const prepared = new Map();
  for (const item of CONVERSATION_EVENT_FUNCTIONS) {
    const index = asset.exportsByPath.get(item.path);
    if (!index) throw new Error(`Missing original ConSys function ${item.path}`);
    const metadata = readFunctionMetadata(asset, index);
    if (metadata.nativeIndex !== item.nativeIndex)
      throw new Error(`ConSys.${item.path} native index changed: ${metadata.nativeIndex}, expected ${item.nativeIndex}`);
    if (metadata.scriptSize !== item.size)
      throw new Error(`ConSys.${item.path} script size changed: ${metadata.scriptSize}, expected ${item.size}`);
    const record = await runtime.prepareFunction(asset, index);
    prepared.set(record.key, record);
  }
  return prepared;
}
