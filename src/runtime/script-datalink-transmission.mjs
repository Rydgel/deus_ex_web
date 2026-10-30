/**
 * Original DataLink transmission preparation and native boundary contracts.
 *
 * DataLinkTrigger, DeusExPlayer, DataLinkPlay, DeusExRootWindow and DeusExHUD
 * are ordinary UnrealScript in DeusEx.u. This module deliberately does not
 * reproduce those bodies in JavaScript. prepareDataLinkFunctions links their
 * installed bytecode into ScriptRuntime; the only host code here describes the
 * ConSys native calls that the bytecode reaches and decodes installed Mission
 * conversation data.
 *
 * Evidence:
 *   .cache/reference/DeusExPlayer.uc:8156-8319
 *   .cache/reference/DataLinkTrigger.uc:1-105
 *   installed DeusEx.u / ConSys.u metadata
 *   DeusExRootWindow.GetTopWindow (export 14052, 33 expanded bytes)
 *   DeusExHUD.CreateInfoLinkWindow (export 19623, 75 expanded bytes)
 *   Extension.Window.NewChild (native 1410, export 2126)
 *   installed System/ConSys.dll, exports and disassembly at image base
 *   0x10000000 (DConversation::BindEvents RVA 0xfec0 and
 *   DConversation::BindActorEvents RVA 0x101d0).
 */

import { readObject, exportAt } from '../unreal/objects.mjs';
import { readFunctionMetadata } from '../unreal/script-metadata.mjs';
import { refValue } from './script-vm.mjs';

/** Native indices registered by ConSys.u's Conversation class. */
export const DATALINK_NATIVE_INDICES = Object.freeze({
  BindEvents: 2052,
  BindActorEvents: 2053,
  ClearBindEvents: 2054,
  GetSpeechAudio: 2055,
  GetSpeechLength: 2056,
});

/** Original function records needed for a DataLink call. The asset name is
 * only a lookup hint; callers pass the actual loaded package asset. */
export const DATALINK_FUNCTIONS = Object.freeze([
  Object.freeze({ asset: 'DeusEx', path: 'deusexplayer.checkflagrefs', size: 97 }),
  Object.freeze({ asset: 'DeusEx', path: 'deusexplayer.getactivedatalink', size: 414 }),
  Object.freeze({ asset: 'DeusEx', path: 'deusexplayer.startdatalinktransmission', size: 218 }),
  Object.freeze({ asset: 'DeusEx', path: 'datalinktrigger.touch', size: 162 }),
  Object.freeze({ asset: 'DeusEx', path: 'datalinktrigger.trigger', size: 184 }),
  Object.freeze({ asset: 'DeusEx', path: 'datalinktrigger.datalinkfinished', size: 50 }),
  Object.freeze({ asset: 'DeusEx', path: 'datalinkplay.setconversation', size: 125 }),
  Object.freeze({ asset: 'DeusEx', path: 'datalinkplay.settrigger', size: 13 }),
  Object.freeze({ asset: 'DeusEx', path: 'datalinkplay.pushdatalink', size: 137 }),
  Object.freeze({ asset: 'DeusEx', path: 'datalinkplay.popdatalink', size: 106 }),
  Object.freeze({ asset: 'DeusEx', path: 'datalinkplay.insertdatalink', size: 70 }),
  Object.freeze({ asset: 'DeusEx', path: 'datalinkplay.startconversation', size: 285 }),
  // StartConversation's normal display path calls these bodies after the
  // ConPlayBase gate. Their child allocation remains an explicit native
  // boundary at Extension.Window.NewChild (1410).
  Object.freeze({ asset: 'DeusEx', path: 'deusexrootwindow.gettopwindow', size: 33 }),
  Object.freeze({ asset: 'DeusEx', path: 'deusexhud.createinfolinkwindow', size: 75 }),
  Object.freeze({ asset: 'DeusEx', path: 'hudinfolinkdisplay.initwindow', size: 27 }),
  Object.freeze({ asset: 'DeusEx', path: 'hudbasewindow.initwindow', size: 37 }),
  Object.freeze({ asset: 'Extension', path: 'window.initwindow', size: 2 }),
  Object.freeze({ asset: 'DeusEx', path: 'hudinfolinkdisplay.stylechanged', size: 127, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'hudinfolinkdisplay.setspeaker', size: 245, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'hudinfolinkdisplay.displaytext', size: 20, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'hudinfolinkdisplay.appendtext', size: 20, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'hudinfolinkdisplay.messagequeued', size: 45, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'hudinfolinkdisplay.clearscreen', size: 14, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'hudinfolinkdisplay.showtextcursor', size: 20, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'hudinfolinkdisplay.showdatalinkicon', size: 79, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'hudinfolinkdisplay.showportrait', size: 66, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'deusexhud.destroyinfolinkwindow', size: 68, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'hudbasewindow.stylechanged', size: 232, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'colorthememanager.getcurrenthudcolortheme', size: 8, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'colortheme.getcolorfromname', size: 55, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'colortheme.getcolorindex', size: 87, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'deusexplayer.gethudbordersvisible', size: 9, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'deusexplayer.gethudbordertranslucency', size: 9, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'deusexplayer.gethudbackgroundtranslucency', size: 9, playback: true }),
  Object.freeze({ asset: 'DeusEx', path: 'datalinkplay.notifydatalinktrigger', size: 28 }),
  Object.freeze({ asset: 'DeusEx', path: 'conplaybase.startconversation', size: 393 }),
]);

