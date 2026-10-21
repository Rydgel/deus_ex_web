/** The census of the original's script natives against what Play implements (docs/native-census.md).
 *
 * Every native the shipped packages declare (891) gets one status:
 *   handled              a dispatcher of Play routes it (src/runtime/native-registry.mjs, checked against the code by
 *                        test/native-registry.test.mjs)
 *   missing-reachable    no dispatcher routes it, and a shipped script can call it (scripts/native-reachability.mjs)
 *   missing-unreachable  no dispatcher routes it and no shipped script calls it
 *   excluded             no dispatcher routes it, and it belongs to a part of the game the project defers: the editor,
 *                        multiplayer (AGENTS.md: last priority) or Stage 6 (saves, GameDirectory)
 * A missing-reachable native is `single-player` when some caller is ordinary game code and `developer` when every caller is a
 * developer tool (the cheat and debug windows, which only a cheat console command opens).
 *
 *   node scripts/census-natives.mjs [--json .work/native-census.json] [--markdown .work/native-census.md] [--probe FILE] [--doc docs/native-census.md]
 *
 * `--doc FILE` rewrites the region of FILE between its `census:begin` and `census:end` markers with the generated numbers and lists.
 *
 * `--probe FILE` merges the outcome of scripts/probe-natives.mjs (every native sent through the live invokeNative chain). */
