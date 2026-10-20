/** Script binding of DeusExTextParser: its native constructor and deleting
 * destructor, the exec wrappers of natives 2210-2221, and the XExtString
 * source OpenText loads through StaticLoadObject. The parser logic itself is
 * script-text-parser.mjs. docs/script-text-parser.md. */
import {destructScriptObject, freeScriptObject} from './script-object-release.mjs';
import {
  TEXT_PARSER_NATIVE, constructTextParser, textParserCloseText, textParserGetColor, textParserGetEmailInfo,
  textParserGetFileInfo, textParserGetName, textParserGetTag, textParserGetText, textParserGotoLabel,
  textParserIsEOF, textParserOpenText, textParserProcessText, textParserSetPlayerName,
} from './script-text-parser.mjs';

const UOBJECT_VTABLE = 0x10179dfc;
const lower = value => String(value ?? '').toLowerCase();
const refValue = value => value?.reference ? value.get() : value;
const isReference = value => Boolean(value?.reference) && typeof value.set === 'function';
const cstringPrefix = text => {
  const end = String(text).indexOf('\0');
  return end < 0 ? String(text) : String(text).slice(0, end);
};

/** Heap addresses are not modelled in Play. The parser's colour alpha bytes
 * come from the high byte of its object and text-buffer addresses; both are
 * modelled as 0. The recovered XGC/XWindow SetTextColor draw plane uses only
 * R, G and B, so these bytes do not reach drawing. */
export const TEXT_PARSER_ADDRESS_MODEL = Object.freeze({object: 0, text: 0});

/** DDeusExTextParser::DDeusExTextParser (0x10001100) after StaticAllocateObject:
 * UObject's constructor stores the Core vtable, then the parser vtable. Its
 * Destroy (0x10001210) frees the text copy, leaving textPos, then runs
 * UObject::Destroy. */
export function constructTextParserObject(object, {state, destroyObjectBase}) {
  if (typeof state !== 'function' || typeof destroyObjectBase !== 'function')
    throw new Error('DeusExTextParser construction requires its state and UObject.Destroy bindings');
  object.nativeVtable = UOBJECT_VTABLE;
  object.nativeVtable = TEXT_PARSER_NATIVE.vtable;
  const parser = constructTextParser({objectAddress: TEXT_PARSER_ADDRESS_MODEL.object});
  state(object.identity, parser);
  object.destroy = receiver => {
    parser.text = null; parser.textAddress = null;
    destroyObjectBase(receiver);
  };
  return parser;
}

/** Scalar branch of the deleting destructor 0x10004820: ~DDeusExTextParser
 * (0x10004030) stores its vtable, runs ConditionalDestroy, finalizes its
 * FString members and runs ~UObject; flag 1 then frees the allocation. */
export function releaseTextParserObject(object, flags, services) {
  if (object.nativeVtable !== TEXT_PARSER_NATIVE.vtable)
    throw new Error('DeusExTextParser release requires its native vtable');
  if (!Number.isInteger(flags) || flags & 2) throw new Error('DeusExTextParser array release is unsupported');
  if (typeof services.conditionalDestroy !== 'function') throw new Error('DeusExTextParser release requires ConditionalDestroy');
  object.nativeVtable = TEXT_PARSER_NATIVE.vtable;
  services.conditionalDestroy(object);
  destructScriptObject(object, services);
  if (flags & 1) freeScriptObject(object, services);
  return object;
}

/** The objects the original's registry gains when Extension:XExtString is first loaded from its package, in AddObject order, [class, name] each
 * (Training capture kpd1, 2026-10-20, DataCube0 read at tick 30: DeusExTextParser0, then `Class ExtString` replacing the registered placeholder under
 * its slot (223 in that session), these 21 members, then the text object `ExtString 00_Datacube01`; the text object and the parser are freed in the
 * same tick). The order is the loader's (CreateExport of the class's children while its Link preloads them): measured, not derived; the retail
 * Extension.u holds exactly these seven Function and the Property objects of docs/script-text-parser.md. docs/stage-5-exit-criteria.md "Captures:
 * Training phase 1". */
export const EXT_STRING_CLASS_MEMBERS = Object.freeze([
  ['Function', 'GetNextTextPart'], ['Function', 'GetFirstTextPart'], ['StrProperty', 'OutText'], ['IntProperty', 'ReturnValue'],
  ['Function', 'GetTextPart'], ['StrProperty', 'OutText'], ['IntProperty', 'ReturnValue'], ['Function', 'GetTextLength'],
  ['IntProperty', 'startPos'], ['IntProperty', 'Count'], ['StrProperty', 'OutText'], ['IntProperty', 'ReturnValue'], ['Function', 'GetText'],
  ['IntProperty', 'ReturnValue'], ['Function', 'AppendText'], ['StrProperty', 'ReturnValue'], ['Function', 'SetText'], ['StrProperty', 'NewText'],
  ['IntProperty', 'speechPage'], ['StrProperty', 'NewText'], ['StrProperty', 'Text'],
].map(row => Object.freeze(row)));

/** XExtString source for OpenText: StaticLoadObject(XExtString, NULL,
 * "Package.Name", NULL, LOAD_NoWarn|LOAD_Quiet) from preloaded packages.
 * XExtString::Serialize (Extension 0x10044140) is UObject::Serialize followed
 * by the Text FString. A package that was not preloaded is an explicit
 * boundary, not a quiet miss. */
