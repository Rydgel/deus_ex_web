/** Print the decoded bytecode of original UnrealScript functions as pseudo-code,
 * with native names, string constants and jump targets (an evidence tool; its
 * output is not committed). The retail script sources are not shipped, so this
 * is how the menu and window scripts are read.
 *
 *   node scripts/dump-script-function.mjs DeusEx MenuUIChoiceSlider.LoadSetting [Class.Func ...]
 *   node scripts/dump-script-function.mjs DeusEx 'MenuChoice_*.*'      (glob on the path)
 */
import {readFile} from 'node:fs/promises';
import {parsePackage} from '../src/unreal/package.mjs';
import {readObject, objectAt, nameAt} from '../src/unreal/objects.mjs';
import {skipBytecode} from '../src/unreal/classes.mjs';
import {decodeScript} from '../src/unreal/bytecode.mjs';
import {gameDirectory} from './game-directory.mjs';

const [pkgName, ...patterns] = process.argv.slice(2);
if (!pkgName || !patterns.length) { console.error('usage: dump-script-function.mjs <Package> <Class.Func|glob> ...'); process.exit(2); }
const root = gameDirectory();
const load = async name => { const bytes = await readFile(`${root}/System/${name}.u`); return {pkg: parsePackage(bytes), bytes}; };

// iNative -> name, over the packages that declare natives.
const natives = new Map();
for (const name of ['Core', 'Engine', 'Extension', 'DeusEx']) {
  const asset = await load(name);
  asset.pkg.exports.forEach((entry, i) => {
    if (entry.className !== 'Function') return;
    try {
      const object = readObject(asset.pkg, asset.bytes, i + 1), r = object.reader;
      for (let k = 0; k < 3; k++) r.compact();
      r.compact(); r.u32(); r.u32();
      const size = r.u32();
      skipBytecode(asset.pkg, r, size);
      const iNative = r.u16();
      if (iNative) natives.set(iNative, entry.name);
    } catch { /* not a plain function */ }
  });
}

const asset = await load(pkgName), {pkg, bytes} = asset;
const matcher = pattern => new RegExp(`^${pattern.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
const wanted = patterns.map(matcher);
const castNames = {0x39: 'RotatorToVector', 0x3a: 'ByteToInt', 0x3b: 'ByteToBool', 0x3c: 'ByteToFloat', 0x3d: 'IntToByte', 0x3e: 'IntToBool',
  0x3f: 'IntToFloat', 0x40: 'BoolToByte', 0x41: 'BoolToInt', 0x42: 'BoolToFloat', 0x43: 'FloatToByte', 0x44: 'FloatToInt', 0x45: 'FloatToBool',
  0x46: 'StringToName', 0x47: 'ObjectToBool', 0x48: 'NameToBool', 0x49: 'StringToByte', 0x4a: 'StringToInt', 0x4b: 'StringToBool',
  0x4c: 'StringToFloat', 0x4d: 'StringToVector', 0x4e: 'StringToRotator', 0x4f: 'VectorToBool', 0x50: 'VectorToRotator', 0x51: 'RotatorToBool',
  0x52: 'ByteToString', 0x53: 'IntToString', 0x54: 'BoolToString', 0x55: 'FloatToString', 0x56: 'ObjectToString', 0x57: 'NameToString',
  0x58: 'VectorToString', 0x59: 'RotatorToString'};
const objectName = index => { try { const e = objectAt(pkg, index); return e?.path ?? e?.name ?? `#${index}`; } catch { return `#${index}`; } };
const show = n => {
  if (!n) return '?';
  const list = args => (args ?? []).map(show).join(', ');
  switch (n.op) {
    case 0x00: return `${n.name}`; case 0x01: return `self.${n.name}`; case 0x02: return `default.${n.name}`; case 0x29: return `parm.${n.name}`;
    case 'literal': return typeof n.value === 'string' ? JSON.stringify(n.value) : Array.isArray(n.value) ? `(${n.value.join(',')})` : String(n.value);
    case 0x1b: case 0x38: return `${n.op === 0x38 ? 'global.' : ''}${n.name}(${list(n.args)})`;
    case 0x1c: return `${objectName(n.functionIndex)}(${list(n.args)})`;
    case 'native': return `${natives.get(n.index) ?? `native#${n.index}`}[${n.index}](${list(n.args)})`;
    case 0x0f: return `${show(n.left)} = ${show(n.right)}`;
    case 0x14: return `${show(n.left)} =bool ${show(n.right)}`;
    case 0x19: case 0x12: return `${show(n.context)}.${show(n.value)}`;
    case 0x1a: return `${show(n.left)}[${show(n.right)}]`;
    case 0x36: return `${show(n.value)}.${n.name}`;
    case 0x2d: return `bool(${show(n.value)})`;
    case 0x17: return 'self'; case 0x0b: return '_'; case 0x08: return 'stop'; case 0x2a: return 'None';
    case 0x20: return `obj(${objectName(n.objectIndex)})`;
    case 0x21: return `'${n.name}'`;
    case 0x13: case 0x2e: return `${n.op === 0x13 ? 'class' : 'cast'}<${n.name ?? n.fieldIndex}>(${show(n.value)})`;
    case 0x04: return `return ${n.value ? show(n.value) : ''}`;
    case 0x06: return `goto @${n.target}`;
    case 0x07: return `ifnot ${show(n.value)} goto @${n.target}`;
    case 0x05: return `switch(${show(n.value)})`;
    case 0x0a: return n.target === 0xffff ? 'default:' : `case ${show(n.value)}: else @${n.target}`;
    case 0x0e: return `eat ${show(n.value)}`;
    case 0x09: return `assert ${show(n.value)}`;
    case 0x18: return `skip @${n.target} ${show(n.value)}`;
    case 0x2f: return `iterator ${show(n.value)} end @${n.target}`;
    case 0x30: return 'iteratorpop'; case 0x31: return 'iteratornext';
    case 0x32: case 0x33: return `${show(n.left)} ${n.op === 0x32 ? '==' : '!='} ${show(n.right)}`;
    default:
      if (n.op >= 0x39 && n.op < 0x60) return `${castNames[n.op] ?? `cast0x${n.op.toString(16)}`}(${show(n.value)})`;
      return `op0x${n.op.toString(16)}`;
  }
};

let count = 0;
pkg.exports.forEach((entry, i) => {
  if (entry.className !== 'Function' || !wanted.some(re => re.test(entry.path))) return;
  const object = readObject(pkg, bytes, i + 1), r = object.reader;
  for (let k = 0; k < 4; k++) r.compact();
  const name = nameAt(pkg, r.compact());
  r.u32(); r.u32();
  const size = r.u32(), start = r.offset;
  skipBytecode(pkg, r, size);
  const script = {pkg, bytes: r.bytes.slice(start, r.offset), size};
  console.log(`\n=== ${entry.path} (${name}) ===`);
  const decoded = decodeScript(script);
  for (const [offset, {node}] of decoded.statements) console.log(`@${offset}  ${show(node)}`);
  count++;
});
if (!count) { console.error('no matching function'); process.exit(1); }
