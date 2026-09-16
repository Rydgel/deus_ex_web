/** Validate XEditWindow::MoveInsertionPoint (native 1880) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-move-insertion-point.mjs'),
  metaExport: 'EDIT_MOVE_INSERTION_POINT_NATIVE',
  entry: 'editWindowMoveInsertionPoint',
  oracleFile: 'native-edit-move-insertion-point-oracle.py',
  section: 'moveInsertionPoint',
  resultKind: 'void',
  metadataParams: ['moveInsert:byte', 'bDrag:bool'],
  mutations: [
    {file: 'module',
     find: '    case 0: // up\n      if (count <= 0) return;\n      moveToLine(L, line - 1, extend);',
     replace: '    case 0: // up\n      if (count <= 0) return;\n      moveToLine(L, line + 1, extend);',
     note: 'jump-table case 0 moves down instead of up'},
    {file: 'module',
     find: '    pageSize = Math.trunc(height / (lineHeight + spacing));\n    if (pageSize < 1) pageSize = 1;',
     replace: '    pageSize = Math.trunc(height / (lineHeight + spacing));',
     note: 'page-size clamp to >= 1 removed'},
    {file: 'module',
     find: '        L.read(rec + EDIT_LINE.fullLen, \'i32\') + L.read(rec + EDIT_LINE.start, \'i32\') - 1,',
     replace: '        L.read(rec + EDIT_LINE.fullLen, \'i32\') + L.read(rec + EDIT_LINE.start, \'i32\'),',
     note: 'line-end case drops the -1'},
    {file: 'model',
     find: '    if ((ch >= 9 && ch <= 0xd) || ch === 0x20) {\n      seenSpace = 1;',
     replace: '    if ((ch >= 9 && ch <= 0xc) || ch === 0x20) {\n      seenSpace = 1;',
     note: 'nextWord whitespace range drops CR (0xd)'},
    {file: 'model',
     find: '  let l = line | 0;\n  if (l > count - 1) l = count - 1;',
     replace: '  let l = line | 0;\n  if (l > count - 1) l = count;',
     note: 'moveToLine high clamp lands one past the last line'},
  ],
});
