/** Validate XEditWindow::GetSelectedArea (native 1884) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-get-selected-area.mjs'),
  metaExport: 'EDIT_GET_SELECTED_AREA_NATIVE',
  entry: 'editWindowGetSelectedArea',
  oracleFile: 'native-edit-get-selected-area-oracle.py',
  section: 'getSelectedArea',
  resultKind: 'outPair',
  metadataParams: ['startPos:int', 'Count:int'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: '  let size = (selEnd - selStart) | 0;\n  if (start < 0) start = 0;',
     replace: '  if (start < 0) start = 0;\n  let size = (selEnd - start) | 0;',
     note: 'size computed after clamping instead of from the raw selStart'},
    {file: 'module',
     find: '  if (start < 0) start = 0;',
     replace: '  if (start < 0) start = -1;',
     note: 'negative selStart reports -1 instead of clamping to 0'},
    {file: 'module',
     find: '  return {start, length: size};',
     replace: '  return {start, length: selEnd};',
     note: 'returns selEnd instead of the clamped size'},
  ],
});
