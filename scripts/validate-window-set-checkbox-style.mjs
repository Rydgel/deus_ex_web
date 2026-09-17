/** Focused original-evidence validator for CheckboxWindow.SetCheckboxStyle. */
import {
  WINDOW_SET_CHECKBOX_STYLE_NATIVE,
  setCheckboxStyleNative,
} from '../src/runtime/script-window-set-checkbox-style.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-set-checkbox-style.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_SET_CHECKBOX_STYLE_NATIVE',
  entry: 'setCheckboxStyleNative',
  oracleFile: 'native-window-setCheckboxStyle-oracle.py',
  section: 'setCheckboxStyle',
  exportPath: 'checkboxwindow.setcheckboxstyle',
  metadataParams: ['NewStyle:byte'],
  invoke: (fn, receiver, args, world) => fn(receiver, args[0], world.services),
  mutations: [
    {
      find: 'checkboxStyle: 0x20c',
      replace: 'checkboxStyle: 0x20d',
      note: 'field offset +0x20c -> +0x20d writes the style byte over the color',
    },
    {
      find: "offset, 'u8', newStyle, {",
      replace: "offset, 'u8', newStyle + 1, {",
      note: 'stored value NewStyle -> NewStyle + 1 changes the style byte',
    },
  ],
});
