# Scroll-window movement

Contract recorded before translation from installed Extension.dll SHA-256
93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c.

* Scale.MoveThumb (3e860) maps 0/default to zero, 1 to count, 2/3 to
  position minus/plus one, 4/5 to minus/plus step, 6/7 to minus/plus span
  (or four without range mode). Arithmetic wraps signed32, then existing
  ChangeThumbPosition(position,0,1) clamps, computes geometry and broadcasts.
  SetTickPosition (3dff0) calls that same body with (position,0,1).
* TickToValue (3ebb0) uses count in range mode, count-1 otherwise. Positive
  denominator: min+(max-min)*tick/denominator, retained x87 arithmetic. Otherwise
  return the midpoint. ChangeScalePosition (3f5a0) captures position, wrapped
  end=position+span and float32 values before bubbling from self to ancestors.
  Range mode calls ScaleRangeChanged; ordinary mode calls ScalePositionChanged.
  A true result stops traversal; parent pointers are read after callbacks.
* Clip.SetChildPosition (b470) stores changed raw integer positions before
  looking up content. No content stops there. Force-axis bits make zero offsets;
  other offsets are float32(-unit*position), clamped to viewport-content then
  <=0. ConfigureChild runs under global100aeafc=self, restoring its previous
  value afterward. ClipPositionChanged bubbles with live position reads and
  parent pointers. Raw positions are not overwritten with clamped pixel values.
* ScrollArea.ScaleRangeChanged (43a50) calls script first. With a clip, it reads
  both current positions, replaces the matching horizontal/vertical coordinate
  with start, and calls SetChildPosition even for an unrelated source. Matching
  source returns true; otherwise preserve script result. End/value/notify do
  not affect the native action.
* ScrollArea.ClipPositionChanged (43c40) calls script first, then for its live
  clip sets horizontal then vertical tick positions, rereading pointers between
  calls, and returns true. Unrelated source preserves the script result.
* Manager.ButtonActivated (42720) calls script first, then tests the second
  button before the first; matching buttons MoveThumb(5/4) and return true.
  Missing scale/unrelated source returns the script result.
* Manager.ScalePositionChanged (42580) calls script first, then for its scale
  calls ChangeValueField (41da0); preserve the script result. ChangeValueField
  only proceeds with both value window and scale; GetValueString and the value
  window's +11c SetText virtual remain explicit services until recovered.
* ScrollArea.MouseButtonPressed (43d10) calls script first. Full integer keys
  236/237 are consumed even with no visible scale. A fully visible vertical
  scale moves with mode 4/5 respectively. Other keys preserve script result;
  script receives only the key's low byte.

Reference cases execute the original complete bodies and nested movement chain,
comparing full receiver/child images, return values, global context and ordered
script/configuration services before host integration. Existing geometry,
visibility, child lookup and attribute evidence is reused. Drawing, drag/repeat,
show-area and destruction are separate slices.

## Movement integration

41 complete original-DLL cases pass, with complete object images, ordered
callbacks/configuration, return values and restored context. Cases include
all MoveThumb modes, signed overflow, both range/value broadcasts, midpoint
fallback, live callback parent/position mutation, forced/clamped clip axes,
unchanged/empty clips, wheel visibility/key gates, button aliases and the full
ScrollArea -> Scale -> Clip -> ScrollArea feedback chain.

The host now binds these callbacks and ChangeScalePosition. Training's real
medical-screen manager down/up buttons traverse the original range/clip
callbacks and keep the thumb and clip row synchronized. Scale value formatting
remains an explicit boundary when a nonnull value field reaches it; Training's
scroll managers have no value field. Draw/drag/repeat/show-area/cleanup are not
claimed by this slice. Bot setup still reaches Actor.PlaySound.

Reproduce: `node scripts/validate-window-scroll-movement.mjs`,
`node scripts/validate-window-baseline-play.mjs`, and `npm run build`.
