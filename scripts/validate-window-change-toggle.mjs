/** Focused original-evidence validator for ToggleWindow.ChangeToggle. */
import {
  WINDOW_CHANGE_TOGGLE_NATIVE,
  changeToggleNative,
} from '../src/runtime/script-window-change-toggle.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-change-toggle.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_CHANGE_TOGGLE_NATIVE',
  entry: 'changeToggleNative',
  oracleFile: 'native-window-changeToggle-oracle.py',
  section: 'changeToggle',
  exportPath: 'togglewindow.changetoggle',
  metadataParams: [],
  invoke: (fn, receiver, args, world) => fn(receiver, world.services),
  mutations: [
    {
      find: 'toggleFlags: 0x174',
      replace: 'toggleFlags: 0x178',
      note: 'toggle bit source +0x174 -> +0x178 reports the wrong toggle value',
    },
    {
      find: 'notifySlot: 0xf0',
      replace: 'notifySlot: 0xec',
      note: 'notify virtual slot +0xf0 -> +0xec dispatches the wrong callback',
    },
  ],
});
