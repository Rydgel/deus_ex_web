/** Native C++ class layouts and MSVC vftables from the Deus Ex SDK 1112f headers.
 *
 * The user supplied the SDK (Reference/, ignored by Git, see docs/sdk-reference.md).
 * Its Headers/DxHeaders.zip declares the C++ classes of Core, Engine, Extension,
 * DeusEx and ConSys. This script copies those Inc directories to a work
 * directory, applies the two MSVC 6 compatibility edits clang requires (below),
 * and asks clang for the Microsoft x86 record layouts and vftables
 * (`-target i686-pc-windows-msvc`; the generated IR is discarded). It writes
 * `.cache/sdk-layouts.json`: every laid-out record with absolute member offsets
 * and bit ranges, and every emitted vftable with its slots.
 *
 * The headers are SDK 1112f; the runtime is GOTY 1112fm. A header fact is a
 * research reference until the retail DLL confirms it. The check below compares
 * the layouts and slots with offsets already recovered from the DLLs.
 *
 *   node scripts/sdk-layouts.mjs [--class XRootWindow] [--vtable XWindow]
 *        [--overrides XWindow] [--at XRootWindow 0x5c8] [--retail XCheckboxWindow]
 *
 * Compatibility edits, applied only to the work copy:
 *  - UnMem.h declares `friend operator new(..., INT Count=1, INT Align=...)` and
 *    then defines it with the same defaults; the friend loses its defaults.
 *  - UnActor.h AActor::GetTopOwner reads its `for` variable after the loop
 *    (MSVC 6 scoping); the variable is declared before the loop. */
import {execFileSync} from 'node:child_process';
import {chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sdk = path.join(root, 'Reference/DeusExSDK1112f/ReleaseSDK1112f/Headers/DxHeaders');
const out = path.join(root, '.cache/sdk-layouts.json');
const work = path.join(root, '.cache/sdk-layouts-work');
const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(name); return i === -1 ? null : argv.slice(i + 1); };
const PACKAGES = ['Core', 'Engine', 'Extension', 'DeusEx', 'ConSys'];

const layouts = existsSync(out) && !argv.includes('--rebuild') ? JSON.parse(readFileSync(out, 'utf8')) : build();
if (flag('--class')) printClass(flag('--class')[0]);
else if (flag('--vtable')) printVtable(flag('--vtable')[0]);
else if (flag('--overrides')) printOverrides(flag('--overrides')[0]);
else if (flag('--at')) printAt(flag('--at')[0], Number(flag('--at')[1]));
else if (flag('--retail')) printRetail(flag('--retail')[0]);
else await check();

