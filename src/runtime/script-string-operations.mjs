/** Logical string operations recovered in docs/script-string-operations.md. */
export function scriptStringText(value) {
  if(typeof value!=='string')throw new TypeError('Original string operation requires typed string text');
  const end=value.indexOf('\0');
  return end<0?value:value.slice(0,end);
}

export function scriptStringEqual(left,right) {
  return scriptStringText(left)===scriptStringText(right);
}

/** Core UObject natives 115/120/121 (<, <=, >= on string,string) -> appStrcmp,
 * which forwards to the shipped MSVCRT wcscmp: a case-sensitive compare of
 * unsigned UTF-16 code units that stops at the first NUL unit.  The bodies
 * substitute the runtime empty-string buffer for an operand whose ArrayNum is
 * zero — the logical adapter's truncation at the first NUL covers both that
 * substitution and embedded-zero storage (oracle cases slt-numzero-ptr and
 * slt-embedded-zero). */
export function scriptStringCompare(left,right) {
  const a=scriptStringText(left),b=scriptStringText(right);
  const n=Math.min(a.length,b.length);
  for(let i=0;i<n;i++){
    const d=a.charCodeAt(i)-b.charCodeAt(i);
    if(d)return d;
  }
  // The shorter text's terminating NUL compares below any remaining unit.
  return a.length-b.length;
}

/** Core UObject::execComplementEqual_StringString native 124 -> appStricmp. */
export function scriptStringComplementEqual(left,right) {
  const a=scriptStringText(left),b=scriptStringText(right);
  // Core's appStricmp uses the original C-locale ASCII fold. Preserve every
  // non-ASCII code unit instead of applying JavaScript Unicode case mapping.
  const fold=value=>value.replace(/[A-Z]/g,unit=>String.fromCharCode(unit.charCodeAt(0)+0x20));
  return fold(a)===fold(b);
}

export function scriptConcat(left,right) {
  scriptStringText(left);scriptStringText(right);
  if(left.includes('\0')||right.includes('\0'))
    throw new Error('Original concatenation with embedded-zero storage is unsupported');
  return left+right;
}

/** Core UObject::execAt_StringString native 168 -> A + L" " + B. */
export function scriptAt(left,right) {
  scriptStringText(left);scriptStringText(right);
  if(left.includes('\0')||right.includes('\0'))
    throw new Error('Original At with embedded-zero storage is unsupported');
  return left+' '+right;
}

function int32(value, operation) {
  if(!Number.isInteger(value)||value<-(2**31)||value>2**31-1)
    throw new TypeError(`${operation} requires an int32 argument`);
  return value;
}

const MID_DEFAULT_COUNT=0xffff;

/** Core UObject::execLen native 125 -> FString::Len. */
export function scriptLen(value) {
  const text=scriptStringText(value);
  // FString::Len reads ArrayNum-1, so an independently stored embedded zero
  // cannot be represented by the logical JavaScript string adapter.
  if(value.includes('\0'))throw new Error('Original Len with embedded-zero storage is unsupported');
  return text.length;
}

/** Core UObject::execInStr native 126 -> FString::InStr(...,0). */
export function scriptInStr(value, needle) {
  const text=scriptStringText(value), part=scriptStringText(needle);
  // appStrstr is case-sensitive and returns a pointer into the terminated
  // source. JavaScript indexOf uses the same UTF-16 code-unit index space.
  return text.indexOf(part);
}

/** Core UObject::execMid native 127 -> FString::Mid. */
export function scriptMid(value, start, count=undefined) {
  const text=scriptStringText(value);
  if(value.includes('\0'))throw new Error('Original Mid with embedded-zero storage is unsupported');
  int32(start,'Mid start');
  if(count!==undefined)int32(count,'Mid count');
  // The installed FString body returns the raw empty form for a negative or
  // out-of-range start. A negative/omitted count means “through the end”.
  if(start<0||start>=text.length)return '';
  if(count===undefined)return text.slice(start,start+MID_DEFAULT_COUNT);
  if(count<0)return text.slice(start);
  return text.slice(start,start+count);
}