export function createExtStringSource(packages, {readObject}) {
  if (typeof readObject !== 'function') throw new TypeError('ExtString source requires the package object reader');
  const byName = new Map();
  for (const asset of packages) {
    const exports = new Map();
    for (const [position, entry] of asset.pkg.exports.entries())
      if (entry.className === 'ExtString' && !exports.has(lower(entry.name))) exports.set(lower(entry.name), position + 1);
    byName.set(lower(asset.name), {asset, exports, texts: new Map()});
  }
  return {
    loadText(path) {
      const dot = path.indexOf('.');
      if (dot < 0 || path.indexOf('.', dot + 1) >= 0)
        throw new Error(`XExtString path outside Package.Name form is not recovered: ${path}`);
      const source = byName.get(lower(path.slice(0, dot)));
      if (!source) throw new Error(`XExtString package is not preloaded: ${path.slice(0, dot)}`);
      const index = source.exports.get(lower(path.slice(dot + 1)));
      if (index === undefined) return null;
      if (!source.texts.has(index)) {
        const object = readObject(source.asset.pkg, source.asset.bytes, index);
        source.texts.set(index, object.reader.string(source.asset.pkg.version));
      }
      return source.texts.get(index);
    },
  };
}

function scriptColor(color) {
  return Object.fromEntries(['r', 'g', 'b', 'a'].map(channel => [`core.object.color.${channel}`, color[channel]]));
}

function expectArguments(call, min, max, name) {
  if (call.argumentCount < min || call.argumentCount > max)
    throw new Error(`DeusExTextParser.${name} argument count ${call.argumentCount} is not ${min === max ? min : `${min}-${max}`}`);
}

/** Exec wrappers 0x10003030-0x10003c40 for a DeusExTextParser receiver.
 * `services` supplies state(receiver), loadText(path) and name(text). */
export function dispatchTextParserNative(call, services) {
  const index = TEXT_PARSER_NATIVE.indices;
  if (call.index < index.openText || call.index > index.setPlayerName) return {handled: false};
  const parser = services.state(call.receiver);
  if (!parser) throw new Error('DeusExTextParser native reached an object without native parser state');
  const helpers = {
    loadText: services.loadText,
    allocateText: () => TEXT_PARSER_ADDRESS_MODEL.text,
    name: services.name,
  };
  switch (call.index) {
    case index.openText: {
      // P_GET_NAME, P_GET_STR_OPTX(TextPackage, "DeusExText"), P_FINISH; an
      // empty package is replaced with "DeusExText" before OpenText.
      expectArguments(call, 1, 2, 'OpenText');
      const textName = refValue(call.evaluateArgument(0));
      let textPackage = call.argumentCount > 1 ? refValue(call.evaluateArgument(1)) : undefined;
      if (textPackage === undefined) textPackage = TEXT_PARSER_NATIVE.defaultPackage;
      if (cstringPrefix(textPackage) === '') textPackage = TEXT_PARSER_NATIVE.defaultPackage;
      return {handled: true, value: textParserOpenText(parser, String(textName), String(textPackage), helpers)};
    }
    case index.closeText:
      expectArguments(call, 0, 0, 'CloseText');
      textParserCloseText(parser);
      return {handled: true, value: undefined};
    case index.processText:
      expectArguments(call, 0, 0, 'ProcessText');
      return {handled: true, value: textParserProcessText(parser, helpers)};
    case index.isEOF:
      expectArguments(call, 0, 0, 'IsEOF');
      return {handled: true, value: textParserIsEOF(parser)};
    case index.getText:
      expectArguments(call, 0, 0, 'GetText');
      return {handled: true, value: textParserGetText(parser)};
    case index.gotoLabel:
      expectArguments(call, 1, 1, 'GotoLabel');
      refValue(call.evaluateArgument(0));
      return {handled: true, value: textParserGotoLabel()};
    case index.getTag:
      expectArguments(call, 0, 0, 'GetTag');
      return {handled: true, value: textParserGetTag(parser)};
    case index.getName:
      expectArguments(call, 0, 0, 'GetName');
      return {handled: true, value: textParserGetName(parser)};
    case index.getColor:
      expectArguments(call, 0, 0, 'GetColor');
      return {handled: true, value: scriptColor(textParserGetColor(parser))};
    case index.getEmailInfo:
    case index.getFileInfo: {
      // Each out FString is P_GET_STR_REF: a non-lvalue writes a discarded
      // local. The fields are copied after P_FINISH.
      const values = call.index === index.getEmailInfo ? textParserGetEmailInfo(parser) : textParserGetFileInfo(parser);
      expectArguments(call, values.length, values.length, call.index === index.getEmailInfo ? 'GetEmailInfo' : 'GetFileInfo');
      const targets = values.map((_, position) => call.evaluateArgument(position));
      targets.forEach((target, position) => { if (isReference(target)) target.set(values[position]); });
      return {handled: true, value: undefined};
    }
    case index.setPlayerName:
      expectArguments(call, 1, 1, 'SetPlayerName');
      textParserSetPlayerName(parser, String(refValue(call.evaluateArgument(0))));
      return {handled: true, value: undefined};
    default:
      return {handled: false};
  }
}
