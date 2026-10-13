/** Census of the virtual functions that the game's own native DLLs override (docs/native-vtable-overrides.md).
 *
 * From the SDK 1112f vftables (.cache/sdk-layouts.json, scripts/sdk-layouts.mjs) it lists, for every class declared in
 * DeusEx, Extension or ConSys, the slots whose function the class defines itself (destructors apart), the retail
 * address of each (the class's exported vftable `??_7Class@@6B@` in the retail DLL + slot*4), and whether the repository
 * mentions that address or the function's name outside this census (src, native, docs, scripts, tools). A class whose
 * header the SDK hides (`#include "AScriptedPawn.h"`) can have more overrides than the SDK shows: the retail vftable
 * is compared with its parent's too (every slot that differs from the parent's table and is not in the SDK's list).
 *
 *   node scripts/census-native-overrides.mjs [--markdown]
 */
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// the checkout's own .cache when it holds vftables (clang built them), else the main checkout's
const withVftables = dir => { try { return Object.keys(JSON.parse(readFileSync(path.join(dir, '.cache/sdk-layouts.json'), 'utf8')).vftables ?? {}).length > 0; } catch { return false; } };
const mainRoot = [root, '/home/rydgel/projects/deus_ex_web'].find(withVftables);
if (!mainRoot) throw new Error('no .cache/sdk-layouts.json with vftables: node scripts/sdk-layouts.mjs');
const layouts = JSON.parse(readFileSync(path.join(mainRoot, '.cache/sdk-layouts.json'), 'utf8'));
const work = path.join(mainRoot, '.cache/sdk-layouts-work');
const system = path.join(gameDirectory(), 'System');

// --- PE: sections and exports of a retail DLL ------------------------------------------------------------------------
function loadDll(name) {
  const data = readFileSync(path.join(system, `${name}.dll`));
  const pe = data.readUInt32LE(0x3c), opt = pe + 24, base = data.readUInt32LE(opt + 28);
  const sections = [];
  const so = opt + data.readUInt16LE(pe + 20);
  for (let i = 0; i < data.readUInt16LE(pe + 6); i++) {
    const o = so + 40 * i;
    sections.push({name: data.toString('latin1', o, o + 8).replace(/\0.*/, ''), virtual: data.readUInt32LE(o + 12), vsize: data.readUInt32LE(o + 8), raw: data.readUInt32LE(o + 20), rsize: data.readUInt32LE(o + 16)});
  }
  const off = rva => { for (const s of sections) if (rva >= s.virtual && rva < s.virtual + Math.max(s.vsize, s.rsize)) return s.raw + rva - s.virtual; throw new Error(`rva ${rva.toString(16)}`); };
  const exports = new Map();
  const e = off(data.readUInt32LE(opt + 96)), count = data.readUInt32LE(e + 24);
  const functions = off(data.readUInt32LE(e + 28)), names = off(data.readUInt32LE(e + 32)), ordinals = off(data.readUInt32LE(e + 36));
  for (let i = 0; i < count; i++) {
    const n = off(data.readUInt32LE(names + 4 * i));
    exports.set(data.toString('latin1', n, data.indexOf(0, n)), base + data.readUInt32LE(functions + 4 * data.readUInt16LE(ordinals + 2 * i)));
  }
  const dword = va => data.readUInt32LE(off(va - base));
  const byte = va => data[off(va - base)];
  // IAT slot VA -> [dll, symbol] (by name; ordinal imports are not followed)
  const imports = new Map();
  const importRva = data.readUInt32LE(opt + 104);
  if (importRva) for (let d = off(importRva); data.readUInt32LE(d + 12); d += 20) {
    const dllName = data.toString('latin1', off(data.readUInt32LE(d + 12)), data.indexOf(0, off(data.readUInt32LE(d + 12)))).toLowerCase().replace(/\.dll$/, '');
    const original = data.readUInt32LE(d) || data.readUInt32LE(d + 16), iat = data.readUInt32LE(d + 16);
    for (let i = 0; ; i++) {
      const entry = data.readUInt32LE(off(original) + 4 * i);
      if (!entry) break;
      if (entry & 0x80000000) continue;
      const n = off(entry) + 2;
      imports.set(base + iat + 4 * i, [dllName, data.toString('latin1', n, data.indexOf(0, n))]);
    }
  }
  const text = sections.find(s => s.name === '.text');
  return {name, base, exports, dword, byte, imports, textStart: base + text.virtual, textEnd: base + text.virtual + text.vsize};
}
const dlls = Object.fromEntries(['Core', 'Engine', 'Extension', 'DeusEx', 'ConSys'].map(n => [n, loadDll(n)]));
/** A vftable entry that is only `jmp [IAT]` stands for the imported function it forwards to. */
const resolve = (dll, address) => {
  if (dll.byte(address) === 0xff && dll.byte(address + 1) === 0x25) {
    const target = dll.imports.get(dll.dword(address + 2));
    const other = target && dlls[Object.keys(dlls).find(k => k.toLowerCase() === target[0])];
    return other?.exports.get(target[1]) ?? address;
  }
  return address;
};

