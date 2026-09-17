/** Focused original-evidence validator for Window.IsKeyDown. */
import {
  WINDOW_IS_KEY_DOWN_NATIVE,
  isKeyDownNative,
} from '../src/runtime/script-window-is-key-down.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-is-key-down.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_IS_KEY_DOWN_NATIVE',
  entry: 'isKeyDownNative',
  oracleFile: 'native-window-isKeyDown-oracle.py',
  section: 'isKeyDown',
  exportPath: 'window.iskeydown',
  metadataParams: ['Key:byte', 'ReturnValue:bool'],
  invoke: (fn, receiver, args, world) => fn(receiver, args[0], world.services),
  mutations: [
    {
      find: 'keyStateBase: 0x630',
      replace: 'keyStateBase: 0x640',
      note: 'key-state base +0x630 -> +0x640 reads the wrong byte index',
    },
    {
      find: 'rootWindowType: 3',
      replace: 'rootWindowType: 4',
      note: 'root type bound 3 -> 4 rejects valid type-3 roots',
    },
  ],
});
