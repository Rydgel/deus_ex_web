/** Focused original-evidence validator for CheckboxWindow.SetCheckboxSpacing. */
import {
  WINDOW_SET_CHECKBOX_SPACING_NATIVE,
  setCheckboxSpacingNative,
} from '../src/runtime/script-window-set-checkbox-spacing.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-set-checkbox-spacing.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_SET_CHECKBOX_SPACING_NATIVE',
  entry: 'setCheckboxSpacingNative',
  oracleFile: 'native-window-setCheckboxSpacing-oracle.py',
  section: 'setCheckboxSpacing',
  exportPath: 'checkboxwindow.setcheckboxspacing',
  metadataParams: ['newSpacing:float'],
  invoke: (fn, receiver, args, world) => fn(receiver, args[0], world.services),
  mutations: [
    {
      find: 'checkboxSpacing: 0x204',
      replace: 'checkboxSpacing: 0x200',
      note: 'field offset +0x204 -> +0x200 reads/writes the wrong member',
    },
    {
      find: 'if (fcompEqual(current, newSpacing)) return;',
      replace: 'if (current === newSpacing) return;',
      note: 'equality drops the NaN-unordered case — a NaN arg wrongly stores',
    },
  ],
});
