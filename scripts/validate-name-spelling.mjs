/** The spelling of a Name across levels (src/unreal/name-spelling.mjs, docs/script-names.md "Spelling across levels") over the shipped packages, through
 * the AssetStore and objects.mjs readObject as Play reads them, against the two flag spellings measured in the original's chains:
 *
 *  - mission 0 (a new process: the Training map, then DeusExConText at the level's start): `dl_bodyexit_Played`, `M00MeetPage_Played`;
 *  - mission 10 (one process through the Paris maps; the Chateau's names enter while the Metro's DeusExConText is loaded): `DL_EverettContact_Played`,
 *    `DL_EverettMaze_Played`, although the Chateau spells `DL_everettcontact`, `DL_everettmaze` and `DL_everettcontact_played` (the original's flag dumps,
 *    .work/chains/m10/g10..g12 on the Linux host; its engine log orders `Loading: Package 10_Paris_Chateau`, `Collecting garbage`,
 *    `Unloading: Package DeusExConText`, `Loading: Package DeusExConText`, `Login: Player`);
 *  - mission 12 (12_Vandenberg_cmd, then a travel to 12_vandenberg_computer, which spells `Heliosborn` and `DL_Heliosborn`): `HeliosBorn`, `DL_HeliosBorn_Played`.
 *
 * A level is what createGame does (beginLevel: LoadMap), then the conversation startup's StaticLoadObject (enterPackage: runtime.prepareConversations); the
 * flag is ConPlayBase's `StringToName(con.conName $ "_Played")` (intern). It also checks that the startup's other 15 packages first-enter no name that
 * DeusExConText or a map spells differently, which is why Play enters five of the startup's packages only.
 *
 *   node scripts/validate-name-spelling.mjs */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { BOOT_SCRIPT_PACKAGES } from '../src/unreal/name-spelling.mjs';

const root = gameDirectory();
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });

/** A new process: the store's first package load enters the startup's script packages. */
const newProcess = () => new AssetStore(files);

/** A level as Play runs it: LoadMap (createGame), then the level's start loads DeusExConText (prepareConversations). */
async function level(assets, map) {
  const asset = await assets.get(map);
  assets.nameSpelling.beginLevel(asset.pkg);
  assets.nameSpelling.enterPackage((await assets.get('DeusExConText')).pkg);
  return asset;
}

/** A Conversation's conName as readObject decodes it now: the live entry's spelling. */
function conName(conText, conversation) {
  for (const [index, entry] of conText.pkg.exports.entries()) {
    if (entry.className !== 'Conversation') continue;
    const value = readObject(conText.pkg, conText.bytes, index + 1).properties.find(p => p.name === 'conName')?.value;
    if (typeof value === 'string' && value.toLowerCase() === conversation.toLowerCase()) return value;
  }
  throw new Error(`DeusExConText has no Conversation ${conversation}`);
}

/** The DataLinkTrigger whose datalinkTag is the conversation's. */
function dataLinkTag(asset, conversation) {
  for (const [path, index] of asset.exportsByPath) {
    if (asset.pkg.exports[index - 1].className !== 'DataLinkTrigger') continue;
    const tag = readObject(asset.pkg, asset.bytes, index).properties.find(p => p.name.toLowerCase() === 'datalinktag')?.value;
    if (typeof tag === 'string' && tag.toLowerCase() === conversation.toLowerCase()) return tag;
  }
  throw new Error(`${asset.name} has no DataLinkTrigger for ${conversation}`);
}

/** ConPlayBase.EndConversation's flag for a conversation the level reaches. */
const playedFlag = (assets, conText, conversation) => assets.nameSpelling.intern(`${conName(conText, conversation)}_Played`);

const checks = [];
const check = (label, actual, expected) => { assert.equal(actual, expected, label); checks.push(`${label}: ${actual}`); };

// Mission 0: a new process; DX (mission -2) loads no ConversationList, so Training's names enter first.
{
  const assets = newProcess();
  const training = await level(assets, '00_Training'), conText = await assets.get('DeusExConText');
  check('mission 0, Training DataLinkTrigger tag', dataLinkTag(training, 'DL_bodyexit'), 'dl_bodyexit');
  check('mission 0, DL_bodyexit flag', playedFlag(assets, conText, 'DL_bodyexit'), 'dl_bodyexit_Played');
  check('mission 0, M00MeetPage flag (DeusEx.u, a startup package, spells it)', playedFlag(assets, conText, 'M00MeetPage'), 'M00MeetPage_Played');
}

