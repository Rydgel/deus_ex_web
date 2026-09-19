"""Original UFunction::Bind with native owner/CPP-name walks.

Only formatting, scratch-string allocation, string comparison and package
GetDllExport are fixture services. Indexed table reads, pointer-cell copying,
flags, assertions and call order execute from hash-checked Core instructions.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class StopAssertion(Exception):
    pass


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.events, self.labels = [], {}
        self.owner_calls = 0
        self.config = {}
        for address, code in [(0x10102c70, b'\xc3'), (0x10102518, b'\xc3'),
                              (0x1010239c, b'\xc3'), (0x101012ad, b'\xc3'),
                              (0x10101168, b'\xc2\x08\x00')]:
            self.cpu.mem_write(address, code)
        self.scratch = self.alloc(1024)
        self.names = self.alloc(1024)
        self.write(0x102961f0, 'I', self.names)

    def text_at(self, pointer):
        units = []
        for i in range(512):
            unit = self.read(pointer + i * 2, 'H')[0]
            if not unit:
                return ''.join(map(chr, units))
            units.append(unit)
        raise RuntimeError('unterminated string')

    def write_name(self, index, text):
        entry = self.alloc(128)
        self.cpu.mem_write(entry + 12, text.encode('utf-16le') + b'\0\0')
        self.write(self.names + index * 4, 'I', entry)

    def on_instruction(self, cpu, address, size, data):
        stack, this = cpu.reg_read(UC_X86_REG_ESP), cpu.reg_read(UC_X86_REG_ECX)
        if address == 0x10102c70:
            line = self.read(stack + 12, 'I')[0]
            self.events.append({'op': 'Assert', 'line': line})
            raise StopAssertion(line)
        if address == 0x10125bc0:
            self.owner_calls += 1
            self.events.append({'op': 'GetOwnerClass', 'object': 'function'})
            if self.owner_calls == 2 and self.config.get('secondOwner'):
                self.write(self.function + 0x18, 'I', self.second)
        elif address == 0x101115a0:
            self.events.append({'op': 'GetNameCPP', 'class': self.labels[this]})
        elif address == 0x10102518:
            cpu.reg_write(UC_X86_REG_EAX, self.scratch)
        elif address == 0x1010239c:
            a, b = self.read(stack + 4, '2I')
            cpu.reg_write(UC_X86_REG_EAX, int(self.text_at(a).lower() != self.text_at(b).lower()))
        elif address == 0x101012ad:
            destination, fmt, a, b = self.read(stack + 4, '4I')
            fmt, a, b = self.text_at(fmt), self.text_at(a), self.text_at(b)
            if fmt == '%s%s':
                result = a + b
            elif fmt == 'int%sexec%s':
                result = 'int' + a + 'exec' + b
                self.events.append({'op': 'FormatExport', 'name': result})
            else:
                raise RuntimeError(f'unexpected format {fmt}')
            self.cpu.mem_write(destination, result.encode('utf-16le') + b'\0\0')
            cpu.reg_write(UC_X86_REG_EAX, len(result))
        elif address == 0x10101168:
            name, checked = self.read(stack + 4, '2I')
            self.events.append({'op': 'GetDllExport', 'package': self.labels[this],
                                'name': self.text_at(name), 'checked': checked})
            cpu.reg_write(UC_X86_REG_EAX, 0 if self.config.get('missing') else self.cell)
        return super().on_instruction(cpu, address, size, data)

    def run(self, config):
        self.events, self.labels, self.owner_calls, self.config = [], {}, 0, config
        self.function, self.second, owner, state, base = [self.alloc(0x500) for _ in range(5)]
        package, other_package, function_vt, class_vt = [self.alloc(0x100) for _ in range(4)]
        self.cell = self.alloc(4)
        self.write(self.cell, 'I', config.get('pointer', 0x12345678))
        self.labels.update({owner: config.get('className', 'Object'), self.second: 'Second',
                            package: 'package', other_package: 'other-package'})
        self.write(function_vt + 0x60, 'I', 0x10101a5f)
        self.write(class_vt + 0x80, 'I', 0x10101456)
        for obj in [owner, self.second, base]:
            self.write(obj, 'I', class_vt)
            self.write(obj + 0x24, 'I', 0x101f1c18)
        self.write(self.function, 'I', function_vt)
        self.write(self.function + 0x18, 'I', state if config.get('nested') else owner)
        self.write(state + 0x18, 'I', owner)
        self.write(self.function + 0x20, 'I', 1)
        self.write(owner + 0x18, 'I', package)
        self.write(owner + 0x20, 'I', 2)
        self.write(owner + 0x28, 'I', base if config.get('actorBase') else 0)
        self.write(base + 0x20, 'I', 3)
        self.write(self.second + 0x18, 'I', other_package)
        self.write_name(1, config.get('functionName', 'DynamicLoadObject'))
        self.write_name(2, config.get('className', 'Object'))
        self.write_name(3, 'aCtOr')
        self.write(self.function + 0x6c, 'I', config.get('flags', 0x400))
        index = config.get('index', 0)
        self.write(self.function + 0x70, 'H', index)
        self.write(self.function + 0x7c, 'I', config.get('before', 0xdeadbeef))
        if 0 < index < 4096:
            self.write(0x101f41b8 + index * 4, 'I', config.get('pointer', 0x12345678))
        assertion = None
        try:
            self.call(0x10129320, self.function, b'')
        except StopAssertion as error:
            assertion = error.args[0]
        return {'spec': config, 'pointer': self.read(self.function + 0x7c, 'I')[0],
                'events': self.events, 'assertion': assertion}


CASES = [
    {'name': 'script-overwrites', 'flags': 0x80000000},
    {'name': 'script-index-assert', 'flags': 0, 'index': 1},
    {'name': 'numbered-first', 'index': 1},
    {'name': 'numbered-last', 'index': 4095},
    {'name': 'numbered-default-handler', 'index': 3072, 'pointer': 0x10101e60},
    {'name': 'numbered-outside-assert', 'index': 4096},
    {'name': 'numbered-null-assert', 'index': 144, 'pointer': 0},
    {'name': 'named-object'},
    {'name': 'named-actor-ancestor', 'className': 'Pawn', 'actorBase': True, 'nested': True},
    {'name': 'named-missing-preserves', 'missing': True},
    {'name': 'named-zero-cell', 'pointer': 0},
    {'name': 'named-owner-reread', 'secondOwner': True},
]

def core_registry(root):
    """Execute Core's real static initializers to supply the binding table.

    BootReplay supplies its documented allocator/CRT process services. No
    mapping is inferred from function order or DLL data-cell adjacency.
    Named cells are read from the original PE export directory.
    """
    spec = importlib.util.spec_from_file_location('boot', Path(__file__).with_name('native-boot-replay.py'))
    boot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(boot)
    probe = boot.BootReplay(root)
    probe.log = lambda *args: None
    probe.run_initializers(probe.read_init_array(boot.CORE_INIT_A, boot.CORE_INIT_Z), stop_on_failure=True)
    assert not probe.failures
    table = probe.read(0x101f41b8, '4096I')
    assert all(table)
    exports = native.Image(root / 'System' / 'Core.dll').exports()
    named = {name: {'address': address, 'pointer': probe.read(address, 'I')[0]}
             for name, address in exports.items() if name.startswith('intUObjectexec')}
    return {'defaultHandler': 0x10101e60, 'initialized': probe.read(0x101f81c4, 'I')[0],
            'numbered': {index: pointer for index, pointer in enumerate(table) if pointer != 0x10101e60},
            'named': named}


def package_forward(root):
    probe = native.NativeCollision(root)
    obj, archive = probe.alloc(0x100), probe.alloc(0x100)
    # Explicit UObject::Serialize edge: record this/archive and mark a word.
    # The real UPackage wrapper must forward both pointers and preserve the
    # base's write. Its complete base serializer has separate evidence.
    code = b'\x89\x0d' + struct.pack('<I', obj + 0x80)
    code += b'\x8b\x44\x24\x04\xa3' + struct.pack('<I', obj + 0x84)
    code += b'\xc7\x41\x2c' + struct.pack('<I', 0x12345678) + b'\xc2\x04\x00'
    probe.cpu.mem_write(0x1010178f, code)
    probe.call(0x1015a470, obj, struct.pack('<I', archive))
    return {'sameObject': probe.read(obj + 0x80, 'I')[0] == obj,
            'sameArchive': probe.read(obj + 0x84, 'I')[0] == archive,
            'wordAfterBase': probe.read(obj + 0x2c, 'I')[0]}


if __name__ == '__main__':
    root = Path(sys.argv[1])
    if '--registry-only' in sys.argv:
        print(json.dumps(core_registry(root)))
        sys.exit(0)
    probe = Probe(root)
    print(json.dumps({'hashes': native.HASHES, 'cases': [probe.run(case) for case in CASES],
                      'registry': core_registry(root), 'packageForward': package_forward(root)}))