function build() {
  if (!existsSync(sdk)) throw new Error(`SDK headers not found at ${path.relative(root, sdk)} (docs/sdk-reference.md)`);
  rmSync(work, {recursive: true, force: true});
  for (const pkg of PACKAGES) cpSync(path.join(sdk, pkg), path.join(work, pkg), {recursive: true});
  const edit = (file, from, to) => {
    // The zip's headers are read-only and cpSync keeps their mode.
    const full = path.join(work, file), text = readFileSync(full, 'latin1'), next = text.replace(from, to);
    chmodSync(full, 0o644);
    if (next === text) throw new Error(`compatibility edit did not apply: ${file}`);
    writeFileSync(full, next, 'latin1');
  };
  edit('Core/Inc/UnMem.h', /(friend void\* operator new\( size_t Size, FMemStack& Mem(?:, EMem\w+ Tag)?), INT Count=1, INT Align=DEFAULT_ALIGNMENT \)/g, '$1, INT Count, INT Align )');
  edit('Engine/Inc/UnActor.h', 'for( AActor* Top=this; Top->Owner; Top=Top->Owner );', 'AActor* Top=this; for( ; Top->Owner; Top=Top->Owner );');
  const includes = PACKAGES.flatMap(pkg => ['-I', path.join(work, pkg, 'Inc')]);
  const clang = (source, extra) => {
    const file = path.join(work, 'tu.cpp');
    writeFileSync(file, source);
    try {
      return {out: execFileSync('clang', ['-target', 'i686-pc-windows-msvc', '-fms-extensions', '-fms-compatibility', '-x', 'c++',
        ...includes, ...extra, file], {encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe']}), errors: ''};
    } catch (error) { return {out: error.stdout ?? '', errors: String(error.stderr ?? error.message)}; }
  };
  const head = '#include "Extension.h"\n#include "DeusEx.h"\n#include "ConSys.h"\n';
  // Candidate class names from the headers; forward declarations and templates
  // fail sizeof and are dropped in the first pass.
  const names = new Set();
  for (const pkg of PACKAGES) for (const file of readdirSync(path.join(work, pkg, 'Inc')).filter(f => f.endsWith('.h'))) {
    const text = readFileSync(path.join(work, pkg, 'Inc', file), 'latin1');
    for (const m of text.matchAll(/^\s*(?:class|struct)\s+(?:\w+_API\s+)?([A-Z]\w+)\s*(?::[^;{]*)?\{/gm)) names.add(m[1]);
  }
  const probe = list => list.map((name, i) => `int __sdk_size_${i} = sizeof(${name});`).join('\n');
  let candidates = [...names];
  const first = clang(head + probe(candidates), ['-fsyntax-only']);
  const bad = new Set([...first.errors.matchAll(/tu\.cpp:(\d+):/g)].map(m => Number(m[1]) - 4));
  candidates = candidates.filter((_, i) => !bad.has(i));
  // A derived class with an out-of-line constructor makes clang emit (and dump)
  // the vftable of each polymorphic class as its final overriders see it.
  const records = parseRecords(clang(head + probe(candidates), ['-fsyntax-only', '-Xclang', '-fdump-record-layouts']).out);
  let polymorphic = Object.keys(records).filter(name => records[name].vfptr);
  let derive = list => list.map(name => `struct __SdkVt_${name} : ${name} { __SdkVt_${name}(); }; __SdkVt_${name}::__SdkVt_${name}() {}`).join('\n');
  let emitted = clang(head + derive(polymorphic), ['-S', '-emit-llvm', '-o', '/dev/null', '-Xclang', '-fdump-vtable-layouts']);
  if (emitted.errors.includes('error')) {
    const failing = new Set([...emitted.errors.matchAll(/tu\.cpp:(\d+):/g)].map(m => Number(m[1]) - 4));
    polymorphic = polymorphic.filter((_, i) => !failing.has(i));
    emitted = clang(head + derive(polymorphic), ['-S', '-emit-llvm', '-o', '/dev/null', '-Xclang', '-fdump-vtable-layouts']);
  }
  const {tables: vftables, bases} = parseVftables(emitted.out);
  const result = {source: 'Deus Ex SDK 1112f Headers/DxHeaders.zip', abi: 'i686-pc-windows-msvc', records, vftables, bases,
    skipped: {sizeof: names.size - candidates.length, vftable: Object.keys(records).filter(n => records[n].vfptr).length - polymorphic.length}};
  mkdirSync(path.dirname(out), {recursive: true});
  writeFileSync(out, JSON.stringify(result));
  console.log(`sdk-layouts: ${Object.keys(records).length} records, ${Object.keys(vftables).length} vftables -> ${path.relative(root, out)}`);
  return result;
}

/** clang -fdump-record-layouts: "  off[:b0-b1] | <indent>decl"; depth 0 names the record. */
function parseRecords(text) {
  const records = {};
  for (const block of text.split('*** Dumping AST Record Layout').slice(1)) {
    const lines = block.split('\n');
    const head = /^\s*0 \| (?:class|struct|union) (.+)$/.exec(lines[1] ?? '');
    if (!head || /[<(]/.test(head[1])) continue;
    const name = head[1].trim(), members = [], stack = [];
    let size = null, vfptr = false;
    for (const line of lines.slice(2)) {
      const sized = /\[sizeof=(\d+)/.exec(line);
      if (sized) { size = Number(sized[1]); break; }
      const m = /^\s*(\d+)(?::(\d+)-(\d+))? \|( +)(.*)$/.exec(line);
      if (!m) continue;
      const depth = (m[4].length - 1) / 2, decl = m[5].trim();
      stack.length = depth - 1;
      if (/vftable pointer\)$/.test(decl)) { if (depth === 1 || stack.every(s => s.base)) vfptr = true; continue; }
      const base = /^(?:class|struct) (\w+) \((?:primary |virtual )?base\)$/.exec(decl);
      const member = base ? null : /^(.*?)\s*([A-Za-z_]\w*)(\[\d+\])?$/.exec(decl);
      const entry = {offset: Number(m[1]), depth, owner: stack.filter(s => s.base).at(-1)?.name ?? name,
        path: [...stack.filter(s => !s.base).map(s => s.name), base ? null : member?.[2]].filter(Boolean).join('.'),
        type: base ? null : member?.[1].replace(/^(?:class|struct|enum) /, '') ?? decl};
      if (m[2] !== undefined) entry.bits = [Number(m[2]), Number(m[3])];
      stack[depth - 1] = base ? {base: true, name: base[1]} : {name: member?.[2] ?? decl};
      if (!base) members.push(entry);
    }
    records[name] ??= {size, vfptr, members};
  }
  return records;
}

/** clang -fdump-vtable-layouts (MS ABI): "VFTable for 'A' in 'B' ... (N entries)." then " i | decl". Entry 0 is RTTI. */
function parseVftables(text) {
  const tables = {}, bases = {};
  for (const block of text.split(/\n(?=VFTable for )/)) {
    const head = /^VFTable for (.+) \((\d+) entries\)\./.exec(block);
    if (!head) continue;
    const chain = [...head[1].matchAll(/'([^']+)'/g)].map(m => m[1]).filter(name => !name.startsWith('__SdkVt_'));
    const cls = chain.at(-1);
    if (chain[0] !== 'FUnknown' && chain[0] !== cls) continue; // secondary (FExec...) tables
    const slots = [];
    // The table ends at the first blank line; a "VFTable indices" block follows.
    for (const line of block.split('\n').slice(1)) {
      if (!line.trim()) break;
      const m = /^\s*(\d+) \| (.*)$/.exec(line);
      if (!m || m[2].endsWith(' RTTI')) continue;
      const decl = m[2].replace(/\s*\[(?:pure|deleted)\]$/, ''), owner = /(\w+)::~?\w+\(/.exec(decl)?.[1] ?? null;
      slots.push({slot: Number(m[1]) - 1, offset: (Number(m[1]) - 1) * 4, owner, decl});
    }
    if (!tables[cls] || tables[cls].length < slots.length) { tables[cls] = slots; bases[cls] = chain.slice(1, -1); }
  }
  return {tables, bases};
}

function membersAt(cls, offset) {
  return (layouts.records[cls]?.members ?? []).filter(member => member.offset === offset && member.type);
}
function printClass(cls) {
  const record = layouts.records[cls];
  if (!record) throw new Error(`no SDK record ${cls}`);
  console.log(`${cls}: sizeof 0x${record.size.toString(16)}`);
  for (const member of record.members.filter(member => member.type))
    console.log(`  +0x${member.offset.toString(16).padStart(3, '0')}${member.bits ? `:${member.bits.join('-')}` : ''}  ${member.owner}.${member.path}  (${member.type})`);
}
function printVtable(cls) {
  for (const slot of layouts.vftables[cls] ?? []) console.log(`  +0x${slot.offset.toString(16).padStart(3, '0')} [${slot.slot}] ${slot.decl}`);
}
function printAt(cls, offset) {
  for (const member of membersAt(cls, offset)) console.log(`${cls}+0x${offset.toString(16)}: ${member.owner}.${member.path} (${member.type})`);
}
/** A class's slots with the function each holds in its retail DLL's exported vftable. */
function printRetail(cls) {
  const slots = layouts.vftables[cls];
  if (!slots) throw new Error(`no SDK vftable ${cls}`);
  for (const dll of ['Core', 'Engine', 'Extension', 'DeusEx', 'ConSys']) {
    const image = peImage(path.join(root, 'Deus Ex GOTY Edition/System', `${dll}.dll`));
    const at = image.exports.get(`??_7${cls}@@6B@`);
    if (at === undefined) continue;
    console.log(`${cls} vftable 0x${at.toString(16)} (${dll}.dll)`);
    for (const slot of slots)
      console.log(`  +0x${slot.offset.toString(16).padStart(3, '0')} 0x${image.u32(at + slot.offset).toString(16)} ${slot.owner === cls ? 'own ' : '    '}${slot.decl}`);
    return;
  }
  console.log(`${cls} has no exported retail vftable`);
}
/** Slots each descendant of `base` defines itself: what admitting that family must translate. */
function printOverrides(base) {
  const ancestry = cls => {
    const table = layouts.vftables[cls];
    return table && table.some(slot => slot.owner === base || cls === base);
  };
  for (const [cls, table] of Object.entries(layouts.vftables).sort()) {
    if (cls === base || !ancestry(cls)) continue;
    const own = table.filter(slot => slot.owner === cls && !slot.decl.includes('~'));
    console.log(`${cls} (${table.length} slots): ${own.length ? own.map(slot => `+0x${slot.offset.toString(16)} ${slot.decl.replace(/^.*?(\w+)\(.*$/, '$1')}`).join(', ') : 'none'}`);
  }
}

/** Offsets the runtime already recovered from the retail DLLs, compared with the SDK. */
async function check() {
  const {O, ROOT} = await import('../src/runtime/script-window-tree-natives.mjs');
  let agree = 0, nested = 0;
  const misses = [];
  for (const [cls, table] of [['XWindow', O], ['XRootWindow', ROOT]])
    for (const [name, offset] of Object.entries(table)) {
      const at = membersAt(cls, offset);
      if (at.some(member => member.depth === 1)) agree++;
      else if (at.length) nested++;
      else misses.push(`${cls}.${name}+0x${offset.toString(16)}`);
    }
  // Virtual offsets named in the recovered window translations.
  const slots = {0x64: 'CursorRequested', 0xbc: 'RawKeyPressed', 0xcc: 'VirtualKeyPressed', 0xe8: 'ButtonActivated',
    0xec: 'ButtonActivatedRight', 0xf0: 'ToggleChanged'};
  let slotAgree = 0;
  for (const [offset, name] of Object.entries(slots)) {
    const slot = layouts.vftables.XWindow?.find(entry => entry.offset === Number(offset));
    if (slot?.decl.includes(`::${name}(`)) slotAgree++;
    else misses.push(`XWindow vtable +0x${Number(offset).toString(16)} ${name}: SDK ${slot?.decl ?? 'none'}`);
  }
  // Every vftable the retail DLLs export (??_7Class@@6B@): a slot the SDK says
  // the class inherits must hold its base's function. A slot the SDK says it
  // defines normally holds a different one; the linker folds byte-identical
  // bodies (XClipWindow/XRadioBoxWindow ChildRequestedReconfiguration and
  // XTabGroupWindow's are all `xor eax,eax; ret 4` at 0x100421d0), so a shared
  // address there is reported as folded, not as a mismatch.
  const retail = {slots: 0, classes: 0, differ: [], folded: []};
  for (const dll of ['Core', 'Engine', 'Extension', 'DeusEx', 'ConSys']) {
    const image = peImage(path.join(root, 'Deus Ex GOTY Edition/System', `${dll}.dll`));
    const table = cls => { const at = image.exports.get(`??_7${cls}@@6B@`); return at === undefined ? null : index => image.u32(at + 4 * index); };
    for (const [cls, slots] of Object.entries(layouts.vftables)) {
      const own = table(cls), parent = layouts.bases?.[cls]?.at(-1), inherited = parent && table(parent);
      if (!own || !inherited) continue;
      retail.classes++;
      const parentLength = layouts.vftables[parent].length;
      for (const slot of slots.filter(slot => slot.slot < parentLength)) {
        const defines = slot.owner === cls, differs = own(slot.slot) !== inherited(slot.slot);
        retail.slots++;
        if (defines && !differs) retail.folded.push(`${cls}+0x${slot.offset.toString(16)}`);
        else if (defines !== differs) retail.differ.push(`${dll} ${cls} +0x${slot.offset.toString(16)} ${slot.decl}: SDK ${defines ? 'overrides' : 'inherits'}, ` +
          `retail 0x${own(slot.slot).toString(16)} vs ${parent} 0x${inherited(slot.slot).toString(16)}`);
      }
    }
  }
  console.log(`sdk-layouts retail: ${retail.slots - retail.differ.length}/${retail.slots} slots of ${retail.classes} exported vftables ` +
    `agree with the SDK override pattern (${retail.folded.length} folded identical bodies: ${retail.folded.join(', ') || '-'})`);
  misses.push(...retail.differ);
  const total = Object.keys(O).length + Object.keys(ROOT).length;
  console.log(`sdk-layouts check: ${agree} direct + ${nested} nested/inherited of ${total} recovered window offsets start an SDK member; ` +
    `${slotAgree}/${Object.keys(slots).length} recovered XWindow virtual offsets name the same SDK slot`);
  if (misses.length) { console.error(`MISMATCH:\n  ${misses.join('\n  ')}`); process.exitCode = 1; }
}

/** Minimal PE32 reader: named exports and little-endian reads at virtual addresses. */
function peImage(file) {
  const data = readFileSync(file), u16 = at => data.readUInt16LE(at), u32 = at => data.readUInt32LE(at);
  const pe = u32(60), opt = pe + 24, base = u32(opt + 28);
  const sections = Array.from({length: u16(pe + 6)}, (_, i) => {
    const at = opt + u16(pe + 20) + 40 * i;
    return {va: u32(at + 12), size: Math.max(u32(at + 8), u32(at + 16)), raw: u32(at + 20)};
  });
  const fileOffset = rva => { const s = sections.find(s => rva >= s.va && rva < s.va + s.size); return s ? s.raw + rva - s.va : -1; };
  const dir = fileOffset(u32(opt + 96)), exports = new Map();
  const [functions, names, ordinals] = [u32(dir + 28), u32(dir + 32), u32(dir + 36)].map(fileOffset);
  for (let i = 0; i < u32(dir + 24); i++) {
    const at = fileOffset(u32(names + 4 * i)), name = data.toString('latin1', at, data.indexOf(0, at));
    exports.set(name, base + u32(functions + 4 * u16(ordinals + 2 * i)));
  }
  return {exports, u32: va => u32(fileOffset(va - base))};
}
