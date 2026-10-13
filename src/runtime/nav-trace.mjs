/** Validation only (src/viewer/live-probe.mjs `navTrace`, docs/script-pawn-nav.md "Live divergence"):
 * the boundary calls of a pawn's reach and path natives, in the order and with the arguments the original's
 * breakpoints at the same functions record (tools/dx-live-win.c `call`): UModel::FastLineCheck 0x103f3280,
 * ULevel::FarMoveActor 0x10398ba0, MoveActor 0x103990e0, SingleLineCheck 0x1039aed0, and the path worker's
 * entry and return (0x103db3f0). Off unless a probe turns it on. */
const plain = value => Array.isArray(value) || ArrayBuffer.isView(value) ? [...value].map(plain)
  : value && typeof value === 'object' ? (typeof value.name === 'string' ? value.name : String(value)) : value ?? null;

export function createNavTrace() {
  const trace = { pawns: new Set(), tick: 0, first: 0, last: -1, events: [], depth: 0 };
  const live = pawn => trace.depth > 0 && trace.tick >= trace.first && trace.tick <= trace.last && pawn !== undefined;
  const push = event => trace.events.push({ u: trace.tick, ...event });
  /** The services a traced pawn's natives run with: the boundary calls log themselves. */
  trace.wrap = (services, receiver) => {
    if (!trace.pawns.has(receiver.name)) return services;
    const wrapped = { ...services };
    const log = (fn, input, result) => { if (live(receiver)) push({ ev: 'call', fn, ...input, ret: plain(result) }); return result; };
    wrapped.navTrace = (fn, input) => {
      if (!live(receiver)) return null;
      push({ ev: 'enter', fn, ...input });
      return result => push({ ev: 'ret', fn, result: result?.name ?? plain(result) });
    };
    wrapped.fastLineCheck = (model, first, second) => log('flc', { first: plain(first), second: plain(second) }, services.fastLineCheck(model, first, second));
    wrapped.farMoveActor = (actor, dest, test, noCheck) => {
      const result = services.farMoveActor(actor, dest, test, noCheck);
      log('farmove', { actor: actor?.name, dest: plain(dest), test, noCheck, after: plain(services.location(actor)) }, result);
      return result;
    };
    wrapped.moveActor = (actor, delta, rotation, flags) => {
      const result = services.moveActor(actor, delta, rotation, flags);
      log('move', { actor: actor?.name, delta: plain(delta), rotation: plain(rotation), flags: flags && typeof flags === 'object' ? JSON.stringify(flags) : flags,
        after: plain(services.location(actor)) },
        result && typeof result === 'object' ? { time: result.time, actor: result.actor?.name ?? null, normal: plain(result.normal) } : result);
      return result;
    };
    wrapped.singleLineCheck = (source, end, start, flags, extent, extra) => {
      const hit = services.singleLineCheck(source, end, start, flags, extent, extra);
      log('slc', { source: source?.name, end: plain(end), start: plain(start), flags, extent: plain(extent), extra },
        hit && typeof hit === 'object' ? { time: hit.time, actor: hit.actor?.name ?? null } : hit);
      return hit;
    };
    return wrapped;
  };
  /** The native's entry (`begin`) and return (`end(result)`), around its worker. */
  trace.begin = (pawn, fn, target, location) => {
    if (!trace.pawns.has(pawn.name) || trace.tick < trace.first || trace.tick > trace.last) return null;
    trace.depth++;
    push({ ev: 'enter', fn, pawn: pawn.name, target: target?.name ?? plain(target), location: plain(location) });
    return { end(result, extra = {}) { push({ ev: 'ret', fn, result: result?.name ?? plain(result), ...extra }); trace.depth--; } };
  };
  return trace;
}