import {readFile, readdir, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {openSystemPackages, scriptPackageNames, scanNativeCalls, resolveCalls} from './native-reachability.mjs';
import {handledNatives, NATIVE_SITES, RUST_NATIVES, LATENT_POLLS, NATIVE_DECISIONS} from '../src/runtime/native-registry.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };

// ---------------------------------------------------------------------------------------------------------------------
// The rules that sort a missing native. Each is a statement about the shipped scripts; the report keeps the callers so each
// can be checked.
// ---------------------------------------------------------------------------------------------------------------------

/** What a calling function is, by its key `Package.Class[.State].Function` (case as the package spells it). */
const CALLER_KINDS = [
  ['editor', /^Editor\./],
  // UT's server browser and its window system: DeusEx.ini lists UWindow and UBrowser under [Editor.EditorEngine] EditPackages
  // only, so the game never loads them; IpServer is the UT server uplink and IpDrv the sockets.
  ['multiplayer', /^(IpDrv|IpServer|UWindow|UBrowser)\./],
  // DeusEx's multiplayer menus and network links (the package spells their class names in lower case) and the HUD's
  // multiplayer windows.
  ['multiplayer', /^DeusEx\.(deusexserver\w*|deusexgspylink|deusexlocallink|menuscreenjoin\w*|menuscreenhostgame|menuchoice_\w+|dxmaplist|HUDMulti\w*|MultiplayerMessageWin)\./],
  ['multiplayer', /^Engine\.(StatLog|StatLogFile|MapList|TestInfo)\./],
  // The save and load screens and the player's quick save/load.
  ['saves', /^DeusEx\.(MenuScreen(Load|Save)Game|LoadMapWindow)\./],
  ['saves', /^DeusEx\.DeusExPlayer\.(QuickSave|QuickLoad|SaveGame|LoadGame|PerformSave)$/],
  // The developer tools: cheat and debug windows, the debug console functions, the DumpLocation windows.
  ['developer', /^DeusEx\.(BehindTheCurtain|DumpLocation\w*|FlagEditWindow|FlagAddWindow|ToolWindow|ToolBorderWindow|ToolTitleBarWindow|ShowClassWindow)\./],
  ['developer', /^DeusEx\.DeusExPlayer\.(DebugCommand|SetDebug|GetDebug|DXDumpInfo)$/],
];
// The rest is game code; Engine's own classes are the base code DeusEx overrides, extends or never reaches.
const callerKind = key => CALLER_KINDS.find(([, pattern]) => pattern.test(key))?.[0] ?? (key.startsWith('Engine.') ? 'engine' : 'game');

/** Natives excluded by their declaration, whoever calls them. */
const EXCLUDED_BY_DECLARATION = [
  ['editor', 'the map editor', decl => decl.package === 'Editor'],
  ['multiplayer', 'network sockets (IpDrv)', decl => decl.package === 'IpDrv'],
  ['multiplayer', 'server statistics logging (UT StatLog)', decl => /^Engine\.StatLog(File)?\./.test(decl.key)],
  ['stage-6', 'saves and the save directory (docs/travel.md, roadmap section 6)', decl => /^DeusEx\.(GameDirectory|DeusExSaveInfo)\./.test(decl.key)],
];

/** Hand-written facts the callers alone do not give, each with its evidence. Keyed by lower-case declaration key. */
const NOTES = new Map([
  ['extension.playerpawnext.prerenderwindows', 'Called by the PreRender event; Play paints the windows from its own render path (src/runtime/script-play-hud.mjs), so the script event is not dispatched.'],
  ['extension.playerpawnext.postrenderwindows', 'Called by the PostRenderFlash event; same as PreRenderWindows.'],
  ['deusex.dumplocation.loadlocation', 'DeusExGameInfo.Login calls it only when HasLocationBeenSaved (3039, handled) is true (docs/travel.md); the DumpLocation windows call it too.'],
  ['engine.actor.consolecommand', 'Reached only through context calls whose receiver class this reading cannot type; the player\'s ConsoleCommand is PlayerPawn.ConsoleCommand (handled by name).'],
  ['engine.console.consolecommand', 'Reached only through context calls whose receiver class this reading cannot type; Play creates no script Console object.'],
  ['engine.actor.playownedsound', 'DeusExWeapon.PlaySimSound (called by Fire, ClientFire and PlayFiringSound) and SpawnEffectSounds: a fired weapon, not a rare path.'],
  ['engine.actor.parabolictrace', 'ScriptedPawn.AISafeToThrow and GetProjectileList: an NPC deciding to throw a grenade or avoid a projectile.'],
  ['extension.window.convertcoordinates', 'Inventory drag and drop (the item buttons and the belt slots).'],
  ['extension.gc.drawactor', 'The vision augmentation (AugmentationDisplayWindow) and the actor display window.'],
  ['consys.conversation.createflagref', 'Only Conversation.AddFlagRef calls it, and no script calls AddFlagRef: the conversation import does (Play loads conversations through script-native-conversation-list.mjs).'],
  ['engine.actor.getnextintdesc', 'Outside the UT browser only GameInfo.GetRules (the server rules list) calls it.'],
  ['engine.playerpawn.updateurl', 'Callers: the multiplayer class and team menu choices, PlayerPawn.SetName and ClientChangeTeam.'],
  ['engine.playerpawn.getdefaulturl', 'Callers: the multiplayer class and team menu choices, GameInfo.ProcessServerTravel.'],
  ['engine.playerpawn.getentrylevel', 'Callers: the multiplayer server list, ping and join menus, Engine.Console and the UT browser.'],
  ['engine.playerpawn.getplayernetworkaddress', 'Only PlayerPawn.KickBan.'],
  ['engine.levelinfo.getaddressurl', 'GameInfo.GetServerPort, the UdpBeacon and the UT browser.'],
  ['engine.gameinfo.parsekillmessage', 'Only GameInfo.Killed.'],
  ['engine.console.savetimedemo', 'Only Console.PrintTimeDemoResult.'],
  ['engine.warpzoneinfo.warp', 'WarpZoneInfo.ActorEntered; none of the 88 shipped maps names WarpZoneInfo in its name table (grep of Maps/*.dx).'],
  ['engine.warpzoneinfo.unwarp', 'Same as Warp.'],
  ['extension.rootwindow.generatesnapshot', 'DeusExRootWindow.ShowSnapshot, which UIPauseGame calls whenever the UI pauses the game; the save screen calls it for its preview.'],
  ['engine.canvas.drawtile', 'Callers: Canvas.DrawIcon and DrawPattern (script functions) and Engine.Console; the HUD paints through Extension GC natives.'],
  ['engine.pawn.findstairrotation', 'PlayerPawn.PlayerWalking.PlayerMove, the base state function that DeusExPlayer.PlayerWalking inherits (it overrides only ProcessMove, PlayerTick and ZoneChange).'],
  ['engine.actor.movesmooth', 'The PlayerSpectating and PlayerWaiting states of PlayerPawn (ProcessMove); DeusExPlayer declares neither.'],
]);

/** Families, by declaring package and class. */
function family(decl) {
  const cls = decl.class.toLowerCase(), pkg = decl.package;
  if (pkg === 'Editor') return 'editor';
  if (pkg === 'IpDrv') return 'network (IpDrv)';
  if (pkg === 'ConSys') return 'conversation';
  if (pkg === 'DeusExText') return 'text parser';
  if (pkg === 'Core') return cls === 'object' ? (decl.operator ? 'core: operators' : 'core: object') : 'core: debug';
  if (pkg === 'Extension') {
    if (cls === 'gc') return 'window: graphics context';
    if (cls === 'flagbase') return 'flags (FlagBase)';
    if (cls === 'extstring') return 'strings (ExtString)';
    if (cls === 'playerpawnext' || cls === 'rootwindow') return 'window: root and player';
    if (cls === 'computerwindow') return 'window: computer terminal';
    if (/list|edit|scroll|ScaleWindow|scale/i.test(cls)) return 'window: lists, edit boxes, scales';
    return 'window';
  }
  if (pkg === 'DeusEx') {
    if (/^(gamedirectory|deusexsaveinfo)$/.test(cls)) return 'saves and GameDirectory';
    if (cls === 'dumplocation') return 'developer: DumpLocation';
    if (cls === 'particleiterator') return 'particles';
    if (cls === 'scriptedpawn') return 'pawn AI (ScriptedPawn)';
    if (cls === 'deusexplayer') return /save|gamedirectory/i.test(decl.function) ? 'saves and GameDirectory' : 'player (DeusExPlayer)';
    return 'DeusEx: other';
  }
  if (pkg === 'Engine') {
    if (/^statlog/.test(cls)) return 'multiplayer: stat logging';
    if (cls === 'pawn') return 'pawn';
    if (cls === 'playerpawn') return 'player pawn';
    if (cls === 'actor') return 'actor';
    if (cls === 'canvas') return 'canvas';
    if (cls === 'console') return 'console';
    if (/gameinfo|levelinfo|warpzoneinfo|decal/.test(cls)) return cls;
    return 'engine: other';
  }
  return pkg;
}

// ---------------------------------------------------------------------------------------------------------------------

const assets = await openSystemPackages();
const names = await scriptPackageNames();
const scan = await scanNativeCalls(assets, names);
const reach = resolveCalls(scan);
const registry = handledNatives();
const rustSet = new Set([...RUST_NATIVES.lowered, ...RUST_NATIVES.aiEvents]);
const latentPolls = new Map(Object.entries(LATENT_POLLS).map(([index, poll]) => [Number(index), poll]));

// Translated bodies: modules that declare `nativeIndex: N` (a recovered native body with its validator). A native with a module
// but no dispatcher has its body written and not wired; the registry test and the probe both treat it as missing.
const translated = new Map();
for (const directory of ['src/runtime', 'src/viewer']) {
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.mjs'))) {
    const text = await readFile(path.join(directory, file), 'utf8');
    for (const match of text.matchAll(/nativeIndex:\s*(0x[0-9a-fA-F]+|\d+)/g)) {
      const index = Number(match[1]);
      if (index > 0 && !(translated.get(index) ?? []).includes(`${directory}/${file}`)) translated.set(index, [...(translated.get(index) ?? []), `${directory}/${file}`]);
    }
  }
}
const decisions = new Map(NATIVE_DECISIONS.map(decision => [decision.native, decision]));
const rows = [];
for (const {declaration: decl, sites, via, callers} of reach.values()) {
  const key = decl.key.toLowerCase();
  const handledBy = decl.index ? registry.byIndex.get(decl.index) ?? [] : registry.byName.get(key) ?? [];
  // What limits a handled native: a site installed only under a condition (every site that routes it has `when`), and the
  // receivers or arguments a branch refuses (`partial`).
  const handlingSites = handledBy.map(id => NATIVE_SITES.find(site => site.id === id));
  const scope = handlingSites.flatMap(site => (site.partial ?? []).filter(([index]) => index === decl.index).map(([, text]) => text));
  const conditional = handlingSites.length > 0 && handlingSites.every(site => site.when || site.partial?.some(([index]) => index === decl.index));
  const conditions = handlingSites.filter(site => site.when).map(site => site.when);
  const callerList = [...callers.values()].map(caller => ({...caller, via: [...caller.via], kind: callerKind(caller.key)}));
  const kinds = new Set(callerList.map(caller => caller.kind));
  const row = {
    key: decl.key, index: decl.index, package: decl.package, class: decl.class, function: decl.function, family: family(decl),
    latent: decl.latent, flags: decl.flags,
    handledBy, scope, conditions, conditional, rust: decl.index ? rustSet.has(decl.index) : false, latentPoll: latentPolls.get(decl.index) ?? null,
    callSites: sites, via, callerCount: callerList.length,
    callerKinds: Object.fromEntries([...kinds].map(kind => [kind, callerList.filter(caller => caller.kind === kind).length])),
    callers: callerList,
    decision: decisions.get(decl.index || key) ?? null,
    note: NOTES.get(key) ?? null,
    translatedBy: decl.index ? translated.get(decl.index) ?? [] : [],
    status: null, owner: null, reach: null,
  };
  if (handledBy.length) row.status = 'handled';
  else {
    const byDeclaration = EXCLUDED_BY_DECLARATION.find(([, , test]) => test(decl));
    const onlyDeferred = callerList.length && callerList.every(caller => ['editor', 'multiplayer', 'saves'].includes(caller.kind));
    if (byDeclaration) { row.status = 'excluded'; row.owner = byDeclaration[0]; row.ownerReason = byDeclaration[1]; }
    else if (onlyDeferred) {
      // The callers decide: the stage that owns most of them.
      row.status = 'excluded';
      row.owner = kinds.has('saves') && !kinds.has('multiplayer') && !kinds.has('editor') ? 'stage-6' : kinds.has('multiplayer') ? 'multiplayer' : 'editor';
      row.ownerReason = `every caller is ${[...kinds].join(' / ')} code`;
    } else if (!callerList.length) row.status = 'missing-unreachable';
    else {
      row.status = 'missing-reachable';
      row.reach = kinds.has('game') ? 'single-player' : kinds.has('engine') ? 'engine-base' : 'developer';
    }
  }
  rows.push(row);
}
rows.sort((a, b) => a.package.localeCompare(b.package) || (a.index || 1e9) - (b.index || 1e9) || a.key.localeCompare(b.key));

