/** Validate XListWindow::GetField (native 1735) bit-exact vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';
import {listLeafServices} from './listwindow-services.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-get-field.mjs'),
  metaExport: 'WINDOW_LIST_GET_FIELD_NATIVE',
  entry: 'listWindowGetField',
  oracleFile: 'native-window-list-get-field-oracle.py',
  section: 'getField',
  resultKind: 'fieldstr',
  metadataParams: ['rowId:int', 'colIndex:int', 'ReturnValue:string'],
  services: (heap, base, spec) => listLeafServices(heap, base, spec),
  mutations: [
    {file: 'module', find: 'if (!row) return 0;',
     replace: 'if (row === 1) return 0;',
     note: 'admit a null row id (dereferences the null node)'},
    {file: 'module', find: '+ (colIndex | 0) * LIST_FIELD.size',
     replace: '+ (colIndex | 0) * (LIST_FIELD.size + 8)',
     note: 'wrong field stride reads a misaligned field cell'},
    {file: 'model', find: 'col >= 0 && col < L.read',
     replace: 'col >= 0 && col != L.read',
     note: 'column bound admits every index except numCols'},
  ],
});
