/** Validate XListWindow::GetNumSelectedRows (native 1741) bit-exact vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-get-num-selected-rows.mjs'),
  metaExport: 'WINDOW_LIST_GETNUMSELECTEDROWS_NATIVE',
  entry: 'listWindowGetNumSelectedRows',
  oracleFile: 'native-window-list-get-num-selected-rows-oracle.py',
  section: 'getNumSelectedRows',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:int'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module', find: "read(base + LIST_WINDOW.numSelected, 'i32')",
     replace: "read(base + LIST_WINDOW.numSelected - 4, 'i32')",
     note: 'read +0x1a4 instead of the selected count at +0x1a8'},
    {file: 'module', find: "read(base + LIST_WINDOW.numSelected, 'i32')",
     replace: "read(base + LIST_WINDOW.numSelected, 'u8')",
     note: 'narrow the read to a single byte at +0x1a8'},
  ],
});
