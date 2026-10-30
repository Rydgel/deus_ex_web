import { readObject, exportAt } from '../unreal/objects.mjs';

/** Incomplete descriptor prototype for DeusEx conversation binding (native 2101 /
 * DeusExPlayer 2100). DeusExConText holds one conversation list per mission:
 * a `ConversationList` ("ConList_Mission<NN>") is
 * `{ conversations: <ConItem>, missionDescription }`, and a `ConItem` is a
 * linked list `{ ConObject: <Conversation>, Next: <ConItem> }`. Each
 * `Conversation` carries `conName`, `conOwnerName` (the actor BindName it binds
 * to) and the `bInvoke*` flags. Evidence: docs/script-conversation-binding.md.
 *
 * This prototype preserves measured Training BindName matches and prepend
 * order. The later direct native trace recovered additional BarkBindName gates,
 * purge/count/allocation behavior which this module does not implement.
 * See docs/script-native-conversation-list.md before extending or using the
 * positive descriptor path as a native construction result. */

const MISSION_PACKAGE = 'DeusExConText';

function missionListName(missionNumber) {
  const n = Number.isInteger(missionNumber) ? missionNumber : 0;
  return `ConList_Mission${String(n).padStart(2, '0')}`;
}

/** Parse one mission's conversation list into ordered descriptors. The parse is
 * pure package decoding; do it once per mission and reuse across actors. */
export function loadMissionConversations(asset, missionNumber) {
  const pkg = asset.pkg, bytes = asset.bytes;
  const name = missionListName(missionNumber);
  const pos = pkg.exports.findIndex(e => e.name === name && e.className === 'ConversationList');
  if (pos < 0) throw new Error(`Mission conversation list ${name} not found in ${MISSION_PACKAGE}`);
  const head = readObject(pkg, bytes, pos + 1).values;
  const conversations = [];
  const seen = new Set();
  for (let item = head.conversations | 0; item > 0 && !seen.has(item);) {
    seen.add(item);
    const node = readObject(pkg, bytes, item).values;
    if (node.ConObject > 0) {
      const values = readObject(pkg, bytes, node.ConObject).values;
      conversations.push({
        ref: node.ConObject,
        object: exportAt(pkg, node.ConObject).name,
        conName: values.conName ?? null,
        conOwnerName: values.conOwnerName ?? null,
        bInvokeFrob: Boolean(values.bInvokeFrob),
        bInvokeBump: Boolean(values.bInvokeBump),
        bInvokeSight: Boolean(values.bInvokeSight),
        bInvokeRadius: Boolean(values.bInvokeRadius),
      });
    }
    item = node.Next | 0;
  }
  return conversations;
}

/** Prototype candidate list in `ConListItems` order: every mission
 * conversation whose conOwnerName matches the actor's BindName. UnrealScript
 * names are compared case-insensitively here; the None shortcut and omitted
 * BarkBindName gates are incomplete outside the measured Training cases.
 *
 * `ConBindEvents` **prepends** each match as it walks the mission list, so the
 * bound order is the reverse of mission-list order. Confirmed against the live
 * game (tools/dump-conlist-win.c): `UNATCOTroop0`/`3` bind
 * `MunitionsTrooperFrob` (Conversation3) then `MunitionsTrooperTake`
 * (Conversation4), the reverse of the list order. */
export function matchConversations(bindName, conversations) {
  const key = bindName == null ? '' : String(bindName).toLowerCase();
  if (key === '' || key === 'none') return [];
  return conversations.filter(c => c.conOwnerName != null && String(c.conOwnerName).toLowerCase() === key).reverse();
}
