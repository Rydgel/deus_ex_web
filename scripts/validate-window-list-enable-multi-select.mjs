/** Validate XListWindow::EnableMultiSelect (native 1794) vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';
import {listLeafServices} from './listwindow-services.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-enable-multi-select.mjs'),
  metaExport: 'WINDOW_LIST_ENABLE_MULTI_SELECT_NATIVE',
  entry: 'listWindowEnableMultiSelect',
  oracleFile: 'native-window-list-enable-multi-select-oracle.py',
  section: 'enableMultiSelect',
  resultKind: 'void',
  metadataParams: ['bEnableMultiSelect:bool'],
  services: (heap, base, spec) => listLeafServices(heap, base, spec),
  mutations: [
    {file: 'module',
     find: "    if (L.read(L.base + LIST_WINDOW.numSelected, 'i32') <= 1) continue;",
     replace: "    if (L.read(L.base + LIST_WINDOW.numSelected, 'i32') <= 0) continue;",
     note: 'deselect continues down to zero selections'},
    {file: 'module',
     find: "  for (let i = L.read(L.base + LIST_WINDOW.rowsCount, 'i32') - 1; i >= 0; i--) {",
     replace: '  for (let i = 0; i < L.read(L.base + LIST_WINDOW.rowsCount, \'i32\'); i++) {',
     note: 'deselect walks rows forward'},
    {file: 'module',
     find: '  if (changed) broadcastSelection(L);',
     replace: '  broadcastSelection(L);',
     note: 'broadcast fires even when nothing changed'},
    {file: 'module',
     find: '  if (((flags >>> 2) & 1) === arg) return;',
     replace: '  if (((flags >>> 2) & 1) === (arg & 1)) return;',
     note: 'argument compare masks to one bit'},
  ],
});