export const CONVERSATION_SCRIPT_FUNCTIONS = Object.freeze([
  Object.freeze({path:'conversation.checkactors',size:272}),
  Object.freeze({path:'conversation.checkactordistances',size:266}),
]);

const nativeContract = Object.freeze({
  [DATALINK_NATIVE_INDICES.BindEvents]: Object.freeze({
    name: 'Conversation.BindEvents', arguments: 2,
    parameters: ['Actor[10] out conBoundActors', 'Actor invokeActor'],
  }),
  [DATALINK_NATIVE_INDICES.BindActorEvents]: Object.freeze({
    name: 'Conversation.BindActorEvents', arguments: 1,
    parameters: ['Actor actorToBind'],
  }),
  [DATALINK_NATIVE_INDICES.ClearBindEvents]: Object.freeze({
    name: 'Conversation.ClearBindEvents', arguments: 0, parameters: [],
  }),
  [DATALINK_NATIVE_INDICES.GetSpeechAudio]: Object.freeze({
    name: 'Conversation.GetSpeechAudio', arguments: 1,
    parameters: ['int soundID'],
  }),
  [DATALINK_NATIVE_INDICES.GetSpeechLength]: Object.freeze({
    name: 'Conversation.GetSpeechLength', arguments: 1,
    parameters: ['int soundID'],
  }),
});

/** Return the recovered native declaration for diagnostics and host adapters. */
export function dataLinkNativeContract(index) {
  const contract = nativeContract[index];
  if (!contract) throw new RangeError('Unknown DataLink ConSys native ' + index);
  return contract;
}

function assetFor(assets, name, explicit) {
  if (explicit) return explicit;
  if (!assets || typeof assets.get !== 'function') {
    throw new TypeError('DataLink preparation needs the ' + name + ' package asset');
  }
  return assets.get(name);
}

/**
 * Prepare the original bytecode and native declarations used by the DataLink
 * route. No function body is translated here. The returned map is keyed by
 * the canonical Asset.Class.Function key used by ScriptRuntime and is useful
 * to a host that wants to assert all records were linked before Play starts.
 *
 * assets may be an AssetStore, or callers may pass deusEx/conSys directly.
 * A size mismatch is an evidence failure, not a reason to accept a different
 * package silently.
 */
