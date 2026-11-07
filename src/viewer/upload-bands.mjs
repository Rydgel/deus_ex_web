/** Rectangles of one texture page sent as fewer, larger ones (light-atlas.mjs flush).
 *
 * The light atlas is written tile by tile, and each written tile used to go up as its own texSubImage call: Battery Park
 * sends about 70 atlas rectangles a frame, each 2 to 5 KB, and a call costs Firefox about as much as 15 KB of
 * copying does. (The fog pages' tiles took the same helper in the branch this came from and measured worse: Battery Park's `p.fog`
 * +0.08 ms in 9 of 9 pairs, as 90 sparse tiles pay for the gap bytes; they are not banded. docs/firefox-60fps-plan.md
 * "Unshipped bundle".) The CPU copy of a page is always current (every writer writes its pixels at once and defers only the upload), so a
 * rectangle that takes in a gap between two dirty tiles sends texels the GPU already holds: the same bytes again, never different
 * ones. A page's tiles are packed in rows (shelves), so tiles written together lie side by side, and the sweep below joins a
 * rectangle to the band before it when they share rows and the join costs no more than the call it saves.
 *
 * ?uploadBands=off (DEUS_EX_UPLOAD_BANDS=off, UPLOAD_BANDS=off in Node) sends every rectangle as it is. */

/** What one upload call costs, in bytes of copying. */
export const CALL_BYTES = 16384;

export const uploadBandsOn = () => ((typeof process !== 'undefined' && process.env?.UPLOAD_BANDS) || globalThis.DEUS_EX_UPLOAD_BANDS) !== 'off';

/** `rects`: [x, y, width, height, ...] arrays of one page. Returns the rectangles to send: an unmerged one is the very array it was,
 * a merged band a new [x, y, width, height]. A rectangle joins the band when it starts above the band's bottom edge and the union adds
 * at most `callBytes` over the two areas (4 bytes a texel). */
export function coalesceRects(rects, callBytes = CALL_BYTES) {
  if (rects.length < 2) return rects;
  const order = rects.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  let band = order[0];
  for (let i = 1; i < order.length; i++) {
    const rect = order[i];
    const x0 = Math.min(band[0], rect[0]), y0 = Math.min(band[1], rect[1]);
    const x1 = Math.max(band[0] + band[2], rect[0] + rect[2]), y1 = Math.max(band[1] + band[3], rect[1] + rect[3]);
    if (rect[1] < band[1] + band[3] && 4 * ((x1 - x0) * (y1 - y0) - band[2] * band[3] - rect[2] * rect[3]) <= callBytes) band = [x0, y0, x1 - x0, y1 - y0];
    else { out.push(band); band = rect; }
  }
  out.push(band);
  return out;
}
