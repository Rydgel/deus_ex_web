import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigCache, loadConfigCache } from '../src/runtime/config-cache.mjs';
import { decodeIniBytes, encodeIniText, sameBytes } from '../src/runtime/ini-bytes.mjs';
import { createConfigStore, layerConfigFiles, rebaseIni, PERSISTED_INI } from '../src/runtime/config-store.mjs';
import { startupViewport, chosenResolution } from '../src/runtime/display-config.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';

const bytes = text => encodeIniText(text);
const file = (path, text) => ({ path, read: async () => bytes(text) });
const SYSTEM = '[Engine.Engine]\r\nGameRenderDevice=D3DDrv.D3DRenderDevice\r\n\r\n[WinDrv.WindowsClient]\r\nStartupFullscreen=True\r\nFullscreenViewportX=640\r\nFullscreenViewportY=480\r\nWindowedViewportX=640\r\nWindowedViewportY=480\r\nBrightness=0.600000\r\n\r\n';
const USER = '[DeusEx.DeusExPlayer]\r\nbAskedToTrain=False\r\nbSubtitles=True\r\n\r\n';

test('appSaveStringToFile: bytes for Latin-1, UTF-16LE after FF FE when a character is 0x100 or more', () => {
  const ansi = encodeIniText('[A]\r\nK=café\r\n');
  assert.equal(ansi.length, 13, 'one byte per character, no terminating NUL');
  assert.equal(ansi[10], 0xe9);
  assert.equal(decodeIniBytes(ansi), '[A]\r\nK=café\r\n');
  const wide = encodeIniText('[A]\r\nK=Ł\r\n');
  assert.deepEqual([...wide.subarray(0, 4)], [0xff, 0xfe, 0x5b, 0x00], 'BOM, then UTF-16LE of the whole text');
  assert.equal(wide.length, 2 + 2 * '[A]\r\nK=Ł\r\n'.length);
  assert.equal(decodeIniBytes(wide), '[A]\r\nK=Ł\r\n');
  assert.ok(sameBytes(encodeIniText(''), new Uint8Array(0)));
  assert.equal(sameBytes(ansi, wide), false);
});

test('ConfigCache.flush reports each written file once, and only dirty ones', () => {
  const writes = [];
  const cache = new ConfigCache({ files: new Map([['user.ini', USER], ['deusex.ini', SYSTEM]]), onWrite: (name, text) => writes.push([name, text]) });
  cache.setString('DeusEx.DeusExPlayer', 'bAskedToTrain', 'False', 'User');
  cache.flush(false);
  assert.deepEqual(writes, [], 'an unchanged value dirties nothing');
  cache.setString('DeusEx.DeusExPlayer', 'bAskedToTrain', 'True', 'User');
  cache.flush(false);
  assert.deepEqual(writes, [['User.ini', '[DeusEx.DeusExPlayer]\r\nbAskedToTrain=True\r\nbSubtitles=True\r\n\r\n']]);
  cache.flush(false);
  assert.equal(writes.length, 1, 'a clean file is not written again');
});

