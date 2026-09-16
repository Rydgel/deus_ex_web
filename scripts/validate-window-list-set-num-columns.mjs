/** Validate XListWindow::SetNumColumns (native 1760) bit-exact vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';
import {listLeafServices} from './listwindow-services.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-set-num-columns.mjs'),
  metaExport: 'WINDOW_LIST_SET_NUM_COLUMNS_NATIVE',
  entry: 'listWindowSetNumColumns',
  oracleFile: 'native-window-list-set-num-columns-oracle.py',
  section: 'setNumColumns',
  resultKind: 'void',
  metadataParams: ['newCols:int'],
  services: (heap, base, spec) => listLeafServices(heap, base, spec),
  mutations: [
    {file: 'module',
     find: "      initColumn(L, L.read(cols, 'u32') + i * LIST_COL.size, i);",
     replace: '      ;',
     note: 'new columns keep zeroed fields instead of initColumn'},
    {file: 'module',
     find: '      for (let i = 0; i < num; i++) columnDtor(L, data + i * LIST_COL.size);\n'
       + '      farrayEmpty(L, cols, LIST_COL.size, 0);',
     replace: '      for (let i = 0; i < num; i++) columnDtor(L, data + i * LIST_COL.size);',
     note: 'zero target leaves the column array allocated'},
    {file: 'module',
     find: "    resizeRowFields(L, L.read(rdata + 4 * i, 'u32'));",
     replace: '    ;',
     note: 'row field arrays are never resized to the new column count'},
    {file: 'model',
     find: "    L.read(L.base + LIST_WINDOW.padX, 'f32') * 2 + 20.0);",
     replace: "    L.read(L.base + LIST_WINDOW.padX, 'f32') * 2 + 21.0);",
     note: 'new column default width off by one'},
    {file: 'model',
     find: "    if (h > L.read(heightAt, 'f32')) L.write(heightAt, 'f32', h);",
     replace: "    if (h < L.read(heightAt, 'f32')) L.write(heightAt, 'f32', h);",
     note: 'row height takes the minimum glyph height'},
  ],
});
