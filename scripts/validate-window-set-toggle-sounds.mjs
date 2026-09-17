/** Focused original-evidence validator for ToggleWindow.SetToggleSounds. */
import {
  WINDOW_SET_TOGGLE_SOUNDS_NATIVE,
  setToggleSoundsNative,
} from '../src/runtime/script-window-set-toggle-sounds.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-set-toggle-sounds.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_SET_TOGGLE_SOUNDS_NATIVE',
  entry: 'setToggleSoundsNative',
  oracleFile: 'native-window-setToggleSounds-oracle.py',
  section: 'setToggleSounds',
  exportPath: 'togglewindow.settogglesounds',
  metadataParams: ['enableSound:object', 'disableSound:object'],
  invoke: (fn, receiver, args, world) =>
    fn(receiver, args[0], args[1], world.services),
  mutations: [
    {
      find: 'enableSound: 0x1ec',
      replace: 'enableSound: 0x1f0',
      note: 'field offset +0x1ec -> +0x1f0 swaps the enable/disable slots',
    },
    {
      find: 'disableSound: 0x1f0',
      replace: 'disableSound: 0x1ec',
      note: 'field offset +0x1f0 -> +0x1ec swaps the disable/enable slots',
    },
  ],
});
