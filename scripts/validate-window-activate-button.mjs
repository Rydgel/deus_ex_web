/** Focused original-evidence validator for ButtonWindow.ActivateButton. */
import {
  WINDOW_ACTIVATE_BUTTON_NATIVE,
  activateButtonNative,
} from '../src/runtime/script-window-activate-button.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-activate-button.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_ACTIVATE_BUTTON_NATIVE',
  entry: 'activateButtonNative',
  oracleFile: 'native-window-activateButton-oracle.py',
  section: 'activateButton',
  exportPath: 'buttonwindow.activatebutton',
  metadataParams: ['Key:byte'],
  invoke: (fn, receiver, args, world) => fn(receiver, args[0], world.services),
  mutations: [
    {
      find: 'activateKey2Slot: 0xec',
      replace: 'activateKey2Slot: 0xe8',
      note: 'key2 slot +0xec -> +0xe8 dispatches the wrong virtual for Key==2',
    },
    {
      find: 'key2: 2',
      replace: 'key2: 3',
      note: 'key selector 2 -> 3 changes which key picks the +0xec slot',
    },
  ],
});