const count = (list, key) => { const out = {}; for (const row of list) out[key(row)] = (out[key(row)] ?? 0) + 1; return out; };
const statusCounts = count(rows, row => row.status);
const summary = {
  declared: rows.length, numbered: rows.filter(row => row.index).length, nameBound: rows.filter(row => !row.index).length,
  status: statusCounts,
  byPackage: Object.fromEntries([...new Set(rows.map(row => row.package))].sort().map(pkg =>
    [pkg, count(rows.filter(row => row.package === pkg), row => row.status)])),
  missingReachable: count(rows.filter(row => row.status === 'missing-reachable'), row => row.reach),
  excluded: count(rows.filter(row => row.status === 'excluded'), row => row.owner),
  handledNumbered: rows.filter(row => row.status === 'handled' && row.index).length,
  handledNameBound: rows.filter(row => row.status === 'handled' && !row.index).length,
  handledAndRust: rows.filter(row => row.status === 'handled' && row.rust).length,
  missingWithTranslatedBody: rows.filter(row => row.status !== 'handled' && row.translatedBy.length).map(row => `${row.index} ${row.function}`),
  handledNeverCalled: rows.filter(row => row.status === 'handled' && !row.callSites).length,
  sharedIndices: Object.fromEntries([...rows.reduce((map, row) => row.index ? map.set(row.index, [...(map.get(row.index) ?? []), row.key]) : map, new Map())]
    .filter(([, keys]) => keys.length > 1)),
  pseudoIndices: NATIVE_SITES.flatMap(site => site.pseudo ?? []),
  registryIndicesWithoutDeclaration: [...registry.byIndex.keys()].filter(index => !rows.some(row => row.index === index) && !NATIVE_SITES.some(site => site.pseudo?.includes(index))).sort((a, b) => a - b),
  registryNamesWithoutDeclaration: [...registry.byName.keys()].filter(name => !rows.some(row => row.key.toLowerCase() === name)).sort(),
  sites: NATIVE_SITES.length, decodeErrors: scan.decodeErrors.length,
};

