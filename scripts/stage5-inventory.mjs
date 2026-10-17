#!/usr/bin/env node
/** Stage 5 inventory tables (docs/stage-5-inventory.md): what a map's own actors offer a player, read from the
 * installed .dx file with Play's map decoder. Read-only; prints text.
 *
 *   node scripts/stage5-inventory.mjs <map> classes            actor classes and counts
 *   node scripts/stage5-inventory.mjs <map> triggers           every trigger-like actor: tag, event, flag, DataLink or conversation tag, place
 *   node scripts/stage5-inventory.mjs <map> movers             DeusExMover/ElevatorMover/Breakable*: tag, key, lock, pick, break
 *   node scripts/stage5-inventory.mjs <map> pawns              pawns grouped by class, orders, bind name, alliance, route tag
 *   node scripts/stage5-inventory.mjs <map> items              pickups, weapons, keys, datacubes, computers, devices
 *   node scripts/stage5-inventory.mjs <map> conlist [N]        the mission's ConversationList (N: mission number, default from the map name)
 */
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const [map, mode = 'classes', arg] = process.argv.slice(2);
if (!map) { console.error('usage: stage5-inventory.mjs <map> classes|triggers|movers|pawns|items|conlist'); process.exit(2); }
const root = gameDirectory();
const {decodeMap} = await import('../src/unreal/map.mjs');
const name = v => (v && typeof v === 'object' && 'name' in v) ? v.name : v;
const place = v => v.Location ? v.Location.map(x => Math.round(x)).join(',') : '?';
const row = (a, keys) => keys.map(k => a.values[k] !== undefined && a.values[k] !== null ? `${k}=${name(a.values[k])}` : '').filter(Boolean).join(' ');

if (mode === 'conlist') {
  const {AssetStore} = await import('../src/unreal/assets.mjs');
  const {readObject} = await import('../src/unreal/objects.mjs');
  const files = [];
  for (const n of await readdir(`${root}/System`)) files.push({path: `System/${n}`, read: () => readFile(`${root}/System/${n}`)});
  const ctx = await new AssetStore(files).get('DeusExConText');
  const number = arg ?? /^(\d\d)_/.exec(map)?.[1] ?? '00';
  const values = i => readObject(ctx.pkg, ctx.bytes, i).values;
  let item = values(ctx.exportsByPath.get(`conlist_mission${String(number).padStart(2, '0')}`)).conversations ?? 0;
  const byOwner = new Map();
  while (item) {
    const it = values(item), c = values(it.ConObject);
    const tag = (c.bDataLinkCon ? 'DL:' : '') + name(c.conName) + (c.bFirstPerson ? '(fp)' : '') + (c.bNonInteractive ? '(ni)' : '');
    const owner = name(c.conOwnerName);
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(tag);
    item = it.Next ?? 0;
  }
  for (const [owner, list] of [...byOwner].sort()) console.log(`${owner}: ${list.filter(t => !/_Bark/.test(t)).join(' ')}${list.some(t => /_Bark/.test(t)) ? ` (+${list.filter(t => /_Bark/.test(t)).length} _Bark*)` : ''}`);
  process.exit(0);
}

const decoded = decodeMap(new Uint8Array(await readFile(path.join(root, 'Maps', `${map}.dx`))));
const actors = decoded.actors;
if (mode === 'classes') {
  const counts = new Map();
  for (const a of actors) counts.set(a.className, (counts.get(a.className) ?? 0) + 1);
  console.log(`${map}: ${actors.length} actors`);
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`${String(v).padStart(5)} ${k}`);
} else if (mode === 'triggers') {
  const re = /Trigger$|^(Teleporter|MapExit|Dispatcher|SpecialEvent|AlarmUnit|ConversationTrigger|InterpolateTrigger|SkillAwardTrigger|OrdersTrigger|FlagTrigger|AllianceTrigger|SequenceTrigger|DataLinkTrigger|SpawnPoint)$/;
  for (const a of actors.filter(a => re.test(a.className)))
    console.log(`${a.className} ${a.name} @${place(a.values)} ${row(a, ['datalinkTag', 'conversationTag', 'BindName', 'FlagName', 'bSetFlag', 'CheckFlag', 'bCheckFalse', 'Tag', 'Event', 'Orders', 'ordersTag', 'URL', 'DestMap', 'skillPointsAdded', 'awardMessage', 'OutEvents', 'Message', 'bTriggerOnceOnly', 'TriggerType'])}`);
} else if (mode === 'movers') {
  for (const a of actors.filter(a => /^(DeusExMover|ElevatorMover|BreakableGlass|BreakableWall)$/.test(a.className))) {
    const v = a.values;
    console.log(`${a.className} ${a.name} @${place({Location: v.Location ?? v.BasePos})} ${[v.Tag && `tag=${v.Tag}`, v.Event && `ev=${v.Event}`, v.KeyIDNeeded && `key=${v.KeyIDNeeded}`,
      v.bLocked && 'locked', v.bPickable === false && 'nopick', v.lockStrength !== undefined && `ls=${v.lockStrength.toFixed(2)}`, v.bBreakable && 'break',
      v.doorStrength !== undefined && `ds=${v.doorStrength}`, v.bFrobbable === false && 'nofrob', v.bIsDoor && 'door', v.InitialState && `is=${v.InitialState}`].filter(Boolean).join(' ')}`);
  }
} else if (mode === 'pawns') {
  const groups = new Map();
  for (const a of actors) {
    if (!/^(Terrorist|TerroristCommander|UNATCOTroop|ThugMale2|SecurityBot2|SecurityBot3|GuntherHermann|PaulDenton|HarleyFilben|BumFemale|MIB|Doctor|JaimeReyes|AnnaNavarre|BobPage|ScientistMale|ScientistFemale|WaltonSimons|JosephManderley|Secretary|Soldier|MedicalBot|RepairBot|MunitionsTrooper)$/.test(a.className)) continue;
    const v = a.values;
    const key = [a.className, v.Orders ?? 'default', v.BindName ?? '', v.Alliance ?? '', v.OrderTag ?? '', v.bInWorld === false ? 'hidden' : '', v.bInvincible ? 'invincible' : ''].join(' | ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(`${a.name}@${place(v)}`);
  }
  for (const [k, v] of [...groups].sort()) console.log(`${v.length} ${k} :: ${v.slice(0, 3).join(' ')}`);
} else if (mode === 'items') {
  const re = /^(Weapon|Ammo|NanoKey|Multitool|Lockpick|DataCube|Computer|Keypad|ATM|ControlPanel|MedKit|AugmentationCannister|HazMatSuit|TechGoggles|AdaptiveArmor|Credits|SecurityCamera|AutoTurret|LaserTrigger|ElectricityEmitter|LAM|GasGrenade|CrateExplosive|Barrel1|BarrelFire|LightSwitch|Switch|Button|Camera$)/;
  for (const a of actors.filter(a => re.test(a.className)))
    console.log(`${a.className} ${a.name} @${place(a.values)} ${row(a, ['KeyID', 'validCode', 'textTag', 'hackStrength', 'Tag', 'Event', 'UnTriggerEvent', 'bActive', 'maxRange', 'AddAugs', 'ComputerNode', 'bSwing', 'bNoAlarm'])}`);
}
