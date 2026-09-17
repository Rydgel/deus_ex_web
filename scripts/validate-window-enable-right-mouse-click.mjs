/** Focused original-evidence validator for ButtonWindow.EnableRightMouseClick. */
import {
  WINDOW_ENABLE_RIGHT_MOUSE_CLICK_NATIVE,
  enableRightMouseClickNative,
} from '../src/runtime/script-window-enable-right-mouse-click.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-enable-right-mouse-click.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_ENABLE_RIGHT_MOUSE_CLICK_NATIVE',
  entry: 'enableRightMouseClickNative',
  oracleFile: 'native-window-enableRightMouseClick-oracle.py',
  section: 'enableRightMouseClick',
  exportPath: 'buttonwindow.enablerightmouseclick',
  metadataParams: ['bEnable:bool'],
  invoke: (fn, receiver, args, world) => fn(receiver, args[0], world.services),
  mutations: [
    {
      find: 'rightMouseClick: 0x08',
      replace: 'rightMouseClick: 0x04',
      note: 'flag bit 0x08 -> 0x04 updates the auto-repeat bit instead',
    },
    {
      find: 'buttonFlags: 0x174',
      replace: 'buttonFlags: 0x178',
      note: 'field offset +0x174 -> +0x178 updates the wrong dword',
    },
  ],
});
