/** Focused original-evidence validator for CheckboxWindow.ShowCheckboxOnRightSide. */
import {
  WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_NATIVE,
  showCheckboxOnRightSideNative,
} from '../src/runtime/script-window-show-checkbox-on-right-side.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-show-checkbox-on-right-side.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_NATIVE',
  entry: 'showCheckboxOnRightSideNative',
  oracleFile: 'native-window-showCheckboxOnRightSide-oracle.py',
  section: 'showCheckboxOnRightSide',
  exportPath: 'checkboxwindow.showcheckboxonrightside',
  metadataParams: ['bRight:bool'],
  invoke: (fn, receiver, args, world) => fn(receiver, args[0], world.services),
  mutations: [
    {
      find: 'checkboxFlags: 0x208',
      replace: 'checkboxFlags: 0x204',
      note: 'field offset +0x208 -> +0x204 updates the wrong dword',
    },
    {
      find: 'onRight: 0x01',
      replace: 'onRight: 0x02',
      note: 'flag bit 0x01 -> 0x02 updates the wrong bit',
    },
  ],
});