/** Core UObject::execLeft native 128 -> FString::Left. */
export function scriptLeft(value,count) {
  scriptStringText(value);
  if(value.includes('\0'))throw new Error('Original Left with embedded-zero storage is unsupported');
  int32(count,'Left count');
  return value.slice(0,Math.min(Math.max(count,0),value.length));
}

/** Core UObject::execRight native 234 -> FString::Right. */
export function scriptRight(value,count) {
  scriptStringText(value);
  if(value.includes('\0'))throw new Error('Original Right with embedded-zero storage is unsupported');
  int32(count,'Right count');
  const take=Math.min(Math.max(count,0),value.length);
  return value.slice(value.length-take);
}

export function scriptCaps(value) {
  scriptStringText(value); // Require an already converted FString value.
  if(value.includes('\0'))throw new Error('Original Caps with embedded-zero storage is unsupported');
  return value.replace(/[a-z]/g,unit=>String.fromCharCode(unit.charCodeAt(0)-0x20));
}

/** Core UObject::execChr native 236 -> FString::Chr(TCHAR). */
export function scriptChr(value) {
  // execChr's int local is passed to FString::Chr as an unsigned 16-bit
  // character. The native does not clamp the int; it keeps only the low word.
  const unit=int32(value,'Chr')&0xffff;
  // FString::Chr(0) follows the original zero-length allocation path.
  return unit===0?'':String.fromCharCode(unit);
}

export function scriptNameToString(value) {
  if(typeof value!=='string'||value.includes('\0'))
    throw new TypeError('NameToString requires a resolved logical FName spelling');
  return value;
}

export function scriptObjectToString(value) {
  if(value==null)return 'None';
  const name=value.name??value.record?.name;
  if(typeof name==='string'&&name)return name;
  throw new TypeError('ObjectToString requires an object with a logical name');
}

/** Core execFloatToString 0x10131ca0: FString::Printf(L"%f", (double)F) (format
 * constant 0x101aaf78). The float32 widens exactly to a double; MSVCRT prints
 * six decimals. Produced here from the exact decimal expansion, rounding the
 * sixth decimal half away from zero, and only where a 17-significant-digit
 * intermediate would give the same text. NaN/Inf, -0, more than 17 integer
 * digits and such double-rounding cases are not measured and stay explicit. */
export function scriptFloatToString(value) {
  const x = Math.fround(value);
  if (!Number.isFinite(x)) throw new Error('FloatToString of NaN/Inf (MSVCRT %f spelling) is not measured');
  if (Object.is(x, -0)) throw new Error('FloatToString of -0 (MSVCRT %f sign) is not measured');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x), true);
  const bits = view.getBigUint64(0, true), biased = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn, exponent = biased ? biased - 1075 : -1074;
  if (biased) mantissa |= 1n << 52n;
  let digits, point;                                   // value = digits * 10^-point
  if (exponent >= 0) { digits = (mantissa << BigInt(exponent)).toString(); point = 0; }
  else { digits = (mantissa * 5n ** BigInt(-exponent)).toString(); point = -exponent; }
  const exact = digits.padStart(point + 1, '0');
  const intDigits = exact.length - point;
  if (intDigits > 17) throw new Error('FloatToString beyond 17 integer digits (MSVCRT zero fill) is not measured');
  // Round the digit string `s` (with `p` fractional digits) half up to `keep` digits after the point.
  const round = (s, p, keep) => {
    if (p <= keep) return {s: s + '0'.repeat(keep - p), p: keep};
    const cut = s.length - (p - keep);
    let head = BigInt(s.slice(0, cut) || '0');
    if (s[cut] >= '5') head += 1n;
    return {s: head.toString().padStart(keep + 1, '0'), p: keep};
  };
  const direct = round(exact, point, 6);
  const significant = exact.replace(/^0+/, '').length;
  if (significant > 17) {
    const drop = significant - 17;
    const via = round(round(exact, point, point - drop).s, point - drop, 6);
    if (via.s.replace(/^0+/, '') !== direct.s.replace(/^0+/, ''))
      throw new Error('FloatToString 17-digit MSVCRT rounding case is not measured');
  }
  const text = direct.s.padStart(7, '0');
  return `${x < 0 ? '-' : ''}${text.slice(0, -6)}.${text.slice(-6)}`;
}
