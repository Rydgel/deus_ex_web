/** Focused original-evidence validator for CheckboxWindow.SetCheckboxColor. */
import {
  WINDOW_SET_CHECKBOX_COLOR_NATIVE,
  setCheckboxColorNative,
} from '../src/runtime/script-window-set-checkbox-color.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-set-checkbox-color.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_SET_CHECKBOX_COLOR_NATIVE',
  entry: 'setCheckboxColorNative',
  oracleFile: 'native-window-setCheckboxColor-oracle.py',
  section: 'setCheckboxColor',
  exportPath: 'checkboxwindow.setcheckboxcolor',
  metadataParams: ['NewColor:struct'],
  invoke: (fn, receiver, args, world) => fn(receiver, args[0], world.services),
  mutations: [
    {
      find: 'checkboxColor: 0x20d',
      replace: 'checkboxColor: 0x20c',
      note: 'field offset +0x20d -> +0x20c writes the color over the style byte',
    },
    {
      find: "offset, 'u32', newColor, {",
      replace: "offset, 'u32', newColor ^ 0xff, {",
      note: 'stored value NewColor -> NewColor ^ 0xff changes the color dword',
    },
  ],
});
