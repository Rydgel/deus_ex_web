/** Validate XListWindow::DeleteAllRows (native 1733) bit-exact vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';
import {listLeafServices} from './listwindow-services.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-delete-all-rows.mjs'),
  metaExport: 'WINDOW_LIST_DELETE_ALL_ROWS_NATIVE',
  entry: 'listWindowDeleteAllRows',
  oracleFile: 'native-window-list-delete-all-rows-oracle.py',
  section: 'deleteAllRows',
  resultKind: 'int',
  services: (heap, base, spec) => listLeafServices(heap, base, spec),
  mutations: [
    {file: 'module', find: 'for (let i = count - 1; i >= 0; i--)',
     replace: 'for (let i = 0; i < count; i++)',
     note: 'destroy rows in forward order'},
    {file: 'module', find: "'i32') > 0 ? 1 : 0",
     replace: "'i32') >= 0 ? 1 : 0",
     note: 'broadcast the selection change even when nothing was selected'},
    {file: 'module', find: 'for (let j = 0; j < fcount; j++)',
     replace: 'for (let j = 1; j < fcount; j++)',
     note: 'skip the first field destructor (text allocation leaks)'},
    {file: 'model', find: "L.write(array + 8, 'i32', newMax);\n  farrayRealloc(L, array, elemSize);",
     replace: "L.write(array + 8, 'i32', newMax);",
     note: 'FArray::Empty never reallocs (fields/rows data leaks and survives)'},
  ],
});
