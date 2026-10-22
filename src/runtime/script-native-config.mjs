/** Config properties of the engine's native classes, and the console
 * `get` / `set` commands that reach them (docs/script-native-config.md).
 *
 * The options menus read and write their settings with
 * `ConsoleCommand("get ini:Engine.Engine.AudioDevice SoundVolume")` and
 * `"set ini:Engine.Engine.ViewportManager Brightness 0.5"`. The named classes
 * are native: UClient / UWindowsClient (Engine.dll, WinDrv.dll),
 * UGalaxyAudioSubsystem (Galaxy.dll) and URenderDevice with its driver class (D3DDrv.dll, see
 * PLAY_RENDER_DEVICE).
 * Their properties are declared by each class's StaticConstructor in the
 * `new(GetClass(), TEXT("Name"), RF_Public) UXProperty(CPP_PROPERTY(Member),
 * TEXT("Category"), CPF_Config)` pattern; the tables below were read from those
 * constructors by tools/native-class-properties.py and are re-derived and
 * compared by scripts/validate-native-config-classes.mjs.
 *
 * Original control flow, all in Core.dll:
 *   UObject::StaticExec 0x10153110 GET (0x101531ad) / SET (0x101532da)
 *   StaticFindObject(UClass, ANY_PACKAGE, name) -> ResolveName 0x10154ad0
 *     ("ini:Section.Key" is GConfig->GetString(Section, Key, "System"),
 *      "usr:" the "User" file; the value is the class path)
 *   FindField 0x101011db, UProperty::ExportText 0x10165440 (flags 1 for GET)
 *   UObject::GlobalSetProperty 0x101523a0 / SaveConfig 0x10151540.
 */
import {importText, exportText} from './config-text.mjs';
import {CLIENT_DETAILS} from './script-client-resource-settings.mjs';

export class UnsupportedNativeConfigError extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedNativeConfigError'; }
}
const unsupported = message => { throw new UnsupportedNativeConfigError(message); };

/** Galaxy's `OutputRates` enum, the names its StaticConstructor registers
 * (Galaxy.dll 0x10604c6d-0x10604dad) in index order. */
export const OUTPUT_RATES = Object.freeze(['8000Hz', '11025Hz', '16000Hz', '22050Hz', '32000Hz', '44100Hz', '48000Hz']);

const B = 'bool', I = 'int', F = 'float', Y = 'byte', S = 'string';
const prop = (name, kind, offset, category, enumNames = null) => Object.freeze({name, kind, offset, category, enumNames});

/** Each class's properties in registration order (UStruct::AddCppProperty
 * 0x10125fd0 prepends, so iteration runs in reverse). `ctor` is the
 * StaticConstructor the table was read from. `incomplete` marks a driver class
 * whose own properties are not tabled: an unknown name there is an explicit
 * boundary, not "Unrecognized property". */