// --- classes by package -----------------------------------------------------------------------------------------------
const classesOf = pkg => {
  const names = [];
  const inc = path.join(work, pkg, 'Inc');
  for (const file of readdirSync(inc)) if (/\.h$/.test(file))
    for (const m of readFileSync(path.join(inc, file), 'latin1').matchAll(/^class \w+_API (\w+)\s*(?::\s*public (\w+))?/gm)) names.push(m[1]);
  return names;
};
const vtableAddress = (dll, cls) => dll.exports.get(`??_7${cls}@@6B@`) ?? null;

// --- repository mentions ----------------------------------------------------------------------------------------------
const mentionFiles = [];
const walk = dir => {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', '.cache', '.work', 'target', 'Reference'].includes(entry)) continue;
    const p = path.join(dir, entry), s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(mjs|md|rs|py|c|js)$/.test(entry) && !/census-native-overrides|native-vtable-overrides/.test(entry)) mentionFiles.push(p);
  }
};
for (const d of ['src', 'native', 'docs', 'scripts', 'tools']) if (existsSync(path.join(root, d))) walk(path.join(root, d));
const texts = mentionFiles.map(f => [path.relative(root, f), readFileSync(f, 'utf8').toLowerCase()]);
const mentions = needle => texts.filter(([, t]) => t.includes(needle.toLowerCase())).map(([f]) => f);

// --- the census -------------------------------------------------------------------------------------------------------
const rows = [];
for (const pkg of ['DeusEx', 'Extension', 'ConSys']) {
  const dll = dlls[pkg];
  const exported = [...dll.exports.keys()].filter(k => /^\?\?_7\w+@@6B@$/.test(k)).map(k => k.slice(4, -4));
  for (const cls of [...new Set([...classesOf(pkg), ...exported])]) {
    const slots = layouts.vftables[cls];
    if (!slots) continue;
    const table = vtableAddress(dll, cls);
    const parent = (layouts.bases[cls] ?? []).at(-1);
    const parentSlots = parent ? layouts.vftables[parent] : null;
    const parentDll = parent ? Object.values(dlls).find(d => vtableAddress(d, parent)) : null;
    const parentTable = parentDll ? vtableAddress(parentDll, parent) : null;
    for (const s of slots) {
      const own = s.owner === cls && !/~/.test(s.decl);
      let address = null, parentAddress = null, differs = null;
      if (table) address = resolve(dll, dll.dword(table + 4 * s.slot));
      if (parentTable && s.slot < (parentSlots?.length ?? 0)) { parentAddress = resolve(parentDll, parentDll.dword(parentTable + 4 * s.slot)); differs = address !== null && address !== parentAddress; }
      if (!own && !(differs && !/~/.test(s.decl))) continue;
      const method = s.decl.replace(/\(.*$/, '').split('::').pop().trim();
      const hex = address ? address.toString(16) : null;
      const byAddress = hex ? mentions(hex) : [];
      const byName = mentions(`${cls}::${method}`);
      rows.push({pkg, cls, parent, slot: s.slot, decl: s.decl, address: hex, kind: own ? 'declared' : 'retail only', retailDiffers: differs, sdkOwner: s.owner, mentioned: byAddress, namedIn: byName, table: table ? table.toString(16) : null});
    }
  }
}
if (process.argv.includes('--markdown')) {
  console.log('| Class | Slot | Function (SDK) | Retail address | Repo mentions |\n|---|---|---|---|---|');
  const files = list => list.slice(0, 2).join(', ') + (list.length > 2 ? ` +${list.length - 2}` : '');
  for (const r of rows) console.log(`| ${r.pkg}:${r.cls} | ${r.slot} | ${r.decl.replace(/\|/g, '\\|')} | ${r.address ? '`0x' + r.address + '`' : '(vftable not exported)'}${r.retailDiffers === false && r.sdkOwner === r.cls ? ' (same as parent)' : ''} | ${r.mentioned.length ? 'address: ' + files(r.mentioned) : r.namedIn.length ? 'name only: ' + files(r.namedIn) : '**none**'} |`);
} else console.log(JSON.stringify(rows, null, 1));
console.error(`${rows.length} overriding slots in ${new Set(rows.map(r => r.cls)).size} classes; ${rows.filter(r => !r.mentioned.length && !r.namedIn.length).length} with no mention of their address or name`);
