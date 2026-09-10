import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_OBJECT_CONFIG,
  UnsupportedScriptObjectConfigError,
  loadScriptConfig,
  loadScriptLocalized,
} from '../src/runtime/script-object-config.mjs';

test('LoadConfig/LoadLocalized preserve native gates, recursion, and branch-local callbacks', () => {
  assert.equal(SCRIPT_OBJECT_CONFIG.config.body, 0x10150d60);
  assert.equal(SCRIPT_OBJECT_CONFIG.localized.body, 0x10151390);

  const noIo = {index: -1};
  const noIoClass = {name: 'NoIO', classFlags: 0, children: [{name: 'Ignored', propertyFlags: 0x4000, arrayDim: 1}]};
  assert.equal(loadScriptConfig(noIo, 0, noIoClass, 0).skipped.reason, 'class-flag');
  assert.equal(loadScriptLocalized(noIo, 0, noIoClass, {
    readGlobal: () => { throw new Error('localized global must not be read behind class gate'); },
  }).skipped.reason, 'class-flag');

  const emptyClass = {name: 'Empty', classFlags: 0x24, children: []};
  assert.equal(loadScriptConfig(noIo, 0, emptyClass, 0).skipped.reason, 'empty-config-properties');
  assert.equal(loadScriptLocalized(noIo, 0, emptyClass, {
    readGlobal: () => 0,
  }).skipped.reason, 'empty-localized-properties');

  const parent = {
    name: 'Parent', classFlags: 0x4, configName: 'System',
    superClass: null,
    sectionName: 'Parent',
    children: [{name: 'ParentValue', isProperty: true, propertyFlags: 0x4000, arrayDim: 1}],
  };
  const child = {
    name: 'Child', classFlags: 0x4, configName: 'System', sectionName: 'Child', superClass: parent,
    children: [{name: 'ChildValue', isProperty: true, propertyFlags: 0x4000, arrayDim: 1}],
  };
  const events = [];
  const config = loadScriptConfig({index: -1}, 1, child, 0, {
    walkProperties: record => record.children,
    configBranch: () => 'array-helper',
    readConfigProperty(detail) {
      events.push(['read-config', detail.classRecord.name, detail.propertyName, detail.branch, detail.manager, detail.helper]);
      return {found: true, value: detail.propertyName === 'ParentValue' ? '2' : '1'};
    },
    propertyDestination: (_object, property) => ({property}),
    importConfigProperty(detail) {
      events.push(['import-config', detail.propertyName, detail.arguments]);
    },
  });
  assert.deepEqual(events.map(event => event[0]), ['read-config', 'import-config', 'read-config', 'import-config']);
  assert.deepEqual(events.filter(event => event[0] === 'read-config').map(event => event[1]), ['Parent', 'Child']);
  assert.equal(events[0][3], 'array-helper');
  assert.equal(events[0][5].body, 0x1010a2d0);
  assert.deepEqual(events[1][2], ['2', {property: parent.children[0]}, 0]);
  assert.equal(config.recursive.length, 1);

  const localizedProperty = {name: 'Caption', isProperty: true, propertyFlags: 0x8000, arrayDim: 2};
  const localizedEvents = [];
  const localized = loadScriptLocalized({index: -1}, 0, {
    name: 'LocalizedClass', classFlags: 0x20, children: [localizedProperty],
  }, {
    readGlobal(address) {
      localizedEvents.push(['global', address]);
      return 0;
    },
    resolveLocalizedNames: () => ({sectionName: 'LocalizedClass', packageName: 'Core'}),
    localize(detail) {
      localizedEvents.push(['localize', detail.arguments]);
      return detail.arrayIndex === 0 ? '' : 'Bonjour';
    },
    propertyDestination: (_object, property, index) => ({property, index}),
    importLocalizedProperty(detail) {
      localizedEvents.push(['import', detail.arguments]);
    },
  });
  assert.deepEqual(localizedEvents[0], ['global', 0x101e5544]);
  assert.deepEqual(localizedEvents[1][1], ['LocalizedClass', 'Caption[0]', 'Core', 0, 1]);
  assert.deepEqual(localizedEvents[2][1], ['LocalizedClass', 'Caption[1]', 'Core', 0, 1]);
  assert.deepEqual(localizedEvents[3], ['import', ['Bonjour', {property: localizedProperty, index: 1}, 0]]);
  assert.equal(localized.properties.length, 1);
  assert.equal(localized.properties[0].arrayIndex, 1);

  let linkGateGetterReads = 0;
  const liveGateServices = {};
  Object.defineProperty(liveGateServices, 'globalLinkGate', {
    get() {
      linkGateGetterReads += 1;
      return () => 0;
    },
  });
  const liveGate = loadScriptLocalized({index: -1}, 0, {
    classFlags: 0x20, superClass: null, children: [],
  }, liveGateServices);
  assert.equal(liveGate.skipped.reason, 'empty-localized-properties');
  assert.equal(linkGateGetterReads, 1);
  const recursiveGate = loadScriptLocalized({index: -1}, 1, {
    classFlags: 0x20, superClass: {classFlags: 0x20, superClass: null, children: []}, children: [],
  }, liveGateServices);
  assert.equal(recursiveGate.recursive.length, 1);
  assert.equal(linkGateGetterReads, 3);

  const liveSecond = {name: 'LiveSecond', isProperty: true, propertyFlags: 0x4000, arrayDim: 1, next: null};
  const liveFirst = {
    name: 'LiveFirst', isProperty: true, propertyFlags: 0x4000, arrayDim: 1,
    configBranch: 'manager', next: liveSecond,
  };
  const liveReads = [];
  const liveWalk = loadScriptConfig({index: -1}, 0, {
    classFlags: 0x4, superClass: null, configName: 'System', sectionName: 'Live',
    children: liveFirst,
  }, 0, {
    readConfigProperty(detail) {
      liveReads.push(detail.propertyName);
      // Native reads +0x2c only after this property returns.
      liveFirst.next = null;
      return {found: false};
    },
  });
  assert.deepEqual(liveReads, ['LiveFirst']);
  assert.equal(liveWalk.skipped, null);

  assert.throws(() => loadScriptLocalized({index: -1}, 0, {
    name: 'NeedsNames', classFlags: 0x20, children: [localizedProperty],
  }, {readGlobal: () => 0, localize: () => 'x'}), error =>
    error instanceof UnsupportedScriptObjectConfigError && /name/.test(error.message));
});
