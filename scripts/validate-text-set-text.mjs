/** Validate XTextWindow::SetText (native 1550) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-set-text.mjs'),
  metaExport: 'TEXT_SET_TEXT_NATIVE',
  entry: 'textWindowSetText',
  oracleFile: 'native-text-set-text-oracle.py',
  section: 'setText',
  resultKind: 'execVoid',
  metadataParams: ['NewText:string'],
  mutations: [
    {file: 'model',
     find: "  const ca = fold(L.read(a + i * 2, 'u16'));",
     replace: "  const ca = L.read(a + i * 2, 'u16');",
     note: 'case-sensitive compare — "SAME"/"same" now reassigns and reconfigures'},
    {file: 'model',
     find: '  if (wcharCmpI(L, old, textPtr) === 0) return;',
     replace: '  if (wcharCmpI(L, old, textPtr) !== 0) return;',
     note: 'early-out inverted — equal text writes, different text returns'},
    {file: 'model',
     find: "  if ((L.read(L.base + TEXT_WINDOW.textFlags, 'u32') & TEXT_FLAGS.accelerator) !== 0) {\n    setAcceleratorText(L, textPtr);\n  }\n  askParentForReconfigure(L);",
     replace: "  askParentForReconfigure(L);",
     note: 'accelerator scan dropped — accelKey stays stale on enable'},
  ],
});