export const NATIVE_CONFIG_CLASSES = Object.freeze([
  {path: 'Engine.Client', superPath: null, ctor: {dll: 'Engine', start: 0x10375010}, properties: [
    prop('WindowedViewportX', I, 0x54, 'Client'), prop('WindowedViewportY', I, 0x58, 'Client'), prop('WindowedColorBits', I, 0x5c, 'Client'),
    prop('FullscreenViewportX', I, 0x60, 'Client'), prop('FullscreenViewportY', I, 0x64, 'Client'), prop('FullscreenColorBits', I, 0x68, 'Client'),
    prop('MipFactor', F, 0x70, 'Client'), prop('Brightness', F, 0x6c, 'Display'),
    prop('CaptureMouse', B, 0x3c, 'Display'), prop('CurvedSurfaces', B, 0x40, 'Display'),
    prop('TextureDetail', Y, 0x78, 'Display', CLIENT_DETAILS), prop('SkinDetail', Y, 0x7c, 'Display', CLIENT_DETAILS),
    prop('ScreenFlashes', B, 0x44, 'Display'), prop('NoLighting', B, 0x48, 'Display'), prop('MinDesiredFrameRate', F, 0x94, 'Display'),
    prop('Decals', B, 0x4c, 'Display'), prop('NoDynamicLights', B, 0x50, 'Display')]},
  {path: 'WinDrv.WindowsClient', superPath: 'Engine.Client', ctor: {dll: 'WinDrv', start: 0x111015f0}, properties: [
    prop('UseDirectDraw', B, 0x9c, 'Display'), prop('UseDirectInput', B, 0xa0, 'Display'), prop('UseJoystick', B, 0xa4, 'Display'),
    prop('StartupFullscreen', B, 0xa8, 'Display'), prop('SlowVideoBuffering', B, 0xac, 'Display'),
    prop('DeadZoneXYZ', B, 0xb0, 'Joystick'), prop('DeadZoneRUV', B, 0xb4, 'Joystick'), prop('InvertVertical', B, 0xb8, 'Joystick'),
    prop('ScaleXYZ', F, 0xbc, 'Joystick'), prop('ScaleRUV', F, 0xc0, 'Joystick')]},
  {path: 'Engine.AudioSubsystem', superPath: null, ctor: null, properties: []},
  {path: 'Galaxy.GalaxyAudioSubsystem', superPath: 'Engine.AudioSubsystem', ctor: {dll: 'Galaxy', start: 0x10604bb0}, properties: [
    prop('UseDirectSound', B, 0x2c, 'Audio'), prop('UseFilter', B, 0x30, 'Audio'), prop('UseSurround', B, 0x34, 'Audio'),
    prop('UseStereo', B, 0x38, 'Audio'), prop('UseCDMusic', B, 0x3c, 'Audio'), prop('UseDigitalMusic', B, 0x40, 'Audio'),
    prop('UseReverb', B, 0x44, 'Audio'), prop('Use3dHardware', B, 0x48, 'Audio'), prop('ReverseStereo', B, 0x4c, 'Audio'),
    prop('LowSoundQuality', B, 0x50, 'Audio'), prop('Latency', I, 0x60, 'Audio'), prop('OutputRate', Y, 0x68, 'Audio', OUTPUT_RATES),
    prop('EffectsChannels', I, 0x64, 'Audio'), prop('MusicVolume', Y, 0x69, 'Audio'), prop('SoundVolume', Y, 0x6a, 'Audio'),
    prop('SpeechVolume', Y, 0x6b, 'Audio'), prop('AmbientFactor', F, 0x58, 'Audio'), prop('DopplerSpeed', F, 0x5c, 'Audio')]},
  {path: 'Engine.RenderDevice', superPath: null, ctor: {dll: 'Engine', start: 0x103713c0}, properties: [
    prop('VolumetricLighting', B, 0x58, 'Client'), prop('ShinySurfaces', B, 0x5c, 'Client'), prop('Coronas', B, 0x60, 'Client'),
    prop('HighDetailActors', B, 0x64, 'Client'), prop('Description', S, 0x38, 'Client'), prop('DescFlags', I, 0x44, 'Client'),
    prop('DetailTextures', B, 0x78, 'Client')]},
  {path: 'D3DDrv.D3DRenderDevice', superPath: 'Engine.RenderDevice', ctor: {dll: 'D3DDrv', start: 0x10001880}, properties: [
    prop('UseMipmapping', B, 0x9ac, 'Options'), prop('UseTrilinear', B, 0x9b0, 'Options'), prop('UseMultitexture', B, 0x9b4, 'Options'),
    prop('UsePalettes', B, 0x9b8, 'Options'), prop('UseGammaCorrection', B, 0x9bc, 'Options'), prop('Use3dfx', B, 0x9c0, 'Options'),
    prop('UseTripleBuffering', B, 0x9c8, 'Options'), prop('UseVSync', B, 0x9cc, 'Options'), prop('UsePrecache', B, 0x9d8, 'Options'),
    prop('UseVideoMemoryVB', B, 0x9dc, 'Options'), prop('UseAGPTextures', B, 0x9e0, 'Options'), prop('UseVertexFog', B, 0x9e4, 'Options'),
    prop('dwVendorId', I, 0x9f4, 'Options'), prop('dwDeviceId', I, 0x9f8, 'Options')]},
  ...['GlideDrv.GlideRenderDevice', 'OpenGLDrv.OpenGLRenderDevice', 'SoftDrv.SoftwareRenderDevice',
    'MetalDrv.MetalRenderDevice', 'SglDrv.SglRenderDevice'].map(path =>
    ({path, superPath: 'Engine.RenderDevice', ctor: null, properties: [], incomplete: true})),
]);

/** The render device Play stands in for: **D3DDrv.D3DRenderDevice**, a documented host choice. The
 * installed DeusEx.ini names GlideDrv.GlideRenderDevice, but everything Play draws follows D3DDrv
 * (the -0.5 pixel centre, the Flush gamma ramp, visual acceptance captured from the D3D renderer,
 * docs/visual-acceptance.md, docs/lighting.md), and the original runs one device. The menus must not
 * mix two: `ini:Engine.Engine.GameRenderDevice` resolves to this class, whatever the ini file says. */
