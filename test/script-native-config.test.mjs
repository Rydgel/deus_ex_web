import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigCache } from '../src/runtime/config-cache.mjs';
import { createNativeConfig, UnsupportedNativeConfigError } from '../src/runtime/script-native-config.mjs';
import { msvcrtSprintf, msvcrtAtof, stringToFloat } from '../src/runtime/script-text-format.mjs';
import { CORE_CASTS } from '../src/runtime/script-core-casts.mjs';
import { brightnessGamma } from '../src/viewer/display-ramp.mjs';

const ini = `[Engine.Engine]\r\nViewportManager=WinDrv.WindowsClient\r\nAudioDevice=Galaxy.GalaxyAudioSubsystem\r\nGameRenderDevice=GlideDrv.GlideRenderDevice\r\n
[WinDrv.WindowsClient]\r\nBrightness=0.600000\r\nDecals=True\r\nTextureDetail=High\r\nUseJoystick=False\r\n
[Galaxy.GalaxyAudioSubsystem]\r\nSoundVolume=204\r\nMusicVolume=153\r\nSpeechVolume=255\r\nOutputRate=44100Hz\r\nEffectsChannels=16\r\nLatency=40\r\nAmbientFactor=0.700000\r\nDopplerSpeed=6500.000000\r\nUseSurround=False\r\nReverseStereo=False\r\n
[GlideDrv.GlideRenderDevice]\r\nDetailTextures=True\r\n[D3DDrv.D3DRenderDevice]\r\nDetailTextures=True\r\nUseGammaCorrection=True\r\n`;
const registry = (audio = () => null) => {
  const gconfig = new ConfigCache({ files: new Map([['deusex.ini', ini]]) });
  return { gconfig, config: createNativeConfig({ gconfig, audio }) };
};
const get = (config, token, name) => { const cls = config.findClass(token), field = cls && config.findField(cls, name); return field ? config.getText(cls, field) : null; };
const set = (config, token, name, text) => { const cls = config.findClass(token); config.globalSetProperty(cls, config.findField(cls, name), text); };

test('ini: names resolve through GConfig; a missing key or an unloaded class is not found', () => {
  const { config } = registry();
  assert.equal(get(config, 'ini:Engine.Engine.ViewportManager', 'Brightness'), '0.600000');
  assert.equal(get(config, 'WindowsClient', 'brightness'), '0.600000');
  assert.equal(get(config, 'ini:Engine.Engine.AudioDevice', 'OutputRate'), '44100Hz');
  assert.equal(config.findClass('ini:Engine.Engine.NoSuchKey'), null);
  assert.equal(config.findClass('GlideDrv.GlideRenderDevice'), null);
  assert.equal(config.findField(config.findClass('WindowsClient'), 'Nope'), null);
  // The render device is the D3D one whatever the ini names; a driver whose own properties are untabled is a boundary.
  assert.equal(config.findClass('ini:Engine.Engine.GameRenderDevice').path, 'D3DDrv.D3DRenderDevice');
  assert.equal(get(config, 'ini:Engine.Engine.GameRenderDevice', 'UseGammaCorrection'), 'True');
  const glide = createNativeConfig({ gconfig: new ConfigCache({ files: new Map([['deusex.ini', ini]]) }), renderDevice: null });
  assert.throws(() => glide.findField(glide.findClass('ini:Engine.Engine.GameRenderDevice'), 'Resolution'), UnsupportedNativeConfigError);
});

test('SET clamps the live instance, keeps the raw class default, and SaveConfig writes the section', () => {
  const { config, gconfig } = registry();
  set(config, 'ini:Engine.Engine.ViewportManager', 'Brightness', '7');
  assert.equal(config.instance('WinDrv.WindowsClient', 'Brightness'), 1);
  assert.equal(get(config, 'WindowsClient', 'Brightness'), '7.000000');
  assert.equal(gconfig.getString('WinDrv.WindowsClient', 'Brightness', 'System'), '7.000000');
  assert.equal(gconfig.getString('WinDrv.WindowsClient', 'Decals', 'System'), 'True');
  assert.throws(() => set(config, 'WindowsClient', 'UseJoystick', 'True'), UnsupportedNativeConfigError);
});

