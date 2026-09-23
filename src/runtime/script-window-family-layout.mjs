/** Original Extension.dll family layout, recovered before translation from
 * SHA256 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c.
 *
 * Tile ComputeChildSizes 0x10048a90: query children last-to-first, clear hidden
 * holds, equalize selected dimensions, build first-to-last 12-byte integer
 * {cross-size, along-size, count} records at +0x168, then either place children
 * when both parent dimensions are supplied or report preferred dimensions.
 * Orientation +0x14c=1 is vertical; +0x14d/+0x14e reverse axes; +0x164 has wrap,
 * fill, equal-width, equal-height bits 1/2/4/8. Each native _ftol and fst/fstp is
 * preserved. ConfigurationChanged 0x100489c0 configures visible children from
 * the holds. No script ConfigurationChanged bridge occurs in this override.
 *
 * TabGroup preferred 0x10045700 uses the script bridge unless flags&3, otherwise
 * maximizes child queries (including child margins unless flags&2). RadioBox
 * preferred 0x100388e0 maximizes child queries; configuration 0x10038840 fills
 * visible children. Both enumerate top-to-bottom, opposite Tile placement.
 * Text preferred 0x100465a0 acquires a GC; nonempty text uses TextExtent and
 * optional font-height line constraints, empty text uses background dimensions
 * or the script bridge; minimum width is enforced only when unconstrained.
 * GC/font measurement remains an explicit recovered-host service.
 *
 * Original reference cases were captured before implementation in the ignored
 * .cache/hud-layout-20260923/ (all twelve tile orders, constrained/preferred
 * dimensions, fractional spacing, hidden children, equal dimensions, radio/tab).
 * The unchanged DLL matches 57/57 layout cases and 39/39 text preferred-size
 * cases, including every recorded configuration/GC leaf call (2026-09-23).
 * Query/GC leaves use controlled responses: this verifies each native family
 * body's control flow, arithmetic and ABI boundary, not font rasterization.
 */
import {O, c0, topChild, bottomChild, lowerSibling, higherSibling,
  queryPreferredSize, queryPreferredWidth, queryPreferredHeight} from './script-window-tree-natives.mjs';
import {x87load as X, x87int32 as I, x87add as A, x87neg as N,
  x87mul as M, x87store as S, x87ftol as T} from './script-vm.mjs';
const f = Math.fround;
const sum = (...values) => values.map(X).reduce(A);
const diff = (a, b) => A(a, N(b));
const below = (a, b) => {
  if (a.nan !== undefined || b.nan !== undefined) return true;
  if (a.inf || b.inf) {
    if (a.inf && b.inf) return Boolean(a.neg && !b.neg);
    return a.inf ? Boolean(a.neg) : !b.neg;
  }
  const d = diff(a, b); return Boolean(d.neg && d.sig);
};
const above = (a, b) => below(b, a) && a.nan === undefined && b.nan === undefined;
const scriptPreferredSize = (W, win, bW, w, bH, h) => {
  const args = [Boolean(bW), f(w), Boolean(bH), f(h)];
  W.processScript(win, 'ParentRequestedPreferredSize', args);
  return {width: f(args[1]), height: f(args[3])};
};

