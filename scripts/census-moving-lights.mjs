#!/usr/bin/env node
/** Reach census for the time-varying moving lights (docs/dynamic-lighting.md
 * "Time-varying moving lights"): which shipped light sources reach
 * FLightManager::AddLight's class 2 (SetupDynamics' candidates that are not
 * bStatic/bNoDelete, or are bDynamicLight), and with which (LightType,
 * LightEffect) pairs.
 *
 * Inputs are original data only:
 *  - every Actor class of the installed script packages (System/*.u), with
 *    its class defaults (classes.mjs ClassDefaults);
 *  - every actor of the 83 single-player maps, with its serialized
 *    properties over its class defaults;
 *  - the script text the packages carry (ScriptText), for the statements that
 *    assign LightType, LightEffect or the light fields at run time and for
 *    the Spawn calls of light classes. The script text is read here from the
 *    package, not from extracted files.
 *
 * Output (JSON on stdout, `--text` for a summary): per class its defaults and
 * AddLight class; per map the lights by (type, effect, class); the script
 * writers; and the (type, effect) pairs class 2 reaches with their sources.
 *
 *   node scripts/census-moving-lights.mjs [--text] [--maps 00_Training,...]
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { ClassDefaults, readClass } from '../src/unreal/classes.mjs';
import { isMovingLightCandidate, surfaceLightClass } from '../src/runtime/dynamic-lighting.mjs';
import { gameDirectory } from './game-directory.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory))) files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), defaults = new ClassDefaults(assets);

const TYPES = ['None', 'Steady', 'Pulse', 'Blink', 'Flicker', 'Strobe', 'BackdropLight', 'SubtlePulse', 'TexturePaletteOnce', 'TexturePaletteLoop'];
const EFFECTS = ['None', 'TorchWaver', 'FireWaver', 'WateryShimmer', 'Searchlight', 'SlowWave', 'FastWave', 'CloudCast', 'StaticSpot',
  'Shock', 'Disco', 'Warp', 'Spotlight', 'NonIncidence', 'Shell', 'OmniBumpMap', 'Interference', 'Cylinder', 'Rotor', 'Unused'];
const FIELDS = ['LightType', 'LightEffect', 'LightBrightness', 'LightRadius', 'LightHue', 'LightSaturation', 'LightPeriod', 'LightPhase',
  'LightCone', 'VolumeRadius', 'bStatic', 'bNoDelete', 'bDynamicLight', 'bMovable', 'bSpecialLit', 'bHidden', 'Physics', 'bIsOn'];
const pick = values => Object.fromEntries(FIELDS.filter(k => values[k] !== undefined).map(k => [k, values[k]]));
const pair = values => `${TYPES[values.LightType ?? 0] ?? values.LightType}/${EFFECTS[values.LightEffect ?? 0] ?? values.LightEffect}`;

// 1. Actor classes of the script packages.
const packages = files.filter(f => f.path.startsWith('System/') && f.path.toLowerCase().endsWith('.u')).map(f => path.basename(f.path, '.u'));
const classes = new Map(), scriptText = new Map();
for (const name of packages) {
  const asset = await assets.get(name);
  for (const [i, entry] of asset.pkg.exports.entries()) {
    if (entry.className !== 'Class') continue;
    let lineage;
    try { lineage = await defaults.lineage(asset, i + 1); } catch { continue; }
    if (!lineage.includes('engine.actor')) continue;
    const values = await defaults.get(asset, i + 1);
    classes.set(lineage[0], { package: name, name: entry.name, lineage, values: pick(values) });
  }
  // ScriptText buffers (a TextBuffer export named ScriptText under each
  // class): no tagged properties (the None name), Pos and Top (int32), then
  // the text as an FString (compact length with its terminator, Latin-1).
  for (const entry of asset.pkg.exports) {
    if (entry.className !== 'TextBuffer' || entry.name !== 'ScriptText' || !entry.serialSize) continue;
    const outer = entry.outer > 0 ? asset.pkg.exports[entry.outer - 1]?.name : null;
    if (!outer) continue;
    const bytes = asset.bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize);
    let at = 0;
    const compact = () => {
      const b0 = bytes[at++]; let value = b0 & 0x3f;
      if (b0 & 0x40) for (let shift = 6, b; ; shift += 7) { b = bytes[at++]; value |= (b & 0x7f) << shift; if (!(b & 0x80)) break; }
      return b0 & 0x80 ? -value : value;
    };
    if (asset.pkg.names[compact()]?.name !== 'None') continue;
    at += 8;
    const length = compact();
    if (length <= 0) continue;
    scriptText.set(`${name.toLowerCase()}.${outer.toLowerCase()}`, Buffer.from(bytes.subarray(at, at + length - 1)).toString('latin1'));
  }
}

// 2. Script writers and Spawn calls of light classes.
const lightClasses = [...classes.values()].filter(c => c.values.LightType);
const writers = [];
const assignment = /([A-Za-z_][A-Za-z0-9_]*\.)?(LightType|LightEffect|LightPeriod|LightPhase|LightCone|bDynamicLight)\s*=\s*([^;]+);/g;
for (const [key, text] of scriptText) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, n) => {
    if (/^\s*\/\//.test(line)) return;
    for (const match of line.matchAll(assignment))
      writers.push({ class: key, line: n + 1, target: match[1] ? match[1].slice(0, -1) : 'self', field: match[2], value: match[3].trim() });
  });
}
const spawns = [];
for (const [key, text] of scriptText) {
  for (const match of text.matchAll(/Spawn\s*\(\s*class\s*'([A-Za-z0-9_.]+)'/gi)) {
    const target = [...classes.keys()].find(k => k.endsWith(`.${match[1].toLowerCase().split('.').pop()}`));
    const cls = target ? classes.get(target) : null;
    const written = writers.some(w => w.class === target);
    if (cls && (cls.values.LightType || written)) spawns.push({ by: key, spawns: target });
  }
}

// 3. Map actors.
const selected = option('maps', null)?.split(',');
const maps = (await readdir(path.join(root, 'Maps'))).filter(n => n.toLowerCase().endsWith('.dx') && !/^dxmp_/i.test(n))
  .map(n => path.basename(n, '.dx')).filter(n => !selected || selected.includes(n)).sort();
const mapLights = {}, reach = new Map();
// Every lit light by LightType, whatever its class: mesh lighting
// (SetupForActor's GlobalLighting) takes static and moving lights alike.
const lightTypes = new Map();
// The distinct lights the level's surfaces list (UModel.Lights, the static light lists SetupForSurf adds through AddLight), by AddLight class:
// a class 2 light there would be merged twice, once shadowed-free from this list and once from SetupDynamics' list (docs/dynamic-lighting.md).
const listedLights = { maps: 0, lights: 0, byClass: {}, class2: [] };
// Every light (or script-lit class) by (LightEffect, AddLight class): which spatial functions the shipped content reaches, and on which kind of
// light (docs/light-effects.md). A script-lit class has no light until a script sets LightType; it counts under its class defaults' effect.
const effectClasses = new Map();
const noteEffect = (effect, cls, type, map, className, count = 1) => {
  const key = `${effect}|${cls}`, e = effectClasses.get(key) ?? { effect, cls, lights: 0, maps: new Set(), types: new Set(), classes: new Map() };
  e.lights += count; e.maps.add(map); e.types.add(type); e.classes.set(className, (e.classes.get(className) ?? 0) + count);
  effectClasses.set(key, e);
};
const note = (key, source) => { const entry = reach.get(key) ?? { pair: key, sources: new Map() }; entry.sources.set(source, (entry.sources.get(source) ?? 0) + 1); reach.set(key, entry); };
for (const map of maps) {
  const asset = await assets.get(map), decoded = decodeMap(asset.bytes), rows = {};
  {
    const byIndex = new Map(decoded.actors.map(a => [a.index, a])), refs = new Set(decoded.model.lights.filter(Boolean));
    listedLights.maps++;
    for (const ref of refs) {
      const actor = byIndex.get(ref);
      let values = null;
      if (actor) try { values = await defaults.forActor(asset, actor); } catch { /* an unreadable actor is counted below */ }
      const cls = values ? surfaceLightClass(values) : 'unread';
      listedLights.lights++; listedLights.byClass[cls] = (listedLights.byClass[cls] ?? 0) + 1;
      if (cls === 2) listedLights.class2.push(`${map}:${actor.name}`);
    }
  }
  for (const actor of decoded.actors) {
    let values, lineage;
    try { values = await defaults.forActor(asset, actor); lineage = await defaults.lineage(asset, asset.pkg.exports[actor.index - 1].classIndex); }
    catch { continue; }
    const className = lineage[0], scripted = writers.some(w => w.class === className && w.target === 'self');
    if (!values.LightType && !scripted) continue;
    const lit = Boolean(values.LightType), candidate = lit && isMovingLightCandidate(values);
    if (lit && values.LightBrightness) {
      const type = TYPES[values.LightType] ?? values.LightType, entry = lightTypes.get(type) ?? { lights: 0, maps: new Set(), classes: new Map() };
      entry.lights++; entry.maps.add(map); entry.classes.set(className, (entry.classes.get(className) ?? 0) + 1);
      lightTypes.set(type, entry);
    }
    const cls = lit ? surfaceLightClass(values) : null;
    if (lit && values.LightBrightness) noteEffect(EFFECTS[values.LightEffect ?? 0] ?? values.LightEffect, cls, TYPES[values.LightType] ?? values.LightType, map, className);
    else if (!lit && scripted) noteEffect(EFFECTS[values.LightEffect ?? 0] ?? values.LightEffect, 'script', 'script', map, className);
    // bIsOn (AlarmLight, Lamp, ...) decides whether BeginPlay keeps the light.
    const on = values.bIsOn === undefined ? '' : ` bIsOn=${Boolean(values.bIsOn)}`;
    const key = `${className} ${pair(values)} class=${cls ?? (scripted ? 'script-lit' : '-')}${candidate ? ' candidate' : ''}${on}`;
    rows[key] = (rows[key] ?? 0) + 1;
    if (cls === 2) note(pair(values), `${map}:${className}`);
    if (!lit && scripted) note(`script:${className}`, `${map}:${className}`);
  }
  mapLights[map] = rows;
}
for (const s of spawns) note(`spawn:${s.spawns}`, s.by);

