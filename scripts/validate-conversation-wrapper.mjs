import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {bindActorConversations} from '../src/runtime/script-conversation-wrapper.mjs';

const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const oracle = fileURLToPath(new URL('./native-conversation-wrapper-oracle.py', import.meta.url));
const original = JSON.parse(execFileSync(python, [oracle, gameDirectory()], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
}));

assert.equal(original.hashes['DeusEx.dll'],
  'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04');
assert.deepEqual(original.bodies, {
  Player: '0x10014320', Decoration: '0x1000ea50', ScriptedPawn: '0x10019140',
});
assert.equal(original.results.length, 21);

function expectedNativeOperations(item) {
  if (item.case === 'missing-level-info') return ['logf'];
  if (item.case === 'negative-mission') return [];
  const operations = ['stricmp', 'strcpy', 'sprintf', 'sprintf', 'staticLoadObject'];
  if (item.loaded) operations.push('bindConversations');
  return operations;
}

function buildActor(item) {
  const receiver = {kind: 'receiver'};
  const actors = item.case === 'missing-level-info'
    ? [null, {kind: 'generic'}]
    : item.case === 'default-package-alias-case-insensitive'
      ? [{kind: 'generic'}, {kind: 'level-info-subclass', levelInfo: true}]
      : item.case === 'negative-mission'
        ? [{kind: 'generic'}, {kind: 'level-info', levelInfo: true}]
        : item.case === 'empty-package'
          ? [{kind: 'level-info', levelInfo: true}]
          : [{kind: 'generic'}, {kind: 'level-info', levelInfo: true}];
  receiver.XLevel = {actors};
  const info = actors.find(candidate => candidate?.levelInfo);
  if (info) {
    info.missionNumber = item.mission;
    info.ConversationPackage = item.package;
  }
  return {receiver, info};
}

function runTranslation(item) {
  const {receiver, info} = buildActor(item);
  const events = [];
  const list = {kind: 'ConversationList'};
  bindActorConversations(receiver, {
    levelFor: actor => {
      assert.equal(actor, receiver);
      return actor.XLevel;
    },
    isLevelInfo: candidate => Boolean(candidate?.levelInfo),
    read: (object, field) => {
      if (!info || object !== info) throw new Error(`unexpected native field read ${field}`);
      return object[field];
    },
    log: message => events.push({op: 'logf', message}),
    load: args => {
      events.push({op: 'staticLoadObject', ...args, loaded: item.loaded});
      return item.loaded ? list : null;
    },
    bind: (loadedList, actor) => {
      assert.equal(loadedList, list);
      assert.equal(actor, receiver);
      events.push({op: 'bindConversations', list: 'loaded', actor: 'receiver'});
    },
  });
  return events;
}

for (const item of original.results) {
  // The body itself must perform the complete imported call sequence.  This
  // assertion catches a probe that merely returns a guessed path or bypasses
  // the original CRT/log/load/bind boundaries.
  assert.deepEqual(item.events.map(event => event.op), expectedNativeOperations(item),
    `${item.body}/${item.case} native call order`);

  // The JavaScript contract intentionally exposes only the host services. Its
  // observable operations therefore correspond to the native log/load/bind
  // events after the original's internal string helpers have completed.
  const nativeHostEvents = item.events.filter(event =>
    event.op === 'logf' || event.op === 'staticLoadObject' || event.op === 'bindConversations')
    .map(event => event.op === 'staticLoadObject'
      ? {...event, classKey: event.class, class: undefined}
      : event);
  nativeHostEvents.forEach(event => { if (event.class === undefined) delete event.class; });
  assert.deepEqual(runTranslation(item), nativeHostEvents,
    `${item.body}/${item.case} translation parity`);
}

console.log('Original DeusEx ConBindEvents Player/Decoration/ScriptedPawn bodies passed missing-info, negative-mission, alias, custom-prefix, empty-package, null-load, subclass, and host call-order parity cases.');
