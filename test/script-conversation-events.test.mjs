import test from 'node:test';
import assert from 'node:assert/strict';
import { propertyReference } from '../src/runtime/script-values.mjs';
import {
  CONVERSATION_ACTOR_CLASS_ORDER,
  CONVERSATION_EVENT_NATIVE_INDICES,
  ConversationEventBoundaryError,
  addBoundActor,
  asciiCaseEqual,
  bindActorEventsNative,
  bindEventsNative,
  createConversationEventsNativeService,
  walkConversationEvents,
  zeroBoundActors,
} from '../src/runtime/script-conversation-events.mjs';

function fixture({ eventHead = undefined } = {}) {
  const first = { id: 'speech', bound: true, nextEvent: null };
  const second = { id: 'end', bound: false, nextEvent: null };
  first.nextEvent = second;
  const conversation = { id: 'conversation', eventList: eventHead === undefined ? first : eventHead };
  const actors = {
    a: { id: 'a', className: 'Pawn', BindName: 'Shared' },
    b: { id: 'b', className: 'Pawn', BindName: 'Shared' },
    player: { id: 'player', className: 'PlayerPawn', BindName: 'Shared' },
    decoration: { id: 'decoration', className: 'Decoration', BindName: 'Other' },
    none: { id: 'none', className: 'Pawn', BindName: '' },
  };
  const objects = [null, actors.a, actors.b, actors.player, actors.decoration, actors.none];
  const calls = [];
  const writes = [];
  const read = (object, field) => object[field];
  const write = (object, field, value) => {
    writes.push({ object, field, value });
    object[field] = value;
  };
  const reference = value => value;
  const isA = (object, classToken) => {
    if (classToken === 'Pawn') return object.className === 'Pawn' || object.className === 'PlayerPawn';
    return object.className === classToken;
  };
  const bindActor = details => {
    calls.push(details);
    return details.event.bound;
  };
  const service = {
    read,
    write,
    isA,
    reference,
    objects,
    bindActor,
    readArray: (array, index) => array[index],
    writeArray: (array, index, value) => {
      writes.push({ array, index, value });
      array[index] = value;
    },
  };
  return { conversation, actors, objects, calls, writes, service, first, second };
}

test('recovered class order, appStricmp comparison, and fixed-array helpers', () => {
  assert.deepEqual(CONVERSATION_ACTOR_CLASS_ORDER, ['Pawn', 'Decoration', 'PlayerPawn']);
  assert.equal(asciiCaseEqual('MunitionsTrooper', 'munitionsTROOPER'), true);
  assert.equal(asciiCaseEqual('Straße', 'STRASSE'), false);
  assert.equal(asciiCaseEqual('Shared\0ignored', 'SHARED'), true);

  const array = Array(10).fill('stale');
  const writes = [];
  const writeArray = (target, index, value) => {
    writes.push([index, value]);
    target[index] = value;
  };
  zeroBoundActors(array, { writeArray });
  assert.equal(writes.length, 10);
  assert.deepEqual(array, Array(10).fill(null));

  const actor = { id: 'actor' };
  assert.deepEqual(addBoundActor(array, actor, {
    readArray: (target, index) => target[index], writeArray,
  }), { added: true, index: 0, full: false });
  assert.deepEqual(addBoundActor(array, actor, {
    readArray: (target, index) => target[index], writeArray,
  }), { added: false, index: 0, full: false });

  const full = Array.from({ length: 10 }, (_, index) => ({ index }));
  assert.deepEqual(addBoundActor(full, { index: 99 }, {
    readArray: (target, index) => target[index], writeArray,
  }), { added: false, index: -1, full: true });
  assert.throws(() => addBoundActor([undefined], actor, {
    readArray: (target, index) => target[index], writeArray, max: 1,
  }), error => error instanceof ConversationEventBoundaryError && error.code === 'CONVERSATION_EVENT_ARRAY');
});

test('BindEvents preserves native pass order, gates, virtual arguments, and ten slots', () => {
  const { conversation, actors, calls, service, first, second } = fixture();
  const output = Array(10).fill('stale');
  const report = bindEventsNative({
    conversation,
    conBoundActors: output,
    invokeActor: actors.a,
    ...service,
  });

  assert.deepEqual(output, [actors.a, actors.decoration, ...Array(8).fill(null)]);
  assert.deepEqual(report.classPasses, [
    { classToken: 'Pawn', candidates: 4, selected: 1, events: 2, bound: 1 },
    { classToken: 'Decoration', candidates: 1, selected: 1, events: 2, bound: 1 },
    { classToken: 'PlayerPawn', candidates: 1, selected: 0, events: 0, bound: 0 },
  ]);
  assert.deepEqual(report.candidates.map(item => [item.classToken, item.actor.id, item.reason]), [
    ['Pawn', 'a', 'bound'], ['Pawn', 'b', 'duplicate-invoke-name'], ['Pawn', 'player', 'duplicate-invoke-name'],
    ['Pawn', 'none', 'empty-bind-name'], ['Decoration', 'decoration', 'bound'],
    ['PlayerPawn', 'player', 'duplicate-invoke-name'],
  ]);
  assert.equal(report.eventCalls.length, 4);
  assert.deepEqual(report.eventCalls.map(item => [item.secondActor.id, item.event.id]), [
    ['a', 'speech'], ['a', 'end'], ['decoration', 'speech'], ['decoration', 'end'],
  ]);
  assert.ok(calls.every(call => call.firstActor === actors.a && call.conversation === conversation));
  assert.deepEqual(calls.map(call => call.secondActor), report.eventCalls.map(call => call.secondActor));
  assert.ok(calls.every(call => call.mode === 'BindEvents'));
  assert.equal(first.nextEvent, second);
});

