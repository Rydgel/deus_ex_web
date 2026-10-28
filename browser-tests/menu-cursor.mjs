/** The original menus' cursor follows relative motion under the pointer lock (src/viewer/window-pointer.mjs: a locked pointermove's
 * movementX/Y, scaled to the drawing buffer). `lockedMove` moves the mouse from `from` to `to` (CSS pixels) in `steps` as the page
 * sees it, in every browser project:
 *  - Chromium: the mouse's own moves (their movementX/Y are the steps).
 *  - Firefox: Playwright's moves under Firefox's pointer lock report movementX/Y as the point's offset from a fixed point, not the
 *    step (-430 and -420 for two 10-pixel steps, measured 2026-10-28), so the menus' cursor cannot be driven with them. The steps
 *    are dispatched instead, as pointermove events on the canvas carrying each step's movement, rounded as a mouse's would be; the
 *    page reads them as it reads the mouse's (it does not check isTrusted). Buttons stay the mouse's own: their events under the
 *    lock carry no movement in either browser (measured).
 *  - WebKit: dispatched as in Firefox (not measured).
 * Without the lock a pointer reaches the menus at its own position, and the mouse's own moves are used everywhere. */
export async function lockedMove(page, from, to, steps = 1) {
  const browser = page.context().browser()?.browserType().name() ?? 'chromium';
  if (browser === 'chromium' || !(await page.evaluate(() => Boolean(document.pointerLockElement)))) return page.mouse.move(to.x, to.y, { steps });
  const at = t => [Math.round(from.x + (to.x - from.x) * t), Math.round(from.y + (to.y - from.y) * t)];
  const deltas = [];
  for (let i = 1; i <= steps; i++) { const [x0, y0] = at((i - 1) / steps), [x1, y1] = at(i / steps); deltas.push([x1 - x0, y1 - y0]); }
  await page.evaluate(deltas => {
    const canvas = document.getElementById('scene');
    for (const [movementX, movementY] of deltas) canvas.dispatchEvent(new PointerEvent('pointermove', { movementX, movementY, bubbles: true, pointerType: 'mouse', isPrimary: true }));
  }, deltas);
}
