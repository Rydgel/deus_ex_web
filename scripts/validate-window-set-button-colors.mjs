/** Focused original-evidence validator for ButtonWindow.SetButtonColors. */
import {
  WINDOW_SET_BUTTON_COLORS_NATIVE,
  setButtonColorsNative,
} from '../src/runtime/script-window-set-button-colors.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-set-button-colors.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_SET_BUTTON_COLORS_NATIVE',
  entry: 'setButtonColorsNative',
  oracleFile: 'native-window-setButtonColors-oracle.py',
  section: 'setButtonColors',
  exportPath: 'buttonwindow.setbuttoncolors',
  metadataParams: [
    'Normal:struct', 'pressed:struct', 'normalFocus:struct',
    'pressedFocus:struct', 'normalInsensitive:struct',
    'pressedInsensitive:struct',
  ],
  invoke: (fn, receiver, args, world) =>
    fn(receiver, ...args, world.services),
  mutations: [
    {
      find: 'F.styleTable + index * 12 + 4',
      replace: 'F.styleTable + index * 12',
      note: 'color slot entry+4 -> entry+0 stores over the texture pointer',
    },
    {
      find: 'sensitive: 0x02',
      replace: 'sensitive: 0x04',
      note: 'sensitivity bit 0x02 -> 0x04 breaks the ancestor walk',
    },
  ],
});
