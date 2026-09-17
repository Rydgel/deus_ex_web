/** Validate XLargeTextWindow::SetVerticalSpacing (native 1860) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-set-vertical-spacing.mjs'),
  metaExport: 'TEXT_SET_VERTICAL_SPACING_NATIVE',
  entry: 'largeTextWindowSetVerticalSpacing',
  oracleFile: 'native-text-set-vertical-spacing-oracle.py',
  section: 'setVerticalSpacing',
  resultKind: 'execVoid',
  metadataParams: ['newVSpace:float'],  mutations: [
    {file: 'model',
     find: '  let bits = argBits >>> 0;\n  if (fcompC0(bits, 0)) bits = 0;\n  if (fcompC3(L.read(L.base + TEXT_WINDOW.lineSpacing',
     replace: '  let bits = argBits >>> 0;\n  if (fcompC3(L.read(L.base + TEXT_WINDOW.lineSpacing',
     note: 'arg normalize dropped — negative/NaN spacing stores raw'},
    {file: 'model',
     find: '  if (fcompC3(L.read(L.base + TEXT_WINDOW.lineSpacing, \'u32\'), bits)) return;',
     replace: '  if (L.read(L.base + TEXT_WINDOW.lineSpacing, \'u32\') === bits) return;',
     note: 'unordered==equal lost — a stored NaN no longer suppresses the write'},
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.lineSpacing, \'u32\', bits);',
     replace: '  L.write(L.base + TEXT_WINDOW.lineSpacing, \'u32\', argBits >>> 0);',
     note: 'stores the unnormalized arg — negative/NaN spacing survives'},
  ],

});
