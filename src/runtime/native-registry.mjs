/** The single declaration of which of the original's script natives Play handles (docs/native-census.md).
 *
 * A native reaches Play's code by one path: the script VM meets a native call (a native token, or a call to a function
 * declared `native`) and, unless it is one of the VM's own primitive operators, calls ScriptRuntime.invokeNative, whose chain
 * is: the record-key and index branches of invokeNative, the window host's handleNative (which delegates to the per-module
 * window dispatchers), then the `native` callback Play installs (script-doors.mjs nativeCall, wrapped by the log, dump and
 * travel stores). Foreach iterators go through ScriptRuntime.createIterator. Each of those places is one entry below, with
 * the indices (numbered natives) and function keys (natives the shipped declarations bind by name) its code routes.
 *
 * `scripts/native-dispatch-parse.mjs` reads each entry's code and test/native-registry.test.mjs compares the two in both
 * directions, so a dispatcher that gains or loses a native without this file saying so fails `npm test`. A dispatcher that
 * is not listed here fails the same test (every source file that compares a call's index must appear). Nothing here says
 * how much of a native's behavior is implemented: `handled` means a branch routes it; the branch's own validator
 * (scripts/validate-*.mjs) is the evidence for its fidelity, and `partial` names the receivers or arguments a branch
 * refuses.
 *
 * Layers (the first is the order in which a call meets them):
 *   vm            the VM's own primitive operators and the iterator-free short circuits
 *   runtime       ScriptRuntime.invokeNative / createIterator
 *   window-host   Extension window natives: windowLifecycle.handleNative and the dispatchers it calls
 *   play-host     the `native` callback Play installs, and the stores that wrap it
 *   rust          native/script-vm: kinds the lowering hands to the Rust interpreter; each runs the body its JavaScript
 *                 case has (the list accelerates, it adds no native: the registry test checks it is a subset of the rest) */
import {primitiveNativeIndices} from './script-vm.mjs';
import {RUST_LOWERED_NATIVES} from './script-vm-lower.mjs';
import {TRIGGER_NATIVE_INDICES} from './script-triggers.mjs';
import {RANDOM_LABEL_NATIVE} from './script-conversation-random-label.mjs';
import {DEUSEX_VERSION_NATIVE} from './script-deusex-version.mjs';
import {TEXT_PARSER_NATIVE} from './script-text-parser.mjs';

/** The named constants the dispatchers' conditions use, for the static reading (scripts/native-dispatch-parse.mjs). */
export const NATIVE_CONSTANTS = Object.freeze({TRIGGER_NATIVE_INDICES, RANDOM_LABEL_NATIVE, DEUSEX_VERSION_NATIVE, TEXT_PARSER_NATIVE});

/** '1409-1419 1421 1425' -> [1409, ..., 1419, 1421, 1425]. */
export function idx(text) {
  const out = [];
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue;
    const [from, to = from] = word.split('-').map(Number);
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) throw new Error(`Bad native index list "${word}"`);
    for (let index = from; index <= to; index++) out.push(index);
  }
  return out;
}

const R = 'src/runtime/', V = 'src/viewer/';

/** Declared dispatchers. Fields:
 *   id, layer, file, anchor     the site: the function (or table) whose body the test reads
 *   table                       a table of [index, handler] rows rather than a function
 *   aliases                     local names `case` labels use for a constant table (`case index.openText:`)
 *   indices, names              what the site handles itself (names: function keys of natives bound by name)
 *   gates                       [[from, to, childId]]: ranges the site only forwards to the child entry of that id
 *   notRoutes                   [[index, reason]]: comparisons in the site that do not route that native
 *   dynamic                     run-time lookups by index the site makes (a lookup the parser cannot enumerate)
 *   when                        set when the site is installed or consulted only under a condition
 *   partial                     [[index, scope]]: handled for the receivers or arguments named, refused otherwise
 *   pseudo                      indices the site routes that no package declares (the poll natives of latent actions) */