export async function prepareDataLinkFunctions(runtime, {
  assets = runtime?.objects?.assets,
  deusEx = null,
  conSys = null,
  extension = null,
  includeTrigger = true,
  includePlayback = true,
} = {}) {
  if (!runtime || typeof runtime.prepareFunction !== 'function') {
    throw new TypeError('DataLink preparation requires ScriptRuntime.prepareFunction');
  }
  const deusExAsset = await assetFor(assets, 'DeusEx', deusEx);
  const conSysAsset = conSys ? await conSys : null;
  const extensionAsset = includePlayback ? await assetFor(assets, 'Extension', extension) : null;
  const selected = DATALINK_FUNCTIONS.filter(item => {
    if (!includePlayback && item.playback) return false;
    if (!includeTrigger && item.path.startsWith('datalinktrigger.')) return false;
    if (!includePlayback && (item.path.startsWith('datalinkplay.') || item.path.startsWith('conplaybase.') ||
        item.path === 'deusexrootwindow.gettopwindow' || item.path === 'deusexhud.createinfolinkwindow'))
      return false;
    if (!includePlayback && item.path.endsWith('.initwindow')) return false;
    return true;
  });
  const prepared = new Map();
  for (const item of selected) {
    const asset = item.asset === 'Extension' ? extensionAsset : deusExAsset;
    const index = asset.exportsByPath.get(item.path);
    if (!index) throw new Error('Missing original DataLink function ' + item.asset + '.' + item.path);
    const record = await runtime.prepareFunction(asset, index);
    const metadata = readFunctionMetadata(asset, index);
    if (metadata.scriptSize !== item.size) {
      throw new Error('Original DataLink function size changed for ' + item.asset + '.' + item.path + ': ' +
        metadata.scriptSize + ', expected ' + item.size);
    }
    prepared.set(record.key, record);
  }
  if (conSysAsset) {
    for(const item of CONVERSATION_SCRIPT_FUNCTIONS){
      const exportIndex=conSysAsset.exportsByPath.get(item.path);
      if(!exportIndex)throw new Error('Missing original ConSys function '+item.path);
      const record=await runtime.prepareFunction(conSysAsset,exportIndex);
      if(readFunctionMetadata(conSysAsset,exportIndex).scriptSize!==item.size)
        throw new Error('Original ConSys function size changed for '+item.path);
      prepared.set(record.key,record);
    }
    for (const [index, contract] of Object.entries(nativeContract)) {
      const path = contract.name.toLowerCase();
      const exportIndex = conSysAsset.exportsByPath.get(path);
      if (!exportIndex) throw new Error('Missing original native declaration ' + contract.name);
      const metadata = readFunctionMetadata(conSysAsset, exportIndex);
      if (metadata.nativeIndex !== Number(index)) {
        throw new Error('Native index changed for ' + contract.name + ': ' +
          metadata.nativeIndex + ', expected ' + index);
      }
      prepared.set(
        (conSysAsset.name + '.' + path).toLowerCase(),
        await runtime.prepareFunction(conSysAsset, exportIndex),
      );
    }
  }
  return prepared;
}

function requireInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(label + ' must be a positive export index');
  return value;
}

function linkedObjects(asset, head, decode, label) {
  const result = [];
  const seen = new Set();
  if (head == null || head === 0) return result;
  requireInteger(head, label + ' head');
  for (let index = head; index > 0;) {
    requireInteger(index, label + ' link');
    if (seen.has(index)) throw new Error('Cyclic original ' + label + ' chain at export ' + index);
    seen.add(index);
    result.push(decode(index));
    const next = result.at(-1).nextRef;
    if (next == null || next === 0) break;
    requireInteger(next, label + ' next');
    index = next;
  }
  return result;
}

function decodeFlagRefs(asset, head) {
  return linkedObjects(asset, head, index => {
    const value = readObject(asset.pkg, asset.bytes, index).values;
    if (!Object.hasOwn(value, 'FlagName'))
      throw new Error('Original ConFlagRef ' + index + ' is missing FlagName');
    return {
      ref: index,
      object: exportAt(asset.pkg, index)?.name ?? null,
      flagName: value.FlagName,
      value: value.Value,
      nextRef: value.nextFlagRef,
    };
  }, 'ConFlagRef');
}

/**
 * Decode the authored MissionNN conversation list while retaining exact
 * authored values and linked export references. This is a package decoder,
 * not a GetActiveDataLink implementation: selection and flag reads remain in
 * the original VM body. Broken linked lists throw instead of being treated as
 * an empty list or an implicit success.
 */