const result = {
  maps: maps.length,
  lightClasses: lightClasses.map(c => ({ class: c.lineage[0], ...c.values, pair: pair(c.values),
    addLight: surfaceLightClass(c.values), candidate: isMovingLightCandidate(c.values) })),
  writers, spawns,
  classTwoPairs: [...reach.values()].map(e => ({ pair: e.pair, sources: Object.fromEntries(e.sources) })),
  lightTypes: Object.fromEntries([...lightTypes].map(([type, e]) => [type, { lights: e.lights, maps: [...e.maps],
    classes: Object.fromEntries(e.classes) }])),
  effectClasses: [...effectClasses.values()].map(e => ({ effect: e.effect, addLight: e.cls, lights: e.lights, maps: e.maps.size,
    types: [...e.types], classes: Object.fromEntries(e.classes) })).sort((a, b) => String(a.effect).localeCompare(String(b.effect)) || String(a.addLight).localeCompare(String(b.addLight))),
  listedLights,
  mapLights,
};
if (argv.includes('--text')) {
  console.log(`maps ${maps.length}, actor classes ${classes.size}, light classes ${lightClasses.length}, script texts ${scriptText.size}`);
  console.log('\nLight classes (defaults):');
  for (const c of result.lightClasses) console.log(`  ${c.class.padEnd(34)} ${c.pair.padEnd(24)} addLight=${c.addLight} static=${c.bStatic ?? 0} noDelete=${c.bNoDelete ?? 0} dyn=${c.bDynamicLight ?? 0} period=${c.LightPeriod ?? '-'} cone=${c.LightCone ?? '-'}`);
  console.log('\nScript writers:');
  for (const w of writers) console.log(`  ${w.class}:${w.line} ${w.target}.${w.field} = ${w.value}`);
  console.log('\nSpawned light classes:');
  for (const s of spawns) console.log(`  ${s.by} -> ${s.spawns}`);
  console.log('\nEvery lit map light by LightType (any class):');
  for (const [type, e] of Object.entries(result.lightTypes))
    console.log(`  ${type.padEnd(20)} ${String(e.lights).padStart(5)} lights in ${e.maps.length} maps: ${Object.entries(e.classes).map(([c, n]) => `${c}×${n}`).join(', ').slice(0, 300)}`);
  console.log('\nEvery lit map light by (LightEffect, AddLight class); script = a script-lit class (no light until a script sets LightType):');
  for (const e of result.effectClasses)
    console.log(`  ${String(e.effect).padEnd(14)} class ${String(e.addLight).padEnd(6)} ${String(e.lights).padStart(6)} lights in ${String(e.maps).padStart(2)} maps  types ${e.types.join('/')}  ${Object.entries(e.classes).map(([c, n]) => `${c}×${n}`).join(', ').slice(0, 200)}`);
  console.log(`  effects with no map light: ${EFFECTS.filter(effect => !result.effectClasses.some(e => e.effect === effect)).join(', ')}`);
  console.log(`\nLights the level surfaces list (UModel.Lights) by AddLight class, over ${listedLights.maps} maps: ${listedLights.lights} distinct, ${Object.entries(listedLights.byClass).map(([c, n]) => `class ${c}: ${n}`).join(', ')}${listedLights.class2.length ? `; class 2: ${listedLights.class2.join(', ')}` : ''}`);
  console.log('\nClass 2 reach (map actors) and script-lit/spawned sources:');
  for (const e of result.classTwoPairs) console.log(`  ${e.pair}: ${Object.entries(e.sources).map(([k, n]) => `${k}${n > 1 ? `×${n}` : ''}`).join(', ')}`);
} else console.log(JSON.stringify(result, null, 1));
