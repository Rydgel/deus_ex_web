# Root window tick and tab-group traversal

Extension.dll `XRootWindow::Tick` 0x1003a540–0x1003a61f first checks
root+0x5c8 FocusWindow. With no focus, it walks visible children from the
top (GetTopChild(1), then GetLowerSibling(1)) to the first type >= 2, or
uses the root. If that modal's byte +0x174 is below 3, it tests preferred
focus +0x178 with IsTraversable(1), calls SetFocusWindow if accepted, then
calls MoveTabGroup(3) if focus is still null.

`MoveTabGroup` 0x1004f440–0x1004f613 finds the same top modal, recomputes
each group's location (0x10045000), and resorts the group table if any
location changed. A focused member of this modal chooses its adjacent
group; otherwise traversal starts at the first group. Directions 0 and 2
step backwards; the other values step forwards with wrap. Each group is
searched in its row-major order for IsTraversable(0). The first accepted
window is passed to SetFocusWindow. If a whole cycle has no candidate, the
existing focus is returned unchanged. HUD groups can exist without any
selectable/sensitive descendants; a nonempty table is not proof of focus.

The root then stores float32(lastButtonPress − delta) at +0x620, compares
the still-unrounded x87 result with zero, and clears the field if below or
unordered. Finally it calls `XModalWindow::Tick` 0x100374a0, whose only body
call is BuildAcceleratorTable 0x10037210. Script Tick dispatch belongs to
the surrounding root traversal, not this native family override.

The translation supplies the already recovered tree/family helpers and
SetFocusWindow as explicit services. Actual focus transitions retain those
helpers' supported boundaries. `validate-window-root-tick.mjs` compares 17
cases with the unchanged DLL: empty and insensitive groups, preferred focus,
modal suppression, forward/backward wrapping, layout-refresh call order,
float32 timer bits, signed zero, unordered subtraction, and subnormal values.
SetFocusWindow, group-location/reordering, and accelerator building are
explicit leaf boundaries in this comparison; it verifies their selection and
call order rather than revalidating their implementations.