test('layering: installed file, kept file over it, rebase when the installed file changed', () => {
  const store = createConfigStore();
  const installed = bytes(SYSTEM);
  assert.ok(sameBytes(store.layer('DeusEx.ini', installed), installed), 'nothing kept: the installed file');
  const written = SYSTEM.replace('Brightness=0.600000', 'Brightness=0.800000');
  store.write('DeusEx.ini', written);
  assert.equal(decodeIniBytes(store.layer('deusex.ini', installed)), written, 'the kept file is the file the game wrote');
  // the installed file changes under it: a new key, and a changed one the player did not touch
  const newer = SYSTEM.replace('GameRenderDevice=D3DDrv.D3DRenderDevice', 'GameRenderDevice=OpenGLDrv.OpenGLRenderDevice') + '[Added]\r\nKey=1\r\n\r\n';
  const kept = createConfigStore({ saved: store.snapshot() });
  const layered = decodeIniBytes(kept.layer('deusex.ini', bytes(newer)));
  assert.match(layered, /GameRenderDevice=OpenGLDrv\.OpenGLRenderDevice/, 'a value the player did not change follows the installed file');
  assert.match(layered, /Brightness=0\.800000/, 'a value the player changed is kept');
  assert.match(layered, /\[Added\]\r\nKey=1/, 'a section the installed file added is there');
  assert.deepEqual(kept.rebased, ['deusex.ini']);
  assert.equal(decodeIniBytes(rebaseIni(bytes(SYSTEM), store.snapshot().get('deusex.ini'))), written, 'over the file it was written over, a rebase is the written file');
  kept.clear();
  assert.ok(sameBytes(kept.layer('deusex.ini', bytes(newer)), bytes(newer)), 'cleared: the installed file again');
});

test('layerConfigFiles: first-run copy of Default.ini and DefUser.ini, the kept file over an installed one', async () => {
  const store = createConfigStore();
  const files = [file('Deus Ex/System/Default.ini', SYSTEM), file('Deus Ex/System/DefUser.ini', USER), file('Deus Ex/System/Manifest.ini', '[M]\r\n')];
  const layered = layerConfigFiles(files, store);
  const leaf = entry => entry.path.split('/').pop();
  assert.deepEqual(layered.map(leaf).sort(), ['DefUser.ini', 'Default.ini', 'DeusEx.ini', 'Manifest.ini', 'User.ini']);
  const system = layered.find(entry => leaf(entry) === 'DeusEx.ini');
  assert.equal(system.path, 'Deus Ex/System/DeusEx.ini', 'the copy sits where Default.ini does');
  assert.equal(decodeIniBytes(await system.read()), SYSTEM, 'appInit copies Default.ini text to the missing DeusEx.ini');
  store.write('DeusEx.ini', SYSTEM.replace('0.600000', '0.300000'));
  assert.match(decodeIniBytes(await system.read()), /Brightness=0\.300000/, 'a later read sees the write');
  assert.equal(decodeIniBytes(await layered.find(entry => leaf(entry) === 'Default.ini').read()), SYSTEM, 'Default.ini itself is never layered');
  // with both files installed nothing is copied
  const both = layerConfigFiles([file('System/DeusEx.ini', 'a'), file('System/User.ini', 'b'), file('System/Default.ini', 'c')], null);
  assert.deepEqual(both.map(leaf).sort(), ['Default.ini', 'DeusEx.ini', 'User.ini']);
  // a kept file with no installed file and no default is the file
  const alone = createConfigStore({ saved: new Map([['user.ini', { bytes: bytes(USER), base: new Uint8Array(0) }]]) });
  const lone = layerConfigFiles([], alone);
  assert.deepEqual(lone.map(leaf), ['User.ini']);
  assert.equal(decodeIniBytes(await lone[0].read()), USER);
  assert.deepEqual(PERSISTED_INI, ['deusex.ini', 'user.ini']);
});

