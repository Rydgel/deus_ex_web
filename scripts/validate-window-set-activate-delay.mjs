/** Focused original-evidence validator for ButtonWindow.SetActivateDelay. */
import {
  WINDOW_SET_ACTIVATE_DELAY_NATIVE,
  setActivateDelayNative,
} from '../src/runtime/script-window-set-activate-delay.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-set-activate-delay.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_SET_ACTIVATE_DELAY_NATIVE',
  entry: 'setActivateDelayNative',
  oracleFile: 'native-window-setActivateDelay-oracle.py',
  section: 'setActivateDelay',
  exportPath: 'buttonwindow.setactivatedelay',
  metadataParams: ['newDelay:float'],
  invoke: (fn, receiver, args, world) => fn(receiver, args[0], world.services),
  mutations: [
    {
      find: 'activateDelay: 0x178',
      replace: 'activateDelay: 0x17c',
      note: 'field offset +0x178 -> +0x17c stores the delay in the wrong member',
    },
    {
      find: "offset, 'f32', newDelay, {",
      replace: "offset, 'f32', newDelay + 1, {",
      note: 'stored value newDelay -> newDelay + 1 changes the delay',
    },
  ],
});
