/** Focused original-evidence validator for RadioBoxWindow.GetEnabledToggle. */
import {
  WINDOW_GET_ENABLED_TOGGLE_NATIVE,
  getEnabledToggleNative,
} from '../src/runtime/script-window-get-enabled-toggle.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-get-enabled-toggle.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_GET_ENABLED_TOGGLE_NATIVE',
  entry: 'getEnabledToggleNative',
  oracleFile: 'native-window-getEnabledToggle-oracle.py',
  section: 'getEnabledToggle',
  exportPath: 'radioboxwindow.getenabledtoggle',
  metadataParams: ['ReturnValue:object'],
  invoke: (fn, receiver, args, world) => fn(receiver, world.services),
  mutations: [
    {
      find: 'enabledToggle: 0x184',
      replace: 'enabledToggle: 0x188',
      note: 'field offset +0x184 -> +0x188 reads the wrong member',
    },
    {
      find: "offset, 'ptr', {",
      replace: "offset, 'u32', {",
      note: 'read kind ptr -> u32 breaks pointer canonicalization',
    },
  ],
});