test('Galaxy PostEditChange clamps and calls SetVolumes on the live audio state', () => {
  const calls = [], volumes = { state: { musicVolume: 153, soundVolume: 204, speechVolume: 255 } };
  const galaxyConfig = { ambientFactor: 0.7, dopplerSpeed: 6500, useSurround: 0, reverseStereo: 0, effectsChannels: 16 };
  const { config } = registry(() => ({ volumes, galaxyConfig, music: { setVolumes: () => calls.push('setVolumes') } }));
  set(config, 'ini:Engine.Engine.AudioDevice', 'SoundVolume', '100');
  assert.deepEqual([volumes.state.soundVolume, calls], [100, ['setVolumes']]);
  set(config, 'ini:Engine.Engine.AudioDevice', 'EffectsChannels', '99');
  assert.deepEqual([config.instance('Galaxy.GalaxyAudioSubsystem', 'EffectsChannels'), galaxyConfig.effectsChannels], [32, 16]);
  set(config, 'ini:Engine.Engine.AudioDevice', 'DopplerSpeed', '0.5');
  assert.equal(galaxyConfig.dopplerSpeed, 1);
  set(config, 'ini:Engine.Engine.AudioDevice', 'AmbientFactor', '55');
  assert.equal(galaxyConfig.ambientFactor, 10);
});

test('MSVCRT %f: ties round up in magnitude, -0.0 is unsigned, widths and flags', () => {
  assert.equal(msvcrtSprintf('%1.0f', 2.5), '3');
  assert.equal(msvcrtSprintf('%1.1f', 0.25), '0.3');
  assert.equal(msvcrtSprintf('%f', -0), '0.000000');
  assert.equal(msvcrtSprintf('%1.1f', -0.01), '-0.0');
  assert.equal(msvcrtSprintf('%8.3f|%-8.2f|%+.1f|%05.1f', 3.14159, 2.5, 0.05, 1.5), '   3.142|2.50    |+0.1|001.5');
  assert.equal(msvcrtSprintf('%.0f%%', 3), '3%');
  assert.throws(() => msvcrtSprintf('%d', 1));
  assert.throws(() => msvcrtSprintf('%f', NaN));
});

test('atof and StringToFloat', () => {
  assert.equal(msvcrtAtof(' \t7.25abc'), 7.25);
  assert.equal(msvcrtAtof('abc'), 0);
  assert.equal(msvcrtAtof('1e3'), 1000);
  assert.equal(stringToFloat('0.6'), Math.fround(0.6));
});

test('Core bool and float casts', () => {
  const cast = token => CORE_CASTS.get(token);
  assert.deepEqual([cast(0x3b)(0), cast(0x3b)(256), cast(0x3e)(0), cast(0x3e)(-1)], [false, false, false, true]);
  assert.deepEqual([cast(0x41)(true), cast(0x41)(false), cast(0x40)(true), cast(0x42)(true)], [1, 0, 1, 1]);
  assert.deepEqual([cast(0x45)(0), cast(0x45)(-0), cast(0x45)(NaN), cast(0x45)(1e-45), cast(0x45)(-2)], [false, false, false, true, true]);
  assert.deepEqual([cast(0x52)(7), cast(0x54)(true), cast(0x54)(false)], ['7', 'True', 'False']);
});

test('display ramp exponent follows the float32 Brightness', () => {
  assert.equal(brightnessGamma(0.4), 1 / Math.fround(Math.fround(0.4) * 2.5));
  assert.equal(brightnessGamma(1), 0.4);
  assert.equal(brightnessGamma(0), 3.4028234663852886e38);
});
