const f = Math.fround;
const squared = v => v[0] * v[0] + v[1] * v[1] + v[2] * v[2];

// AdjustSpot retains Z through three x87 operations. Binary64 evaluation can
// erase a term at a float32 midpoint (see docs/fitting-arithmetic.md).
const bits = new DataView(new ArrayBuffer(8));
function binary(value) {
  bits.setFloat64(0, value, true);
  const word=bits.getBigUint64(0,true), exponent=Number((word>>52n)&2047n);
  return {n:((word&0xfffffffffffffn)|(exponent?0x10000000000000n:0n))*(word>>63n?-1n:1n),e:exponent?exponent-1075:-1074};
}
function round(value,precision) {
  const sign=value.n<0n?-1n:1n,n=value.n*sign;
  // Float32 subnormals retain the fixed 2^-149 quantum.
  const shift=Math.max(n.toString(2).length-precision,precision===24?-149-value.e:0);
  if(shift<=0)return value;
  const unit=1n<<BigInt(shift),half=unit>>1n;
  let kept=n>>BigInt(shift);const remainder=n&(unit-1n);
  if(remainder>half||(remainder===half&&(kept&1n)))kept++;
  return {n:kept*sign,e:value.e+shift};
}
function add(a,b) {
  const e=Math.min(a.e,b.e);
  return round({n:(a.n<<BigInt(a.e-e))+(b.n<<BigInt(b.e-e)),e},64);
}
const multiply=(a,b)=>round({n:a.n*b.n,e:a.e+b.e},64);
function adjustZ(position,time,normal,distance) {
  if(normal===0)return f(position+(1.05-time)*normal*distance);
  const t=binary(time);t.n=-t.n;
  const result=round(add(binary(position),multiply(multiply(add(binary(1.05),t),binary(normal)),binary(distance))),24);
  return f(Number(result.n)*2**result.e);
}

/** Original ULevel.FindSpot / AdjustSpot, Engine.dll 0x10398480 / 0x10398360.
 * queries supplies the original level point/ray semantics, documented in
 * docs/fitting.md. Return a fitted copy or null; never change the input position.
 * Options retain native order: checkActors controls the point-query actor hash;
 * checkFirst enables the early point check. Landing supplies zero for both.
 */
export function findSpot(queries, position, extent, checkActors = 0, checkFirst = 1) {
  const original = position.map(f), e = extent.map(f);
  const clearAt = location => queries.pointCheck([...location], [...e], 0, checkActors) === 1;
  if (e.every(value => value === 0)) return clearAt(original) ? original : null;
  if (checkFirst && clearAt(original)) return original;

  let candidate = [...original];
  const size = f(Math.sqrt(e[2] * e[2] + e[1] * e[1] + e[0] * e[0]) + 2);
  const adjust = (end, distance) => {
    const hit = queries.lineCheck([...candidate], end, [0, 0, 0], 6, 0);
    if (hit.time < 1) {
      const factor = 1.05 - f(hit.time), n = hit.normal.map(f);
      // Original AdjustSpot retains the Z products in x87 until the position
      // addition, but stores X/Y after both multiplications.
      candidate = [f(candidate[0] + f(f(factor * n[0]) * distance)),
        f(candidate[1] + f(f(factor * n[1]) * distance)),
        adjustZ(candidate[2],f(hit.time),n[2],distance)];
    }
  };
  for (const sign of [-1, 1]) for (let axis = 0; axis < 3; axis++) {
    const end = [...candidate]; end[axis] = f(end[axis] + sign * e[axis]);
    adjust(end, e[axis]);
  }
  if (clearAt(candidate)) return candidate;
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    adjust(candidate.map((value, axis) => f(value + [x, y, z][axis] * e[axis])), size);
  }
  const displacement = candidate.map((value, axis) => f(value - original[axis]));
  if (f(squared(displacement)) > 1.5 * f(squared(e))) return null;
  return clearAt(candidate) ? candidate : null;
}
