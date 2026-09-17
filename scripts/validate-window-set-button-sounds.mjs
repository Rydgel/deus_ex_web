/** Focused original-evidence validator for ButtonWindow.SetButtonSounds. */
import {
  WINDOW_SET_BUTTON_SOUNDS_NATIVE,
  setButtonSoundsNative,
} from '../src/runtime/script-window-set-button-sounds.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-set-button-sounds.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_SET_BUTTON_SOUNDS_NATIVE',
  entry: 'setButtonSoundsNative',
  oracleFile: 'native-window-setButtonSounds-oracle.py',
  section: 'setButtonSounds',
  exportPath: 'buttonwindow.setbuttonsounds',
  metadataParams: ['pressSound:object', 'clickSound:object'],
  invoke: (fn, receiver, args, world) =>
    fn(receiver, args[0], args[1], world.services),
  mutations: [
    {
      find: 'pressSound: 0x190',
      replace: 'pressSound: 0x194',
      note: 'field offset +0x190 -> +0x194 swaps the press/click slots',
    },
    {
      find: 'clickSound: 0x194',
      replace: 'clickSound: 0x190',
      note: 'field offset +0x194 -> +0x190 swaps the click/press slots',
    },
  ],
});
