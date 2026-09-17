/** Validate XTextWindow::EnableTextAsAccelerator (native 1564) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-enable-text-as-accelerator.mjs'),
  metaExport: 'TEXT_ENABLE_TEXT_AS_ACCELERATOR_NATIVE',
  entry: 'textWindowEnableTextAsAccelerator',
  oracleFile: 'native-text-enable-text-as-accelerator-oracle.py',
  section: 'enableTextAsAccelerator',
  resultKind: 'execVoid',
  metadataParams: ['bEnable:bool'],  mutations: [
    {file: 'model',
     find: '  if (((flags >>> 1) & 1) === (bEnable >>> 0)) return;',
     replace: '  if (((flags >>> 1) & 1) === ((bEnable >>> 0) & 1)) return;',
     note: 'guard masks the arg — raw 3 with the flag on early-outs'},
    {file: 'model',
     find: '  const newFlags = ((flags & ~TEXT_FLAGS.accelerator) | ((bEnable & 1) << 1)) >>> 0;',
     replace: '  const newFlags = ((flags & ~TEXT_FLAGS.accelerator) | (bEnable << 1)) >>> 0;',
     note: 'raw arg shifted in — arg 3 lights bit2 as well'},
    {file: 'model',
     find: '    setAcceleratorText(L, textDataOrEmpty(L));',
     replace: '    setAcceleratorText(L, 0);',
     note: 'enable scans NULL — the |&x key never registers'},
  ],

});
