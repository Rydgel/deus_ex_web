/** The mouse wheel into the original's input events (docs/input-bindings.md "The mouse wheel").
 *
 * The original half is WinDrv.dll's ViewportWndProc (0x11109b30), WM_MOUSEWHEEL (0x20a) case at 0x1110b29e (the registered
 * MSWHEEL_ROLLMSG message jumps into it with wParam = delta << 16, 0x11109b97). One message, whatever its delta:
 *   delta = (signed 16-bit) HIWORD(wParam); a zero delta does nothing;
 *   CauseInputEvent(IK_MouseW,         IST_Axis,    (FLOAT) delta)   the raw delta, not divided by WHEEL_DELTA
 *   CauseInputEvent(IK_MouseWheelUp,   IST_Press,   0) then (.., IST_Release, 0)   for delta > 0
 *   CauseInputEvent(IK_MouseWheelDown, IST_Press,   0) then (.., IST_Release, 0)   for delta < 0
 * `wheelMessage` is that sequence; the host (game.mjs inputWheel) runs it through UEngine::InputEvent.
 *
 * The platform half is this page's rule, not the original's: a browser delivers wheel events in pixels, lines or pages, and
 * Chromium coalesces the notches of a frame into one event, while Windows delivers one message of WHEEL_DELTA (120) per notch.
 * `wheelUnits` converts an event to Windows' units and `createWheelAccumulator` cuts them into messages of one notch. */

export const WHEEL_DELTA = 120;
/** The most notches one browser event is cut into (a frame's worth of a very fast spin); the rest of its delta is dropped. */
export const MAX_NOTCHES_PER_EVENT = 8;
/** A partial notch (a touchpad's, a high-resolution wheel's) is forgotten after this many milliseconds without wheel events. */
export const WHEEL_IDLE_MS = 500;
/** WheelEvent.deltaMode */
const DOM_DELTA_LINE = 1, DOM_DELTA_PAGE = 2;
/** Windows scrolls SPI_GETWHEELSCROLLLINES lines per notch (3 by default) and one page when it is WHEEL_PAGESCROLL. */
const LINES_PER_NOTCH = 3;
/** Chromium on Windows reports a 120-unit notch as 100 pixels of deltaY (a wheel's `wheelDeltaY` is exactly the unit when present). */
const PIXELS_PER_NOTCH = 100;

/** EInputAction values (Engine.u) the sequence uses. */
export const IST = Object.freeze({ press: 1, release: 3, axis: 4 });

/** The CauseInputEvent calls of one WM_MOUSEWHEEL whose HIWORD(wParam) is `delta`, in WinDrv's order. */
export function wheelMessage(delta) {
  const signed = (Number(delta) << 16) >> 16;   // HIWORD(wParam) is a signed 16-bit value (movsx edx, di at 0x1110b2ac)
  if (signed === 0) return [];
  const key = signed > 0 ? 'MouseWheelUp' : 'MouseWheelDown';
  return [{ name: 'MouseW', action: IST.axis, delta: signed },
    { name: key, action: IST.press, delta: 0 }, { name: key, action: IST.release, delta: 0 }];
}

/** A browser WheelEvent in Windows' wheel units (WHEEL_DELTA = 120 per notch, positive = away from the user, as WM_MOUSEWHEEL).
 * Lines count 40 each (three lines to a notch), a page is one notch, pixels use the browser's own tick count (`wheelDeltaY`, the
 * legacy attribute Chromium and Safari fill from the platform's notches) or else 1.2 each (100 pixels to a notch). */
export function wheelUnits(event) {
  const dy = Number(event.deltaY) || 0;
  if (event.deltaMode === DOM_DELTA_PAGE) return 0 - dy * WHEEL_DELTA;
  if (event.deltaMode === DOM_DELTA_LINE) return 0 - dy * (WHEEL_DELTA / LINES_PER_NOTCH);
  const legacy = Number(event.wheelDeltaY);
  if (Number.isFinite(legacy) && legacy !== 0 && Math.sign(legacy) === -Math.sign(dy)) return legacy;
  return 0 - dy * (WHEEL_DELTA / PIXELS_PER_NOTCH);
}

/** Wheel units in, WM_MOUSEWHEEL deltas (+-120) out. The remainder under a notch waits for the next event; a reversal of
 * direction or a pause of WHEEL_IDLE_MS drops it. */
export function createWheelAccumulator({ idleMs = WHEEL_IDLE_MS } = {}) {
  let sum = 0, last = -Infinity;
  return {
    push(units, time = 0) {
      if (!Number.isFinite(units) || units === 0) return [];
      if (time - last > idleMs || Math.sign(units) !== Math.sign(sum)) sum = 0;
      last = time;
      sum += units;
      const notches = [], step = Math.sign(sum) * WHEEL_DELTA;
      while (Math.abs(sum) >= WHEEL_DELTA) {
        if (notches.length < MAX_NOTCHES_PER_EVENT) notches.push(step);
        sum -= step;
      }
      return notches;
    },
    get pending() { return sum; },
    reset() { sum = 0; last = -Infinity; },
  };
}