test('the asset store reads the kept files, and a second cache reads what Flush wrote', async () => {
  const sunk = [];
  const store = createConfigStore({ persist: (leaf, record) => sunk.push([leaf, record]) });
  const assets = new AssetStore([file('System/DeusEx.ini', SYSTEM), file('System/User.ini', USER)], { configStore: store });
  const first = await loadConfigCache(assets.configFiles, { onWrite: (name, text) => store.write(name, text) });
  assert.equal(first.getString('DeusEx.DeusExPlayer', 'bAskedToTrain', 'User'), 'False');
  first.setString('DeusEx.DeusExPlayer', 'bAskedToTrain', 'True', 'User');
  first.flush(false);
  assert.equal(sunk.length, 1);
  assert.equal(sunk[0][0], 'user.ini');
  assert.equal(decodeIniBytes(sunk[0][1].bytes), '[DeusEx.DeusExPlayer]\r\nbAskedToTrain=True\r\nbSubtitles=True\r\n\r\n');
  assert.ok(sameBytes(sunk[0][1].base, bytes(USER)), 'the record keeps the installed file it was written over');
  // the next map load builds a new cache over the same asset store
  const second = await loadConfigCache(assets.configFiles);
  assert.equal(second.getString('DeusEx.DeusExPlayer', 'bAskedToTrain', 'User'), 'True');
  assert.equal(second.getString('Engine.Engine', 'GameRenderDevice', 'System'), 'D3DDrv.D3DRenderDevice', 'a file nothing wrote is the installed file');
  // a page reload: a new store over the saved records
  const reloaded = new AssetStore([file('System/DeusEx.ini', SYSTEM), file('System/User.ini', USER)], { configStore: createConfigStore({ saved: store.snapshot() }) });
  assert.equal((await loadConfigCache(reloaded.configFiles)).getString('DeusEx.DeusExPlayer', 'bAskedToTrain', 'User'), 'True');
  // without a store the files are the installed ones, and the cache has no sink
  const plain = new AssetStore([file('System/DeusEx.ini', SYSTEM), file('System/User.ini', USER)]);
  assert.equal((await loadConfigCache(plain.configFiles)).getString('DeusEx.DeusExPlayer', 'bAskedToTrain', 'User'), 'False');
});

test('the startup viewport is the one StartupFullscreen picks, and only a different one is a chosen resolution', () => {
  assert.deepEqual(startupViewport(SYSTEM), { fullscreen: true, width: 640, height: 480 });
  const windowed = SYSTEM.replace('StartupFullscreen=True', 'StartupFullscreen=False').replace('WindowedViewportX=640', 'WindowedViewportX=800');
  assert.deepEqual(startupViewport(windowed), { fullscreen: false, width: 800, height: 480 });
  assert.equal(startupViewport('[WinDrv.WindowsClient]\r\nStartupFullscreen=True\r\n'), null, 'no keys, no viewport');
  assert.equal(startupViewport(null), null);
  assert.equal(chosenResolution(SYSTEM, SYSTEM), null, 'the installed size is no choice');
  const chosen = SYSTEM.replace('FullscreenViewportX=640', 'FullscreenViewportX=1024').replace('FullscreenViewportY=480', 'FullscreenViewportY=768');
  assert.deepEqual(chosenResolution(SYSTEM, chosen), { width: 1024, height: 768 });
  // a size chosen while windowed does not take effect at a fullscreen start, as in the original
  const chosenWindowed = SYSTEM.replace('WindowedViewportX=640', 'WindowedViewportX=800');
  assert.equal(chosenResolution(SYSTEM, chosenWindowed), null);
  assert.deepEqual(chosenResolution(null, chosen), { width: 1024, height: 768 }, 'no installed file: any kept size is a choice');
  // the page starts windowed whatever StartupFullscreen says: its start reads the Windowed* keys
  assert.deepEqual(startupViewport(SYSTEM, false), { fullscreen: false, width: 640, height: 480 });
  assert.deepEqual(chosenResolution(SYSTEM, chosenWindowed, false), { width: 800, height: 480 });
  assert.equal(chosenResolution(SYSTEM, chosen, false), null, 'a size chosen in fullscreen does not take effect at a windowed start');
});

test('only the System and User files are kept', () => {
  const sunk = [];
  const store = createConfigStore({ persist: (leaf) => sunk.push(leaf) });
  assert.equal(store.write('Detected.ini', '[A]\r\n'), null);
  assert.equal(store.accept('Running.ini', { bytes: bytes('x'), base: bytes('') }), null);
  store.write('User.ini', USER);
  assert.deepEqual(sunk, ['user.ini']);
  assert.deepEqual([...store.snapshot().keys()], ['user.ini']);
});
