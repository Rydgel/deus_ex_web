/**
 * Recovered Extension.dll XCheckboxWindow::SetCheckboxTextures translation.
 *
 * The registered exec body evaluates four arguments (toggleOff, toggleOn
 * object pointers, textureWidth/textureHeight floats) and tail-calls the
 * method at 0x1000a840, which short-circuit compares each stored field:
 *   +0x1f4 (off ptr) read;   if != arg1 -> update
 *   +0x1f8 (on ptr)  read;   if != arg2 -> update
 *   +0x1fc (width)   fcomp;  if != arg3 -> update   (unordered counts equal)
 *   +0x200 (height)  fcomp;  if != arg4 -> update   (unordered counts equal)
 * The update writes +0x1f4, +0x1fc, +0x1f8, +0x200 in that order and calls
 * AskParentForReconfigure.  When every field matches nothing happens — the
 * reads themselves short-circuit at the first mismatch.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x1000afb0 through 0x1000b075,
 * method body 0x1000a840 through 0x1000a8db,
 * AskParentForReconfigure leaf at 0x1004e060.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_SET_CHECKBOX_TEXTURES_NATIVE = freeze({
  package: 'Extension',
  function:
    'CheckboxWindow.SetCheckboxTextures / XCheckboxWindow::SetCheckboxTextures',
  packageExport: 995,
  nativeIndex: 1840,
  functionFlags: 0x401,
  serialSize: 40,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x1000afb0,
  execEnd: 0x1000b075,
  execSha256: 'f17b90c66944cbdf9feb98d3027b67572ba9507bb10b10c7bc85fe129581b841',
  methodBody: 0x1000a840,
  methodEnd: 0x1000a8db,
  methodSha256: '182e4caa157afcaeec4f442a5bbc6c383cef941ca87b21f6571a2b25114bba1c',
});

export const WINDOW_SET_CHECKBOX_TEXTURES_ADDRESSES = freeze({
  body: WINDOW_SET_CHECKBOX_TEXTURES_NATIVE.methodBody,
  end: WINDOW_SET_CHECKBOX_TEXTURES_NATIVE.methodEnd,
});

/** Numeric byte offsets in the native XCheckboxWindow object. */
export const WINDOW_SET_CHECKBOX_TEXTURES_OFFSETS = freeze({
  textureOff: 0x1f4,
  textureOn: 0x1f8,
  textureWidth: 0x1fc,
  textureHeight: 0x200,
});

export const WINDOW_SET_CHECKBOX_TEXTURES_FIELDS =
  WINDOW_SET_CHECKBOX_TEXTURES_OFFSETS;

export const WINDOW_SET_CHECKBOX_TEXTURES_NATIVE_CONTRACT = freeze({
  name: 'XCheckboxWindow::SetCheckboxTextures',
  address: WINDOW_SET_CHECKBOX_TEXTURES_NATIVE.methodBody,
  arguments: freeze([
    'toggleOff:object', 'toggleOn:object',
    'textureWidth:float', 'textureHeight:float',
  ]),
  returns: 'void',
  rawStorage: 'read/write(object, offset, kind, ..., details)',
  fields: freeze({...WINDOW_SET_CHECKBOX_TEXTURES_OFFSETS}),
  callbacks: freeze(['AskParentForReconfigure (leaf, only when changed)']),
});

export class WindowSetCheckboxTexturesNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowSetCheckboxTexturesNativeBoundaryError';
    this.code = `WINDOW_SET_CHECKBOX_TEXTURES_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowSetCheckboxTexturesNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XCheckboxWindow::SetCheckboxTextures ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XCheckboxWindow::SetCheckboxTextures requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

function textureReference(value, name) {
  if (value === 0) return null;
  if (value !== null && value !== undefined &&
      typeof value !== 'object' && typeof value !== 'function') {
    fail(`XCheckboxWindow::SetCheckboxTextures requires canonical ${name} or none`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value ?? null;
}

/** x87 fcomp equality: equal OR unordered (either operand NaN). */
const fcompEqual = (a, b) => a === b || Number.isNaN(a) || Number.isNaN(b);

const F = WINDOW_SET_CHECKBOX_TEXTURES_OFFSETS;
const NATIVE = WINDOW_SET_CHECKBOX_TEXTURES_NATIVE;

function readField(object, offset, kind, phase, services) {
  return sync(services.read(object, offset, kind, {
    native: NATIVE.methodBody, phase, object, offset, kind,
    width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
}

function writeField(object, offset, kind, value, phase, services) {
  sync(services.write(object, offset, kind, value, {
    native: NATIVE.methodBody, phase, object, offset, kind,
    width: kind === 'u8' ? 1 : 4,
  }), `write +0x${offset.toString(16)}`);
}

/**
 * Execute the original method body: short-circuit compare each field against
 * the arguments; on the first mismatch write all four fields and emit
 * AskParentForReconfigure.
 */
export function setCheckboxTexturesNative(
  object, toggleOff, toggleOn, textureWidth, textureHeight, services = {}) {
  objectReference(object, 'window');
  if (typeof services.read !== 'function' ||
      typeof services.write !== 'function') {
    fail('XCheckboxWindow::SetCheckboxTextures requires read/write services', {
      kind: 'SERVICE', offset: F.textureOff,
      operation: 'checkbox-textures-update',
    });
  }
  const off = textureReference(toggleOff, 'toggleOff');
  const on = textureReference(toggleOn, 'toggleOn');
  const changed =
    readField(object, F.textureOff, 'ptr', 'compare-off', services) !== off ||
    readField(object, F.textureOn, 'ptr', 'compare-on', services) !== on ||
    !fcompEqual(
      readField(object, F.textureWidth, 'f32', 'compare-width', services),
      textureWidth) ||
    !fcompEqual(
      readField(object, F.textureHeight, 'f32', 'compare-height', services),
      textureHeight);
  if (!changed) return;
  writeField(object, F.textureOff, 'ptr', off, 'store-off', services);
  writeField(object, F.textureWidth, 'f32', textureWidth, 'store-width', services);
  writeField(object, F.textureOn, 'ptr', on, 'store-on', services);
  writeField(object, F.textureHeight, 'f32', textureHeight, 'store-height', services);
  const reconfigure = services.askParentForReconfigure;
  if (typeof reconfigure !== 'function') {
    fail('XCheckboxWindow::SetCheckboxTextures requires AskParentForReconfigure service', {
      kind: 'SERVICE', object, operation: 'ask-parent-reconfigure',
    });
  }
  sync(reconfigure({
    native: NATIVE.methodBody, phase: 'ask-parent-reconfigure',
    object, callee: 0x1004e060,
  }), 'AskParentForReconfigure');
}

export const windowSetCheckboxTexturesNative = setCheckboxTexturesNative;
export const checkboxWindowSetCheckboxTexturesNative =
  setCheckboxTexturesNative;
