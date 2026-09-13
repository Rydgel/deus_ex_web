import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SOUND_LIFECYCLE_CONTRACT,
  UnsupportedSoundLifecycleError,
  deleteSoundLifecycle,
  destroySoundDataLifecycle,
  destroySoundLifecycle,
  serializeSoundHelperLifecycle,
  serializeSoundLifecycle,
} from '../src/runtime/script-sound-lifecycle.mjs';

function sound({archive = null, data = 0x2000, num = 4, max = 8} = {}) {
  return {
    vtable: 0,
    formatName: {index: 1, name: 'wav'},
    serializedByteCount: num,
    allocationHeader: 0x1ff0,
    allocationCount: 1,
    soundData: {
      vtable: 0,
      archive,
      array: {data, num, max},
    },
  };
}

function names(operations) {
  return operations.map(operation => operation.operation);
}

test('lifecycle contract pins original serializer and destructor addresses', () => {
  assert.equal(SOUND_LIFECYCLE_CONTRACT.serializer.body, 0x1036f900);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.serializer.helperBody, 0x10371140);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.serializer.loadByteCountCopy, 0x1036f4db);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.destructor.soundBody, 0x1031cb60);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.destructor.soundDataBody, 0x1030ca50);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.destructor.archiveVtable, 0x10177640);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.destructor.archiveBaseVtable, 0x101751f8);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.destructor.archiveAttachThunk, 0x10101325);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.destructor.archiveDetachThunk, 0x101022d4);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.destructor.archiveDetachSlot, 0x3c);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.destructor.arrayRemoveIat, 0x10599a18);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.destructor.allocatorGlobalIat, 0x10599a94);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.destructor.scalarSize, 0x54);
  assert.equal(SOUND_LIFECYCLE_CONTRACT.destructor.allocationCookieOffset, -4);
});

test('USound Serialize calls UObject, FName and CountBytes in the no-helper branch', () => {
  const events = [], calls = [], object = sound({num: 17, max: 24});
  const archive = {ar0c: 0, ar10: 0, version: 68, serializationFlag: 9};
  const services = {
    trace: events,
    uobjectSerialize: (value, currentArchive) => {
      calls.push(['uobject', value, currentArchive]);
      assert.equal(currentArchive, archive);
      assert.equal(archive.serializationFlag, 1);
    },
    serializeName: (reference, currentArchive) => {
      calls.push(['name', reference, currentArchive]);
      assert.equal(reference.get(), object.formatName);
      assert.equal(reference.value, object.formatName);
      assert.equal(typeof reference.set, 'function');
      reference.set({index: 2, name: 'ogg'});
    },
    countBytes: (currentArchive, count, maximum, details) => {
      calls.push(['count', count, maximum, details]);
      assert.equal(currentArchive, archive);
      assert.equal(count, 17);
      assert.equal(maximum, 17);
    },
  };
  const result = serializeSoundLifecycle(object, archive, services);
  assert.equal(archive.serializationFlag, 9);
  assert.deepEqual(calls.map(call => call[0]), ['uobject', 'name', 'count']);
  assert.deepEqual(names(result.operations), [
    'serialization-flag-set', 'uobject-serialize', 'archive-serialize-name',
    'sound-archive-gates', 'archive-count-bytes', 'serialization-flag-restore',
  ]);
  assert.equal(result.branch.branch, 'count-bytes');
  assert.equal(result.branch.byteCount, 17);
  assert.deepEqual(object.formatName, {index: 2, name: 'ogg'});
  assert.equal(result.operations[4].slot, 0x14);
  assert.equal(result.operations[4].fieldOffset, 0x48);
});

