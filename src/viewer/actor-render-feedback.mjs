/** Original Render.dll 0x10b25150..0x10b25161 copies LevelInfo.TimeSeconds
 * to the submitted actor's LastRenderTime. Wire this to a mesh draw callback,
 * never to simulation or pose updates. Zone visibility is a separate contract
 * (Model.Zones, not ZoneInfo.LastRenderTime); see script-loadmap-startup.md. */
export function actorRenderFeedback(runtime, actor) {
  const last = runtime.namedReference(actor, 'LastRenderTime');
  const hidden = runtime.namedReference(actor, 'bHidden');
  const deleted = runtime.namedReference(actor, 'bDeleteMe');
  const time = runtime.namedReference(runtime.levelFor(actor).actors[0], 'TimeSeconds');
  return () => {
    if (!hidden.get() && !deleted.get()) last.set(Math.fround(time.get()));
  };
}
