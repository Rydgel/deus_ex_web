/**
 * The native net-field ordering helper reached by UClass::Link.
 *
 * Core.dll does not call the CRT qsort here.  `0x1012b690` is a small
 * iterative quicksort with a selection-sort path for ranges of eight or
 * fewer entries.  The comparator is supplied by the caller because the
 * JavaScript records do not have the native +0x10/+0x14 layout by default.
 */

export const SCRIPT_NET_FIELD_SORT = Object.freeze({
  thunk: 0x101012bc,
  body: 0x1012b690,
  elementSize: 4,
  smallRange: 8,
  offsets: Object.freeze({
    sortPresence: 0x10,
    sortValue: 0x14,
  }),
});

export class UnsupportedScriptNetFieldSortError extends Error {
  constructor(message, { operation = 'native net-field sort', slot = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptNetFieldSortError';
    this.code = 'UNSUPPORTED_SCRIPT_NET_FIELD_SORT';
    this.operation = operation;
    this.slot = slot;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptNetFieldSortError(message, details);
}

function integer(value, label, { minimum = null, maximum = null } = {}) {
  if (value === null || value === undefined) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) ||
      (minimum !== null && number < minimum) ||
      (maximum !== null && number > maximum)) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function swap(data, left, right) {
  const value = data[left];
  data[left] = data[right];
  data[right] = value;
}

function sortSmallRange(data, low, high, compare) {
  // 0x1012b7d2..0x1012b80f selects the greatest remaining item and places it
  // at the current high end.  The strict `> 0` test deliberately leaves an
  // equal candidate in its earlier position; the swap still occurs at the
  // end of every pass, including when the selected index is already high.
  for (let end = high; end > low; end -= 1) {
    let selected = low;
    for (let index = low + 1; index <= end; index += 1) {
      if (compare(data[index], data[selected]) > 0) selected = index;
    }
    swap(data, selected, end);
  }
}

function sortLargeRange(data, low, high, compare) {
  // 0x1012b6e5..0x1012b761.  For ranges above eight entries the native code
  // swaps the first element with element floor(Num / 2), then partitions
  // around the element now at the first position.
  const count = high - low + 1;
  const middle = low + Math.floor(count / 2);
  swap(data, low, middle);

  let left = low + 1;
  let right = high;
  for (;;) {
    while (left <= high && compare(data[left], data[low]) <= 0) left += 1;
    while (right > low && compare(data[right], data[low]) >= 0) right -= 1;
    if (left > right) break;
    swap(data, left, right);
    left += 1;
    right -= 1;
  }

  // The element at low is moved to the final right-scan position.  Native
  // partitioning then treats [low, right - 1] and [left, high] as the two
  // pending ranges.
  swap(data, low, right);
  return { left, pivot: right };
}

/**
 * Mutate and return the same array using Core.dll's `0x1012b690` ordering.
 *
 * `detail.comparator(left, right)` must implement the native signed
 * comparison: positive means left belongs after right, negative means it
 * belongs before, and zero means equal.  The comparator is called only on
 * the branches where the original helper reads candidate +0x10/+0x14.  An
 * explicit `detail.count` sorts only the first count entries and leaves the
 * remaining array tail untouched.
 */
export function sortScriptNetFields(data, detail = {}) {
  if (!Array.isArray(data)) {
    throw new TypeError('Native net-field sort requires a mutable JavaScript array');
  }
  if (detail === null || typeof detail !== 'object') {
    throw new TypeError('Native net-field sort requires a detail object');
  }

  const count = detail.count === undefined
    ? data.length
    : integer(detail.count, 'net-field count', { minimum: 0, maximum: data.length });
  const compare = detail.comparator;
  if (count >= 2 && typeof compare !== 'function') {
    fail('Native net-field sort requires detail.comparator for two or more entries', {
      operation: 'sort-net-fields',
    });
  }

  // The native body returns before touching the data pointer for Num < 2.
  if (count < 2) return data;

  const pending = [];
  let low = 0;
  let high = count - 1;

  for (;;) {
    const rangeCount = high - low + 1;
    if (rangeCount <= SCRIPT_NET_FIELD_SORT.smallRange) {
      sortSmallRange(data, low, high, compare);
    } else {
      const { left, pivot } = sortLargeRange(data, low, high, compare);
      const leftMetric = pivot - low - 1;
      const rightMetric = high - left;

      // Native code processes the smaller partition immediately and stores
      // the larger one in its explicit 8-byte range stack.  The strict
      // comparison is observable for equal-size partitions.
      if (leftMetric < rightMetric) {
        if (left < high) pending.push({ low: left, high });
        if (low + 1 < pivot) {
          high = pivot - 1;
        } else {
          if (pending.length === 0) break;
          ({ low, high } = pending.pop());
        }
        continue;
      }

      if (low + 1 < pivot) pending.push({ low, high: pivot - 1 });
      if (left < high) {
        low = left;
        continue;
      }
      if (pending.length === 0) break;
      ({ low, high } = pending.pop());
      continue;
    }

    if (pending.length === 0) break;
    ({ low, high } = pending.pop());
  }

  return data;
}

export default sortScriptNetFields;
