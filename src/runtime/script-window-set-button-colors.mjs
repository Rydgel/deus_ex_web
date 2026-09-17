/**
 * Recovered Extension.dll XButtonWindow::SetButtonColors translation.
 *
 * The registered exec body evaluates six Color struct arguments (each
 * marshalled as a dword, script default 0x00ffffff) and tail-calls the
 * method at 0x10007940, which stores them into the color slot of the six
 * +0x1a4 style-table entries (stride 0x0c: {tex, buttonColor, textColor})
 * in order +0x1a8,+0x1b4,+0x1c0,+0x1cc,+0x1d8,+0x1e4, then calls the
 * shared style refresh at 0x10008380:
 *   - climb +0x138 while the current window's +0x30 byte has bit 1 set;
 *   - when the chain ends at null, focus = IsFocusWindow(this)
 *     (GetRootWindow: +0x138 to the topmost, keep when +0x28 >= 3, then the
 *     root's +0x5c8 focus window == this); otherwise focus state = 2;
 *   - index = state*2 + (this.+0x174 & 1); entry = table[index];
 *   - tex = entry.tex, falling back to table[1].tex (toggled) or
 *     table[0].tex when the entry texture is null;
 *   - write +0x18c = entry.textColor, +0x184 = tex, +0x188 = entry.color.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x100087b0 through 0x10008913,
 * method body 0x10007940 through 0x100079b6,
 * style refresh 0x10008380 through 0x10008440.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_SET_BUTTON_COLORS_NATIVE = freeze({
  package: 'Extension',
  function: 'ButtonWindow.SetButtonColors / XButtonWindow::SetButtonColors',
  packageExport: 975,
  nativeIndex: 1593,
  functionFlags: 0x401,
  serialSize: 46,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x100087b0,
  execEnd: 0x10008913,
  execSha256: '2a8f3c2325631b662989040c09f16f655cadbfc18460620f1ee5a2e0d31aa201',
  methodBody: 0x10007940,
  methodEnd: 0x100079b6,
  methodSha256: 'fd2eeab858c4dc25f8235d1ad8c4b70943548f674e04c2170262310efde2b713',
  refreshBody: 0x10008380,
  refreshEnd: 0x10008440,
  refreshSha256: 'a93dc1baf64348923639c08f8938ecd3f7310e1e5213f84d066d482f24d846cf',
});

export const WINDOW_SET_BUTTON_COLORS_ADDRESSES = freeze({
  body: WINDOW_SET_BUTTON_COLORS_NATIVE.methodBody,
  end: WINDOW_SET_BUTTON_COLORS_NATIVE.methodEnd,
  refresh: WINDOW_SET_BUTTON_COLORS_NATIVE.refreshBody,
});

/** Numeric byte offsets in the native XButtonWindow object. */
export const WINDOW_SET_BUTTON_COLORS_OFFSETS = freeze({
  vtable: 0x00,
  windowType: 0x28,
  sensitivity: 0x30,
  parent: 0x138,
  toggleFlags: 0x174,
  activeTex: 0x184,
  activeColor: 0x188,
  activeTextColor: 0x18c,
  styleTable: 0x1a4,
  rootFocusWindow: 0x5c8,
});

export const WINDOW_SET_BUTTON_COLORS_FIELDS =
  WINDOW_SET_BUTTON_COLORS_OFFSETS;

export const WINDOW_SET_BUTTON_COLORS_BITS = freeze({
  sensitive: 0x02,
  toggled: 0x01,
});

export const WINDOW_SET_BUTTON_COLORS_NATIVE_CONTRACT = freeze({
  name: 'XButtonWindow::SetButtonColors',
  address: WINDOW_SET_BUTTON_COLORS_NATIVE.methodBody,
  arguments: freeze([
    'Normal:color', 'pressed:color', 'normalFocus:color',
    'pressedFocus:color', 'normalInsensitive:color',
    'pressedInsensitive:color',
  ]),
  returns: 'void',
  rawStorage: 'read/write(object, offset, kind, ..., details)',
  fields: freeze({...WINDOW_SET_BUTTON_COLORS_OFFSETS}),
  callbacks: freeze([]),
});

