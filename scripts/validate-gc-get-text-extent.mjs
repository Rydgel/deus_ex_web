#!/usr/bin/env node
/**
 * GC.GetTextExtent (native 1280) validator — replays every
 * gc-textmetrics-cases.json case through the JS translation and compares
 * {xExtent,yExtent} f32 bits, events and canonical GC state against the
 * Unicorn oracle running the real Extension.dll method + exec bodies over
 * real UFont data.  Then applies the mutation gate.
 *
 * Usage: node scripts/validate-gc-get-text-extent.mjs
 */
import path from 'node:path';
import {runTextMetricsValidator} from './gc-textmetrics-validator-lib.mjs';
import {f32FromBits} from './gc-services.mjs';

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const f32bits = v => { F32[0] = v; return U32[0]; };

const hasOut = a => a && typeof a === 'object' && 'out' in a;

await runTextMetricsValidator({
  moduleFile: path.resolve(import.meta.dirname, '../src/runtime/script-gc-get-text-extent.mjs'),
  metaExport: 'GC_GET_TEXT_EXTENT_NATIVE',
  entry: 'gcGetTextExtentMethod',
  oracleFile: 'native-gc-textextent-oracle.py',
  section: 'getTextExtent',
  resultKind: 'outs',
  metadataParams: ['destWidth:float', 'xExtent:float', 'yExtent:float', 'textStr:string'],
  // The |c/|p channel scale at 0x1005e3e8 is a distinct 1/255 constant
  // (0x3f70101010101027), not the GC color scale at 0x1005e3c0.
  dllAssert: [{offset: 0x1005e3e8, hex: '271010101010703f'}],
  invoke(fn, object, args, services, caseSpec, mod) {
    // Args: {value: destWidth f32 bits}, {out}|{value:0} xExtent,
    //       {out}|{value:0} yExtent, resolved text string.
    const destWidth = f32FromBits(args[0] && typeof args[0] === 'object' && 'value' in args[0]
      ? args[0].value : args[0]);
    const r = fn(object, destWidth,
      hasOut(args[1]), hasOut(args[2]), args[3], services);
    return {
      xExtent: r.xExtent == null ? null : f32bits(r.xExtent),
      yExtent: r.yExtent == null ? null : f32bits(r.yExtent),
    };
  },
  mutations: [
    {file: 'fontModel', note: 'glyph width field offset +8 -> +0',
     find: '  uSize:  0x08, // advance width',
     replace: '  uSize:  0x00, // advance width'},
    {file: 'fontModel', note: 'glyph height field offset +0xc -> +4',
     find: '  vSize:  0x0c, // height',
     replace: '  vSize:  0x04, // height'},
    {file: 'fontModel', note: 'char->page map forces every unit out of page range',
     find: "export function uFontGlyph(L, font, ch, texOut = 0, out = null) {\n  ch &= 0xffff;",
     replace: "export function uFontGlyph(L, font, ch, texOut = 0, out = null) {\n  ch |= 0x10000;"},
    {file: 'module', note: 'bold toggle polarity on |b',
     find: 'state[STATE_BOLD] = gBang === 0 ? 1 : 0;',
     replace: 'state[STATE_BOLD] = gBang === 0 ? 0 : 1;'},
    {file: 'module', note: 'newline stop char 0x0a -> 0x0b in the line scanner',
     find: 'if (ch === 0 || ch === 0x0a) {',
     replace: 'if (ch === 0 || ch === 0x0b) {'},
    {file: 'module', note: 'width overflow strictness (>=) collapses exact fit',
     find: 'if (!(sum > destW)) { runW = Math.fround(sum); firstChar = 0; continue; }',
     replace: 'if (!(sum >= destW)) { runW = Math.fround(sum); firstChar = 0; continue; }'},
    {file: 'module', note: 'word-wrap resume rewinds to wordEnd instead of wordStart',
     find: '    outCursor = wordStart;\n    outLenEnd = wordEnd;',
     replace: '    outCursor = wordEnd;\n    outLenEnd = wordEnd;'},
    {file: 'module', note: 'line-height fallback uses a 0.0f threshold instead of 1.0f',
     find: 'if (!(lineH >= 1) && font !== 0)',
     replace: 'if (!(lineH >= 0) && font !== 0)'},
  ],
});
