import test from 'node:test';
import assert from 'node:assert/strict';
import {typedCharacters} from '../src/viewer/typed-characters.mjs';

test('printable keys produce their UTF-16 units (Unicode viewport window)', () => {
  assert.deepEqual(typedCharacters({key: 'a'}), [0x61]);
  assert.deepEqual(typedCharacters({key: 'A'}), [0x41]);
  assert.deepEqual(typedCharacters({key: ' '}), [0x20]);
  assert.deepEqual(typedCharacters({key: 'é'}), [0xe9]);
  assert.deepEqual(typedCharacters({key: '€'}), [0x20ac]);
  assert.deepEqual(typedCharacters({key: '\u{1f600}'}), [0xd83d, 0xde00]);
});

test('control keys follow TranslateMessage', () => {
  assert.deepEqual(typedCharacters({key: 'Backspace'}), [0x08]);
  assert.deepEqual(typedCharacters({key: 'Backspace', ctrlKey: true}), [0x7f]);
  assert.deepEqual(typedCharacters({key: 'Tab'}), [0x09]);
  assert.deepEqual(typedCharacters({key: 'Tab', ctrlKey: true}), []);
  assert.deepEqual(typedCharacters({key: 'Enter'}), [0x0d]);
  assert.deepEqual(typedCharacters({key: 'Enter', ctrlKey: true}), [0x0a]);
  assert.deepEqual(typedCharacters({key: 'Escape'}), [0x1b]);
  assert.deepEqual(typedCharacters({key: 'c', ctrlKey: true}), [0x03]);
  assert.deepEqual(typedCharacters({key: 'Z', ctrlKey: true}), [0x1a]);
  assert.deepEqual(typedCharacters({key: '[', ctrlKey: true}), [0x1b]);
  assert.deepEqual(typedCharacters({key: '@', ctrlKey: true}), [0x00]);
  assert.deepEqual(typedCharacters({key: '1', ctrlKey: true}), []);
});

test('AltGr and Alt characters are delivered; non-character keys are not', () => {
  assert.deepEqual(typedCharacters({key: '@', ctrlKey: true, altKey: true}), [0x40]);
  assert.deepEqual(typedCharacters({key: 'n', altKey: true}), [0x6e]);
  for (const key of ['Shift', 'ArrowUp', 'F1', 'Dead', 'Process', 'Unidentified', 'Control'])
    assert.deepEqual(typedCharacters({key}), [], key);
  assert.deepEqual(typedCharacters({key: 'a', metaKey: true}), []);
  assert.deepEqual(typedCharacters({key: 'a', isComposing: true}), []);
});
