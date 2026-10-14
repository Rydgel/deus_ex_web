// A child frame looks through every mirror request merged into it (docs/mirror-surfaces.md "Merged mirror requests"):
// OccludeBsp passes iSurf 0 in each mirror request (Render.dll 0x10b18b4a), so CreateChildFrame (0x10b15a40) merges the
// requests of one parent with equal zone and NearClip, different surfaces included (three coplanar panes, a static
// plane and a mover's polygon). The page used to plan one pass through the group of the request that made the frame,
// so only that group reflected.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { frameGroup, frameGroups, planFramePasses } from '../src/viewer/mirror-passes.mjs';

const mover = key => ({ key, moving: true, matrix: new THREE.Matrix4(), meshes: [] });
const stat = (key, nodes) => ({ key, moving: false, matrix: new THREE.Matrix4(), meshes: [], nodes });

test('a merged frame looks through every request\'s group, in request order', () => {
  const groups = [mover('BreakableGlass0:1'), mover('BreakableGlass5:1'), mover('BreakableGlass17:1')];
  const frame = { index: 1, parent: 0, kind: 'mirror', iNode: 10, group: 'BreakableGlass5:1',
    requests: [{ iNode: 10, group: 'BreakableGlass5:1' }, { iNode: 11, group: 'BreakableGlass17:1' }, { iNode: 12, group: 'BreakableGlass0:1' }] };
  assert.deepEqual(frameGroups(groups, frame).map(g => g.key), ['BreakableGlass5:1', 'BreakableGlass17:1', 'BreakableGlass0:1']);
  assert.equal(frameGroup(groups, frame).key, 'BreakableGlass5:1', 'the first is the request that made the frame');
});

test('a static plane group and a mover polygon share a frame; a group appears once', () => {
  const groups = [stat('plane', [5, 6, 7]), mover('Door:3')];
  const frame = { index: 1, parent: 0, kind: 'mirror', iNode: 5,
    requests: [{ iNode: 5, group: null }, { iNode: 6, group: null }, { iNode: 99, group: 'Door:3' }] };
  assert.deepEqual(frameGroups(groups, frame).map(g => g.key), ['plane', 'Door:3']);
});

test('requests with no supported group are left out; no group at all leaves the frame out', () => {
  const groups = [mover('A:1')];
  const some = { index: 1, parent: 0, kind: 'mirror', iNode: 1, requests: [{ iNode: 1, group: 'Unbuilt:1' }, { iNode: 2, group: 'A:1' }] };
  assert.deepEqual(frameGroups(groups, some).map(g => g.key), ['A:1']);
  assert.equal(frameGroups(groups, { index: 2, parent: 0, kind: 'mirror', iNode: 1, requests: [{ iNode: 1, group: 'Unbuilt:1' }] }), null);
});

test('a frame without requests keeps looking through its own request\'s group', () => {
  const groups = [stat('plane', [5]), mover('A:1')];
  assert.deepEqual(frameGroups(groups, { iNode: 5, group: null }).map(g => g.key), ['plane']);
  assert.deepEqual(frameGroups(groups, { iNode: 1, group: 'A:1' }).map(g => g.key), ['A:1']);
});

test('the plan\'s pass carries every group of its frame and reflects through the first', () => {
  const groups = [mover('P0:1'), mover('P5:1'), mover('P17:1')];
  for (const [i, g] of groups.entries()) { g.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 2054); g.matrix = new THREE.Matrix4().makeScale(1, -1, 1).setPosition(0, i, 0); }
  const source = new THREE.PerspectiveCamera(75, 16 / 9, 1, 50000);
  const frame = { index: 1, parent: 0, kind: 'mirror', iNode: 7, group: 'P5:1', bounds: [100, 200, 900, 400], coords: [], mirror: -1,
    requests: [{ iNode: 7, group: 'P5:1' }, { iNode: 8, group: 'P17:1' }, { iNode: 9, group: 'P0:1' }] };
  const plan = planFramePasses(source, groups, { x: 1280, y: 720 }, [frame]);
  assert.equal(plan.length, 1, 'one frame, one pass');
  assert.deepEqual(plan[0].groups.map(g => g.key), ['P5:1', 'P17:1', 'P0:1']);
  assert.equal(plan[0].group.key, 'P5:1');
});
