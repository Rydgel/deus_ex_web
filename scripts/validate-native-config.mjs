/** `get` / `set ini:` on the native config classes (docs/script-native-config.md), headless.
 *
 * Part 1, the registry over the installed DeusEx.ini: class resolution (ini: indirection through
 * GConfig, bare names, classes the engine did not load, a missing ini key), FindField, ExportText of
 * the class defaults, and GlobalSetProperty's order: the live instance takes ImportText then the
 * class's PostEditChange clamp, the class defaults take the raw value, SaveConfig writes every config
 * property of the class into GConfig (and flushes it) and the defaults reload from that text.
 *
 * Part 2, Training with the original menus: the Sound screen's sliders reach the live Galaxy
 * subsystem and its library through SetInstant*Volume and PostEditChange -> SetVolumes (volumes
 * checked against the x87 arithmetic of galaxy-volumes.mjs); Display > Brightness reaches the render
 * device's Flush; the Controls screen's Mouse Sensitivity and Invert Mouse change what
 * PlayerPawn.PlayerInput does with mouse motion; a SetRes request is recorded for the page. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {loadConfigCache} from '../src/runtime/config-cache.mjs';
import {createNativeConfig, PLAY_RENDER_DEVICE, UnsupportedNativeConfigError} from '../src/runtime/script-native-config.mjs';
import {createMenuDriver} from '../src/viewer/menu-driver.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files);
let checks = 0;
const is = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };

// ---- Part 1: the registry ------------------------------------------------------------------------
{
  const gconfig = await loadConfigCache(assets.configFiles);
  const volumes = {state: {musicVolume: 153, soundVolume: 204, speechVolume: 255}};
  const galaxyConfig = {ambientFactor: 0.7, dopplerSpeed: 6500, useSurround: 0, reverseStereo: 0, effectsChannels: 16};
  const calls = [];
  let live = {volumes, galaxyConfig, music: {setVolumes: () => calls.push('setVolumes')}};
  const config = createNativeConfig({gconfig, audio: () => live});
  const get = (token, name) => { const cls = config.findClass(token), field = cls && config.findField(cls, name); return field ? config.getText(cls, field) : null; };
  const set = (token, name, text) => { const cls = config.findClass(token); config.globalSetProperty(cls, config.findField(cls, name), text); };
  // Installed values, through the ini: indirection and every spelling of the class.
  is(get('ini:Engine.Engine.ViewportManager', 'Brightness'), '0.600000', 'Brightness');
  is(get('WinDrv.WindowsClient', 'brightness'), '0.600000', 'full path, case-insensitive property');
  is(get('WindowsClient', 'TextureDetail'), 'High', 'bare class name, byte enum');
  // The abstract base has no [Engine.Client] section: its constructor default is not recovered.
  assert.throws(() => get('Engine.Client', 'Decals'), UnsupportedNativeConfigError); checks++;
  is(get('ini:Engine.Engine.AudioDevice', 'OutputRate'), '44100Hz', 'Galaxy OutputRates enum');
  is(get('ini:Engine.Engine.AudioDevice', 'AmbientFactor'), '0.700000', 'float');
  is(get('ini:Engine.Engine.AudioDevice', 'Latency'), '40', 'int');
  // One render device: the installed ini names Glide, Play's rendering is D3DDrv's (PLAY_RENDER_DEVICE).
  is([gconfig.getString('Engine.Engine', 'GameRenderDevice', 'System'), config.findClass('ini:Engine.Engine.GameRenderDevice').path],
    ['GlideDrv.GlideRenderDevice', PLAY_RENDER_DEVICE], 'GameRenderDevice resolves to the D3D device the renderer follows');
  is(get('ini:Engine.Engine.GameRenderDevice', 'DetailTextures'), 'True', 'URenderDevice property of the D3D device');
  is(get('ini:Engine.Engine.GameRenderDevice', 'UseGammaCorrection'), 'True', 'a D3DRenderDevice property');
  is(get('ini:Engine.Engine.GameRenderDevice', 'HighDetailActors'), 'True', 'another');
  // Lookups that fail the way the original's do.
  is(config.findClass('ini:Engine.Engine.NoSuchKey'), null, 'ResolveName fails for a missing ini key');
  is(config.findClass('GlideDrv.GlideRenderDevice'), null, 'a render device the engine did not load');
  is(config.findField(config.findClass('WindowsClient'), 'NoSuchProperty'), null, 'FindField returns none');
  is(config.findField(config.findClass('ini:Engine.Engine.GameRenderDevice'), 'NoSuchDeviceProperty'), null, 'the D3D device is fully tabled: FindField returns none');
  // GlobalSetProperty: instance clamp, raw defaults, SaveConfig into GConfig.
  set('ini:Engine.Engine.ViewportManager', 'Brightness', '7');
  is(config.instance('WinDrv.WindowsClient', 'Brightness'), 1, 'UClient::PostEditChange clamps the live Brightness to 1');
  is(get('ini:Engine.Engine.ViewportManager', 'Brightness'), '7.000000', 'the class default keeps the imported value');
  is(gconfig.getString('WinDrv.WindowsClient', 'Brightness', 'System'), '7.000000', 'SaveConfig wrote [WinDrv.WindowsClient]');
  is(gconfig.getString('WinDrv.WindowsClient', 'Decals', 'System'), 'True', 'every config property of the class was exported');
  assert.match(gconfig.written.get('deusex.ini'), /\[WinDrv\.WindowsClient\]\r\nWindowedViewportX=640/); checks++;
  set('WindowsClient', 'MipFactor', '-9');
  is(config.instance('WinDrv.WindowsClient', 'MipFactor'), -3, 'MipFactor clamps to -3');
  set('WindowsClient', 'Brightness', 'x');                            // float ImportText never fails: atof("x") = 0
  is(config.instance('WinDrv.WindowsClient', 'Brightness'), 0, 'atof of text with no digits');
  set('WindowsClient', 'ScreenFlashes', 'maybe');                     // a bool that does not parse leaves the value
  is(get('WindowsClient', 'ScreenFlashes'), 'True', 'a bool that does not parse is left alone');
  set('WindowsClient', 'ScreenFlashes', 'false');
  is(get('WindowsClient', 'ScreenFlashes'), 'False', 'bool ImportText is case-insensitive');
  assert.throws(() => set('WindowsClient', 'UseJoystick', 'True'), UnsupportedNativeConfigError); checks++;
  // The Galaxy instance is Play's own audio state; PostEditChange clamps then SetVolumes.
  calls.length = 0;
  set('ini:Engine.Engine.AudioDevice', 'SoundVolume', '100');
  is([volumes.state.soundVolume, get('ini:Engine.Engine.AudioDevice', 'SoundVolume'), calls], [100, '100', ['setVolumes']], 'SoundVolume reaches the live byte, then SetVolumes');
  set('ini:Engine.Engine.AudioDevice', 'EffectsChannels', '99');
  is([config.instance('Galaxy.GalaxyAudioSubsystem', 'EffectsChannels'), galaxyConfig.effectsChannels, get('ini:Engine.Engine.AudioDevice', 'EffectsChannels')], [32, 16, '99'],
    'EffectsChannels clamps 0..32 on the instance, raw in the defaults; the voice array keeps its size');
  set('ini:Engine.Engine.AudioDevice', 'DopplerSpeed', '0.5');
  is(galaxyConfig.dopplerSpeed, 1, 'DopplerSpeed clamps to 1..100000');
  set('ini:Engine.Engine.AudioDevice', 'AmbientFactor', '55');
  is(galaxyConfig.ambientFactor, 10, 'AmbientFactor clamps to 0..10');
  set('ini:Engine.Engine.AudioDevice', 'OutputRate', '48000Hz');
  is(get('ini:Engine.Engine.AudioDevice', 'OutputRate'), '48000Hz', 'enum name import');
  set('ini:Engine.Engine.AudioDevice', 'UseSurround', 'True');
  is(galaxyConfig.useSurround, 1, 'a flag Update reads each frame is live');
  live = null;
  set('ini:Engine.Engine.AudioDevice', 'SoundVolume', '10');                              // no live audio (between maps): the instance keeps its own copy
  is(config.instance('Galaxy.GalaxyAudioSubsystem', 'SoundVolume'), 10, 'the instance without Play\'s audio state');
}

// ---- Part 2: the original menus in Training ---------------------------------------------------------
{
  const asset = await assets.get('00_Training');
  const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
  const paint = () => game.hud.commands(1432, 1268, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
  const input = createPlayerInputFixture(game, {paint});
  input.tick(30);
  const driver = createMenuDriver(game), host = game.doors.scriptRuntime.windowHost, runtime = driver.runtime, player = driver.player;
  const open = (...screens) => { driver.showMainMenu(); input.tick(5); for (const screen of screens) { driver.invoke(screen); input.tick(5); } };
  const audio = runtime.audio, library = audio.library;
  assert.equal(library.kind, 'mirror', 'headless Play records the Galaxy library calls'); checks++;
  const K = 1 / 255;
  // Sound: Sound Effects 5/10, Speech to 100, Music to 51 (11 ticks over 0..255).
  open('MenuSettings', 'MenuScreenSound');
  is(driver.top(), 'deusex.menuscreensound', 'the Sound screen opens');
  driver.drag('MenuChoice_SpeechVolume', 4); input.tick(3);              // 255 * 4/10 = 102
  driver.drag('MenuChoice_SoundVolume', 4); input.tick(3);
  driver.drag('MenuChoice_MusicVolume', 2); input.tick(3);               // 255 * 2/10 = 51
  is([audio.volumes.state.speechVolume, audio.volumes.state.soundVolume, audio.volumes.state.musicVolume], [102, 102, 51], 'slider values reach the live subsystem');
  // PostEditChange -> SetVolumes on OK (SaveSettings sets each slider's config): sound/speech equal ->
  // ftol(float32(102/255 in 80-bit) * 127); music = ftol(1.0 * float32(51/255) * 127).
  driver.pressAction(1); input.tick(5);
  const digital = Math.trunc(Math.fround(Math.fround(102 * K) * 127));
  is(library.state.sampleTarget, digital, 'the digital sample volume is the louder of sound and speech');
  is(library.state.musicTarget, Math.trunc(Math.fround(Math.fround(51 * K)) * 127), 'music volume reaches glxSetMusicVolume');
  is(host.consoleCommands.consoleCommand(player, 'get ini:Engine.Engine.AudioDevice SoundVolume'), '102', 'OK wrote the class default');
  // Display > Brightness: the slider's set + FLUSH reach the render device.
  while (driver.top() !== 'deusex.menusettings') { game.windowKey('Escape', true); game.windowKey('Escape', false); input.tick(5); if (driver.top() === 'deusex.menumain') break; }
  if (driver.top() === 'deusex.menumain') { driver.invoke('MenuSettings'); input.tick(5); }
  driver.invoke('MenuScreenDisplay'); input.tick(5);
  driver.press('MenuChoice_Brightness'); input.tick(5);
  const flushes = host.display.flushes;
  driver.drag('MenuChoice_AdjustBrightness', 10); input.tick(3);         // 21 ticks over 0..1: 0.5
  is([host.display.brightness, host.display.flushes > flushes, driver.top()], [0.5, true, 'deusex.menuscreenbrightness'], 'Flush took Brightness 0.5');
  // Display > Decals: Client.Decals, which AttachDecal and the decal pass read, is the live property.
  const client = runtime.levelFor(player).engine.client;
  is(client.decals, true, 'the installed Decals=True');
  host.consoleCommands.consoleCommand(player, 'set ini:Engine.Engine.ViewportManager Decals False');
  is([client.decals, host.consoleCommands.consoleCommand(player, 'get ini:Engine.Engine.ViewportManager Decals')], [false, 'False'], 'Decals off reaches Client.Decals');
  // Display modes: UD3DRenderDevice::Exec GetRes lists the host's 16-bit modes once each; GetColorDepths is not the
  // D3D device's and stays refused (UWindowsViewport::Exec).
  is(host.consoleCommands.consoleCommand(player, 'GetRes'), '640x480 800x600 1024x768 1280x1024 1600x1200', 'GetRes');
  assert.throws(() => host.consoleCommands.consoleCommand(player, 'GetColorDepths'), error => error.name === 'UnsupportedConsoleCommandError'); checks++;
  // Resolution: SetRes becomes a request for the page.
  host.consoleCommands.consoleCommand(player, 'SetRes 1024x768');
  is(host.display.resolution, {width: 1024, height: 768, colorBytes: null}, 'SetRes request'); is(host.display.resolutionVersion, 1, 'versioned');
  // Display > Toggle Full-Screen Mode: MenuChoice_FullScreen sends ConsoleCommand("TOGGLEFULLSCREEN") down the viewport's Exec chain,
  // where UWindowsViewport::Exec ToggleFullscreen (the call Alt+Enter makes) becomes one request for the page; EndFullscreen and the
  // other unrecovered keywords stay refused.
  for (let guard = 0; driver.top() && guard < 8; guard++) { game.windowKey('Escape', true); game.windowKey('Escape', false); input.tick(5); }
  open('MenuSettings', 'MenuScreenDisplay');
  is(driver.top(), 'deusex.menuscreendisplay', 'the Display screen opens');
  is(host.display.fullscreenToggles, 0, 'no fullscreen request yet');
  driver.press('MenuChoice_FullScreen'); input.tick(5);
  is([host.display.fullscreenToggles, driver.top()], [1, 'deusex.menuscreendisplay'], 'the Full-Screen choice made one request and the screen stayed');
  is(host.consoleCommands.consoleCommand(player, 'togglefullscreen'), '', 'the Exec keyword is case-insensitive and logs nothing');
  is(host.display.fullscreenToggles, 2, 'a second request');
  assert.throws(() => host.consoleCommands.consoleCommand(player, 'EndFullscreen'), error => error.name === 'UnsupportedConsoleCommandError'); checks++;
  // Display > Render Device: the choice's restart prompt; its OK saves the menu and sends RELAUNCH -changevideo (USystem::Exec),
  // which becomes a restart request for the page carrying the arguments the new instance would get.
  driver.press('MenuChoice_RenderDevice'); input.tick(5);
  is(host.display.relaunches, 0, 'the prompt alone relaunches nothing');
  const prompt = driver.top();
  driver.pressField('btnYes'); input.tick(5);
  is([host.display.relaunches, host.display.relaunchArguments], [1, '-changevideo'], `the prompt's OK (${prompt}) relaunched with -changevideo`);
  host.consoleCommands.consoleCommand(player, 'RELAUNCH   -changevideo -nosound');
  is([host.display.relaunches, host.display.relaunchArguments], [2, '-changevideo -nosound'], 'RELAUNCH keeps the arguments past the keyword and its spaces');
  // Controls: Mouse Sensitivity and Invert Mouse drive PlayerInput.
  while (!['deusex.menusettings', 'deusex.menumain'].includes(driver.top())) { game.windowKey('Escape', true); game.windowKey('Escape', false); input.tick(5); }
  if (driver.top() === 'deusex.menumain') { driver.invoke('MenuSettings'); input.tick(5); }
  driver.invoke('MenuScreenControls'); input.tick(5);
  const closeMenus = () => { for (let guard = 0; driver.top() && guard < 8; guard++) { game.windowKey('Escape', true); game.windowKey('Escape', false); input.tick(5); } };
  // Customize Keys: Down + Enter on a row waits for a key (GrabMouse, LockMouse, ShowCursor), the
  // key is taken, OK runs `set Input G ...` through InputExt and replaces the old binding of G.
  const press = code => { game.windowKey(code, true); game.windowKey(code, false); input.tick(3); };
  closeMenus();
  open('MenuSettings', 'MenuScreenCustomizeKeys');
  const bound = key => host.consoleCommands.consoleCommand(player, `KEYBINDING ${key}`);
  is(bound('G'), 'ShowGoalsWindow', 'G is bound to the Goals window');
  press('ArrowDown'); press('Enter');
  is(runtime.readNamed(driver.topWindow(), 'bWaitingForInput'), true, 'the row waits for a key');
  press('KeyG');
  is(runtime.readNamed(driver.topWindow(), 'bWaitingForInput'), false, 'the key was taken');
  driver.pressAction(1); input.tick(5);
  is(bound('G'), 'ParseRightClick', 'G now runs the second row\'s action');
  const mouse = () => { closeMenus(); input.tick(20); const before = [...game.player.viewRotation]; game.inputAxis('MouseX', 10); game.inputAxis('MouseY', 10); input.tick(1);
    const after = game.player.viewRotation; return [after[0] - before[0], after[1] - before[1]]; };
  const [pitch3, yaw3] = mouse();
  assert.ok(yaw3 !== 0 && pitch3 !== 0, `mouse motion turns the player: ${pitch3} ${yaw3}`); checks++;
  open('MenuSettings', 'MenuScreenControls');
  driver.drag('MenuChoice_MouseSensitivity', 5); input.tick(3);           // 10 ticks over 1..10
  const sensitivity = runtime.readNamed(player, 'MouseSensitivity');
  assert.ok(sensitivity > 3, `MenuChoice_MouseSensitivity.ScalePositionChanged -> UpdateSensitivity: ${sensitivity}`); checks++;
  driver.pressAction(1); input.tick(5);                                   // OK
  const [pitchFast, yawFast] = mouse();
  assert.ok(Math.abs(yawFast / yaw3 - sensitivity / 3) < 0.03, `yaw follows MouseSensitivity: ${yaw3} -> ${yawFast} at ${sensitivity}`); checks++;
  open('MenuSettings', 'MenuScreenControls');
  driver.press('MenuChoice_InvertMouse'); driver.pressAction(1); input.tick(5);
  is(runtime.readNamed(player, 'bInvertMouse'), true, 'OK saved Invert Mouse');
  const [pitchInverted, yawInverted] = mouse();
  assert.equal(Math.sign(pitchInverted), -Math.sign(pitchFast), 'Invert Mouse flips the pitch'); checks++;
  assert.equal(yawInverted, yawFast, 'and leaves the yaw'); checks++;
  assert.equal(runtime.readNamed(player, 'MouseSensitivity'), sensitivity, 'sensitivity unchanged'); checks++;
}
console.log(`native-config: ${checks} checks pass`);
process.exit(0);