test('old and new archive+0x0c helper paths preserve Attach, offset and Seek order', () => {
  const oldEvents = [], oldCalls = [], oldSound = sound({num: 3});
  const oldArchive = {ar0c: 1, ar10: 0, version: 61, serializationFlag: 5};
  const oldServices = {
    trace: oldEvents,
    uobjectSerialize: () => oldCalls.push('uobject'),
    serializeName: reference => {
      oldCalls.push('name');
      assert.equal(reference.get(), oldSound.formatName);
    },
    attachLazyLoader: (archive, data) => {
      oldCalls.push('attach');
      assert.equal(archive, oldArchive);
      assert.equal(data, oldSound.soundData);
    },
    serializeCompact: (archive, holder) => {
      oldCalls.push('compact');
      holder.value = 6;
    },
    tell: () => {
      oldCalls.push('tell');
      return 100;
    },
    seek: (archive, offset) => {
      oldCalls.push(['seek', offset]);
    },
  };
  const oldResult = serializeSoundLifecycle(oldSound, oldArchive, oldServices);
  assert.deepEqual(oldCalls, ['uobject', 'name', 'attach', 'compact', 'tell', ['seek', 106]]);
  assert.equal(oldResult.branch.format, 'compact-offset');
  assert.equal(oldResult.branch.offset, 106);
  assert.equal(oldArchive.serializationFlag, 5);
  assert.deepEqual(names(oldEvents), [
    'serialization-flag-set', 'uobject-serialize', 'archive-serialize-name',
    'sound-archive-gates', 'sound-helper', 'archive-attach-lazy-loader',
    'archive-serialize-compact', 'archive-tell', 'sound-lazy-offset-add',
    'sound-data-load-skipped', 'archive-seek', 'serialization-flag-restore',
  ]);

  const newEvents = [], newCalls = [], newSound = sound({num: 2});
  const newArchive = {ar0c: 1, ar10: 0, version: 68, serializationFlag: 4};
  const newServices = {
    trace: newEvents,
    uobjectSerialize: () => newCalls.push('uobject'),
    serializeName: reference => {
      newCalls.push('name');
      assert.equal(reference.get(), newSound.formatName);
    },
    serializeRaw: (archive, holder, width, details) => {
      newCalls.push(['raw', width, details.target]);
      assert.equal(width, 4);
      holder.value = 0x500;
    },
    attachLazyLoader: () => newCalls.push('attach'),
    seek: (archive, offset) => newCalls.push(['seek', offset]),
  };
  const newResult = serializeSoundLifecycle(newSound, newArchive, newServices);
  assert.deepEqual(newCalls, [
    'uobject', 'name', ['raw', 4, 'lazy-offset'], 'attach', ['seek', 0x500],
  ]);
  assert.equal(newResult.branch.format, 'raw-offset');
  assert.equal(newResult.branch.offset, 0x500);
  assert.equal(newArchive.serializationFlag, 4);
  assert.equal(newEvents.filter(event => event.operation === 'sound-data-load-skipped').length, 1);
});

test('archive+0x10 version 68 transfers both offsets around the generic array helper', () => {
  const events = [], calls = [], object = sound({data: 0x2400, num: 4, max: 8});
  const archive = {ar0c: 0, ar10: 1, version: 68, serializationFlag: 0};
  let tells = 0;
  const services = {
    trace: events,
    uobjectSerialize: () => calls.push('uobject'),
    serializeName: () => calls.push('name'),
    tell: () => {
      calls.push('tell');
      return tells++ === 0 ? 100 : 220;
    },
    serializeRaw: (currentArchive, holder, width, details) => {
      calls.push(['raw', width, details.target]);
      if (details.target === 'first-offset') holder.value = 0x180;
      else if (details.target === 'second-offset') holder.value = 0x2c0;
      // Generic-array data transfer starts from the native data pointer.
    },
    countBytes: (currentArchive, count, maximum) => calls.push(['count', count, maximum]),
    // Preserve the native by-reference holder.  Array#push returns a number;
    // returning that value would incorrectly replace CompactIndex's value.
    serializeCompact: (currentArchive, holder) => {
      calls.push(['compact', holder.value]);
    },
    seek: (currentArchive, offset) => calls.push(['seek', offset]),
  };
  const result = serializeSoundLifecycle(object, archive, services);
  assert.deepEqual(calls, [
    'uobject', 'name', 'tell', ['raw', 4, 'first-offset'],
    ['count', 4, 8], ['compact', 4], ['raw', 4, 'TArray.Data'],
    'tell', ['seek', 100], ['raw', 4, 'second-offset'], ['seek', 0x2c0],
  ]);
  assert.equal(result.branch.format, 'array-with-two-raw-offsets');
  assert.deepEqual({
    firstTell: result.branch.firstTell,
    firstOffset: result.branch.firstOffset,
    secondTell: result.branch.secondTell,
    secondOffset: result.branch.secondOffset,
  }, {firstTell: 100, firstOffset: 0x180, secondTell: 220, secondOffset: 0x2c0});
  assert.deepEqual(names(events).filter(name => name.startsWith('archive-') || name.startsWith('sound-generic')),
    ['archive-serialize-name', 'archive-tell', 'archive-serialize-raw',
      'sound-generic-array-helper', 'archive-count-bytes',
      'archive-serialize-compact', 'archive-serialize-raw', 'archive-tell',
      'archive-seek', 'archive-serialize-raw', 'archive-seek']);
  assert.equal(archive.serializationFlag, 0);
});

