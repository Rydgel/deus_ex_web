/** Validate XListWindow::IndexToRowId (native 1720) bit-exact vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-index-to-row-id.mjs'),
  metaExport: 'WINDOW_LIST_INDEX_TO_ROW_ID_NATIVE',
  entry: 'listWindowIndexToRowId',
  oracleFile: 'native-window-list-index-to-row-id-oracle.py',
  section: 'indexToRowId',
  resultKind: 'ptr',
  metadataParams: ['index:int', 'ReturnValue:int'],
  mutations: [
    {file: 'module', find: 'index < 0 || index >=',
     replace: 'index < 0 || index >',
     note: 'admit index == rowsCount (off-by-one upper bound)'},
    {file: 'module', find: "read(read(base + LIST_WINDOW.rowsData, 'u32') + 4 * index, 'u32')",
     replace: "read(read(base + LIST_WINDOW.rowsData, 'u32') + 4 * index + 4, 'u32')",
     note: 'return node->flags instead of the node pointer'},
  ],
});
