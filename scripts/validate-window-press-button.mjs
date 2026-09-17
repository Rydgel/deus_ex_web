/** Focused original-evidence validator for ButtonWindow.PressButton. */
import {
  WINDOW_PRESS_BUTTON_NATIVE,
  pressButtonNative,
} from '../src/runtime/script-window-press-button.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-press-button.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_PRESS_BUTTON_NATIVE',
  entry: 'pressButtonNative',
  oracleFile: 'native-window-pressButton-oracle.py',
  section: 'pressButton',
  exportPath: 'buttonwindow.pressbutton',
  metadataParams: ['Key:byte'],
  invoke: (fn, receiver, args, world) => fn(receiver, args[0], world.services),
  mutations: [
    {
      find: 'buttonPressedSlot: 0x124',
      replace: 'buttonPressedSlot: 0x120',
      note: 'notify virtual slot +0x124 -> +0x120 dispatches the wrong callback',
    },
    {
      find: 'key: key & 0xff',
      replace: 'key: key & 0x7f',
      note: 'key mask 0xff -> 0x7f truncates the key byte passed to the virtual',
    },
  ],
});