// The optional dynamic probe (scripts/probe-natives.mjs).
const probeFile = option('probe', null);
let probe = null;
if (probeFile) {
  probe = JSON.parse(await readFile(probeFile, 'utf8'));
  summary.probe = {file: probeFile, disagreements: []};
  for (const row of rows) {
    const outcome = probe.outcomes[row.index ? String(row.index) : row.key.toLowerCase()] ?? probe.outcomes[row.key.toLowerCase()];
    if (!outcome) continue;
    row.probe = outcome;
    const handledByChain = outcome.kind !== 'unsupported';
    // A native the registry marks conditional or partial is refused by a bare call in a session without its condition.
    if (handledByChain !== (row.status === 'handled'))
      summary.probe.disagreements.push({key: row.key, index: row.index, status: row.status, probe: outcome.kind, explained: row.conditional});
  }
  summary.probe.slots = Object.keys(probe.outcomes).length;
  summary.probe.unexplained = summary.probe.disagreements.filter(item => !item.explained).length;
}

const jsonOut = option('json', '.work/native-census.json');
await mkdir(path.dirname(path.resolve(jsonOut)), {recursive: true});
await writeFile(jsonOut, JSON.stringify({summary, natives: rows, registry: {sites: NATIVE_SITES.map(({id, layer, file, indices = [], names: keys = []}) => ({id, layer, file, indices: indices.length, names: keys}))}}, null, 1) + '\n');

