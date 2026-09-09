/** Original Actor.execTrace103e3330. Unlike TraceActors this native wrapper
 * selects through SingleLineCheck and supplies its blocking-only generic flag.
 * The complete query adapter owns output-buffer behavior. */
export function scriptTrace(queries, source, end, start = source.position, traceActors = Boolean(source.flags & 1), extent = [0,0,0]) {
  return queries.lineCheck(start.map(Math.fround), end.map(Math.fround), extent.map(Math.fround), traceActors ? 0x37 : 6, 0, source);
}
