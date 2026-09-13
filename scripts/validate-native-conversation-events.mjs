/** Compare the translated Conversation event loops with direct original DLL
 * executions from native-conversation-events-oracle.py.
 *
 * This validator deliberately includes the invoking/non-invoking same-name
 * case.  The original body skips a non-invoking candidate whose BindName is
 * equal to invokeActor.BindName; a differing name proceeds.  Keeping that
 * case here prevents the host translation from quietly reverting to the
 * tempting but incorrect equality gate.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { access } from 'node:fs/promises';
import {
  addBoundActor,
  bindActorEventsNative,
  bindEventsNative,
} from '../src/runtime/script-conversation-events.mjs';
import { gameDirectory } from './game-directory.mjs';

const gameRoot = gameDirectory();
const python = process.env.NATIVE_PROBE_PYTHON ||
  path.resolve('.cache/native-probe-env/bin/python');
await access(python);

const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-conversation-events-oracle.py'), gameRoot,
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));

const actors = {
  first: { name: 'first', className: 'Pawn', BindName: 'Shared' },
  second: { name: 'second', className: 'Pawn', BindName: 'shared' },
  player: { name: 'player', className: 'PlayerPawn', BindName: 'Shared' },
  decoration: { name: 'decoration', className: 'Decoration', BindName: 'Other' },
  none: { name: 'none', className: 'Pawn', BindName: '' },
  late: { name: 'late', className: 'Pawn', BindName: 'Late' },
  literalNone: { name: 'literalNone', className: 'Decoration', BindName: 'None' },
};
const conversation = { name: 'conversation' };
const speech = { name: 'speech' };
const ending = { name: 'end' };
conversation.eventList = speech;
speech.nextEvent = ending;
ending.nextEvent = null;

const allObjects = [null, actors.first, actors.second, actors.player,
  actors.decoration, actors.none, actors.late, actors.literalNone];

function label(value) {
  if (value === null || value === undefined) return null;
  if (value === conversation) return 'conversation';
  if (value === speech) return 'speech';
  if (value === ending) return 'end';
  for (const [name, actor] of Object.entries(actors))
    if (value === actor) return name;
  return value?.name || String(value);
}

function fixture({ live = false, eventResult = true } = {}) {
  // The native fixture has the same six visible entries initially: the null
  // hole, three actors, a decoration, and the empty BindName actor.  Its late
  // Pawn and literal-text "None" actor are at the next slots and become
  // visible only in the live case after Num is raised by the first event
  // callback.  This distinguishes nonempty "None" from native empty.
  const objects = allObjects.slice(0, 6);
  const output = Array(10).fill('seed');
  const events = [];
  const comparisons = [];
  let livePublished = false;
  const read = (object, field) => object[field];
  const reference = value => value;
  const isA = (object, classToken) => classToken === 'Pawn'
    ? object.className === 'Pawn' || object.className === 'PlayerPawn'
    : object.className === classToken;
  const equalText = (left, right) => {
    comparisons.push([left, right]);
    return left.toLocaleUpperCase('en-US') === right.toLocaleUpperCase('en-US');
  };
  const bindActor = details => {
    events.push({
      event: label(details.event),
      first: label(details.firstActor),
      second: label(details.secondActor),
      conversation: label(details.conversation),
      result: eventResult,
    });
    if (live && !livePublished) {
      livePublished = true;
      objects.push(actors.late, actors.literalNone);
    }
    return eventResult;
  };
  const readArray = (array, index) => array[index];
  const writeArray = (array, index, value) => { array[index] = value; };
  return {
    objects,
    output,
    events,
    comparisons,
    read,
    reference,
    isA,
    equalText,
    bindActor,
    readArray,
    writeArray,
    run() {
      const report = bindEventsNative({
        conversation,
        conBoundActors: output,
        invokeActor: actors.first,
        read,
        write: () => {},
        isA,
        reference,
        objects: () => objects,
        bindActor,
        readArray,
        writeArray,
        equalText,
      });
      return { report, output, events, comparisons };
    },
  };
}

function normalizeReport(result) {
  return {
    output: result.output.map(label),
    events: result.events,
    comparisons: result.comparisons,
    helpers: result.report.candidates.map(candidate => label(candidate.actor)),
  };
}

function nativeBindEvents(name) {
  const value = native.cases[name];
  assert.ok(value, `native oracle case ${name}`);
  return value;
}

// The static and live cases pin class-pass order, name gates, virtual argument
// order, and fixed-array publication against the original body.
const nativeStatic = nativeBindEvents('bindEvents');
assert.deepEqual(nativeStatic.output,
  ['first', 'decoration', null, null, null, null, null, null, null, null],
  'original same-name non-invoking candidates are skipped');
assert.deepEqual(nativeStatic.helpers,
  ['first', 'second', 'player', 'none', 'decoration', 'player'],
  'original helper/class-pass order');
assert.equal(nativeStatic.events.length, 4, 'original virtual event count');
assert.deepEqual(nativeStatic.events.map(event => [event.first, event.second, event.event]), [
  ['first', 'first', 'speech'], ['first', 'first', 'end'],
  ['first', 'decoration', 'speech'], ['first', 'decoration', 'end'],
]);
assert.deepEqual(nativeStatic.comparisons, [
  ['Shared', ''],
  ['shared', ''], ['Shared', 'shared'],
  ['Shared', ''], ['Shared', 'Shared'],
  ['', ''],
  ['Other', ''], ['Shared', 'Other'],
  ['Shared', ''], ['Shared', 'Shared'],
], 'native appStricmp gate order and operands');

const translatedStatic = fixture().run();
assert.deepEqual(normalizeReport(translatedStatic), {
  output: nativeStatic.output,
  events: nativeStatic.events,
  comparisons: nativeStatic.comparisons,
  helpers: nativeStatic.helpers,
}, 'translated BindEvents matches direct original execution');

const nativeLive = nativeBindEvents('bindEventsLiveGObjObjects');
assert.deepEqual(nativeLive.output,
  ['first', 'late', 'decoration', 'literalNone', null, null, null, null, null, null],
  'native iterator sees callback-published GObjObjects entries');
assert.equal(nativeLive.gobjNum, 8);
assert.equal(nativeLive.liveMutationCount, 1);
const translatedLive = fixture({ live: true }).run();
assert.deepEqual(normalizeReport(translatedLive), {
  output: nativeLive.output,
  events: nativeLive.events,
  comparisons: nativeLive.comparisons,
  helpers: nativeLive.helpers,
}, 'translated live GObjObjects traversal matches original');

const nativeActorEvents = native.cases.bindActorEvents;
const translatedActorFixture = fixture({ eventResult: false });
const translatedActor = bindActorEventsNative({
  conversation,
  actorToBind: actors.second,
  read: translatedActorFixture.read,
  write: () => {},
  reference: translatedActorFixture.reference,
  bindActor: translatedActorFixture.bindActor,
});
assert.deepEqual(translatedActor.eventCalls.map(call => ({
  event: label(call.event),
  first: label(call.firstActor),
  second: label(call.secondActor),
  // The translated report intentionally keeps the receiver at report level;
  // the native event record carries it on each virtual call.
  conversation: label(call.conversation ?? conversation),
  result: call.result,
})), nativeActorEvents.events,
  'BindActorEvents preserves duplicate actor arguments and ignores bool');

// Exercise the actual AddBoundActor body’s three outcomes through the pure
// translated helper. The native oracle has the same three direct-body cases.
const nativeAdds = native.cases.addBoundActor;
function translatedAdd(initial, actor) {
  const slots = initial.slice();
  addBoundActor(slots, actor, {
    readArray: (array, index) => array[index],
    writeArray: (array, index, value) => { array[index] = value; },
  });
  return slots.map(label);
}
assert.deepEqual(translatedAdd([actors.first, ...Array(9).fill(null)], actors.first),
  nativeAdds.duplicate.after, 'duplicate AddBoundActor path');
assert.deepEqual(translatedAdd([actors.first, ...Array(9).fill(null)], actors.decoration),
  nativeAdds.firstEmpty.after, 'first empty AddBoundActor path');
const fullActors = Array.from({ length: 10 }, (_, index) => ({ name: `full${index}` }));
assert.deepEqual(translatedAdd(fullActors, actors.late),
  nativeAdds.full.after, 'full AddBoundActor path');

console.log('Native ConSys conversation event oracle and translated loops passed: ' +
  '2052 BindEvents name/class/live traversal, 2053 duplicate-actor dispatch, and 10-slot AddBoundActor.');
console.log('Unresolved native boundaries remain explicit: concrete event subclass BindActor bodies, ' +
  'and the FFrame/GNatives exec wrappers.');
