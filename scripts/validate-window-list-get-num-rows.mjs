/** Validate XListWindow::GetNumRows (native 1740) bit-exact vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-get-num-rows.mjs'),
  metaExport: 'WINDOW_LIST_GETNUMROWS_NATIVE',
  entry: 'listWindowGetNumRows',
  oracleFile: 'native-window-list-get-num-rows-oracle.py',
  section: 'getNumRows',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:int'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module', find: "read(base + LIST_WINDOW.rowsCount, 'i32')",
     replace: "read(base + LIST_WINDOW.rowsMax, 'i32')",
     note: 'read the rows TArray capacity (+0x178) instead of the count (+0x174)'},
    {file: 'model', find: 'rowsCount: 0x174,',
     replace: 'rowsCount: 0x170,',
     note: 'read the rows TArray data pointer (+0x170) instead of the count'},
  ],
});
