import { refValue } from './script-vm.mjs';

/**
 * Original Core.Object::execRotRand (native 320,
 * `native(320) static final function rotator RotRand(optional bool bRoll)`).
 *
 * Core.dll registers the cell 0x101aa940 (thunk 0x10102ebe -> body 0x101391b0)
 * into GNatives+0x500 (index 320) at 0x10139271.  The body:
 *   - P_GET_UBOOL_OPTX(bRoll, 0): a zeroed DWORD, then one `Stack.Step` of the
 *     argument expression (an omitted trailing optional reads EX_EndFunctionParms,
 *     whose handler backs the cursor up; EX_Nothing leaves the zero);
 *   - P_FINISH (`inc Stack.Code`);
 *   - Yaw   = (2 * appRand()) % 65535   (first CRT rand),
 *     Pitch = (2 * appRand()) % 65535   (second),
 *     Roll  = bRoll ? (2 * appRand()) % 65535 : 0   (third only when bRoll != 0).
 * appRand is a tail jump to MSVCRT rand (0x101232d0 -> [0x102ab4fc]), so each
 * value is 2*[0,32767] and the signed `idiv 0xffff` never changes it.  The result
 * is a rotator [Pitch, Yaw, Roll] of int32 components.
 */
export function execRotRand(call, { rng } = {}) {
  if (typeof rng?.rand !== 'function') throw new Error('RotRand requires the shared original RNG stream');
  const count = call?.argumentCount ?? 0;
  if (count > 1) throw new Error('RotRand accepts at most one optional bool argument');
  let roll = false;
  if (count === 1) {
    const value = refValue(call.evaluateArgument(0));
    if (value !== undefined && typeof value !== 'boolean' && typeof value !== 'number')
      throw new Error('RotRand requires a bool bRoll argument');
    // `test eax, eax` on the DWORD the argument expression wrote.
    roll = value !== undefined && value !== false && value !== 0;
  }
  const yaw = (2 * rng.rand()) % 65535;
  const pitch = (2 * rng.rand()) % 65535;
  return [pitch, yaw, roll ? (2 * rng.rand()) % 65535 : 0];
}

export const ROTRAND_NATIVE = Object.freeze({
  index: 320,
  coreSha256: '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
  registration: 0x10139271,
  cell: 0x101aa940,
  thunk: 0x10102ebe,
  body: 0x101391b0,
});