export const PLAY_RENDER_DEVICE = 'D3DDrv.D3DRenderDevice';

const lower = text => String(text).toLowerCase();
const clampInt = (value, low, high) => value < low ? low : value >= high ? high : value;
// FCOM against the low bound then `test ah,1` (below or unordered -> low), then against the high bound
// (`jne` keeps a value below it): UClient::PostEditChange 0x10374ef0, Galaxy 0x10605ad0.
const clampFloat = (value, low, high) => !(value >= low) ? low : value < high ? value : high;

/**
 * `services`:
 *   gconfig        the GConfig cache (config-cache.mjs)
 *   audio()        the live Galaxy objects {volumes, music, galaxyConfig} or null
 *   onChange(info) notified after a SET changed a live instance {className, name, value}
 *   loaded         class paths the engine has loaded (default: the configured
 *                  ViewportManager, AudioDevice and GameRenderDevice, with their bases)
 */
export function createNativeConfig({gconfig, audio = () => null, onChange = () => {}, concrete = null, renderDevice = PLAY_RENDER_DEVICE}) {
  const classes = new Map(NATIVE_CONFIG_CLASSES.map(cls => [lower(cls.path), cls]));
  const superOf = cls => cls.superPath ? classes.get(lower(cls.superPath)) : null;
  const chain = cls => { const out = []; for (let c = cls; c; c = superOf(c)) out.push(c); return out; };
  /** TFieldIterator<UProperty>: own children (reverse registration order), then each super's. */
  const fields = cls => chain(cls).flatMap(owner => [...owner.properties].reverse().map(property => ({owner, property})));
  const findIn = (cls, name) => fields(cls).find(({property}) => lower(property.name) === lower(name)) ?? null;

  // The classes the engine instantiated from [Engine.Engine] (UGameEngine::Init's StaticLoadClass of
  // ViewportManager, AudioDevice and GameRenderDevice) and their bases are the loaded UClasses.
  const engineKey = key => lower(key) === 'gamerenderdevice' && renderDevice ? renderDevice : gconfig.getString('Engine.Engine', key, 'System', 0x400);
  const instanceClasses = (concrete ?? ['ViewportManager', 'AudioDevice', 'GameRenderDevice'].map(engineKey).filter(Boolean))
    .map(path => classes.get(lower(path))).filter(Boolean);
  const loadedPaths = new Set(instanceClasses.flatMap(cls => chain(cls).map(c => lower(c.path))));

  // ---- values: the class default object of each loaded class, the live object of each instantiated one ----
  const defaults = new Map(), instances = new Map();
  /** UObject::LoadConfig(Propagate=1) (script-config.mjs): a pass per class from the topmost down,
   * each reading every inherited property under that pass's class path in the System ini. */
  function loadConfig(cls, values) {
    for (const pass of chain(cls).reverse())
      for (const {property} of fields(pass)) {
        const text = gconfig.getString(pass.path, property.name, 'System', 0x400);
        if (text === null) continue;
        const imported = importText(property.kind, text, {enumNames: property.enumNames});
        if (imported && imported.value !== undefined) values.set(lower(property.name), imported.value);
      }
  }
  for (const key of loadedPaths) defaults.set(key, new Map()), loadConfig(classes.get(key), defaults.get(key));
  for (const cls of instanceClasses) instances.set(lower(cls.path), new Map()), loadConfig(cls, instances.get(lower(cls.path)));

  // ---- live-state links: properties whose live value is Play's own structure ----
  const galaxy = 'galaxy.galaxyaudiosubsystem';
  const audioLinks = {
    musicvolume: live => ({get: () => live.volumes.state.musicVolume, set: v => { live.volumes.state.musicVolume = v & 255; }}),
    soundvolume: live => ({get: () => live.volumes.state.soundVolume, set: v => { live.volumes.state.soundVolume = v & 255; }}),
    speechvolume: live => ({get: () => live.volumes.state.speechVolume, set: v => { live.volumes.state.speechVolume = v & 255; }}),
    ambientfactor: live => ({get: () => live.galaxyConfig.ambientFactor, set: v => { live.galaxyConfig.ambientFactor = Math.fround(v); }}),
    dopplerspeed: live => ({get: () => live.galaxyConfig.dopplerSpeed, set: v => { live.galaxyConfig.dopplerSpeed = Math.fround(v); }}),
    usesurround: live => ({get: () => Boolean(live.galaxyConfig.useSurround), set: v => { live.galaxyConfig.useSurround = v ? 1 : 0; }}),
    reversestereo: live => ({get: () => Boolean(live.galaxyConfig.reverseStereo), set: v => { live.galaxyConfig.reverseStereo = v ? 1 : 0; }}),
  };
  /** Accessors of one property of a live instance. */
  function instanceValue(cls, name) {
    if (lower(cls.path) === galaxy) {
      const live = audio(), link = live && audioLinks[lower(name)]?.(live);
      if (link) return link;
    }
    const store = instances.get(lower(cls.path));
    return {get: () => store.get(lower(name)), set: v => store.set(lower(name), v)};
  }

  // ---- PostEditChange (UObject virtual slot +0x40) of the instantiated classes ----
  function clampClient(cls) {                                // UClient::PostEditChange 0x10374ef0
    for (const [name, low, high] of [['Brightness', 0, 1], ['MipFactor', -3, 3]]) {
      const value = instanceValue(cls, name);
      value.set(Math.fround(clampFloat(value.get(), low, high)));
    }
  }
  function postEditChange(cls) {
    switch (lower(cls.path)) {
      case 'windrv.windowsclient': {                         // 0x111030f0: UClient's, then the joystick code
        clampClient(cls);
        if (instanceValue(cls, 'UseJoystick').get())
          unsupported('UWindowsClient::PostEditChange joystick enumeration (WINMM joyGetDevCapsA) is not available');
        return;
      }
      case galaxy: {                                         // 0x10605ad0, ending in SetVolumes 0x106061b0
        const value = name => instanceValue(cls, name);
        let v = value('OutputRate'); v.set(Math.min(v.get() & 255, 6));
        v = value('Latency'); v.set(clampInt(v.get() | 0, 10, 250));
        v = value('EffectsChannels'); v.set(clampInt(v.get() | 0, 0, 32));
        v = value('DopplerSpeed'); v.set(Math.fround(clampFloat(v.get(), 1, 100000)));
        v = value('AmbientFactor'); v.set(Math.fround(clampFloat(v.get(), 0, 10)));
        audio()?.music?.setVolumes?.();
        return;
      }
      default: return;                                       // URenderDevice: UObject::PostEditChange (Modify) only
    }
  }

  // ---- name resolution ----
  /** UObject::ResolveName 0x10154ad0 for "ini:" / "usr:" names: the key is the text after the last
   * '.', the section the rest; the stored value replaces the name (null: the lookup fails). */
  function resolveName(name) {
    const prefix = /^(ini|usr):/i.exec(name);
    if (!prefix || name.length >= 0x400 || !name.includes('.')) return name;
    const body = name.slice(4), dot = body.lastIndexOf('.'), section = body.slice(0, dot), key = body.slice(dot + 1);
    if (/^ini/i.test(prefix[0]) && lower(section) === 'engine.engine' && lower(key) === 'gamerenderdevice' && renderDevice) return renderDevice;
    return gconfig.getString(section, key, /^ini/i.test(prefix[0]) ? 'System' : 'User', 0x400);
  }
  /** StaticFindObject(UClass, ANY_PACKAGE, name): a loaded native class by full path or bare name. */
  function findClass(token) {
    const resolved = resolveName(token);
    if (resolved === null) return null;
    const wanted = lower(resolved), bare = !wanted.includes('.');
    for (const [key, cls] of classes)
      if (loadedPaths.has(key) && (key === wanted || (bare && key.endsWith(`.${wanted}`)))) return cls;
    return null;
  }
  /** FindField 0x101011db. An unknown name on a class with an untabled part is a boundary. */
  function findField(cls, name) {
    const found = findIn(cls, name);
    if (found) return {cls, owner: found.owner, property: found.property};
    if (chain(cls).some(c => c.incomplete)) unsupported(`${cls.path} driver properties are not tabled; cannot resolve ${name}`);
    return null;
  }

  // ---- GET / SET ----
  function defaultValue(cls, property) {
    const value = defaults.get(lower(cls.path))?.get(lower(property.name));
    if (value === undefined) unsupported(`${cls.path}.${property.name} has no ini value and its native constructor default is not recovered`);
    return value;
  }
  /** UProperty::ExportText on the class defaults, port flags 1. */
  const getText = (cls, field) =>
    exportText(field.property.kind, defaultValue(cls, field.property), {enumNames: field.property.enumNames});

  /** UObject::SaveConfig(CPF_Config) 0x10151540: every config property of `cls` (own, then supers) that `valueOf` knows into
   * `[<class path>]` of the System file, Flush(0), then the reload of every loaded class under the topmost CLASS_Config ancestor
   * (DECLARE_ABSTRACT_CLASS(..., CLASS_Config) for UClient, UAudioSubsystem and URenderDevice in the SDK headers). SaveConfig's
   * `this` decides the values: the class defaults for GlobalSetProperty's call, the live object for `Client->SaveConfig()`. */
  function saveConfigOf(cls, valueOf) {
    for (const {property} of fields(cls)) {
      const value = valueOf(property);
      if (value === undefined) continue;                     // never read or written: nothing to export
      gconfig.setString(cls.path, property.name, exportText(property.kind, value, {enumNames: property.enumNames}), 'System');
    }
    gconfig.flush(false, null);
    const root = chain(cls).at(-1);
    for (const [key, loadedValues] of defaults)
      if (chain(classes.get(key)).includes(root)) loadConfig(classes.get(key), loadedValues);
  }
  /** SaveConfig on the class default object (GlobalSetProperty 0x101523a0 ends with it). */
  const saveConfig = cls => saveConfigOf(cls, property => defaults.get(lower(cls.path)).get(lower(property.name)));
  /** SaveConfig on the live object of an instantiated class: its values, clamps included (`set ... Brightness 7` leaves the object
   * at the clamped 1 but the defaults at 7). */
  const saveInstance = cls => saveConfigOf(cls, property => instanceValue(cls, property.name).get());

  // The colour depth the viewport holds (UViewport +0x80, in bytes): the client's ColorBits of the mode it opened in, then what
  // each ResizeViewport stored.
  let viewportColorBytes = null;
  /**
   * UWindowsViewport::ResizeViewport's save (WinDrv.dll 0x1110e2f6-0x1110e35d), reached by every SetRes through the render device:
   * with a render device and outside the editor, a fullscreen viewport stores FullscreenViewportX/Y/ColorBits in the client and a
   * windowed one WindowedViewportX/Y/ColorBits (X = width, Y = height: measured, 1280x960 changed WindowedViewportY only),
   * ColorBits = ColorBytes * 8, and then `Client->SaveConfig(CPF_Config)` writes the file at once (measured under Wine: the ini was
   * rewritten before the next input). A size with a zero side stores nothing but still saves.
   */
  function resizeViewport({fullscreen, width, height, colorBytes = null}) {
    const cls = classes.get('windrv.windowsclient');
    if (!cls || !instances.has(lower(cls.path))) return false;
    const read = name => instanceValue(cls, name).get(), write = (name, value) => instanceValue(cls, name).set(value);
    // (2 when the client holds none: UWindowsViewport::Exec's GetCurrentRes reads ColorBytes +0x80 as 2 when 0)
    viewportColorBytes ??= ((Number(read(read('StartupFullscreen') ? 'FullscreenColorBits' : 'WindowedColorBits')) | 0) / 8 | 0) || 2;
    const bytes = colorBytes ?? viewportColorBytes;
    viewportColorBytes = bytes;
    if (width && height) {
      const prefix = fullscreen ? 'Fullscreen' : 'Windowed';
      write(`${prefix}ViewportX`, width | 0); write(`${prefix}ViewportY`, height | 0); write(`${prefix}ColorBits`, bytes * 8);
    }
    saveInstance(cls);
    return true;
  }

  /** UObject::GlobalSetProperty 0x101523a0 (bNotify = 1): every live object that IsA the class gets
   * ImportText then PostEditChange; the class defaults import the text; SaveConfig on them. */
  function globalSetProperty(cls, field, text) {
    const imported = importText(field.property.kind, text, {enumNames: field.property.enumNames});
    const changed = imported && imported.value !== undefined;   // a NULL result leaves the value untouched
    for (const instanceClass of instanceClasses) {
      if (!chain(instanceClass).includes(cls)) continue;
      if (changed) {
        instanceValue(instanceClass, field.property.name).set(imported.value);
        onChange({className: instanceClass.path, name: field.property.name, value: imported.value});
      }
      postEditChange(instanceClass);
    }
    if (changed) defaults.get(lower(cls.path)).set(lower(field.property.name), imported.value);
    saveConfig(cls);
  }

  return {
    classes, findClass, findField, getText, globalSetProperty, resolveName, loadedPaths, renderDevice,
    /** A live instance property of an instantiated class (hosts read Brightness here). */
    instance(path, name) {
      const cls = classes.get(lower(path));
      return cls && instances.has(lower(path)) && findIn(cls, name) ? instanceValue(cls, name).get() : undefined;
    },
    defaultsOf: path => defaults.get(lower(path)),
    resizeViewport,
  };
}
