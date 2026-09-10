import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTOR_SERIALIZE,
  CAMERA_POINT_GC_ARCHIVE_STATE,
  serializeAActor,
  serializeCameraPointActor,
} from '../src/runtime/script-actor-serialization.mjs';

test('CameraPoint AActor::Serialize delegates exactly once to UObject::Serialize', () => {
  const object = { nativeVtable: ACTOR_SERIALIZE.cameraPointVtable };
  const archive = { archiveState: CAMERA_POINT_GC_ARCHIVE_STATE };
  const result = { references: 4 };
  const calls = [];
  const returned = serializeCameraPointActor(object, archive, {
    serializeUObject(current, currentArchive) {
      calls.push([current, currentArchive]);
      return result;
    },
  });

  assert.equal(returned, result);
  assert.deepEqual(calls, [[object, archive]]);
  assert.deepEqual(archive.archiveState, {
    ar0c: 0, ar10: 0, ar14: 0, ar18: 0, ar1c: 1, ar20: 1, ar24: 1,
  });
});

test('serializer rejects an unverified native table or missing base service', () => {
  const object = { nativeVtable: ACTOR_SERIALIZE.cameraPointVtable };
  const archive = {};
  assert.throws(
    () => serializeCameraPointActor(object, archive),
    /requires the verified UObject::Serialize base service/,
  );
  assert.throws(
    () => serializeAActor({ nativeVtable: 0x104290b8 }, archive, {
      serializeUObject() {},
    }),
    /verified Actor native vtables/,
  );
});
