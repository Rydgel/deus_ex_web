/** Focused original-evidence validator for ButtonWindow.SetButtonTextures. */
import {
  WINDOW_SET_BUTTON_TEXTURES_NATIVE,
  setButtonTexturesNative,
} from '../src/runtime/script-window-set-button-textures.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-set-button-textures.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_SET_BUTTON_TEXTURES_NATIVE',
  entry: 'setButtonTexturesNative',
  oracleFile: 'native-window-setButtonTextures-oracle.py',
  section: 'setButtonTextures',
  exportPath: 'buttonwindow.setbuttontextures',
  metadataParams: [
    'Normal:object', 'pressed:object', 'normalFocus:object',
    'pressedFocus:object', 'normalInsensitive:object',
    'pressedInsensitive:object',
  ],
  invoke: (fn, receiver, args, world) =>
    fn(receiver, ...args, world.services),
  mutations: [
    {
      find: 'styleTable: 0x1a4',
      replace: 'styleTable: 0x1a8',
      note: 'style table base +0x1a4 -> +0x1a8 shifts every entry access',
    },
    {
      find: 'toggled: 0x01',
      replace: 'toggled: 0x02',
      note: 'toggle bit 0x01 -> 0x02 corrupts the refresh index',
    },
  ],
});
