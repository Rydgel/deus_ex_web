/** Original Render.dll 0x10b25150..0x10b25161 copies LevelInfo.TimeSeconds
 * to the submitted actor's LastRenderTime. Wire this to a mesh draw callback,
 * never to simulation or pose updates. Zone visibility is a separate contract
 * (Model.Zones, not ZoneInfo.LastRenderTime); see script-loadmap-startup.md.
 *
 * Called with the renderer (three's onAfterRender passes it), an actor
 * drawn by several groups stamps once per renderer.render call: no script
 * runs inside a pass, so a repeat would write the same value or nothing.
 * Without a renderer every call stamps. */
export function actorRenderFeedback(runtime, actor) {
  const last = runtime.namedReference(actor, 'LastRenderTime');
  const hidden = runtime.namedReference(actor, 'bHidden');
  const deleted = runtime.namedReference(actor, 'bDeleteMe');
  const time = runtime.namedReference(runtime.levelFor(actor).actors[0], 'TimeSeconds');
  let stampedPass = -1;
  return renderer => {
    const pass = renderer?.info?.render.frame;
    if (pass !== undefined) { if (pass === stampedPass) return; stampedPass = pass; }
    if (!hidden.get() && !deleted.get()) last.set(Math.fround(time.get()));
  };
}
