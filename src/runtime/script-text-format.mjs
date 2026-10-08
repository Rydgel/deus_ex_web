/** MSVCRT text conversions behind Core's appSprintf and appAtof.
 *
 * Core appSprintf (10123490) is `_vsnwprintf(dest, 0x400, fmt, args)` and
 * appAtof (101235c0) is `atof(appToAnsi(str))`, both through the game's own
 * System/MSVCRT.dll. This module is the JavaScript model of the parts the
 * scripts reach; scripts/validate-msvcrt-text-hardware.mjs compares it with
 * that DLL running under Wine. Evidence: docs/script-value-format.md.
 *
 * Supported: `%[flags][width][.precision]f` of a double (flags - + space 0),
 * `%%` and literal text. Anything else (other conversions, NaN, infinities,
 * a result of 0x400 or more units) is an explicit error because no shipped
 * script format reaches it and it has not been measured. */

const LIMIT = 0x400;                      // appSprintf's buffer count

/** Exact decimal expansion of a finite double's magnitude: {digits, point} with
 * value = digits * 10^-point (digits has no leading zeros except "0"). */
function exactDecimal(magnitude) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, magnitude, true);
  const bits = view.getBigUint64(0, true), biased = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn, exponent = biased ? biased - 1075 : -1074;
  if (biased) mantissa |= 1n << 52n;
  let digits, point;
  if (exponent >= 0) { digits = (mantissa << BigInt(exponent)).toString(); point = 0; }
  else { digits = (mantissa * 5n ** BigInt(-exponent)).toString(); point = -exponent; }
  return {digits, point};
}

/** `%.{precision}f` of a finite magnitude the way MSVCRT's _cfltcvt does: 17
 * significant digits of the exact value (digit 18 and beyond round the 17th
 * half up), digits past the 17th are zero, then half up at `precision` places. */
export function fixedDigits(magnitude, precision) {
  let {digits, point} = exactDecimal(magnitude);
  let value = BigInt(digits);
  const extra = digits.length - 17;
  if (value !== 0n && extra > 0) {
    const scale = 10n ** BigInt(extra);
    value = ((value + scale / 2n) / scale) * scale;
  }
  let scaled;
  if (point <= precision) scaled = value * 10n ** BigInt(precision - point);
  else {
    const divisor = 10n ** BigInt(point - precision);
    scaled = (value + divisor / 2n) / divisor;
  }
  const text = scaled.toString().padStart(precision + 1, '0');
  return precision ? `${text.slice(0, -precision)}.${text.slice(-precision)}` : text;
}

/** One `%` specification applied to a double. */
function formatFloat(spec, value) {
  const {flags, width, precision} = spec;
  if (!Number.isFinite(value)) throw new Error('MSVCRT %f of NaN/Inf (1.#INF / 1.#QNAN spelling) is not measured');
  // MSVCRT tests `value < 0`, so -0.0 prints unsigned while -0.01 at %1.1f is "-0.0" (measured).
  const negative = value < 0;
  let body = fixedDigits(Math.abs(value), precision);
  const sign = negative ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
  if (sign.length + body.length >= width) return sign + body;
  if (flags.includes('-')) return (sign + body).padEnd(width, ' ');
  if (flags.includes('0')) return sign + body.padStart(width - sign.length, '0');
  return (sign + body).padStart(width, ' ');
}

/** appSprintf(dest, format, doubles...) -> the destination text. */
export function msvcrtSprintf(format, ...args) {
  let out = '', next = 0;
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%') { out += format[i]; continue; }
    const match = /^%([-+ 0#]*)(\d*)(?:\.(\d*))?([a-zA-Z%])/.exec(format.slice(i));
    if (!match) throw new Error(`MSVCRT format ${JSON.stringify(format.slice(i))} is not measured`);
    const [whole, flags, width, precision, conversion] = match;
    if (conversion === '%' && whole === '%%') { out += '%'; i += 1; continue; }
    if (conversion !== 'f' || flags.includes('#')) throw new Error(`MSVCRT %${flags}${width}${precision === undefined ? '' : `.${precision}`}${conversion} is not measured`);
    if (next >= args.length) throw new Error('MSVCRT format reads past its arguments');
    out += formatFloat({flags, width: Number(width || 0), precision: precision === undefined ? 6 : Number(precision || 0)}, args[next++]);
    i += whole.length - 1;
  }
  if (out.length >= LIMIT) throw new Error('MSVCRT _vsnwprintf result reaches the 0x400-unit buffer (truncation is not measured)');
  return out;
}

/** atof: the longest decimal prefix after leading whitespace, as a double. */
export function msvcrtAtof(text) {
  const match = /^[ \t\n\v\f\r]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text);
  return match ? Number(match[1]) : 0;
}

/** execStringToFloat (101326b0): atof(appToAnsi(S)) stored with FSTP m32. */
export const stringToFloat = text => Math.fround(msvcrtAtof(text));
