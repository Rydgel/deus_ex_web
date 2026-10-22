// Drives the installed original Deus Ex inside the CrossOver "DeusEx" bottle to
// take clean in-engine screenshots (the game's own Shot command) for the promo.
// The user's DeusEx.ini/User.ini stay untouched: the game is launched with
// INI=/USERINI= copies that only switch to a silent 1280x720 window.
//
//   node ad/scripts/original-game.mjs launch <map>   start the game on a map
//   node ad/scripts/original-game.mjs run <script>    post a dxinput script
//   node ad/scripts/original-game.mjs collect <name>  convert new Shot*.bmp to PNG
//   node ad/scripts/original-game.mjs quit
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const adRoot = path.resolve(here, '..');
// Plain Wine (the Linux host, docs/linux-host.md): DX_WINE=/usr/bin/wine and
// DX_GAME=$WINEPREFIX/drive_c/Deus Ex GOTY Edition, with WINEPREFIX exported.
export const WINE = process.env.DX_WINE || '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';
export const BOTTLE = process.env.DX_BOTTLE || 'DeusEx';
export const GAME = process.env.DX_GAME || path.join(process.env.HOME, 'Library/Application Support/CrossOver/Bottles', BOTTLE,
  'drive_c/Deus Ex GOTY Edition');
export const SYSTEM = path.join(GAME, 'System');
const WIDTH = Number(process.env.DX_WIDTH || 1280), HEIGHT = Number(process.env.DX_HEIGHT || 720);
const env = {...process.env, CX_BOTTLE: BOTTLE};

function setKeys(text, section, values) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim().toLowerCase() === `[${section.toLowerCase()}]`);
  if (start < 0) throw new Error(`missing [${section}]`);
  let end = lines.findIndex((line, i) => i > start && /^\[.*\]\s*$/.test(line.trim()));
  if (end < 0) end = lines.length;
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line, i) => i > start && i < end && line.split('=')[0].trim().toLowerCase() === key.toLowerCase());
    if (index >= 0) lines[index] = `${key}=${value}`;
    else { lines.splice(end, 0, `${key}=${value}`); end++; }
  }
  return lines.join('\r\n');
}

// soft: the original software renderer presenting through GDI (UseDirectDraw
// off), whose window contents Wine can read back with dxgrab; the D3D
// renderer's output is only reachable through the game's own Shot command.
export function writeIni({soft = process.env.DX_SOFT === '1'} = {}) {
  let ini = readFileSync(path.join(SYSTEM, 'DeusEx.ini'), 'latin1');
  ini = setKeys(ini, 'WinDrv.WindowsClient', {StartupFullscreen: 'False', WindowedViewportX: WIDTH,
    WindowedViewportY: HEIGHT, WindowedColorBits: 32, CaptureMouse: 'False', ...(soft ? {UseDirectDraw: 'False'} : {})});
  if (soft) ini = setKeys(ini, 'Engine.Engine', {GameRenderDevice: 'SoftDrv.SoftwareRenderDevice'});
  ini = setKeys(ini, 'Galaxy.GalaxyAudioSubsystem', {MusicVolume: 0, SoundVolume: 0, SpeechVolume: 0});
  // DX_INI_SET='Section.Name.Key=Value;Other.Key=Value': further keys of the copy (a measurement's setting, e.g.
  // D3DDrv.D3DRenderDevice.DetailTextures=False); the user's DeusEx.ini stays as it is.
  for (const item of (process.env.DX_INI_SET || '').split(';').filter(Boolean)) {
    const eq = item.indexOf('='), dot = item.lastIndexOf('.', eq);
    if (eq < 0 || dot < 0) throw new Error(`DX_INI_SET ${item}: expected Section.Key=Value`);
    ini = setKeys(ini, item.slice(0, dot), {[item.slice(dot + 1, eq)]: item.slice(eq + 1)});
  }
  writeFileSync(path.join(SYSTEM, 'DeusEx-ad.ini'), ini, 'latin1');
  // Cinematics keep JC in state Paralyzed ('ignores all'), so console typing via
  // Talk is unavailable there. Bindings still reach the engine's own commands:
  // NumPad8 freezes the level (LevelInfo.bPlayersOnly) and NumPad9 runs the
  // camera commands in System/adcam.txt (UEngine EXEC).
  let user = readFileSync(path.join(SYSTEM, 'User.ini'), 'latin1');
  const bindings = {NumPad8: 'set LevelInfo bPlayersOnly True', NumPad9: 'exec adcam.txt'};
  user = setKeys(setKeys(user, 'Engine.Input', bindings), 'Extension.InputExt', bindings);
  // DX_USER_SET='Section.Key=Value;...': further keys of the User.ini copy (docs/config-persistence.md: bAskedToTrain=False).
  for (const item of (process.env.DX_USER_SET || '').split(';').filter(Boolean)) {
    const eq = item.indexOf('='), dot = item.lastIndexOf('.', eq);
    if (eq < 0 || dot < 0) throw new Error(`DX_USER_SET ${item}: expected Section.Key=Value`);
    user = setKeys(user, item.slice(0, dot), {[item.slice(dot + 1, eq)]: item.slice(eq + 1)});
  }
  writeFileSync(path.join(SYSTEM, 'User-ad.ini'), user, 'latin1');
}

