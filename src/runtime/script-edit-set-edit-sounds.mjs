/**
 * Recovered Extension.dll XEditWindow::SetEditSounds translation
 * (method body 0x1001dc70, exec stub 0x100227a0).
 *
 * Four raw dword stores: the sound object arguments go to +0x20c,
 * +0x210, +0x214 and +0x218 in parameter order (typeSound, deleteSound,
 * enterSound, moveSound).  The arguments are opaque dwords here.  The
 * export is void.
 */
import {
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  editMemory,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_SET_EDIT_SOUNDS_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.SetEditSounds',
  packageExport: 968,
  nativeIndex: 1920,
  functionFlags: 0x401,
  serialSize: 40,
  ...EDIT_WINDOW_DLL,
  execBody: 0x100227a0,
  execEnd: 0x10022859,
  execSha256: '07111157e5b8d4fc13525957a100d3672357464b4bb2461c5cf9ba552713bd1d',
  methodBody: 0x1001dc70,
  methodEnd: 0x1001dc9b,
  methodSha256: 'c1c03433c23f7b05aa57f66d2630010cbdf56b742bf43c73667c4b5b2794120c',
});

export class EditWindowSetEditSoundsBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowSetEditSoundsBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowSetEditSoundsBoundaryError(message);
};

export function editWindowSetEditSounds(object, typeSound, deleteSound, enterSound, moveSound, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.SetEditSounds requires a canonical window object');
  }
  const L = editMemory(object, services);
  L.write(L.base + EDIT_WINDOW.sound0, 'u32', typeSound | 0);
  L.write(L.base + EDIT_WINDOW.sound1, 'u32', deleteSound | 0);
  L.write(L.base + EDIT_WINDOW.sound2, 'u32', enterSound | 0);
  L.write(L.base + EDIT_WINDOW.sound3, 'u32', moveSound | 0);
}

export const execEditWindowSetEditSounds = editWindowSetEditSounds;
