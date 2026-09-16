/** Validate XListWindow::SetSortColumn (native 1780) bit-exact vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';
import {listLeafServices} from './listwindow-services.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-set-sort-column.mjs'),
  metaExport: 'WINDOW_LIST_SET_SORT_COLUMN_NATIVE',
  entry: 'listWindowSetSortColumn',
  oracleFile: 'native-window-list-set-sort-column-oracle.py',
  section: 'setSortColumn',
  resultKind: 'void',
  metadataParams: ['colIndex:int', 'bReverse:bool', 'bCaseSensitive:bool'],
  services: (heap, base, spec) => listLeafServices(heap, base, spec),
  mutations: [
    {file: 'module',
     find: '  if (!colIndexValid(L, col)) return;',
     replace: '  if (colIndexValid(L, col)) return;',
     note: 'valid column indices are rejected'},
    {file: 'module',
     find: "    L.write(colPtr + LIST_COL.sortPriority, 'i32', 0);",
     replace: '    ;',
     note: 'non-target columns keep their sort priority'},
    {file: 'module',
     find: "  L.write(target + LIST_COL.sortPriority, 'i32', 1);",
     replace: "  L.write(target + LIST_COL.sortPriority, 'i32', 2);",
     note: 'target column priority is two instead of one'},
    {file: 'module',
     find: '(((sortFlags ^ bReverse) & 1) ^ sortFlags)',
     replace: '(((sortFlags ^ bCaseSensitive) & 1) ^ sortFlags)',
     note: 'reverse bit read from the case-sensitive argument'},
    {file: 'module',
     find: "  if (L.read(L.base + LIST_WINDOW.flags, 'u32') & LIST_FLAGS.sorting) sortRows(L);",
     replace: "  if (L.read(L.base + LIST_WINDOW.flags, 'u32') & LIST_FLAGS.autoExpand) sortRows(L);",
     note: 'sort driver gated on the auto-expand bit'},
  ],
});
