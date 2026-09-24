# Scroll-area preferred sizing

Original contract recorded before translation: installed Extension.dll SHA-256
93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c, and its
native class declarations in Extension.u. This slice addresses preferred sizing;
configuration, drawing and input remain separate guarded native overrides.

* Scale.ParentRequestedPreferredSize (3f780) ignores proposed constraints, takes
  componentwise x87 C0 maxima of scale/thumb/tick texture extents including their
  respective borders, then adds twice each scale margin. Thumb caps are not part
  of this preferred-size calculation. ComputeTextureSize is the existing body.
* Manager.ParentRequestedPreferredSize (420e0) queries visible children bottom
  to higher sibling, accumulating their dimensions through AddToBoundingBox
  (41e40): along-axis sum plus spacing after the first child, cross-axis maximum.
  Orientation dword+15c equals 1 for vertical; margins+164/+168 double at the end.
* Clip.GetChild (bb40) reads the top child without visibility filtering. If it is
  invisible the original calls GetLowerSibling on the **clip itself** (bb7e),
  not the child. Preserve this behavior; a repeating hidden result cannot finish.
* Clip.GetChildUnits (bd50) returns 1/1 or QueryGranularity when flag4 is set.
  GetClipPreferredSize (bfa0) applies nonnegative unit counts+17c/+180 only on
  unconstrained axes. GetChildPreferredSize (be60) combines these constraints
  with force-size flags0/1, writes the child's temporary rectangle+a4..b0,
  and calls width/height/both preferred queries for unforced axes. Scroll
  positions+174/+178 supply the unconstrained offsets. No child delegates to
  the original TabGroup preferred-size implementation.
* QueryClipPreferredSize (bbd0) first applies nonnegative hard sizes+9c/+a0,
  seeds unconstrained dimensions to 10, computes the child rectangle and overflow
  booleans using C0 (including unordered), then restores explicitly fixed sizes.
* ScrollArea.ComputeChildSizes (432d0; virtual wrapper438f0) reads visible manager
  and clip pointers. Missing/invisible clip zeros visible manager rectangles and
  returns 10/10. Otherwise it queries manager thicknesses, subtracts margins and
  chosen bars from supplied dimensions, and iterates clip preferred queries to
  resolve auto-hide. Trial count is 1, 2 or 4; the final extra trial forces all
  eligible bars on. It writes last-show bits1/2 and clip/manager temporary
  rectangles. The original final height adds **twice marginWidth**, not
  marginHeight (43698..436c7); preserve its stores and x87 rounding.

Before host wiring, compare original full method outputs, mutated object images
and query order on bounded cases covering both orientations, forced axes,
hard/unit sizes, visible/missing children, auto-hide convergence and fallback.
Inherited query/TabGroup services are explicit at the comparison boundary.

The first host run reaches Tile.ParentRequestedGranularity (48860) through the
clip content. This override calls the Window script bridge first, then uses the
first visible top child. Equal-width flag4 replaces horizontal granularity with
child.width plus vertical spacing for orientation1, horizontal spacing otherwise;
equal-height flag8 analogously uses child.height plus the other spacing. Empty
content and unset flags preserve the script results. QueryGranularity supplies
its existing clamp to at least 1. Recover and compare this dependency before
continuing the original medical sizing path.

## Verification and host integration

29 original-DLL cases pass, comparing complete output bytes, all receiver/child
images (including preferred-size cache state), and ordered script sizing/
granularity services. They cover scale texture fallback, unequal margins and
borders, both manager orientations, hidden/empty children, all four Clip force
combinations, unit/hard dimensions, Clip's hidden-top lookup, fixed and automatic
scrollbars, cross-axis overflow, retained last-show bits, and the auto-hide trial
limit. One case executes the full original ScrollArea -> Manager -> Scale and
Clip chain with only content script queries supplied as services. Four cases
compare Tile granularity's base-script call, orientations, equal-size flags,
hidden children and empty content.

The host now dispatches the four preferred-size overrides and Tile granularity.
Training MedicalBot.Frob returns from its original QueryPreferredSize call with
a nonempty clip rectangle, then stops explicitly at
ScrollAreaWindow.ConfigurationChanged (437c0). Initialization, baseline and
accelerator checks remain in the same integration validator. The independent
RepairBot path retains its Actor.PlaySound boundary.

This closes the preferred-sizing slice, not full screen layout. Child placement,
configuration notifications, visible range/position callbacks, drawing, input
and cleanup remain unsupported at their existing explicit boundaries. No visual
equivalence or full Stage 3 completion is claimed.

Reproduce: `node scripts/validate-window-scroll-layout.mjs`,
`node scripts/validate-window-baseline-play.mjs`, and `npm run build`.
The focused comparisons and integration/build pass; no full sweep is needed.

Follow-up: [child configuration](script-window-scroll-configuration.md) now
completes the reached placement/count/range/sensitivity chain. MedicalBot's next
boundary is Actor.PlaySound in SetMedicalBot; draw/input/cleanup remain guarded.