// Mission 10: the chain's maps in one process (scripts/chains/mission10.mjs; the original loads the first from Save0109's .dxs).
{
  const assets = newProcess();
  for (const map of ['10_Paris_Catacombs', '10_Paris_Catacombs_Tunnels', '10_Paris_Metro', '10_Paris_Club', '10_Paris_Metro']) await level(assets, map);
  // a package parsed in the middle of a level (a destination looked up early) begins no level
  await assets.get('11_Paris_Cathedral');
  const chateau = await level(assets, '10_Paris_Chateau'), conText = await assets.get('DeusExConText');
  check('mission 10, Chateau DataLinkTrigger tag', dataLinkTag(chateau, 'DL_EverettContact'), 'DL_EverettContact');
  check('mission 10, DL_EverettContact flag', playedFlag(assets, conText, 'DL_EverettContact'), 'DL_EverettContact_Played');
  check('mission 10, DL_EverettMaze flag', playedFlag(assets, conText, 'DL_EverettMaze'), 'DL_EverettMaze_Played');
  // the travel's collection: what only the Metro's level entered is gone, the Chateau's names keep their spelling
  assets.nameSpelling.beginLevel((await assets.get('11_Paris_Cathedral')).pkg);
  check('after the next travel, a name only the left level held', assets.nameSpelling.spell('dl_everettmaze_played'), 'dl_everettmaze_played');
}

// Mission 12 (the original's m12 flag dumps, m12-6-uplink and m12-7-heliosborn: `HeliosBorn`, `DL_HeliosBorn_Played`; its log loads 12_Vandenberg_cmd, then travels to
// 12_vandenberg_computer, which spells `Heliosborn` and `DL_Heliosborn`).
{
  const assets = newProcess();
  await level(assets, '12_Vandenberg_Cmd');
  await level(assets, '12_Vandenberg_Computer');
  const conText = await assets.get('DeusExConText');
  check('mission 12, the Computer map\'s Heliosborn', assets.nameSpelling.spell('Heliosborn'), 'HeliosBorn');
  check('mission 12, DL_HeliosBorn flag', playedFlag(assets, conText, 'DL_HeliosBorn'), 'DL_HeliosBorn_Played');
}

// The same Chateau in a new process (no DeusExConText before its names enter): the map spells them, Play's spelling before this model.
{
  const assets = newProcess();
  const conText = await assets.get('DeusExConText');
  await level(assets, '10_Paris_Chateau');
  check('a new process at the Chateau, DL_EverettContact flag', playedFlag(assets, conText, 'DL_EverettContact'), 'DL_everettcontact_played');
}

// The startup's other packages (docs/original-startup-log.md) first-enter no name that DeusExConText or a map spells differently.
{
  const STARTUP = ['DeusEx', 'Core', 'Engine', 'Extension', 'DeusExCharacters', 'DeusExUI', 'DeusExItems', 'Effects', 'Fire', 'ConSys', 'DeusExSounds', 'DeusExDeco',
    'UBrowser', 'UWindow', 'IpDrv', 'DeusExText', 'Ambient', 'MoverSFX', 'IpServer', 'MPCharacters'];
  const assets = newProcess(), first = new Map();
  for (const name of STARTUP) for (const entry of (await assets.get(name)).pkg.names) if (!first.has(entry.name.toLowerCase())) first.set(entry.name.toLowerCase(), { name: entry.name, by: name });
  const others = [], readers = ['DeusExConText', ...files.filter(f => /^Maps\/.*\.dx$/i.test(f.path)).map(f => f.path.slice(5, -3))];
  for (const reader of readers) {
    const asset = await assets.get(reader);
    for (const entry of asset.pkg.names) {
      const hit = first.get(entry.name.toLowerCase());
      if (hit && hit.name !== entry.name && !BOOT_SCRIPT_PACKAGES.includes(hit.by)) others.push(`${reader}:${entry.name} (${hit.by}: ${hit.name})`);
    }
    assets.packages.delete(reader.toLowerCase()); assets.ready.delete(reader.toLowerCase());
  }
  assert.deepEqual(others, [], 'a startup package outside BOOT_SCRIPT_PACKAGES spells a name a map or DeusExConText reads');
  checks.push(`the startup's ${STARTUP.length - BOOT_SCRIPT_PACKAGES.length} other packages against DeusExConText and ${readers.length - 1} maps: no spelling they decide`);
}

for (const line of checks) console.log(`ok  ${line}`);
console.log(`validate-name-spelling: ${checks.length} checks passed`);