export function loadDataLinkMissionDescriptors(asset, missionNumber = 0) {
  if (!asset?.pkg || !asset.bytes) throw new TypeError('Expected a loaded DeusExConText asset');
  const name = 'ConList_Mission' +
    String(Number.isInteger(missionNumber) ? missionNumber : 0).padStart(2, '0');
  const listPos = asset.pkg.exports.findIndex(e => e.name === name && e.className === 'ConversationList');
  if (listPos < 0) throw new Error('Missing original conversation list ' + name);
  const list = readObject(asset.pkg, asset.bytes, listPos + 1).values;
  if (list.conversations === undefined)
    throw new Error('Original conversation list ' + name + ' has no conversations head');
  const items = linkedObjects(asset, list.conversations, index => {
    const value = readObject(asset.pkg, asset.bytes, index).values;
    if (!Object.hasOwn(value, 'ConObject')) throw new Error('Conversation item ' + index + ' has no ConObject');
    return { ref: index, conObjectRef: value.ConObject, nextRef: value.Next };
  }, name + '.ConItem');
  return items.filter(item => item.conObjectRef > 0).map(item => {
    const ref = requireInteger(item.conObjectRef, name + '.ConObject');
    const values = readObject(asset.pkg, asset.bytes, ref).values;
    const descriptor = {
      ref,
      object: exportAt(asset.pkg, ref)?.name ?? null,
      conName: values.conName,
      conOwnerName: values.conOwnerName,
      bDataLinkCon: values.bDataLinkCon,
      bDisplayOnce: values.bDisplayOnce,
      flagRefListRef: values.flagRefList,
      flagRefList: values.flagRefList == null ? undefined : decodeFlagRefs(asset, values.flagRefList),
      eventListRef: values.eventList,
      authored: values,
    };
    if (descriptor.conName === undefined || descriptor.conOwnerName === undefined)
      throw new Error('Original Conversation ' + ref + ' is missing its name/owner fields');
    return descriptor;
  });
}

/** Error raised when a DataLink native reaches a host without a real service. */
export class DataLinkNativeBoundaryError extends Error {
  constructor(index, message = null) {
    const contract = dataLinkNativeContract(index);
    super(message ?? ('Original ' + contract.name + ' native ' + index + ' is not implemented'));
    this.name = 'DataLinkNativeBoundaryError';
    this.code = 'DATALINK_NATIVE_BOUNDARY';
    this.nativeIndex = index;
    this.contract = contract;
  }
}

function argument(call, index, label) {
  if (typeof call.evaluateArgument !== 'function') throw new TypeError('Native ' + label + ' has no argument evaluator');
  return call.evaluateArgument(index);
}

/**
 * Build a strict ConSys service adapter. The callbacks are the native/host
 * service boundary; this helper only verifies call arity and preserves VM
 * references. Missing services throw DataLinkNativeBoundaryError instead of
 * inventing a Bool, zero sound, empty actor binding, or queue result.
 *
 * A bindEvents callback receives { call, conversation, conBoundActors,
 * invokeActor, conBoundActorsReference }; it must mutate/set the fixed array
 * reference exactly as the original out parameter does. bindActorEvents
 * receives { call, conversation, actorToBind }. Other callbacks receive the
 * native arguments and must return the original native result.
 */
export function createDataLinkNativeService({
  bindEvents = null,
  bindActorEvents = null,
  clearBindEvents = null,
  getSpeechAudio = null,
  getSpeechLength = null,
} = {}) {
  const callbacks = new Map([
    [DATALINK_NATIVE_INDICES.BindEvents, bindEvents],
    [DATALINK_NATIVE_INDICES.BindActorEvents, bindActorEvents],
    [DATALINK_NATIVE_INDICES.ClearBindEvents, clearBindEvents],
    [DATALINK_NATIVE_INDICES.GetSpeechAudio, getSpeechAudio],
    [DATALINK_NATIVE_INDICES.GetSpeechLength, getSpeechLength],
  ]);
  return call => {
    const contract = dataLinkNativeContract(call.index);
    if (call.argumentCount !== contract.arguments) {
      throw new Error(contract.name + ' native ' + call.index + ' received ' + call.argumentCount +
        ' arguments; expected ' + contract.arguments);
    }
    const callback = callbacks.get(call.index);
    if (typeof callback !== 'function') throw new DataLinkNativeBoundaryError(call.index);
    const values = Array.from({ length: contract.arguments }, (_, index) => argument(call, index, contract.name));
    return callback({
      call,
      conversation: call.receiver,
      values: values.map(refValue),
      references: values,
      conBoundActors: call.index === DATALINK_NATIVE_INDICES.BindEvents ? refValue(values[0]) : undefined,
      conBoundActorsReference: call.index === DATALINK_NATIVE_INDICES.BindEvents ? values[0] : undefined,
      invokeActor: call.index === DATALINK_NATIVE_INDICES.BindEvents ? refValue(values[1]) : undefined,
      actorToBind: call.index === DATALINK_NATIVE_INDICES.BindActorEvents ? refValue(values[0]) : undefined,
    });
  };
}