export class WindowSetButtonColorsNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowSetButtonColorsNativeBoundaryError';
    this.code = `WINDOW_SET_BUTTON_COLORS_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowSetButtonColorsNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XButtonWindow::SetButtonColors ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XButtonWindow::SetButtonColors requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

function colorValue(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`XButtonWindow::SetButtonColors requires a dword ${name}`, {
      kind: 'VALUE', value, operation: name,
    });
  }
  return value >>> 0;
}

const present = value => value !== null && value !== undefined && value !== 0;

const F = WINDOW_SET_BUTTON_COLORS_OFFSETS;
const NATIVE = WINDOW_SET_BUTTON_COLORS_NATIVE;

function readRaw(object, offset, kind, services, phase) {
  const reader = services.read;
  if (typeof reader !== 'function') {
    fail('XButtonWindow::SetButtonColors requires read service', {
      kind: 'SERVICE', offset, operation: phase,
    });
  }
  return sync(reader(object, offset, kind, {
    native: NATIVE.refreshBody, phase, object, offset, kind,
    width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
}

function writeRaw(object, offset, kind, value, services, phase) {
  const writer = services.write;
  if (typeof writer !== 'function') {
    fail('XButtonWindow::SetButtonColors requires write service', {
      kind: 'SERVICE', offset, operation: phase,
    });
  }
  sync(writer(object, offset, kind, value, {
    native: NATIVE.refreshBody, phase, object, offset, kind,
    width: kind === 'u8' ? 1 : 4,
  }), `write +0x${offset.toString(16)}`);
}

/** GetRootWindow at 0x1004c5a0: climb +0x138 to the topmost window; keep it
 * only when its +0x28 type byte is at least 3. */
function getRootWindow(start, services, phase) {
  const seen = new Set([start]);
  let node = start;
  for (;;) {
    const parent = readRaw(node, F.parent, 'ptr', services, phase);
    if (!present(parent)) break;
    if (seen.has(parent)) {
      fail('XButtonWindow::SetButtonColors received a cyclic native parent chain', {
        kind: 'REFERENCE', value: parent, object: start, operation: phase,
      });
    }
    seen.add(parent);
    node = parent;
  }
  const type = readRaw(node, F.windowType, 'u8', services, phase);
  return type >= 3 ? node : null;
}

/** IsFocusWindow at 0x1004ca20: the root's +0x5c8 focus window == this. */
function isFocusWindow(object, services, phase) {
  const root = getRootWindow(object, services, phase);
  if (!present(root)) return 0;
  const focus = readRaw(root, F.rootFocusWindow, 'ptr', services, phase);
  return focus === object ? 1 : 0;
}

/** Style refresh at 0x10008380 (shared with ToggleWindow). */
function refreshButtonStyle(object, services) {
  const phase = 'style-refresh';
  const seen = new Set();
  let current = object;
  while (present(current)) {
    if (seen.has(current)) {
      fail('XButtonWindow::SetButtonColors received a cyclic native sensitivity chain', {
        kind: 'REFERENCE', value: current, object, operation: phase,
      });
    }
    seen.add(current);
    const flags = readRaw(current, F.sensitivity, 'u8', services, phase);
    if ((flags & WINDOW_SET_BUTTON_COLORS_BITS.sensitive) === 0) break;
    current = readRaw(current, F.parent, 'ptr', services, phase);
  }
  // A null chain end means every ancestor was sensitive; ecx survives as 2
  // when the walk stopped on an insensitive window.
  const state = present(current)
    ? 2
    : (isFocusWindow(object, services, phase) !== 0 ? 1 : 0);
  const toggleFlags = readRaw(object, F.toggleFlags, 'u32', services, phase);
  const toggle = toggleFlags & WINDOW_SET_BUTTON_COLORS_BITS.toggled;
  const index = state * 2 + toggle;
  const entry = F.styleTable + index * 12;
  const tex = readRaw(object, entry, 'ptr', services, phase);
  const color = readRaw(object, entry + 4, 'u32', services, phase);
  const textColor = readRaw(object, entry + 8, 'u32', services, phase);
  let selected = tex;
  if (!present(selected)) {
    if (toggle !== 0) {
      selected = readRaw(object, F.styleTable + 12, 'ptr', services, phase);
      if (!present(selected)) {
        selected = readRaw(object, F.styleTable, 'ptr', services, phase);
      }
    } else {
      selected = readRaw(object, F.styleTable, 'ptr', services, phase);
    }
  }
  writeRaw(object, F.activeTextColor, 'u32', textColor, services, phase);
  writeRaw(object, F.activeTex, 'ptr', selected, services, phase);
  writeRaw(object, F.activeColor, 'u32', color, services, phase);
}

/**
 * Execute the original method body: store the six color dwords into the
 * +0x1a4 style table (color slot at entry+4), then run the shared style
 * refresh.
 */
export function setButtonColorsNative(
  object, normal, pressed, normalFocus, pressedFocus,
  normalInsensitive, pressedInsensitive, services = {}) {
  objectReference(object, 'window');
  const phase = 'style-table-store';
  const colors = [
    colorValue(normal, 'Normal'),
    colorValue(pressed, 'pressed'),
    colorValue(normalFocus, 'normalFocus'),
    colorValue(pressedFocus, 'pressedFocus'),
    colorValue(normalInsensitive, 'normalInsensitive'),
    colorValue(pressedInsensitive, 'pressedInsensitive'),
  ];
  for (let index = 0; index < 6; index += 1) {
    writeRaw(object, F.styleTable + index * 12 + 4, 'u32', colors[index],
      services, phase);
  }
  refreshButtonStyle(object, services);
}

export const windowSetButtonColorsNative = setButtonColorsNative;
export const buttonWindowSetButtonColorsNative = setButtonColorsNative;
