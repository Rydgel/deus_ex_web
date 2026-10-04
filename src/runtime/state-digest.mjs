/** A digest of every script property of every Level.Actors entry, for
 * comparing two runs of the same scenario (host measurement only). It walks
 * values as bench-sim's digest does (float bits, object identities by name
 * and class, strings, bounded host graphs) with a portable 64-bit FNV-1a
 * hash, so it runs in a page or a worker; its values are not comparable with
 * bench-sim's SHA-256 digests. */
export function stateDigest(runtime, level) {
  let low = 0x84222325, high = 0xcbf29ce4;
  const update = text => {
    for (let i = 0; i < text.length; i++) {
      // FNV-1a 64 over UTF-16 code units: xor, then multiply by 2^40 + 0x1b3.
      low = (low ^ text.charCodeAt(i)) >>> 0;
      const lo = low * 0x1b3, hi = high * 0x1b3 + (low << 8) + Math.floor(lo / 0x100000000);
      low = lo >>> 0; high = hi >>> 0;
    }
  };
  const bits = new DataView(new ArrayBuffer(8));
  const identity = value => {
    try { const instance = runtime.instance(value); return `@${value.name ?? '?'}:${instance.cls.record.key}`; }
    catch { return null; }
  };
  let budget = 0;
  const put = (value, depth = 0) => {
    if (depth > 8 || --budget < 0) { update('<bound>'); return; }
    if (value === null || value === undefined) { update(`${value};`); return; }
    switch (typeof value) {
      case 'number': bits.setFloat64(0, value); update(`n${bits.getBigUint64(0).toString(16)};`); return;
      case 'boolean': case 'bigint': update(`${typeof value[0]}${value};`); return;
      case 'string': update(`s${value.length}:${value};`); return;
      case 'function': update('fn;'); return;
    }
    if (ArrayBuffer.isView(value)) { update(`t${value.length};`); for (const v of value) put(v, depth + 1); return; }
    const id = identity(value);
    if (id) { update(id); return; }
    if (Array.isArray(value)) { update(`[${value.length}`); for (const v of value) put(v, depth + 1); update(']'); return; }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) { update(`<${value.constructor?.name ?? '?'}>`); return; }
    if (typeof value.key === 'string' && depth > 0) { update(`#${value.key}`); return; }
    if (typeof value.key === 'string' && (value.record || value.asset || value.linkedClass)) { update(`#${value.key}`); return; }
    update('{');
    for (const key of Object.keys(value).sort()) { update(`${key}=`); put(value[key], depth + 1); }
    update('}');
  };
  update(`time ${level.timeSeconds};`);
  for (const actor of level.actors) {
    if (!actor) { update('null-actor;'); continue; }
    let instance;
    try { instance = runtime.instance(actor); } catch { update(`detached ${actor.name};`); continue; }
    update(`actor ${actor.name} ${instance.cls.record.key};`);
    for (let cls = instance.cls; cls; cls = cls.base) for (const field of cls.propertyOrder) {
      update(`${field.metadata.name ?? field.name}=`);
      budget = 4096;
      try { put(runtime.fieldReference(actor, field).get()); }
      catch (error) { update(`!${String(error?.message).split('\n')[0]};`); }
    }
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}