export function tileComputeChildSizes(W, win, bW, w, bH, h) {
  w = f(w); h = f(h);
  const flags = () => W.u32(win, 0x164);
  const vertical = () => W.u8(win, 0x14c) === 1;
  let forceW = false, forceH = false, inner = 0;
  if (!(flags() & 1) && (flags() & 2)) {
    if (vertical() && bW) {
      forceW = true;
      const x = diff(X(w), sum(W.f32(win, 0x150), W.f32(win, 0x150)));
      inner = below(x, X(0)) ? 0 : S(x);
    } else if (!vertical() && bH) {
      forceH = true;
      const x = diff(X(h), sum(W.f32(win, 0x154), W.f32(win, 0x154)));
      inner = below(x, X(0)) ? 0 : S(x);
    }
  }
  let maxW = 0, maxH = 0;
  for (let child = W.ptr(win, O.lastChild); child; child = W.ptr(child, O.prevSibling)) {
    if (!(W.u8(child, O.flags) & 1)) {
      for (const offset of [O.holdWidth, O.holdHeight, O.holdX, O.holdY]) W.setF32(child, offset, 0);
      continue;
    }
    let size;
    if (forceW) {
      W.setF32(child, O.holdWidth, inner);
      size = {width: inner, height: queryPreferredHeight(W, child, inner)};
    } else if (forceH) {
      W.setF32(child, O.holdHeight, inner);
      size = {width: queryPreferredWidth(W, child, inner), height: inner};
    } else size = queryPreferredSize(W, child, 0, 0, 0, 0);
    W.setF32(child, O.holdWidth, size.width); W.setF32(child, O.holdHeight, size.height);
    if ((flags() & 4) && c0(maxW, size.width)) maxW = size.width;
    if ((flags() & 8) && c0(maxH, size.height)) maxH = size.height;
  }
  if (flags() & 12) for (let child = bottomChild(W, win, true); child; child = higherSibling(W, child, true)) {
    if (flags() & 4) W.setF32(child, O.holdWidth, maxW);
    if (flags() & 8) W.setF32(child, O.holdHeight, maxH);
  }
  let limit = 1000000;
  if (flags() & 1) {
    if (bW && !vertical()) limit = S(diff(X(w), sum(W.f32(win, 0x150), W.f32(win, 0x150))));
    if (bH && vertical()) limit = S(diff(X(h), sum(W.f32(win, 0x154), W.f32(win, 0x154))));
  }
  W.farray.empty(win, 0x168, 12);
  const readRow = (index, field) => W.heap.mem.read(W.farray.data(win, 0x168) + index * 12 + field * 4, 'i32');
  const writeRow = (index, field, value) => W.heap.mem.write(W.farray.data(win, 0x168) + index * 12 + field * 4, 'i32', value | 0);
  let cross = T(X(inner)), along = 0, count = 0;
  const append = () => {
    const index = W.farray.add(win, 0x168, 1, 12);
    [cross, along, count].forEach((value, field) => writeRow(index, field, value));
  };
  for (let child = bottomChild(W, win, true); child; child = higherSibling(W, child, true)) {
    const childCross = W.f32(child, vertical() ? O.holdWidth : O.holdHeight);
    const childAlong = W.f32(child, vertical() ? O.holdHeight : O.holdWidth);
    if (count > 0 && above(A(I(along), X(childAlong)), X(limit))) {
      along = T(diff(I(along), X(W.f32(win, 0x158)))); append();
      cross = T(X(inner)); along = 0; count = 0;
    }
    along = T(A(A(I(along), X(W.f32(win, 0x158))), X(childAlong)));
    if (below(I(cross), X(childCross))) cross = T(X(childCross));
    count++;
  }
  if (count > 0) { along = T(diff(I(along), X(W.f32(win, 0x158)))); append(); }
  if (bW && bH) {
    let x = W.f32(win, 0x150), y = W.f32(win, 0x154), row = 0;
    for (let child = bottomChild(W, win, true); child; child = higherSibling(W, child, true)) {
      const rowCross = readRow(row, 0), cw = W.f32(child, O.holdWidth), ch = W.f32(child, O.holdHeight);
      let hx, hy;
      if (vertical()) {
        hy = W.u8(win, 0x14e) === 1 ? S(diff(X(h), sum(y, ch))) : y;
        hx = W.u8(win, 0x14d) === 1 ? S(diff(X(w), A(I(rowCross), X(x)))) : x;
        switch (W.u8(win, 0x160)) {
          case 1: hx = S(A(I(Math.trunc(T(diff(I(rowCross), X(cw))) / 2)), X(hx))); break;
          case 2: hx = S(A(diff(I(rowCross), X(cw)), X(hx))); break;
          case 3: W.setF32(child, O.holdWidth, S(I(rowCross))); break;
        }
        y = S(sum(W.f32(win, 0x158), ch, y));
      } else {
        hy = W.u8(win, 0x14e) === 1 ? S(diff(X(h), A(I(rowCross), X(y)))) : y;
        hx = W.u8(win, 0x14d) === 1 ? S(diff(X(w), sum(x, cw))) : x;
        switch (W.u8(win, 0x161)) {
          case 1: hy = S(A(I(Math.trunc(T(diff(I(rowCross), X(ch))) / 2)), X(hy))); break;
          case 2: hy = S(A(diff(I(rowCross), X(ch)), X(hy))); break;
          case 3: W.setF32(child, O.holdHeight, S(I(rowCross))); break;
        }
        x = S(sum(W.f32(win, 0x158), cw, x));
      }
      W.setF32(child, O.holdX, hx); W.setF32(child, O.holdY, hy);
      writeRow(row, 2, readRow(row, 2) - 1);
      if (readRow(row, 2) < 1) {
        if (vertical()) { y = W.f32(win, 0x154); x = S(A(A(I(rowCross), X(W.f32(win, 0x15c))), X(x))); }
        else { x = W.f32(win, 0x150); y = S(A(A(I(rowCross), X(W.f32(win, 0x15c))), X(y))); }
        row++;
      }
    }
  } else {
    let outW = 0, outH = X(0);
    for (let row = 0; row < W.farray.num(win, 0x168); row++) {
      const rc = readRow(row, 0), ra = readRow(row, 1);
      if (vertical()) {
        const height = S(I(ra)); if (below(outH, X(height))) outH = X(height);
        outW = S(A(I(rc), X(outW)));
        if (row > 0) outW = S(sum(outW, W.f32(win, 0x15c)));
      } else {
        if (below(X(outW), I(ra))) outW = S(I(ra));
        outH = A(outH, I(rc));
        if (row > 0) outH = A(outH, X(W.f32(win, 0x15c)));
      }
    }
    if (!bW) w = S(sum(W.f32(win, 0x150), W.f32(win, 0x150), outW));
    if (!bH) h = S(A(sum(W.f32(win, 0x154), W.f32(win, 0x154)), outH));
  }
  return {width: w, height: h};
}

