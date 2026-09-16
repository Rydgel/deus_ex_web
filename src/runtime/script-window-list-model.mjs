/**
 * Shared recovered model for the Extension.dll XListWindow row/column
 * subsystem (natives 1720-1794).  The original implementation keeps a TArray
 * of 24-byte heap row nodes at this+0x170 and a TArray of 0x38-byte column
 * records at this+0x17c; row nodes carry a second TArray of 24-byte field
 * cells.  All heap traffic goes through the engine allocator (GMalloc ->
 * FMalloc vtable slots Malloc/Realloc/Free), so the translation requires a
 * byte-addressable native heap service instead of hidden JS storage.
 *
 * Evidence: Extension.dll bodies listed in each native module and
 * docs/script-window-list.md.  Nothing here is approximated.
 */

const freeze = Object.freeze;
const f = Math.fround;

export const LIST_WINDOW_DLL = freeze({
  dll: 'Extension.dll',
  imageBase: 0x10000000,
  oracleBase: 0x12000000,
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
});

/** XListWindow/XWindow fields recovered from the native bodies. */
export const LIST_WINDOW = freeze({
  vtable: 0x00,          // virtual 0x10c = selection-changed broadcast
  colPacked: 0x3d,       // dword copied into new column +0x1d
  defFont: 0x54,         // font copied into new column +0x24
  style: 0x130,          // style source read by the measure-context acquire
  context: 0x134,        // pooled measure-context object
  parent: 0x138,         // parent chain walked by the selection broadcast
  delimiter: 0x14c,      // FString row delimiter (data/count/max)
  rowsData: 0x170,       // TArray<RowNode*> data
  rowsCount: 0x174,
  rowsMax: 0x178,
  colsData: 0x17c,       // TArray<Column 0x38> data
  numCols: 0x180,        // the cols TArray count IS the column count
  colsMax: 0x184,
  flags: 0x188,          // bit0 sorting, bit1 autoExpand, bit2 multiSelect
  padX: 0x18c,           // float, doubled into the field width requirement
  padY: 0x190,           // float, doubled into the row height
  rowHeight: 0x19c,      // float, recomputed from column fonts
  numSelected: 0x1a8,
  selected: 0x1ac,       // cached selected row node
  selected2: 0x1b0,
});

export const LIST_ROW = freeze({
  size: 0x18,
  id: 0x00,              // int, renumbered to the array index after insert/sort
  flags: 0x04,           // bit0 selected
  fieldsData: 0x08,      // TArray<Field 0x18>
  fieldsCount: 0x0c,
  fieldsMax: 0x10,
  clientData: 0x14,
});

export const LIST_FIELD = freeze({
  size: 0x18,
  text: 0x00,            // FString data
  textCount: 0x04,
  textMax: 0x08,
  value: 0x0c,           // float parsed numeric value
  width: 0x10,           // float measured width (0 when the column has no font)
  height: 0x14,          // float measured height
});

export const LIST_COL = freeze({
  size: 0x38,
  index: 0x00,
  header: 0x04,          // FString (data/count/max)
  sortPriority: 0x10,    // int, lower sorts first; -1/0 excludes the column
  sortFlags: 0x14,       // bit0 reverse compare, bit1 case sensitive
  width: 0x18,           // float configured width
  flagByte: 0x1c,
  packed: 0x1d,          // dword copied from this+0x3d
  font: 0x24,            // font object (0 -> field measurement is skipped)
  type: 0x28,            // byte, low bits select text/numeric/time formatting
  format: 0x2c,          // FString custom format
});

/** Extension image scratch state (oracle-rebased addresses in metadata). */
export const LIST_GLOBALS = freeze({
  sortList: 0xa6f28,     // column pointer list, capacity 0x100
  sortCount: 0xa7348,
  emptyWString: 0x99ea8,
  fmtDefault: 0x988fc,   // "%f"
  fmtTime: 0x988e8,      // "%02h:%02m"
  tokenBuffer: 0xa5f10,
  sprintfBuffer: 0xa5810,
  fieldCopyBuffer: 0xa380c,
  newTag: 0x97988,       // "new"
});

export const LIST_FLAGS = freeze({sorting: 1, autoExpand: 2, multiSelect: 4});
export const SORT_REVERSE = 1;
export const SORT_CASE_SENSITIVE = 2;
export const ROW_SELECTED = 1;

export class ListWindowModelBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowModelBoundaryError';
    this.code = `LIST_MODEL_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const modelFail = (message, details) => {
  throw new ListWindowModelBoundaryError(message, details);
};

export function rejectAsync(value, label) {
  if (value && typeof value.then === 'function')
    modelFail(`ListWindow ${label} suspended`, {kind: 'ASYNC'});
  return value;
}

function requireMem(services) {
  const mem = services.mem;
  if (!mem || typeof mem.read !== 'function' || typeof mem.write !== 'function'
      || typeof mem.alloc !== 'function' || typeof mem.free !== 'function'
      || typeof mem.realloc !== 'function' || typeof mem.readString !== 'function'
      || typeof mem.allocString !== 'function')
    modelFail('ListWindow requires a raw native heap service (mem)', {kind: 'SERVICE'});
  return mem;
}

/** Checked accessors over the injected byte-addressable heap service. */
export function listMemory(object, services) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    modelFail('ListWindow requires a canonical window object', {kind: 'REFERENCE', value: object});
  const mem = requireMem(services);
  const base = rejectAsync(services.objectAddress ? services.objectAddress(object) : object.base, 'objectAddress');
  if (typeof base !== 'number' || !Number.isInteger(base) || base <= 0)
    modelFail('ListWindow requires the window heap address', {kind: 'SERVICE', value: base});
  const sync = (value, label) => rejectAsync(value, label);
  const int32 = value => {
    if (typeof value !== 'number' || !Number.isInteger(value))
      modelFail('ListWindow heap read returned a non-integer', {kind: 'VALUE', value});
    return value | 0;
  };
  const uint32 = value => {
    if (typeof value !== 'number' || !Number.isInteger(value))
      modelFail('ListWindow heap read returned a non-integer', {kind: 'VALUE', value});
    return value >>> 0;
  };
  const float32 = value => {
    if (typeof value !== 'number')
      modelFail('ListWindow heap read returned a non-number', {kind: 'VALUE', value});
    return f(value);
  };
  const checked = kind => {
    if (kind === 'i32' || kind === 'i16' || kind === 'i8') return int32;
    if (kind === 'u32' || kind === 'u16' || kind === 'u8') return uint32;
    if (kind === 'f32') return float32;
    return modelFail(`ListWindow unsupported heap kind ${kind}`, {kind: 'VALUE', value: kind});
  };
  const read = (address, kind) => checked(kind)(sync(mem.read(address, kind), `read 0x${address.toString(16)}`));
  const write = (address, kind, value) => sync(mem.write(address, kind, value), `write 0x${address.toString(16)}`);
  const alloc = (size, tag) => {
    const address = sync(mem.alloc(size, tag), 'alloc');
    return uint32(address);
  };
  const free = address => sync(mem.free(address), 'free');
  const realloc = (address, size, tag) => uint32(sync(mem.realloc(address, size, tag), 'realloc'));
  const readString = address => {
    const text = sync(mem.readString(address), 'readString');
    if (typeof text !== 'string')
      modelFail('ListWindow readString returned a non-string', {kind: 'VALUE', value: text});
    return text;
  };
  const allocString = text => uint32(sync(mem.allocString(text), 'allocString'));
  return {mem, base, read, write, alloc, free, realloc, readString, allocString};
}
