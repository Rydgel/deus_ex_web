/** Validate XListWindow::GetSelectedRow (native 1747) bit-exact vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-get-selected-row.mjs'),
  metaExport: 'WINDOW_LIST_GET_SELECTED_ROW_NATIVE',
  entry: 'listWindowGetSelectedRow',
  oracleFile: 'native-window-list-get-selected-row-oracle.py',
  section: 'getSelectedRow',
  resultKind: 'ptr',
  metadataParams: ['ReturnValue:int'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module', find: 'read(base + LIST_WINDOW.selected, \'u32\')',
     replace: 'read(base + LIST_WINDOW.selected2, \'u32\')',
     note: 'read the other selection slot +0x1b0 instead of the cached +0x1ac'},
    {file: 'module', find: "read(node + LIST_ROW.flags, 'u8') & 1) return node",
     replace: "read(node + LIST_ROW.flags, 'u8') & 2) return node",
     note: 'scan tests bit1 instead of the selection bit0'},
  ],
});