export function tileConfigurationChanged(W, win) {
  tileComputeChildSizes(W, win, true, W.f32(win, O.width), true, W.f32(win, O.height));
  for (let child = bottomChild(W, win, true); child; child = higherSibling(W, child, true))
    W.native.configureChild(child, ...[O.holdX, O.holdY, O.holdWidth, O.holdHeight].map(offset => W.f32(child, offset)));
}

export function radioBoxPreferredSize(W, win, bW, w, bH, h) {
  let width = 0, height = 0;
  for (let child = topChild(W, win, true); child; child = lowerSibling(W, child, true)) {
    const result = queryPreferredSize(W, child, bW, w, bH, h);
    if (c0(width, result.width)) width = result.width;
    if (c0(height, result.height)) height = result.height;
  }
  return {width, height};
}
export function radioBoxConfigurationChanged(W, win) {
  for (let child = topChild(W, win, true); child; child = lowerSibling(W, child, true))
    W.native.configureChild(child, 0, 0, W.f32(win, O.width), W.f32(win, O.height));
}
export function tabGroupPreferredSize(W, win, bW, w, bH, h) {
  if (!(W.u8(win, 0x164) & 3)) return scriptPreferredSize(W, win, bW, w, bH, h);
  let width = 0, height = 0;
  for (let child = topChild(W, win, true); child; child = lowerSibling(W, child, true)) {
    let {width: cw, height: ch} = queryPreferredSize(W, child, bW, w, bH, h);
    if (!(W.u8(win, 0x164) & 2)) {
      cw = S(sum(cw, W.f32(child, O.hMargin0))); ch = S(sum(ch, W.f32(child, O.vMargin0)));
      if (W.u8(child, O.hAlign) === 3) cw = S(sum(cw, W.f32(child, O.hMargin1)));
      if (W.u8(child, O.vAlign) === 3) ch = S(sum(ch, W.f32(child, O.vMargin1)));
    }
    if (c0(width, cw)) width = cw; if (c0(height, ch)) height = ch;
  }
  return {width, height};
}
export function tabGroupConfigurationChanged(W, win) {
  if (W.u8(win, 0x164) & 2) return radioBoxConfigurationChanged(W, win);
  return W.processScript(win, 'ConfigurationChanged', []);
}

export function textPreferredSize(W, win, bW, w, bH, h) {
  w = f(w); h = f(h);
  const gc = W.gc.get(win);
  if (!gc) return {width: w, height: h};
  const text = W.heap.read(win, 0x168, 'string');
  const minLines = W.i32(win, 0x15c), maxLines = W.i32(win, 0x160);
  if (text.length) {
    const wrap = bW && (W.u8(win, 0x150) & 1);
    const clipWidth = wrap ? S(diff(X(w), sum(W.f32(win, 0x154), W.f32(win, 0x154)))) : 0;
    const size = W.gc.textExtent(gc, clipWidth, text);
    // The constrained/min-lines path uses a temporary width pointer: retain w.
    if (!(!bH && (minLines >= 0 || maxLines >= 0) && wrap)) w = f(size.width);
    h = f(size.height);
    if (!bH && (minLines >= 0 || maxLines >= 0)) {
      const fontHeight = f(W.gc.fontHeight(gc, true));
      let height = X(h);
      if (minLines >= 0) {
        const min = M(I(minLines), X(fontHeight)); if (above(min, X(h))) height = X(S(min));
      }
      if (maxLines >= 0) {
        const max = S(M(I(maxLines), X(fontHeight))); if (above(X(h), X(max))) height = X(max);
      }
      h = S(height);
    }
    w = S(sum(W.f32(win, 0x154), W.f32(win, 0x154), w));
    h = S(sum(W.f32(win, 0x158), W.f32(win, 0x158), h));
  } else {
    const background = W.ptr(win, O.background);
    if (background) {
      h = S(I(W.i32(background, 0x38)));
      if (!bH && (minLines >= 0 || maxLines >= 0)) h = S(M(I(minLines >= 0 ? minLines : maxLines), X(f(W.gc.fontHeight(gc, true)))));
      w = S(I(W.i32(background, 0x34)));
    } else ({width: w, height: h} = scriptPreferredSize(W, win, bW, w, bH, h));
  }
  if (!bW && c0(w, W.f32(win, 0x164))) w = W.f32(win, 0x164);
  W.gc.release(win, gc);
  return {width: w, height: h};
}
