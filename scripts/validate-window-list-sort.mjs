/** Validate XListWindow::Sort (native 1784) bit-exact vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';
import {listLeafServices} from './listwindow-services.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-sort.mjs'),
  metaExport: 'WINDOW_LIST_SORT_NATIVE',
  entry: 'listWindowSort',
  oracleFile: 'native-window-list-sort-oracle.py',
  section: 'sort',
  resultKind: 'void',
  metadataParams: [],
  services: (heap, base, spec) => listLeafServices(heap, base, spec),
  mutations: [
    {file: 'model',
     find: 'export function sortRows(L) {\n  buildSortList(L);',
     replace: 'export function sortRows(L) {\n  ',
     note: 'sort-column list is never rebuilt'},
    {file: 'model',
     find: '      if (sortFlags & SORT_REVERSE) result = av > bv ? -1 : av < bv ? 1 : 0;',
     replace: '      if (sortFlags & SORT_REVERSE) result = av < bv ? -1 : av > bv ? 1 : 0;',
     note: 'descending numeric compare inverted'},
    {file: 'model',
     find: '      const [x, y] = sortFlags & SORT_REVERSE ? [bt, at] : [at, bt];',
     replace: '      const [x, y] = sortFlags & SORT_REVERSE ? [at, bt] : [bt, at];',
     note: 'descending text swap inverted'},
    {file: 'model',
     find: '      result = sortFlags & SORT_CASE_SENSITIVE ? wcsCompare(x, y) : wcsiCompare(x, y);',
     replace: '      result = sortFlags & SORT_CASE_SENSITIVE ? wcsiCompare(x, y) : wcsCompare(x, y);',
     note: 'case-sensitive flag selects the insensitive compare'},
    {file: 'model',
     find: '  return aid < bid ? -1 : aid > bid ? 1 : 0;',
     replace: '  return aid < bid ? 1 : aid > bid ? -1 : 0;',
     note: 'row-id tie-break inverted'},
    {file: 'model',
     find: '      const mid = lo + Math.trunc(size / 2) * width;',
     replace: '      const mid = lo + Math.trunc(size / 2 - 1) * width;',
     note: 'qsort pivot taken one element early'},
  ],
});
