/** The host's clocks as the simulation reads them (docs/sim-worker.md
 * "Clocks"): appSeconds-style millisecond time (performance.now) and the
 * wall-clock date. On the page they are the browser's own. The simulation
 * worker sets a source each frame from the page's clocks at the frame's
 * post, so a worker reads the page's time, frozen for the frame, and a run
 * under a page's fake clock stays reproducible. */
let source = null;

/** Milliseconds, as performance.now(). */
export const hostNow = () => source ? source.now : performance.now();
/** The wall-clock date. */
export const hostDate = () => source ? new Date(source.date) : new Date();
/** `next` {now, date} (milliseconds), or null for the browser's clocks. */
export function setHostClock(next) { source = next; }