export const NATIVE_SITES = [
  {id: 'vm-primitives', layer: 'vm', file: R + 'script-vm.mjs', anchor: /function native\(index, args, receiver, services, frame\) \{/,
    // native()'s switch, plus the mover (166 186 225) and decoration (152 153 159 161 162 178 246 275) primitives, which the
    // switch hands to their own modules, and the short-circuit pair 130/132 compiled apart (all in primitiveNativeIndices).
    indices: primitiveNativeIndices,
    dynamic: ['moverPrimitiveIndices.has(index)', 'decorationPrimitiveIndices.has(index)', 'STRING_COMPARE_NATIVES.has(index)',
      'UNARY_FLOAT_NATIVES.has(index)', 'VECTOR_PAIR_NATIVES.has(index)'], parsed: false},

  {id: 'runtime-invoke', layer: 'runtime', file: R + 'script-runtime.mjs', anchor: /\n {2}invokeNative\(call\) \{/,
    indices: idx(`113 117-118 167 195 231 252 256 258-262 264 266-267 272 277-284 293-294 298-299 303 320 500 502 504 506 508 510
      512 514 517-518 520-521 523-524 527 529-534 536 548 650 700-701 705 708-711 713-718 721-723 751 1010 1012-1013 1024 1099 1409-1419
      1421-1423 1425 1428 1430-1434 1438 1440 1455-1461 1467 1475-1477 1488 1493 1550-1551 1556-1557 1610-1612 1971 1973 1975-1976
      1978 1980 1985 1987 2001 2052-2056 2060-2062 2100-2102 2108-2109 3016-3017 3970`),
    names: ['engine.pawn.stopwaiting', 'engine.decal.attachdecal', 'engine.playerpawn.clienttravel', 'engine.decal.detachdecal',
      'core.object.dynamicloadobject', 'core.object.getenum'],
    gates: [[1535, 1545, 'window-tile'], [2105, 2107, 'pawn-alliance'], [2210, 2221, 'text-parser']],
    notRoutes: [[0, 'the marker of a native bound by name: its branch tests the record key']],
    dynamic: ['this.boundaryNatives.has(index)', 'names[index]'],
    partial: [[264, 'Play declares 264 a host boundary native (script-doors.mjs boundaryNatives), so this body serves harnesses; Play\'s PlaySound is the play-native one'],
      [262, 'actors with the spawn collision view; the map actors with the native flag word are play-native\'s'],
      [283, 'same receivers as SetCollision'], [298, 'collision-view actors and map actors of an Actor class'],
      [3970, 'attached non-mover actors; a mover only for an equal Physics (script-doors.mjs)']]},
  {id: 'runtime-iterator', layer: 'runtime', file: R + 'script-runtime.mjs', anchor: /\n {2}createIterator\(call\) \{/,
    indices: idx('304 306 309-312 1000 1002-1004'), iterators: true},
  {id: 'pawn-alliance', layer: 'runtime', file: R + 'script-pawn-alliance.mjs', anchor: /export function execPawnAlliance\(/,
    indices: idx('2105-2107')},
  {id: 'window-tile', layer: 'runtime', file: R + 'script-window-tile.mjs', anchor: /export function setTileWindow\(/,
    indices: idx('1535-1545')},
  {id: 'text-parser', layer: 'runtime', file: R + 'script-text-parser-natives.mjs', anchor: /export function dispatchTextParserNative\(/,
    aliases: {index: TEXT_PARSER_NATIVE.indices}, indices: idx('2210-2221')},

  {id: 'window-host', layer: 'window-host', file: R + 'script-window-host.mjs', anchor: /handleNative: call => \{/,
    indices: idx('1472 1552-1553 1940-1943'),
    gates: [[1720, 1812, 'window-list'], [1860, 1860, 'window-edit'], [1880, 1921, 'window-edit']]},
  {id: 'window-sound', layer: 'window-host', file: R + 'script-window-sound.mjs', anchor: /export function dispatchWindowSoundNative\(/,
    indices: idx('1473')},
  {id: 'window-actor-refs', layer: 'window-host', file: R + 'script-window-actor-refs.mjs', anchor: /const dispatch = call =>/,
    indices: idx('1497-1499')},
  {id: 'console-command', layer: 'window-host', file: R + 'script-input-console.mjs', anchor: /playerConsoleCommand\(call,commands\)\{/,
    names: ['engine.playerpawn.consolecommand']},
  {id: 'window-list', layer: 'window-host', file: R + 'script-window-list.mjs', anchor: /export function dispatchListWindowNative\(/,
    indices: idx('1720-1725 1730-1737 1740-1747 1750-1751 1755-1756 1760-1762 1765-1778 1780-1786 1790-1795 1800-1812')},
  {id: 'window-edit', layer: 'window-host', file: R + 'script-window-edit-natives.mjs', anchor: /export function dispatchEditWindowNative\(/,
    indices: idx('1860 1880-1892 1895-1896 1900-1902 1905-1912 1915-1917 1920-1921')},
  {id: 'window-gc', layer: 'window-host', file: R + 'script-window-gc-dispatch.mjs', anchor: /const natives\s*=\s*new Map\(/, table: true,
    indices: idx('1200 1210-1221 1230-1231 1240-1248 1250-1262 1270-1272 1280-1289 1295')},
  {id: 'window-host-natives', layer: 'window-host', file: R + 'script-window-host-natives.mjs', anchor: /export function dispatchWindowHostNative\(/,
    indices: idx(`1420 1424 1426-1427 1429 1439 1442-1449 1450-1451 1453-1454 1462-1466 1468-1470 1474 1482-1487 1489-1492 1495
      1500 1510-1518 1521-1524 1554-1555 1558-1564 1570-1573 1590-1598 1613 1620-1653 1660-1668 1680-1681 1689 1700-1703 1820
      1840-1844 1945-1948 1950-1951 1955-1956`)},

  {id: 'play-native', layer: 'play-host', file: R + 'script-doors.mjs', anchor: /function nativeCall\(call\) \{/,
    indices: idx('262 264-265 283 301-302 544 713-716 724 1052 3970-3971'),
    // 302 is execPollFinishInterpolation (0x103e0100), the poll of the latent action 301 starts: no package declares it.
    pseudo: [302],
    partial: [[262, 'a map actor with the native +0x1dc flag word (script-actor-collision.mjs)'],
      [283, 'a map actor the host holds an identity for'],
      [264, 'an emitter with a measured or modeled global object index plays through Galaxy; another is a recorded no-audio boundary'],
      [713, 'AI events without the Rust event manager are recorded, not propagated'], [714, 'same'], [715, 'same'], [716, 'same'],
      [3970, 'only a mover asking for the Physics it already has']]},
  {id: 'conplay', layer: 'play-host', file: R + 'script-conplay-live.mjs', anchor: /function handleNative\(call\)\{/,
    indices: idx('264 268-270 2051 3002-3003'), when: 'a live ConPlay/DataLinkPlay owns the receiver',
    partial: [[264, 'the speech PlaySound of ConPlay and DataLinkPlay'], [2051, 'a Conversation receiver']]},
  {id: 'triggers', layer: 'play-host', file: R + 'script-triggers.mjs', anchor: /function handleNative\(call\) \{/,
    indices: idx('123 720 1100 1102 1110 1112 1120-1122 1124-1130'),
    partial: idx('1100 1102 1110 1112 1120-1122 1124-1130').map(index => [index, 'the player\'s FlagBase (the receiver must be the bound store)'])},
  {id: 'player-log', layer: 'play-host', file: R + 'script-player-log.mjs', anchor: /runtime\.native=call=>\{/,
    indices: idx('3010 3014')},
  {id: 'player-dump', layer: 'play-host', file: R + 'script-player-dump.mjs', anchor: /runtime\.native=call=>\{/,
    indices: idx('3015 3039')},
  {id: 'travel', layer: 'play-host', file: R + 'script-travel.mjs', anchor: /runtime\.native = call => \{/,
    indices: idx('3012'), when: 'a session that travels (the save store)'},
  {id: 'play-hud', layer: 'play-host', file: R + 'script-play-hud.mjs', anchor: /runtime\.native=call=>\{/,
    indices: idx('1212 1230 1284 1289'), when: 'only while the HUD paints (the draw natives of the HUD background)'},
  {id: 'weapon-overlay', layer: 'play-host', file: V + 'weapon-overlay-sim.mjs', anchor: /runtime\.native=call=>\{/,
    indices: idx('467'), when: 'only while the first-person overlay is recorded'},
];

/** The Rust interpreter's kinds (native/script-vm, lowered by script-vm-lower.mjs): each native here also has a JavaScript
 * dispatcher above, whose body the kind transcribes. natives.rs, percep.rs and gc.rs hold the bodies, aievent.rs the AI event
 * manager (UEventManager) the JavaScript cases 650 and 710-716 hand to when it owns the receiver. */
export const RUST_NATIVES = Object.freeze({
  lowered: RUST_LOWERED_NATIVES,
  aiEvents: Object.freeze(idx('650 710-711 713-716')),
});

/** Latent natives and the latent action their poll runs (ScriptRuntime pollLatent and script-doors.mjs). */
export const LATENT_POLLS = Object.freeze({256: 384, 261: 0x181, 301: 302, 500: 501, 502: 503, 504: 505, 506: 507, 508: 509, 510: 511, 527: 528});

/** Source files that read `call.index` (or a name-bound native's key) but are not dispatchers of Play's chain, with the reason. */
export const NOT_DISPATCHERS = Object.freeze({
  'src/runtime/script-conversation-events.mjs': 'the 2052/2053 bodies and argument contracts that runtime-invoke routes (conversationEventNative)',
  'src/runtime/script-datalink-transmission.mjs': 'a callback service only validators install (createDataLinkNativeService)',
  'src/runtime/script-pawn-carcass.mjs': 'the 2108/2109 body runtime-invoke routes',
  'src/runtime/script-vm-perception.mjs': 'the Rust perception handback of 705 (lowered, RUST_NATIVES)',
});


/** Natives the project has examined and decided not to route, each with the reason and the evidence (docs/native-census.md,
 * "Decisions"). A decision is not a handler: it records why the census keeps listing the native as missing, and the test
 * (test/native-registry.test.mjs) fails when a decided native becomes handled, so a stale decision cannot outlive the code.
 * Fields: `native` (the index, or the lower-case function key `package.class.function` of a native bound by name), `name`,
 * `decision` ('not-reached': the shipped single-player code cannot call it under the shipped configuration; 'host-path':
 * Play does the work the native's body does through another path; 'unsupported': reachable, not implemented), `reason`,
 * `evidence`, `date`, `reopen` (what would make it reachable). */
export const NATIVE_DECISIONS = Object.freeze([
  {native: 'engine.actor.playownedsound', name: 'Actor.PlayOwnedSound', decision: 'not-reached', date: '2026-10-21',
    reason: 'Every caller sits behind a multiplayer or non-default condition. DeusExWeapon.PlaySimSound tests Level.NetMode == NM_Standalone and then calls ' +
      'Owner.PlaySound (264, handled); only the else branch calls PlayOwnedSound. SpawnEffectSounds is called only by DeusExWeapon.SelectiveSpawnEffects, ' +
      'whose first test returns for NM_Standalone. PlayerPawn.DoJump is overridden by DeusExPlayer.DoJump, which has no Super call and plays through ' +
      'PlaySound (264). PlayerPawn.PlayerWalking.Dodge runs only for a double-tap dodge, and both installed User.ini and DefUser.ini set DodgeClickTime=0, ' +
      'which PlayerMove tests (DodgeClickTime > 0) before it reads a dodge. Play runs standalone (NetMode 0, no net driver).',
    evidence: 'dump-script-function.mjs: DeusExWeapon.PlaySimSound (@11 NetMode == 0 -> native 264, @71 PlayOwnedSound), DeusExWeapon.SelectiveSpawnEffects ' +
      '(@0 NetMode == 0 -> SpawnEffects, return), DeusExPlayer.DoJump (native 264 at @90, no Super call); System/User.ini line 249; Engine.dll execPlayOwnedSound ' +
      '0x103e29d0: in NM_Standalone it only forwards ClientHearSound to the player pawns (no local sound of its own).',
    reopen: 'a networked NetMode, or DodgeClickTime > 0 (an edited User.ini; Play has no typed console and does not persist the ini).'},
  {native: 1050, name: 'PlayerPawnExt.PreRenderWindows', decision: 'host-path', date: '2026-10-21',
    reason: 'The native is the Draw-time window work of the PreRender script event (Extension exec 0x10038480 calls the pawn\'s vtable slot +0xb4 with the Canvas). ' +
      'Play never dispatches the PreRender, PostRender or PostRenderFlash events (Engine.PlayerPawn.PreRender only forwards to myHUD); it runs the windows ' +
      'directly: RootWindow rendering rectangle and PreRender frame (script-root-render-viewport.mjs, validate-root-render-viewport against ' +
      '0x1003a7dd..0x1003a8cb) in HudPlay.renderViewport, and the paint in HudPlay.commands (src/runtime/script-play-hud.mjs), both inside the render ' +
      'pass at x87 precision control 24 (render-precision.mjs).',
    evidence: 'dump-script-function.mjs Extension PlayerPawnExt.PreRender (Super.PreRender, native 1050); x86 0x10038480-0x100384c6; docs/conversation-camera.md.',
    reopen: 'a script that overrides PreRender or PostRenderFlash on a shipped PlayerPawn subclass (none: DeusExPlayer declares neither).'},
  {native: 1051, name: 'PlayerPawnExt.PostRenderWindows', decision: 'host-path', date: '2026-10-21',
    reason: 'As PreRenderWindows: exec 0x100384f0 calls the pawn\'s vtable slot +0xb8 with the Canvas, the PostRenderFlash event\'s paint of the root window ' +
      '(XRootWindow::PaintWindows), which HudPlay.commands performs every frame.',
    evidence: 'dump-script-function.mjs Extension PlayerPawnExt.PostRenderFlash (native 1051, then Super.PostRenderFlash, which is empty in Engine.PlayerPawn); x86 0x100384f0-0x10038536.',
    reopen: 'as PreRenderWindows.'},
  {native: 2050, name: 'Conversation.CreateFlagRef', decision: 'not-reached', date: '2026-10-21',
    reason: 'Only Conversation.AddFlagRef calls it, and no shipped script calls AddFlagRef: the conversation import (the editor\'s .con importer) does. A shipped map carries ' +
      'its Conversation objects serialized, ConFlagRef chains included; Play prepares each chain from the package (script-conversation-face-live.mjs) and never imports a .con file.',
    evidence: 'native-census.json callers of 2050 (one: ConSys.Conversation.AddFlagRef; callers of AddFlagRef: none); execCreateFlagRef 0x10010600 (docs/script-conversation-construction.md).',
    reopen: 'importing a conversation source file (an editor feature, out of scope).'},
]);

/** Everything the registry handles, as sorted unique indices and function keys, with the entries that handle each. */
export function handledNatives({layers = null} = {}) {
  const byIndex = new Map(), byName = new Map();
  for (const site of NATIVE_SITES) {
    if (layers && !layers.includes(site.layer)) continue;
    const gated = new Set();
    for (const [from, to] of site.gates ?? []) for (let index = from; index <= to; index++) gated.add(index);
    for (const index of site.indices ?? []) {
      if (gated.has(index) || index === 0) continue;
      if (!byIndex.has(index)) byIndex.set(index, []);
      byIndex.get(index).push(site.id);
    }
    for (const name of site.names ?? []) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(site.id);
    }
  }
  return {byIndex, byName};
}
