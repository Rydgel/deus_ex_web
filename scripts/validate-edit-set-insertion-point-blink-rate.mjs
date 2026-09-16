/** Validate XEditWindow::SetInsertionPointBlinkRate (native 1902) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-set-insertion-point-blink-rate.mjs'),
  metaExport: 'EDIT_SET_INSERTION_POINT_BLINK_RATE_NATIVE',
  entry: 'editWindowSetInsertionPointBlinkRate',
  oracleFile: 'native-edit-set-insertion-point-blink-rate-oracle.py',
  section: 'setInsertionPointBlinkRate',
  resultKind: 'void',
  metadataParams: ['blinkStart:float', 'blinkPeriod:float'],
  mutations: [
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.blinkOn, 'f32', blinkStart);",
     replace: "  L.write(L.base + EDIT_WINDOW.blinkOff, 'f32', blinkStart);",
     note: 'blinkStart stored into the period field'},
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.blinkOn, 'f32', blinkStart);",
     replace: "  L.write(L.base + EDIT_WINDOW.blinkOn, 'f32', blinkPeriod);",
     note: 'arguments swapped at the first store'},
  ],
});
