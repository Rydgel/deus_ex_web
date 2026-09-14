import {fastLineCheck} from './fast-line-check.mjs';

/** Original Actor.execTrace103e3330. Unlike TraceActors this native wrapper
 * selects through SingleLineCheck and supplies its blocking-only generic flag.
 * The complete query adapter owns output-buffer behavior. */
export function scriptTrace(queries, source, end, start = source.position, traceActors = Boolean(source.flags & 1), extent = [0,0,0]) {
  return queries.lineCheck(start.map(Math.fround), end.map(Math.fround), extent.map(Math.fround), traceActors ? 0x37 : 6, 0, source);
}

/** Original Actor.execFastTrace103e35e0 (native index 548): evaluates End then
 * Start (default = this->Location pre-stored before the optional argument's
 * expression runs), pushes both vectors by value and returns
 * Level->Model->FastLineCheck(End, Start) masked to a byte — the exec keeps
 * only AL, so a callee return of 0x100 reads back false. Geometry only —
 * no actor collision and no hit outs. Evidence: docs/script-trace.md. */
export function scriptFastTrace(model, source, end, start = source.position, check = fastLineCheck) {
  return Boolean(check(model, end.map(Math.fround), start.map(Math.fround)) & 0xff);
}