test('direct helper delegates Load field writes before seeking to the lazy end', () => {
  const events = [], calls = [], object = sound({num: 0, max: 0});
  const archive = {ar0c: 1, ar10: 0, version: 68, serializationFlag: 0};
  const services = {
    trace: events,
    serializeRaw: (currentArchive, holder, width) => {
      calls.push(['raw', width]);
      holder.value = 0x800;
    },
    attachLazyLoader: () => calls.push('attach'),
    loadSoundData: data => {
      calls.push('load');
      data.array.num = 13;
      data.array.max = 13;
    },
    seek: (currentArchive, offset) => calls.push(['seek', offset]),
  };
  const result = serializeSoundHelperLifecycle(object, archive, services);
  assert.deepEqual(calls, [['raw', 4], 'attach', 'load', ['seek', 0x800]]);
  assert.equal(object.serializedByteCount, 0);
  assert.equal(result.branch.offset, 0x800);
  assert.equal(events.some(event => event.operation === 'sound-byte-count-copy'), false);
});

test('helper gate reads archive+0x10 only after archive+0x0c is zero', () => {
  const reads = [], object = sound({num: 1, max: 1});
  const archive = {serializationFlag: 1};
  const result = serializeSoundHelperLifecycle(object, archive, {
    readArchiveWord: (currentArchive, offset) => {
      reads.push(offset);
      if (offset === 0x0c) return 1;
      if (offset === 0x04) return 68;
      throw new Error(`unexpected archive read +0x${offset.toString(16)}`);
    },
    serializeRaw: (currentArchive, holder, width) => {
      assert.equal(width, 4);
      holder.value = 0x340;
    },
    attachLazyLoader: () => {},
    seek: () => {},
  });
  assert.deepEqual(reads, [0x0c, 0x04]);
  assert.equal(result.branch.offset, 0x340);
});

test('complete USound destruction detaches its archive owner, removes storage and reaches UObject base', () => {
  const events = [], calls = [], archiveOwner = {kind: 'archive'};
  const object = sound({archive: archiveOwner, data: 0x2a00, num: 7, max: 9});
  const services = {
    trace: events,
    conditionalDestroy: (value, details) => {
      calls.push(['conditional', value, details.argument]);
      assert.equal(value.vtable, SOUND_LIFECYCLE_CONTRACT.layout.soundVtable);
    },
    detachLazyLoader: (archive, data, details) => {
      calls.push(['detach', archive, data, details.slot]);
      assert.equal(data.vtable, SOUND_LIFECYCLE_CONTRACT.layout.soundDataBaseDestructorVtable);
      assert.equal(archive, archiveOwner);
      assert.equal(details.address, SOUND_LIFECYCLE_CONTRACT.destructor.archiveDetachThunk);
    },
    arrayRemove: (array, index, count, elementSize, details) => {
      calls.push(['remove', index, count, elementSize, details.address]);
      array.num = 0;
    },
    allocatorFree: (pointer, details) => calls.push(['free', pointer, details.slot]),
    baseDestructor: (value, details) => {
      calls.push(['base', value, details.argument]);
      assert.equal(value.soundData.array.data, 0);
      assert.equal(value.soundData.array.num, 0);
      assert.equal(value.soundData.array.max, 0);
    },
  };
  const result = destroySoundLifecycle(object, services);
  assert.deepEqual(calls.map(call => call[0]), ['conditional', 'detach', 'remove', 'free', 'base']);
  assert.deepEqual(object.soundData.array, {data: 0, num: 0, max: 0});
  assert.equal(object.vtable, SOUND_LIFECYCLE_CONTRACT.layout.soundVtable);
  assert.equal(object.soundData.vtable, SOUND_LIFECYCLE_CONTRACT.layout.soundDataBaseDestructorVtable);
  assert.deepEqual(names(result.operations), [
    'sound-vtable-write', 'conditional-destroy', 'sound-data-vtable-write',
    'archive-detach-lazy-loader', 'array-remove', 'array-allocator-free',
    'array-clear-data', 'array-clear-max', 'array-clear-num',
    'uobject-base-destructor',
  ]);
  assert.equal(events.find(event => event.operation === 'array-remove').count, 7);
  assert.equal(events.find(event => event.operation === 'array-allocator-free').pointer, 0x2a00);
  assert.equal(events.find(event => event.operation === 'archive-detach-lazy-loader').slot,
    SOUND_LIFECYCLE_CONTRACT.destructor.archiveDetachSlot);
  assert.equal(result.soundData.archiveOwner, archiveOwner);
});

