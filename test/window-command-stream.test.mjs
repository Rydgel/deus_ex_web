import test from 'node:test';
import assert from 'node:assert/strict';
import {HudCommandStream, expandHudStream} from '../src/runtime/script-window-command-stream.mjs';

const tile = (texture, i, color) => ({texture, x: i + 0.5, y: -i, width: 3 * i, height: 7, u: 0, v: -0, ul: i / 3, vl: 1e-30, color, style: i % 5});

test('the stream expands to the tile objects it was given, in order, among the other kinds', () => {
  const stream = new HudCommandStream();
  const a = {key: 'a', package: 'P', index: 1}, b = {key: 'b', dynamic: true, width: 4, height: 4};
  const white = Object.freeze([255, 255, 255]), red = Object.freeze([255, 0, 0]);
  const expected = [];
  for (let frame = 0; frame < 3; frame++) {
    stream.reset();
    expected.length = 0;
    // 700 commands: past two doublings of the 256-command buffer
    for (let i = 0; i < 700; i++) {
      if (i % 97 === 0) { const other = {kind: i % 2 ? 'clearZ' : 'actor', actor: `A${i}`, draw: null}; stream.other(other); expected.push(other); continue; }
      const t = tile(i % 3 ? a : b, i + frame, i % 4 ? white : red);
      stream.tile(t.texture, t.x, t.y, t.width, t.height, t.u, t.v, t.ul, t.vl, t.color, t.style);
      expected.push(t);
    }
    const posted = stream.finish();
    assert.equal(posted.words.length, posted.count * 12, 'the posted words are the exact length');
    assert.equal(posted.textures.length, 2);
    assert.equal(posted.colors.length, 2);
    const commands = expandHudStream(posted);
    assert.equal(commands.length, expected.length);
    for (let i = 0; i < commands.length; i++) {
      assert.deepStrictEqual(commands[i], expected[i], `command ${i} of frame ${frame}`);
      assert.deepEqual(Object.keys(commands[i]), Object.keys(expected[i]), `command ${i} keys in order`);
    }
    assert.ok(Object.is(commands[1].v, -0), '-0 survives');
  }
});

test('a finished stream is not changed by the next frame', () => {
  const stream = new HudCommandStream();
  const texture = {key: 'k', package: 'P', index: 0}, color = [1, 2, 3];
  stream.tile(texture, 1, 2, 3, 4, 5, 6, 7, 8, color, 1);
  const first = stream.finish();
  stream.reset();
  stream.tile(texture, 9, 9, 9, 9, 9, 9, 9, 9, color, 2);
  assert.equal(expandHudStream(first)[0].x, 1);
});