// ---------------------------------------------------------------------------------------------------------------------
// Markdown for docs/native-census.md
// ---------------------------------------------------------------------------------------------------------------------
const label = row => row.index ? `${row.index} ${row.package}.${row.path ?? `${row.class}.${row.function}`}` : `by name ${row.package}.${row.class}.${row.function}`;
const callerSummary = row => {
  const classes = new Map();
  for (const caller of row.callers) {
    const parts = caller.key.split('.'), name = `${caller.package}.${caller.class}`;
    if (!classes.has(name)) classes.set(name, new Set());
    classes.get(name).add(parts.at(-1));
  }
  const entries = [...classes].map(([name, functions]) => `${name.replace(/^DeusEx\./, '')} (${[...functions].slice(0, 2).join(', ')}${functions.size > 2 ? ', ...' : ''})`);
  return entries.slice(0, 3).join('; ') + (entries.length > 3 ? `; +${entries.length - 3} more classes` : '');
};
const section = (title, list) => {
  if (!list.length) return '';
  const byFamily = new Map();
  for (const row of list) { if (!byFamily.has(row.family)) byFamily.set(row.family, []); byFamily.get(row.family).push(row); }
  let text = `#### ${title} (${list.length})\n\n`;
  for (const [fam, members] of [...byFamily].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    text += `**${fam}** (${members.length})\n\n| native | called from | note |\n|---|---|---|\n`;
    for (const row of members) text += `| ${label(row)} | ${callerSummary(row)} | ${[row.decision ? `Decided ${row.decision.decision} (${row.decision.date}), see Decisions.` : row.note, row.translatedBy.length ? `translated body, not wired: ${row.translatedBy.join(', ')}` : null].filter(Boolean).join(' ')} |\n`;
    text += '\n';
  }
  return text;
};
// A compact list of natives by family: index (or function name) with the declaring class when it helps.
const compact = (title, list) => {
  if (!list.length) return '';
  const byFamily = new Map();
  for (const row of list) { if (!byFamily.has(row.family)) byFamily.set(row.family, []); byFamily.get(row.family).push(row); }
  let text = `#### ${title} (${list.length})\n\n`;
  for (const [fam, members] of [...byFamily].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])))
    text += `- **${fam}** (${members.length}): ${members.map(row => row.index ? `${row.index} ${row.class}.${row.function}` : `${row.class}.${row.function} (by name)`).join(', ')}\n`;
  return text + '\n';
};
const statusTable = () => {
  const statuses = ['handled', 'missing-reachable', 'missing-unreachable', 'excluded'];
  let text = `| package | declared | ${statuses.join(' | ')} |\n|---|---|${statuses.map(() => '---').join('|')}|\n`;
  for (const [pkg, counts] of Object.entries(summary.byPackage))
    text += `| ${pkg} | ${statuses.reduce((sum, status) => sum + (counts[status] ?? 0), 0)} | ${statuses.map(status => counts[status] ?? 0).join(' | ')} |\n`;
  text += `| **all** | **${rows.length}** | ${statuses.map(status => `**${summary.status[status] ?? 0}**`).join(' | ')} |\n\n`;
  return text;
};
const siteTable = () => {
  const counts = new Map();
  for (const row of rows) for (const id of row.handledBy) counts.set(id, (counts.get(id) ?? 0) + 1);
  let text = '| dispatcher | layer | natives routed | source |\n|---|---|---|---|\n';
  for (const site of NATIVE_SITES) text += `| ${site.id} | ${site.layer} | ${counts.get(site.id) ?? 0}${site.gates?.length ? ' (+ forwards ranges)' : ''} | ${site.file} |\n`;
  return text + '\n';
};
const decisionSection = () => {
  const list = rows.filter(row => row.decision);
  const stale = NATIVE_DECISIONS.filter(decision => !rows.some(row => row.decision === decision));
  if (stale.length) throw new Error(`Decisions for natives no package declares: ${stale.map(decision => decision.native)}`);
  let text = `### Decisions\n\nNatives examined and deliberately not routed (\`NATIVE_DECISIONS\` in src/runtime/native-registry.mjs; \`npm test\` fails if a decided native becomes handled). `
    + `\`not-reached\`: the shipped single-player code cannot call it under the shipped configuration; \`host-path\`: Play does the work its body does through another path; `
    + `\`unsupported\`: reachable and not implemented.\n\n`;
  for (const row of list) {
    const decision = row.decision;
    text += `- **${label(row)}** - ${decision.decision} (${decision.date}). ${decision.reason}\n  - Evidence: ${decision.evidence}\n${decision.reopen ? `  - Reopen when: ${decision.reopen}\n` : ''}`;
  }
  return text + '\n';
};
const conditional = rows.filter(row => row.status === 'handled' && row.conditional);
const md = [
  '### Numbers\n\n' + statusTable(),
  '### Dispatchers\n\n' + siteTable(),
  `Handled only under a condition or for some receivers (${conditional.length}):\n\n` +
    conditional.map(row => `- ${label(row)}: ${[...row.conditions, ...row.scope].join('; ')}`).join('\n') + '\n\n',
  '### Missing and reachable\n\n',
  section('From game code (DeusEx, Extension, ConSys)', rows.filter(row => row.status === 'missing-reachable' && row.reach === 'single-player')),
  section('Only from Engine base classes', rows.filter(row => row.status === 'missing-reachable' && row.reach === 'engine-base')),
  section('Developer tools only', rows.filter(row => row.status === 'missing-reachable' && row.reach === 'developer')),
  decisionSection(),
  '### Excluded\n\n',
  ['stage-6', 'multiplayer', 'editor'].map(owner => compact(`Owner: ${owner}`, rows.filter(row => row.status === 'excluded' && row.owner === owner))).join(''),
  '### Missing and unreachable\n\n',
  compact('No shipped script calls them', rows.filter(row => row.status === 'missing-unreachable')),
  `Natives with a translated body (a module declaring \`nativeIndex\`) that no dispatcher routes (${summary.missingWithTranslatedBody.length}): ${summary.missingWithTranslatedBody.join(', ')}\n\n`,
].join('');
await writeFile(option('markdown', '.work/native-census.md'), md);
// --doc FILE: replace the region between the census markers of the document with the generated numbers and lists.
const docFile = option('doc', null);
if (docFile) {
  const text = await readFile(docFile, 'utf8');
  const begin = '<!-- census:begin -->', end = '<!-- census:end -->';
  const from = text.indexOf(begin), to = text.indexOf(end);
  if (from < 0 || to < from) throw new Error(`${docFile} has no ${begin} ... ${end} region`);
  await writeFile(docFile, `${text.slice(0, from + begin.length)}\n\n${md.trim()}\n\n${text.slice(to)}`);
}

console.log(JSON.stringify(summary.status), JSON.stringify({numbered: summary.numbered, nameBound: summary.nameBound}));
console.log('missing-reachable', JSON.stringify(summary.missingReachable), 'excluded', JSON.stringify(summary.excluded));
console.log('handled numbered', summary.handledNumbered, 'name-bound', summary.handledNameBound, 'also in Rust', summary.handledAndRust, 'never called by a script', summary.handledNeverCalled);
if (summary.registryIndicesWithoutDeclaration.length || summary.registryNamesWithoutDeclaration.length)
  console.log('REGISTRY LISTS NATIVES NO PACKAGE DECLARES', summary.registryIndicesWithoutDeclaration, summary.registryNamesWithoutDeclaration);
if (summary.probe) {
  const unexplained = summary.probe.disagreements.filter(item => !item.explained);

  console.log('probe vs registry: agree on', Object.keys(probe.outcomes).length - summary.probe.disagreements.length, 'of', Object.keys(probe.outcomes).length,
    '; disagree on', summary.probe.disagreements.length, '(explained by a condition or a receiver scope in the registry:',
    summary.probe.disagreements.length - unexplained.length + ')', JSON.stringify(unexplained));
}
console.log('written', jsonOut);
