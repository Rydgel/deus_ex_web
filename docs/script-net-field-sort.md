# GOTY native net-field sort contract

This document records the helper reached by `UClass::Link` after it shrinks
the class net-field FArray.  The evidence is the installed Deus Ex GOTY
`Core.dll` (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`) and
`.cache/reference/Core-rng.asm`.

The PE thunk `0x101012bc` jumps to body `0x1012b690`.  The caller at
`0x10128077` passes the FArray data pointer first and its `Num` second; the
body treats each element as a four-byte pointer.  It returns immediately for
`Num < 2`.

The comparator is inlined in the native helper.  During both partition scans
and the small-range selection scan it reads the candidate and pivot/selected
objects at `+0x10`.  If either word is zero, the comparison is equal and the
corresponding `+0x14` word is not read.  If both are nonzero, it computes the
signed 32-bit difference `candidate[+0x14] - pivot[+0x14]`.  The standalone
adapter [`src/runtime/script-net-field-sort.mjs`](../src/runtime/script-net-field-sort.mjs)
receives this already translated behavior as `detail.comparator(left,right)`;
positive, negative, and zero results must have the same meaning.  It does not
replace the native comparator with a key guess.

## Exact ordering

The helper keeps an explicit stack of inclusive pointer ranges.  It processes
the smaller partition immediately and pushes the larger partition, with the
strict size comparison deciding which side is pushed when their sizes match.
The stack avoids recursive calls.

For an inclusive range `[low, high]` with more than eight entries, it first
swaps `data[low]` with `data[low + floor((high-low+1)/2)]`.  The element now at
`low` is the pivot.  It then repeats these scans:

1. Advance `left` from `low + 1` while `compare(data[left], data[low]) <= 0`.
2. Decrease `right` from `high` while `compare(data[right], data[low]) >= 0`.
3. If `left <= right`, swap those two entries, advance `left`, decrease
   `right`, and repeat.

When the scans cross, it swaps the pivot at `low` with `data[right]`.  The
pending ranges are `[low, right-1]` and `[left, high]`; one-entry ranges are
discarded.  If the left metric `right-low-1` is strictly less than the right
metric `high-left`, the right range is pushed and the left range is processed.
Otherwise the left range is pushed and the right range is processed.  These
strict inequalities and the swap after each scan are observable with equal
keys.

Ranges of eight or fewer entries bypass partitioning.  The body at
`0x1012b7d2` performs selection sort: for each decreasing `end`, it scans from
`low+1` through `end`, replacing the selected index only when the candidate
compares strictly greater (`> 0`), then swaps the selected entry with
`data[end]`.  It performs that swap even when the selected index already is
`end`, and equal candidates therefore retain the native, non-stable movement
pattern.

The implementation returns the identical input array and mutates only the
first `detail.count` entries when an explicit count is supplied.  A missing
comparator is an error for a count of two or more; no comparator is called for
zero- or one-entry input.  The implementation never calls JavaScript
`Array.sort`.

## Remaining boundary

The native helper's records are raw pointers.  This adapter intentionally
requires the caller to provide the exact comparator, including the `+0x10`
presence guard and signed `+0x14` difference already exposed by the class-link
translation.  It does not invent a record layout or silently order missing
native fields.
