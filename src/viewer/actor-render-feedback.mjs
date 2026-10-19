/** Original Render.dll 0x10b25150..0x10b25161 copies LevelInfo.TimeSeconds
 * to the submitted actor's LastRenderTime. Wire this to a mesh draw callback,
 * never to simulation or pose updates. Zone visibility is a separate contract
 * (Model.Zones, not ZoneInfo.LastRenderTime); see script-loadmap-startup.md.
 *
 * Called with the renderer (three's onAfterRender passes it), an actor
 * drawn by several groups stamps once per renderer.render call: no script
 * runs inside a pass, so a repeat would write the same value or nothing.
 * Without a renderer every call stamps.
 *
 * `canvas`: a Canvas.DrawActor submission (the first-person weapon or held item, Inventory.RenderOverlays). Its path, URender::DrawActor
 * (Render.dll 0x10b262c0) -> FDynamicSprite::Setup (0x10b23910: DrawType, Mesh, camera depth, bounds) -> DrawActorSprite, tests no bHidden
 * (that is the world pass's admission), so a held item, hidden since BecomeItem, is stamped: the original's held Multitool0 (bHidden 1) has
 * LastRenderTime equal to the level clock in every traced tick it is drawn (Stage 5 capture hck1, 2026-10-18). */
export function actorRenderFeedback(runtime, actor, { canvas = false } = {}) {
  const last = runtime.namedReference(actor, 'LastRenderTime');
  const hidden = runtime.namedReference(actor, 'bHidden');
  const deleted = runtime.namedReference(actor, 'bDeleteMe');
  const time = runtime.namedReference(runtime.levelFor(actor).actors[0], 'TimeSeconds');
  let stampedPass = -1;
  return renderer => {
    const pass = renderer?.info?.render.frame;
    if (pass !== undefined) { if (pass === stampedPass) return; stampedPass = pass; }
    if ((canvas || !hidden.get()) && !deleted.get()) last.set(Math.fround(time.get()));
  };
}
