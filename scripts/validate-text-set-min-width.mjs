/** Validate XTextWindow::SetMinWidth (native 1562) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-set-min-width.mjs'),
  metaExport: 'TEXT_SET_MIN_WIDTH_NATIVE',
  entry: 'textWindowSetMinWidth',
  oracleFile: 'native-text-set-min-width-oracle.py',
  section: 'setMinWidth',
  resultKind: 'execVoid',
  metadataParams: ['newMinWidth:float'],  mutations: [
    {file: 'model',
     find: '  let bits = argBits >>> 0;\n  if (fcompC0(bits, 0)) bits = 0;\n  if (fcompC3(L.read(L.base + TEXT_WINDOW.minWidth',
     replace: '  let bits = argBits >>> 0;\n  if (fcompC3(L.read(L.base + TEXT_WINDOW.minWidth',
     note: 'arg normalize dropped — negative/NaN args store raw'},
    {file: 'model',
     find: '  if (fcompC3(L.read(L.base + TEXT_WINDOW.minWidth, \'u32\'), bits)) return;',
     replace: '  if (L.read(L.base + TEXT_WINDOW.minWidth, \'u32\') === bits) return;',
     note: 'unordered==equal lost — a stored NaN no longer suppresses the write'},
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.minWidth, \'u32\', bits);',
     replace: '  L.write(L.base + TEXT_WINDOW.minWidth, \'u32\', argBits >>> 0);',
     note: 'stores the unnormalized arg — negative/NaN arg survives'},
  ],

});