export function writeCameraFile(lines) {
  writeFileSync(path.join(SYSTEM, 'adcam.txt'), lines.join('\r\n') + '\r\n', 'latin1');
}

export function shots() {
  return readdirSync(SYSTEM).filter(name => /^Shot\d{4}\.bmp$/i.test(name)).sort();
}

// DX_DESKTOP=WxH runs the prefix's programs in a Wine virtual desktop of that
// size (winecfg's "Emulate a virtual desktop": HKCU\Software\Wine\Explorer
// Desktop=Default, Desktops\Default=WxH), set before the launch. Under a
// tiling Wayland compositor (the Linux host's Hyprland) the game's own window
// is otherwise tiled to another size: WinDrv's window procedure then resizes
// the D3D device over and over and the level stops ticking (a stalled
// capture, 2026-10-20). Every later tool (dxinput, the tracer) joins the same
// desktop, so it still finds the game's window.
export function launch(map) {
  writeIni();
  const desktop = process.env.DX_DESKTOP;
  if (desktop) for (const args of [['HKCU\\Software\\Wine\\Explorer', '/v', 'Desktop', '/d', 'Default'],
    ['HKCU\\Software\\Wine\\Explorer\\Desktops', '/v', 'Default', '/d', desktop]])
    execFileSync(WINE, ['reg', 'add', ...args, '/f'], {env, stdio: 'ignore', timeout: 60000});
  const child = spawn(WINE, ['C:\\Deus Ex GOTY Edition\\System\\DeusEx.exe', map, 'INI=DeusEx-ad.ini', 'USERINI=User-ad.ini'],
    {env, detached: true, stdio: 'ignore', cwd: SYSTEM});
  child.unref();
  return child.pid;
}

// Wine resolves Unix paths for the executable but not for program arguments, so
// scripts are copied onto the bottle's C: drive first.
export function run(script, timeout = 180000) {
  const exe = path.join(adRoot, 'tools/dxinput.exe');
  const dir = path.join(GAME, '..', 'dxad');
  mkdirSync(dir, {recursive: true});
  writeFileSync(path.join(dir, 'script.txt'), readFileSync(script));
  return execFileSync(WINE, [exe, 'run', 'C:\\dxad\\script.txt'], {env, encoding: 'utf8', timeout});
}

export function find() {
  return execFileSync(WINE, [path.join(adRoot, 'tools/dxinput.exe'), 'find'], {env, encoding: 'utf8', timeout: 60000});
}

// Original Shot bitmaps are bottom-up 24-bit BGR. At some widths the game writes
// rows tightly packed (docs/lighting.md); 1280 px rows are 4-byte aligned anyway.
export function bmpToPng(bmpPath, pngPath) {
  const data = readFileSync(bmpPath);
  const offset = data.readUInt32LE(10), width = data.readInt32LE(18), height = data.readInt32LE(22);
  const bpp = data.readUInt16LE(28);
  if (bpp !== 24) throw new Error(`${bmpPath}: ${bpp} bpp`);
  const padded = Math.ceil(width * 3 / 4) * 4;
  const stride = data.length - offset >= padded * Math.abs(height) ? padded : width * 3;
  const rgb = Buffer.alloc(width * Math.abs(height) * 3);
  for (let y = 0; y < Math.abs(height); y++) {
    const src = offset + (height > 0 ? Math.abs(height) - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      rgb[(y * width + x) * 3] = data[src + x * 3 + 2];
      rgb[(y * width + x) * 3 + 1] = data[src + x * 3 + 1];
      rgb[(y * width + x) * 3 + 2] = data[src + x * 3];
    }
  }
  const raw = pngPath.replace(/\.png$/, '.rgb');
  writeFileSync(raw, rgb);
  execFileSync('magick', ['-size', `${width}x${Math.abs(height)}`, '-depth', '8', `rgb:${raw}`, pngPath]);
  unlinkSync(raw);
  return {width, height: Math.abs(height)};
}

export function collect(name, before) {
  const out = path.join(adRoot, 'captures/original');
  mkdirSync(out, {recursive: true});
  const fresh = shots().filter(shot => !before.includes(shot));
  return fresh.map((shot, i) => {
    const png = path.join(out, `${name}${fresh.length > 1 ? `-${i + 1}` : ''}.png`);
    const size = bmpToPng(path.join(SYSTEM, shot), png);
    renameSync(path.join(SYSTEM, shot), path.join(out, `${path.basename(png, '.png')}.bmp`));
    return {png, ...size};
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [verb, arg] = process.argv.slice(2);
  if (verb === 'launch') console.log('pid', launch(arg || '00_Training.dx'));
  else if (verb === 'find') console.log(find());
  else if (verb === 'run') console.log(run(arg));
  else if (verb === 'shots') console.log(shots().join('\n'));
  else if (verb === 'quit') console.log(run(writeTemp('cmd exit\n')));
  else console.log('usage: launch <map> | find | run <script> | shots | quit');
}

function writeTemp(text) {
  const file = path.join(adRoot, 'build/dxinput-temp.txt');
  mkdirSync(path.dirname(file), {recursive: true});
  writeFileSync(file, text);
  return file;
}
