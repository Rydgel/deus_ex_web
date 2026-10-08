/** Core primitive casts the scripts reach beyond the ones script-vm.mjs
 * already carried (byte/int/float/string/vector conversions). Each handler is
 * a GNatives entry registered by Core's static initialisers; the cast token is
 * the VM opcode. Evidence and checks: docs/script-core-casts.md.
 *
 *   0x3b ByteToBool   10131120  byte != 0
 *   0x3e IntToBool    101314c0  dword != 0
 *   0x40 BoolToByte   101317b0  bool & 1, stored as a byte
 *   0x41 BoolToInt    10131850  bool & 1
 *   0x42 BoolToFloat  101318f0  (bool & 1) as float32
 *   0x45 FloatToBool  10131be0  FCOMP against 0.0: equal or unordered -> FALSE
 *   0x4c StringToFloat 101326b0 FSTP m32 of MSVCRT atof(appToAnsi(S))
 *   0x52 ByteToString 10131270  Printf("%i", byte)       (format 101aaf68)
 *   0x54 BoolToString 101319a0  the constants "True" / "False" (101a7d4c / 101a7dcc)
 *
 * The VM holds script bools as JavaScript booleans, so a bool operand is
 * already its low bit. */
import {stringToFloat} from './script-text-format.mjs';
import {scriptStringText} from './script-string-operations.mjs';

const lowBit = value => typeof value === 'boolean' ? (value ? 1 : 0) : (value & 1);

export const CORE_CASTS = new Map([
  [0x3b, value => (value & 255) !== 0],
  [0x3e, value => (value | 0) !== 0],
  [0x40, value => lowBit(value)],
  [0x41, value => lowBit(value)],
  [0x42, value => lowBit(value)],
  [0x45, value => !(value === 0 || Number.isNaN(value))],
  [0x4c, value => stringToFloat(scriptStringText(value ?? ''))],
  [0x52, value => String(value & 255)],
  [0x54, value => (value ? 'True' : 'False')],
]);
