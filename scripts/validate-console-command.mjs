#!/usr/bin/env node
/** Console commands and the key path that reaches them
 * (docs/script-console-command.md):
 *  1. every Exec body's fall-through order, traced in the retail DLLs by
 *     scripts/native-exec-chain-oracle.py, against EXEC_KEYWORDS and the
 *     dispatch steps script-console-command.mjs follows;
 *  2. UStructProperty::ImportText over the input Alias struct, ParseLine and
 *     ParseToken against the unchanged Core bodies
 *     (scripts/native-console-text-oracle.py);
 *  3. Training in Play: Escape runs the User.ini ShowMainMenu binding through
 *     UEngine::InputEvent, FLUSH and the original MenuMain, and closes it. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';
import {EXEC_KEYWORDS, ALIAS_MEMBERS, importStructText, parseLine, parseToken, UnsupportedConsoleCommandError}
  from '../src/runtime/script-console-command.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? process.env.DEUS_EX_NATIVE_PYTHON ??
  '.cache/native-probe-env/bin/python';
const root = gameDirectory();
const run = (script, input) => JSON.parse(execFileSync(python, [script, root],
  {encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024}));

// 1. Fall-through order. A step is KW:<keyword> or CALL:<callee>, where the
// callee is an import/export name or the load path from `this` (the FExec or
// object pointer the body receives). ScriptConsoleExec calls (vtable +0x48)
// carry their executor argument.
const trace = run('scripts/native-exec-chain-oracle.py', '');
const label = step => {
  if (/ParseCommand/.test(step.call)) return `KW:${step.args[1].slice(1, -1)}`;
  const callee = step.call.replace(/^[a-z.]+!/, '').replace(/@@.*$/, '');
  return `CALL:${callee}${/\/0x48$/.test(callee) ? `(${step.args[2]})` : ''}`;
};
const kw = body => EXEC_KEYWORDS[body].map(keyword => `KW:${keyword}`);
const STEPS = {
  'UInput::Exec': [...kw('UInput::Exec'), 'CALL:?ParseToken'],
  'URenderDevice::Exec': kw('URenderDevice::Exec'),
  // The device Play follows (PLAY_RENDER_DEVICE, D3DDrv.D3DRenderDevice): its keywords are EXEC_KEYWORDS.
  'UD3DRenderDevice::Exec': ['CALL:?Exec@URenderDevice', ...kw('UD3DRenderDevice::Exec')],
  // The installed ini's GlideRenderDevice. Play does not dispatch it since f02d132 (no EXEC_KEYWORDS entry),
  // so its trace stays pinned here as the original's own order instead of being dropped.
  'UGlideRenderDevice::Exec': ['CALL:?Exec@URenderDevice', 'KW:TMUDETAIL', 'KW:GetRes', 'KW:GetColorDepths'],
  // FExec this: +0x34 Input (UViewport+0x60), +0x38 RenDev (+0x64), +0x8
  // Console (+0x34) with the viewport Actor (+0x30) as executor.
  'UViewport::Exec': ['CALL:this/0x34/0x28/0x0', 'CALL:this/0x38/0x28/0x0', ...kw('UViewport::Exec'),
    'CALL:this/0x8/0x0/0x48(this/0x4)', 'CALL:?Exec@UPlayer'],
  'UWindowsViewport::Exec': ['CALL:?Exec@UViewport', ...kw('UWindowsViewport::Exec')],
  // Actor (+0x30): XLevel +0xac -> ULevel::Exec (vtable +0x74); Level +0xa8
  // Game +0x544; myHUD +0x628; the Actor; the Inventory (+0xc0) chain; then
  // XLevel.Engine (+0x40) FExec.
  'UPlayer::Exec': ['CALL:this/0x4/0xac/0x0/0x74', 'CALL:this/0x4/0xa8/0x544/0x0/0x48(this/0x4)',
    'CALL:this/0x4/0x628/0x0/0x48(this/0x4)', 'CALL:this/0x4/0x0/0x48(this/0x4)', 'CALL:Inventory chain(this/0x4)',
    'CALL:this/0x4/0xac/0x40/0x28/0x0'],
  // NetDriver +0x3c and DemoRecDriver +0x88 FExecs.
  'ULevel::Exec': ['CALL:this/0x3c/0x28/0x0', 'CALL:this/0x88/0x28/0x0', ...kw('ULevel::Exec')],
  'DDeusExGameEngine::Exec': [...kw('DDeusExGameEngine::Exec'), 'CALL:?Exec@UGameEngine'],
  // GLevel's ULevel::Exec, then Actors(0) (asserted LevelInfo).Game with no executor.
  'UGameEngine::Exec': [...kw('UGameEngine::Exec'), 'CALL:this/0x40/0x0/0x74', 'CALL:this/0x40/0x2c/0x0/0x544/0x0/0x48(0x0)',
    'CALL:?Exec@UEngine'],
  // GSys, StaticExec, GCache, GExec, Client (+0x44, vtable +0x68), Render
  // (+0x48) and Audio (+0x4c) FExecs.
  'UEngine::Exec': ['CALL:?GSys', 'CALL:?StaticExec@UObject', 'CALL:?Exec@FMemCache', 'CALL:?GExec',
    'CALL:this/0x1c/0x0/0x68', 'CALL:this/0x20/0x28/0x0', 'CALL:this/0x24/0x28/0x0', ...kw('UEngine::Exec')],
  'USystem::Exec': kw('USystem::Exec'),
  'UObject::StaticExec': kw('UObject::StaticExec'),
  'FMemCache::Exec': kw('FMemCache::Exec'),
  'FExecHook::Exec': kw('FExecHook::Exec'),
  'UWindowsClient::Exec': ['CALL:?Exec@UClient'],
  'UClient::Exec': kw('UClient::Exec'),
  'URender::Exec': kw('URender::Exec'),
  'UGalaxyAudioSubsystem::Exec': [...kw('UGalaxyAudioSubsystem::Exec'), 'CALL:0x10601145'],
  'Galaxy 0x106019b0': kw('Galaxy 0x106019b0'),
  // GCache.Flush, then Client (+0x44) Flush (vtable +0x58).
  'UEngine::Flush': ['CALL:?Flush@FMemCache', 'CALL:this/0x44/0x0/0x58'],
};
assert.deepEqual(Object.keys(trace).sort(), Object.keys(STEPS).sort());
for (const [body, result] of Object.entries(trace)) {
  assert.equal(result.result, 0, `${body} claims the unclaimed command`);
  const steps = [];
  for (const label_ of result.steps.map(label)) {
    // check() asserts on the symbolic Actors(0) class.
    if (label_ === 'CALL:?appFailAssert') continue;
    // The Inventory loop runs until the symbolic chain reaches the depth
    // limit (a null vtable); one entry stands for the loop.
    if (/^CALL:(this\/0x4(\/0xc0)+\/0x0\/0x48\(this\/0x4\)|0x0)$/.test(label_)) {
      if (steps.at(-1) !== 'CALL:Inventory chain(this/0x4)') steps.push('CALL:Inventory chain(this/0x4)');
      continue;
    }
    steps.push(label_);
  }
  assert.deepEqual(steps, STEPS[body], body);
}
const keywordCount = Object.values(EXEC_KEYWORDS).flat().length;

// 2. Text parsers.
const ini = (await readFile(`${root}/System/User.ini`, 'latin1')).replace(/\r/g, '');
const installed = [...ini.matchAll(/^Aliases\[\d+\]=(.*)$/gm)].map(match => match[1]);
assert.equal(installed.length, 40);
const structCases = [...new Set([...installed,
  'Command="x",Alias=Fire)', '(Alias[1]=Fire)', '(Alias)', '(Foo="a,b",Alias=Fire)', '(Foo=(a,(b)),Alias=Fire)',
  '(Foo=(a,Alias=Fire)', '(Command="a"x,Alias=Fire)', '(Command="esc\\\\aped\\41",Alias=Fi-re_1)',
  '(Alias=Fire,Command="")', '(Command=Unquoted words,Alias=X)', '()', '(alias=lower,command="c")', '(Command="a"',
  '(Command="unterminated,Alias=X)', '(Alias=)', '(Alias=Fire,Alias=Second)', '(=x)', '(Command="a")trailing',
  '( Alias=Fire)', '(Alias=Fire )', '(Foo="q)x",Alias=Fire)', '(Foo=x\ny,Alias=Fire)', '(Command="two\\"q",Alias=A)'])];
const lineCases = [['ShowMainMenu', 256, 0], ['ParseLeftClick|Fire', 256, 0], ['Jump | Axis aUp Speed=+300.0', 256, 0],
  ['a//b|c', 256, 0], ['"x|y"|z', 256, 0], ['', 256, 0], ['|||', 256, 0], ['a\r\n\r\nb', 256, 0], ['abc\r\ndef', 256, 1],
  ['abc\n\ndef', 256, 1], ['abcdef', 4, 0], ['x//"|y', 256, 0]];
const tokenCases = [['  Fire now', 256, 0], ['"a\\b" c', 256, 0], ['"a\\b" c', 64, 1], ['', 256, 0], ['""', 256, 0],
  ['abcdef', 4, 0], ['"abcdef"', 4, 0], ['\tTab', 256, 0], ['"a\\"b" c', 64, 1], ['"a\\"b" c', 64, 0],
  ['"open', 256, 0]];
const texts = run('scripts/native-console-text-oracle.py',
  JSON.stringify({struct: structCases, parseLine: lineCases, parseToken: tokenCases}));
for (const original of texts.struct) {
  const warnings = [], value = {Alias: 'None', Command: ''};
  const rest = importStructText(original.text, ALIAS_MEMBERS, value, warning => warnings.push(warning));
  assert.deepEqual({rest: rest === null ? null : original.text.length - rest.length, Alias: value.Alias,
    Command: value.Command, warnings}, {rest: original.rest, Alias: original.Alias, Command: original.Command,
    warnings: original.warnings}, JSON.stringify(original.text));
}
for (const original of texts.parseLine) {
  const result = parseLine(original.text, original.max, Boolean(original.flag));
  assert.deepEqual({ok: Number(result.ok), consumed: original.text.length - result.rest.length, result: result.line},
    {ok: original.ok, consumed: original.consumed, result: original.result}, `ParseLine ${JSON.stringify(original.text)}`);
}
for (const original of texts.parseToken) {
  const result = parseToken(original.text, original.max, Boolean(original.flag));
  assert.deepEqual({ok: Number(result.ok), consumed: original.text.length - result.rest.length, result: result.token},
    {ok: original.ok, consumed: original.consumed, result: original.result}, `ParseToken ${JSON.stringify(original.text)}`);
}

// 3. Play.
const {AssetStore} = await import('../src/unreal/assets.mjs');
const {decodeMap} = await import('../src/unreal/map.mjs');
const {createGame} = await import('../src/viewer/game.mjs');
const files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
const commands = game.hud.host.consoleCommands;
const idle = {forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false};
const tick = frames => { for (let i = 0; i < frames; i++) { game.tick(1 / 60, idle); game.hud.commands(1432, 1268, null); } };
const classKey = object => object ? runtime.instance(object).cls.record.key : null;
const topModal = () => {
  const W = game.hud.host.W, rootWindow = runtime.namedReference(player, 'rootWindow').get();
  let window = W.ptr(rootWindow, 0x140);
  while (window && W.u8(window, 0x28) < 2) window = W.ptr(window, 0x144);
  return window;
};
const key = (code, pressed) => game.inputKey(code, pressed);
tick(30);

// UViewport::ReadInput calls UpdateInput(0), then ReadInput(dt, *GLog).
// Browser mouse deltas accumulate until that platform sampling boundary.
const mouseXBefore=runtime.readNamed(player,'aMouseX'),mouseYBefore=runtime.readNamed(player,'aMouseY');
game.mouseMotion(1,1);game.mouseMotion(2,1);
assert.equal(runtime.readNamed(player,'aMouseX'),mouseXBefore,'mouse motion waits for UpdateInput');
assert.equal(runtime.readNamed(player,'aMouseY'),mouseYBefore,'mouse motion waits for UpdateInput');
game.doors.scriptRuntime.windowHost.viewportReadInput(.05);
assert.ok(Math.abs(runtime.readNamed(player,'aMouseX')-72)<0.0001,'MouseX cumulative integer delta uses installed Speed=6');
assert.ok(Math.abs(runtime.readNamed(player,'aMouseY')+48)<0.0001,'MouseY delivers the native negative vertical delta');
game.resetInput({releasePhysical:true});

// UInput::StaticInitInput's LoadConfig of Aliases[40] through GConfig.
assert.deepEqual(commands.aliases.filter(alias => alias.Alias !== 'None').map(alias => alias.Alias),
  installed.map(text => /Alias=(\w+)\)$/.exec(text)[1]).filter(name => name !== 'None'));
assert.equal(commands.aliases[0].Command, 'Button bFire | Fire');
// Escape=ShowMainMenu: not consumed by the root, so its binding runs; the
// menu's keyboard grab then consumes the release.
assert.deepEqual(key('Escape', true), {handled: true, consumed: false, host: false});
assert.equal(commands.state.flushes, 1, 'ShowMainMenu runs ConsoleCommand("FLUSH") first');
assert.equal(classKey(topModal()), 'deusex.menumain');
assert.deepEqual(key('Escape', false), {handled: true, consumed: true, host: false});
tick(10);
const drawn = new Set(game.hud.commands(1432, 1268, null).map(command => command.texture.key));
for (const texture of ['dxfonts.mainmenutruetype.page0', 'deusexui.userinterface.menumainbuttonnormal_center'])
  assert.ok(drawn.has(texture), `open MenuMain draws ${texture}`);
assert.deepEqual(key('Escape', true), {handled: true, consumed: true, host: false});
key('Escape', false);
tick(10);
assert.equal(topModal(), null, 'Escape closes MenuMain through the root');
// Movement uses the installed User.ini alias and the recovered input commands.
assert.deepEqual(key('KeyW', true), {handled: true, consumed: false, host: false});
key('KeyW', false);
// PlayerPawn.ConsoleCommand through UWindowsViewport::Exec.
assert.equal(commands.consoleCommand(player, 'FLUSH'), '');
assert.equal(commands.state.flushes, 2);
assert.equal(commands.consoleCommand(player, 'KEYNAME 27'), 'Escape');
assert.equal(commands.consoleCommand(player, 'KEYBINDING Escape'), 'ShowMainMenu');
assert.equal(commands.consoleCommand(player, 'NoSuchCommand 1'), '');
// UWindowsViewport::Exec GetCurrentRes (0x11106e23): Logf("%ix%i") of the
// viewport size, the drawing buffer the last frame painted (1432x1268 above).
assert.equal(commands.consoleCommand(player, 'GetCurrentRes'), '1432x1268');
assert.throws(() => commands.consoleCommand(player, 'GetCurrentColorDepth'),
  error => error instanceof UnsupportedConsoleCommandError && error.body === 'UWindowsViewport::Exec', 'GetCurrentColorDepth');
for (const [command, body] of [['OPEN 00_Training', 'UGameEngine::Exec'],
  ['obj list', 'UObject::StaticExec'], ['stat fps', 'URender::Exec']])
  assert.throws(() => commands.consoleCommand(player, command),
    error => error instanceof UnsupportedConsoleCommandError && error.body === body, command);
// DeusExRootWindow.InitWindow's ConditionalBindMultiplayerKeys ran at startup:
// no key was bound to Talk/TeamTalk/BuySkills/KillerProfile/ShowScores and
// T, Y, B, K, Equals were free in the installed User.ini, so its five
// SET InputExt commands (UObject::StaticExec -> GlobalSetProperty) bound them,
// and SaveConfig wrote the whole [Extension.InputExt] section.
for (const [name, alias] of [['T', 'Talk'], ['Y', 'TeamTalk'], ['B', 'BuySkills'], ['K', 'KillerProfile'], ['Equals', 'ShowScores']]) {
  assert.equal(commands.consoleCommand(player, `KEYBINDING ${name}`), alias, `ConditionalBindMultiplayerKeys bound ${name}`);
  assert.equal(game.hud.host.input.defaults.bindings[game.hud.host.inputKeyNames.indexOf(`IK_${name}`)], alias);
}
const userIni = runtime.classLoader.graph.config.written.get('user.ini') ?? '';
assert.match(userIni, /\[Extension\.InputExt\]\r\n/, 'SaveConfig wrote the InputExt section');
assert.match(userIni, /\r\nT=Talk\r\n/);
assert.match(userIni, /\r\nAliases\[0\]=\(Command="Button bFire \| Fire",Alias=Fire\)\r\n/, 'the Alias struct export round-trips');
assert.equal(commands.consoleCommand(player, 'SET InputExt NoSuchKey 1'), 'Unrecognized property NoSuchKey');
assert.equal(commands.consoleCommand(player, 'SET InputExt'), 'Unrecognized property ');
// UObject::GlobalSetProperty for a script class (0x101523a0): every live object that IsA the class takes the ImportText of the value
// (the live-scene acceptance aims the player with `set JCDentonMale ViewRotation (...)`). AActor::PostEditChange (0x10369140) is a game no-op.
// The class defaults and SaveConfig are not modelled; property kinds other than int/float/bool/name/Rotator/Vector are not linked and throw.
{
  const before = [...runtime.readNamed(player, 'ViewRotation')];
  assert.equal(commands.consoleCommand(player, 'SET JCDentonMale ViewRotation (Pitch=-10130,Yaw=49096,Roll=0)'), '');
  assert.deepEqual([...runtime.readNamed(player, 'ViewRotation')], [-10130, 49096, 0], 'SET writes the Rotator members it names');
  assert.equal(commands.consoleCommand(player, 'SET DeusEx.JCDentonMale ViewRotation (Yaw=-16440)'), '');
  assert.deepEqual([...runtime.readNamed(player, 'ViewRotation')], [-10130, -16440, 0], 'members the text omits keep their values');
  runtime.writeNamed(player, 'ViewRotation', before);
  const cheats = runtime.readNamed(player, 'bCheatsEnabled');
  assert.equal(commands.consoleCommand(player, `SET DeusExPlayer bCheatsEnabled ${cheats ? 'False' : 'True'}`), '');
  assert.equal(runtime.readNamed(player, 'bCheatsEnabled'), !cheats, 'SET of a bool reaches every object that IsA the class (a superclass name)');
  runtime.writeNamed(player, 'bCheatsEnabled', cheats);
  assert.equal(commands.consoleCommand(player, 'SET JCDentonMale NoSuchProperty 1'), 'Unrecognized property NoSuchProperty');
  assert.throws(() => commands.consoleCommand(player, 'SET DeusExPlayer Weapon None'),
    error => error instanceof UnsupportedConsoleCommandError && /not linked/.test(error.message), 'an object property is not linked');
}
// F1=ShowInventoryWindow opens the persona screen; Escape closes it.
key('F1', true); key('F1', false); tick(5);
assert.equal(classKey(topModal()), 'deusex.personascreeninventory');
key('Escape', true); key('Escape', false); tick(5);
assert.equal(topModal(), null);
// A key whose release never arrived stays in the table and its next press is
// ignored, until ResetInput clears the table (Play: browser focus loss).
assert.equal(key('Tab', true).handled, true);
assert.equal(key('Tab', true).handled, false);
game.resetInput({releasePhysical:true});
assert.equal(key('Tab', true).handled, true);
key('Tab', false);

console.log(`validate-console-command: ${Object.keys(trace).length} Exec bodies (${keywordCount} keywords) match their ` +
  `retail fall-through order; ${texts.struct.length} struct ImportText, ${texts.parseLine.length} ParseLine and ` +
  `${texts.parseToken.length} ParseToken cases match Core; in Play, Escape opens MenuMain through InputEvent, the ` +
  'ShowMainMenu binding and FLUSH, draws it, and closes it; ConsoleCommand dispatch and keyword boundaries hold; ' +
  'ConditionalBindMultiplayerKeys SET the five free multiplayer keys and SaveConfig wrote [Extension.InputExt]');
