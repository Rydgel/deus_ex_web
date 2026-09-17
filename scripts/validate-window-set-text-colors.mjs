/** Focused original-evidence validator for ButtonWindow.SetTextColors. */
import {
  WINDOW_SET_TEXT_COLORS_NATIVE,
  setTextColorsNative,
} from '../src/runtime/script-window-set-text-colors.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-set-text-colors.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_SET_TEXT_COLORS_NATIVE',
  entry: 'setTextColorsNative',
  oracleFile: 'native-window-setTextColors-oracle.py',
  section: 'setTextColors',
  exportPath: 'buttonwindow.settextcolors',
  metadataParams: [
    'Normal:struct', 'pressed:struct', 'normalFocus:struct',
    'pressedFocus:struct', 'normalInsensitive:struct',
    'pressedInsensitive:struct',
  ],
  invoke: (fn, receiver, args, world) =>
    fn(receiver, ...args, world.services),
  mutations: [
    {
      find: 'F.styleTable + index * 12 + 8',
      replace: 'F.styleTable + index * 12 + 4',
      note: 'textColor slot entry+8 -> entry+4 stores over the color',
    },
    {
      find: 'activeTextColor: 0x18c',
      replace: 'activeTextColor: 0x188',
      note: 'active textColor write +0x18c -> +0x188 corrupts the refresh',
    },
  ],
});