test('BindEvents allows null invoke actor and does not fabricate a binder result', () => {
  const { conversation, actors, service } = fixture();
  const calls = [];
  const output = Array(10).fill(null);
  bindEventsNative({
    conversation,
    conBoundActors: output,
    invokeActor: null,
    ...service,
    bindActor: details => {
      calls.push(details);
      return false;
    },
  });
  assert.equal(calls.length, 10); // A/B/player/decoration, each with two events; player repeats in pass 3.
  assert.ok(calls.every(call => call.firstActor === null));
  assert.equal(output.every(value => value === null), true);
  assert.equal(actors.none.BindName, '');
});

test('zero-length actor BindName follows the native empty-string fallback', () => {
  const event = { nextEvent: null };
  const conversation = { eventList: event };
  const actor = { className: 'Pawn', BindName: '' };
  const calls = [];
  const output = Array(10).fill('stale');
  bindEventsNative({
    conversation,
    conBoundActors: output,
    invokeActor: null,
    read: (object, field) => object[field],
    write: () => {},
    isA: () => true,
    reference: value => value,
    objects: [actor],
    bindActor: details => calls.push(details),
    readArray: (array, index) => array[index],
    writeArray: (array, index, value) => { array[index] = value; },
  });
  assert.deepEqual(output, Array(10).fill(null));
  assert.deepEqual(calls, []);
});

test('BindActorEvents passes the actor twice and ignores the virtual return', () => {
  const { conversation, actors, service } = fixture();
  const calls = [];
  const report = bindActorEventsNative({
    conversation,
    actorToBind: actors.b,
    ...service,
    bindActor: details => {
      calls.push(details);
      return undefined;
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(report.eventCalls.length, 2);
  assert.ok(calls.every(call => call.firstActor === actors.b && call.secondActor === actors.b));
  assert.ok(calls.every(call => call.mode === 'BindActorEvents'));

  const empty = fixture({ eventHead: null });
  const emptyCalls = [];
  bindActorEventsNative({
    conversation: empty.conversation,
    actorToBind: null,
    ...empty.service,
    bindActor: details => emptyCalls.push(details),
  });
  assert.deepEqual(emptyCalls, []);
  assert.doesNotThrow(() => bindActorEventsNative({
    conversation: empty.conversation,
    actorToBind: null,
    ...empty.service,
  }), 'an unneeded virtual binder is not required on the native null-list early return');
});

test('VM native adapter publishes typed fixed-array writes before the next event callback', () => {
  const { conversation, actors, service } = fixture();
  let output = Array(10).fill(actors.none);
  const outputRef = propertyReference({type:'object',arrayDim:10,elementSize:4},
    () => output, next => { output = next; });
  let callbacks = 0;
  const native = createConversationEventsNativeService({...service, bindActor: details => {
    if(callbacks++ === 0) assert.deepEqual(output, Array(10).fill(null));
    else assert.equal(output[0], actors.a, 'previous BindActor result is already published');
    return details.event.bound;
  }});
  assert.equal(native({
    index: CONVERSATION_EVENT_NATIVE_INDICES.BindEvents,
    receiver: conversation,
    argumentCount: 2,
    evaluateArgument: index => index === 0 ? outputRef : actors.a,
  }), undefined);
  assert.deepEqual(output, [actors.a, actors.decoration, ...Array(8).fill(null)]);
  assert.throws(() => native({
    index: CONVERSATION_EVENT_NATIVE_INDICES.BindActorEvents,
    receiver: conversation,
    argumentCount: 0,
    evaluateArgument: () => null,
  }), /expected 1/);
});

test('reached unresolved links and non-boolean BindActor results fail explicitly', () => {
  const conversation = { eventList: { nextEvent: undefined } };
  const common = {
    read: (object, field) => object[field],
    write: () => {},
    reference: value => value,
    bindActor: () => true,
  };
  assert.throws(() => walkConversationEvents(conversation, {
    ...common,
    onEvent: () => {},
  }), error => error instanceof ConversationEventBoundaryError && error.code === 'CONVERSATION_EVENT_FIELD');

  const actor = { BindName: 'Bound', className: 'Pawn' };
  const eventConversation = { eventList: { nextEvent: null } };
  assert.throws(() => bindEventsNative({
    conversation: eventConversation,
    conBoundActors: Array(10).fill(null),
    invokeActor: actor,
    ...common,
    isA: () => true,
    objects: [actor],
    readArray: (array, index) => array[index],
    writeArray: (array, index, value) => { array[index] = value; },
    bindActor: () => undefined,
  }), error => error instanceof ConversationEventBoundaryError && error.code === 'CONVERSATION_EVENT_RETURN');
});
