/** Focused original-evidence validator for ButtonWindow.EnableAutoRepeat. */
import {
  WINDOW_ENABLE_AUTO_REPEAT_NATIVE,
  enableAutoRepeatNative,
} from '../src/runtime/script-window-enable-auto-repeat.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-enable-auto-repeat.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_ENABLE_AUTO_REPEAT_NATIVE',
  entry: 'enableAutoRepeatNative',
  oracleFile: 'native-window-enableAutoRepeat-oracle.py',
  section: 'enableAutoRepeat',
  exportPath: 'buttonwindow.enableautorepeat',
  metadataParams: ['bEnable:bool', 'initialDelay:float', 'repeatRate:float'],
  invoke: (fn, receiver, args, world) =>
    fn(receiver, args[0], args[1], args[2], world.services),
  mutations: [
    {
      find: 'autoRepeat: 0x04',
      replace: 'autoRepeat: 0x08',
      note: 'flag bit 0x04 -> 0x08 updates the right-click bit instead',
    },
    {
      find: 'repeatRate: 0x180',
      replace: 'repeatRate: 0x184',
      note: 'field offset +0x180 -> +0x184 stores the rate in the wrong member',
    },
  ],
});
