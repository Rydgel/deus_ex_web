/** Shared driver for tools/msvcrt-text-probe.c: the game's own MSVCRT.dll
 * (_vsnwprintf, atof) executed under Wine. Used by
 * validate-msvcrt-text-hardware.mjs and the validators that need the real
 * MSVCRT spelling of a value (validate-window-scale-values.mjs).
 *
 * `probeAvailable()` is the reason string when the toolchain or Wine is
 * missing (else null). On Linux:
 *   X87_PROBE_WINE=/usr/bin/wine WINEPREFIX=$HOME/.wine-deusex */
import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Wine: X87_PROBE_WINE, else the Mac CrossOver wrapper, else /usr/bin/wine (Linux).
const crossOver = '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';
const wine = process.env.X87_PROBE_WINE || (existsSync(crossOver) ? crossOver : '/usr/bin/wine');
const bottle = process.env.X87_PROBE_BOTTLE || 'DeusEx';
// A Linux prefix holding the game folder: WINEPREFIX, else ~/.wine-deusex when present.
const prefix = process.env.WINEPREFIX || (existsSync(`${process.env.HOME}/.wine-deusex`) ? `${process.env.HOME}/.wine-deusex` : undefined);
const cc = process.env.X87_PROBE_CC || 'i686-w64-mingw32-gcc';
const cache = path.join(root, '.cache');

export function probeAvailable() {
  if (!existsSync(wine)) return `no CrossOver/Wine at ${wine} (set X87_PROBE_WINE)`;
  try { execFileSync('which', [cc], {stdio: 'ignore'}); } catch { return `no ${cc} on PATH`; }
  return null;
}

const view = new DataView(new ArrayBuffer(8));
export const doubleBits = value => { view.setFloat64(0, value, true); return view.getBigUint64(0, true).toString(16).padStart(16, '0'); };
export const wideHex = text => [...text].map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('') || '-';
export const ansiHex = text => [...text].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('') || '-';
export const decodeWide = hex => hex === '-' ? '' : hex.match(/.{4}/g).map(h => String.fromCharCode(parseInt(h, 16))).join('');

let built = null;
function build() {
  if (built) return built;
  mkdirSync(cache, {recursive: true});
  const exe = path.join(cache, 'msvcrt-text-probe.exe');
  const dll = path.join(cache, 'msvcrt-goty-text.dll');
  copyFileSync(path.join(gameDirectory(), 'System', 'MSVCRT.dll'), dll);
  execFileSync(cc, ['-O1', '-o', exe, path.join(root, 'tools', 'msvcrt-text-probe.c')]);
  return built = {exe, dll};
}

/** Run probe case lines ("P <wide format hex> <double bits>" / "A <ansi hex>");
 * returns the result lines, one per case. */
export function runProbe(lines, name = 'msvcrt-text-cases.txt', controlWord = null) {
  const {exe, dll} = build();
  const caseFile = path.join(cache, name);
  writeFileSync(caseFile, lines.join('\n') + '\n');
  const args = [exe, `Z:${dll.replaceAll('/', '\\')}`, `Z:${caseFile.replaceAll('/', '\\')}`];
  if (controlWord !== null) args.push(controlWord.toString(16));
  const out = execFileSync(wine, args,
    {env: {...process.env, CX_BOTTLE: bottle, WINEDEBUG: '-all', ...(prefix ? {WINEPREFIX: prefix} : {})}, maxBuffer: 1 << 28, encoding: 'utf8'});
  runProbe.controlWord = out.match(/^#cw=([0-9a-f]+)/m)?.[1] ?? null;   // the word the cases ran under
  const rows = out.split(/\r?\n/).filter(l => /^[PA] /.test(l));
  if (rows.length !== lines.length) throw new Error(`probe returned ${rows.length} rows for ${lines.length} cases`);
  return rows;
}

/** MSVCRT _vsnwprintf(format, double) for each [format, value]: the text. */
export function measurePrintf(pairs) {
  const rows = runProbe(pairs.map(([format, value]) => `P ${wideHex(format)} ${doubleBits(value)}`), 'msvcrt-printf-cases.txt');
  return rows.map(row => decodeWide(row.split(' ')[2]));
}