test('FSoundData null archive-owner branch skips only DetachLazyLoader', () => {
  const calls = [], data = sound({archive: null, data: 0, num: 0, max: 0}).soundData;
  destroySoundDataLifecycle(data, {
    arrayRemove: () => calls.push('remove'),
  });
  // FSoundData destruction has no UObject base call; only array cleanup is
  // represented by this public entry point.
  assert.deepEqual(calls, ['remove']);
});

test('missing reached lifecycle services fail explicitly and preserve native exception flag state', () => {
  const object = sound({archive: {}});
  const archive = {ar0c: 0, ar10: 0, version: 68, serializationFlag: 3};
  assert.throws(() => serializeSoundLifecycle(object, archive, {
    uobjectSerialize: () => {},
  }), error => {
    assert.ok(error instanceof UnsupportedSoundLifecycleError);
    assert.equal(error.operation, 'FArchive::operator<<(FName&)');
    return true;
  });
  // The recovered Engine exception landing path has no visible write through
  // GLazyLoad; only the normal epilogue restores the saved value.
  assert.equal(archive.serializationFlag, 1);

  assert.throws(() => destroySoundLifecycle(object, {
    conditionalDestroy: () => {},
  }), error => {
    assert.ok(error instanceof UnsupportedSoundLifecycleError);
    assert.equal(error.operation, 'FArchive::DetachLazyLoader');
    return true;
  });
});

test('deleting-wrapper preserves scalar and unresolved array branches', () => {
  const scalarCalls = [], scalar = sound({data: 0, num: 0, max: 0});
  const scalarServices = {
    conditionalDestroy: () => scalarCalls.push('conditional'),
    arrayRemove: () => scalarCalls.push('remove'),
    baseDestructor: () => scalarCalls.push('base'),
    objectFree: (value, size, details) => scalarCalls.push(['object-free', value, size, details.address]),
  };
  const scalarResult = deleteSoundLifecycle(scalar, 1, scalarServices);
  assert.deepEqual(scalarCalls, ['conditional', 'remove', 'base', ['object-free', scalar, 0x54, 0x10599ab4]]);
  assert.equal(scalarResult.branch, 'scalar');

  const arrayCalls = [], array = sound({data: 0, num: 0, max: 0});
  const arrayResult = deleteSoundLifecycle(array, 2, {
    allocationCount: () => 3,
    arrayDestructor: (value, size, count, thunk, details) => {
      arrayCalls.push(['array', value, size, count, thunk, details.address]);
    },
  });
  assert.deepEqual(arrayCalls, [['array', array, 0x54, 3, 0x10303a5d, 0x104134d6]]);
  assert.equal(arrayResult.branch, 'array');
  assert.equal(arrayResult.returnedPointer, 0x1ff0);
  assert.equal(arrayResult.allocationCount, 3);

  assert.throws(() => deleteSoundLifecycle(sound(), 2, {
    allocationHeader: () => 0x1ff0,
  }), error => {
    assert.ok(error instanceof UnsupportedSoundLifecycleError);
    assert.equal(error.operation, 'Engine array destruction helper');
    return true;
  });
});
