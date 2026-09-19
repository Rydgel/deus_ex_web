"""Original Core EndLoad/ConditionalPostLoad/metadata PostLoad instructions.

Preload, virtual Bind, output, allocation and deliberately custom PostLoad
callbacks are explicit fixture services. The control flow, original metadata
PostLoad bodies, flags writes and import cleanup execute in the hash-checked
DLL. Captures and original files are not committed. See docs/script-end-load.md.
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

END = 0x10155510
CONDITIONAL = 0x1014ff70
BODIES = {'Object': 0x1014f9b0, 'Field': 0x10125bf0, 'Struct': 0x10128f30,
          'Function': 0x101291a0, 'Class': 0x10127d70}
NEED_LOAD, NEED_POST, POSTED, NATIVE = 0x200, 0x1000000, 0x20000000, 0x4000000
DATA, NUM, MAX, NEST, COUNTER = 0x1029e638, 0x1029e63c, 0x1029e640, 0x102a2650, 0x102a2658


class OriginalAssertion(Exception):
    pass


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.events = []
        self.labels = {}
        self.objects = {}
        self.config = {}
        self.specs = {}
        self.assertion = None
        self.stubs = {}
        for address, name, code in [
            (0x10102a95, 'Logf', b'\xc3'),
            (0x10102c70, 'Assert', b'\xc3'),
            (0x1010240f, 'GetFullName', b'\xc2\x04\x00'),
            (0x1010280b, 'ErrorLogf', b'\xc3'),
        ]:
            self.cpu.mem_write(address, code)
            self.stubs[address] = name
        for name, code in [
            ('Preload', b'\xc2\x04\x00'), ('Bind', b'\xc3'),
            ('Realloc', b'\x31\xc0\xc2\x0c\x00'),
            ('Callback', b'\xb8' + struct.pack('<I', BODIES['Object']) + b'\xff\xe0'),
            ('NoBase', b'\xc3'),
        ]:
            address = self.alloc(32)
            self.cpu.mem_write(address, code)
            self.stubs[address] = name
            setattr(self, name.lower(), address)
        # A custom override reenters ConditionalPostLoad, then calls the real
        # UObject base. Preserve this across the nested native call.
        self.reenter = self.alloc(32)
        self.cpu.mem_write(self.reenter, b'\x51\xb8' + struct.pack('<I', CONDITIONAL) +
                           b'\xff\xd0\x59\xb8' + struct.pack('<I', BODIES['Object']) + b'\xff\xe0')
        self.stubs[self.reenter] = 'Reenter'
        malloc, vt = self.alloc(16), self.alloc(16)
        self.write(malloc, 'I', vt)
        self.write(vt + 4, 'I', self.realloc)
        self.write(0x101a7c44, 'I', malloc)
        self.write(0x101a7c3c, 'I', 0x1234)
        self.write(0x101a7c38, 'I', 0x5678)

    def label(self, pointer):
        return self.labels.get(pointer) if pointer else None

    def append(self, label, relocate=False):
        count = self.read(NUM, 'I')[0]
        array = self.read(DATA, 'I')[0]
        if relocate:
            replacement = self.alloc(128)
            if count:
                self.cpu.mem_write(replacement, bytes(self.cpu.mem_read(array, count * 4)))
            self.write(DATA, 'I', replacement)
            array = replacement
        self.write(array + count * 4, 'I', self.objects[label])
        self.write(NUM, 'I', count + 1)

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        this = cpu.reg_read(UC_X86_REG_ECX)
        label = self.label(this)
        if address == CONDITIONAL:
            self.events.append({'op': 'ConditionalPostLoad', 'object': label})
        if address in BODIES.values() and self.read(stack, 'I')[0] == 0x1014ffb4:
            kind = next(k for k, v in BODIES.items() if v == address)
            self.events.append({'op': 'PostLoad', 'kind': kind, 'object': label,
                                'flags': self.read(this + 0x1c, 'I')[0]})
        service = self.stubs.get(address)
        if service == 'Assert':
            line = self.read(stack + 12, 'I')[0]
            self.assertion = line
            self.events.append({'op': 'Assert', 'line': line})
            raise OriginalAssertion(line)
        if service == 'Logf':
            receiver, name, fmt = self.read(stack + 4, '3I')
            self.events.append({'op': 'Logf', 'receiver': receiver, 'name': name, 'formatPointer': fmt})
            if self.config.get('logAppend'):
                self.append(self.config['logAppend'], relocate=True)
        elif service == 'Preload':
            obj = self.read(stack + 4, 'I')[0]
            obj_label = self.label(obj)
            self.events.append({'op': 'Preload', 'object': obj_label, 'linker': self.label(this - 0xa4)})
            self.write(obj + 0x1c, 'I', self.read(obj + 0x1c, 'I')[0] & ~NEED_LOAD)
            target = self.specs[obj_label].get('preloadAppend')
            if target:
                self.append(target, relocate=True)
        elif service == 'Bind':
            self.events.append({'op': 'Bind', 'object': label, 'flags': self.read(this + 0x1c, 'I')[0]})
            replacement = self.specs[label].get('bindSuper')
            if replacement:
                self.write(this + 0x28, 'I', self.objects[replacement])
        elif service in ['Callback', 'NoBase', 'Reenter']:
            self.events.append({'op': 'PostLoad', 'kind': service, 'object': label,
                                'flags': self.read(this + 0x1c, 'I')[0]})
            target = self.specs[label].get('postAppend')
            if target:
                self.append(target, relocate=True)
        elif service == 'GetFullName':
            self.events.append({'op': 'GetFullName', 'object': label, 'stopOuter': self.read(stack + 4, 'I')[0]})
            cpu.reg_write(UC_X86_REG_EAX, this)
        elif service == 'ErrorLogf':
            receiver, fmt, name = self.read(stack + 4, '3I')
            self.events.append({'op': 'ErrorLogf', 'receiver': receiver, 'formatPointer': fmt,
                                'fullName': self.label(name)})
        elif service == 'Realloc':
            old, size, tag = self.read(stack + 4, '3I')
            self.events.append({'op': 'Realloc', 'bytes': size, 'tag': tag,
                                'num': self.read(NUM, 'I')[0], 'max': self.read(MAX, 'I')[0]})
        return super().on_instruction(cpu, address, size, data)

    def run(self, config):
        self.config = config
        self.events, self.objects, self.labels, self.specs = [], {}, {}, {}
        self.assertion = None
        linker = self.alloc(0x500)
        self.labels[linker] = 'linker'
        archive_vt = self.alloc(32)
        self.write(linker + 0xa4, 'I', archive_vt)
        self.write(archive_vt + 0x10, 'I', self.preload)
        for entry in config.get('objects', []):
            obj, vt = self.alloc(0x500), self.alloc(0x80)
            label, kind = entry['name'], entry.get('kind', 'Object')
            self.objects[label], self.labels[obj], self.specs[label] = obj, label, entry
            post = BODIES[kind] if kind in BODIES else getattr(self, kind.lower())
            self.write(obj, 'I', vt)
            self.write(vt + 0x20, 'I', post)
            self.write(vt + 0x5c, 'I', self.bind)
            self.write(obj + 0x1c, 'I', entry.get('flags', NEED_LOAD | NEED_POST))
            self.write(obj + 0x10, 'I', 0 if entry.get('noLinker') else linker)
            self.write(obj + 0x49c, 'I', 0 if entry.get('noWithin') else linker)
        for entry in config.get('objects', []):
            self.write(self.objects[entry['name']] + 0x28, 'I', self.objects.get(entry.get('super'), 0))
        self.write(DATA, 'I', self.alloc(128))
        self.write(NUM, 'I', 0)
        self.write(MAX, 'I', 32)
        for label in config.get('loaded', list(self.objects)):
            self.append(label)
        self.write(NEST, 'I', config.get('nest', 1))
        self.write(COUNTER, 'I', config.get('counter', 0))
        imports = self.alloc(28 * max(1, len(config.get('imports', []))))
        for i, label in enumerate(config.get('imports', [])):
            self.write(imports + 28 * i + 0x10, '3I', self.objects.get(label, 0), linker, i + 7)
        self.write(linker + 0x78, '2I', imports, len(config.get('imports', [])))
        loaders = self.alloc(4)
        self.write(loaders, 'I', linker)
        self.write(0x1029e608, '2I', loaders, 1)
        try:
            self.call(CONDITIONAL if config.get('conditional') else END,
                      self.objects.get(config.get('conditional'), 0), b'')
        except OriginalAssertion:
            pass
        count = self.read(NUM, 'I')[0]
        loaded = self.read(DATA, 'I')[0]
        return {'spec': config, 'events': self.events, 'assertion': self.assertion,
                'nest': self.read(NEST, 'I')[0], 'counter': self.read(COUNTER, 'I')[0],
                'max': self.read(MAX, 'I')[0],
                'loaded': [self.label(self.read(loaded + 4 * i, 'I')[0]) for i in range(count)],
                'flags': {key: self.read(obj + 0x1c, 'I')[0] for key, obj in self.objects.items()},
                'imports': [{'object': self.label(self.read(imports + 28 * i + 0x10, 'I')[0]),
                             'sourceLinker': self.label(self.read(imports + 28 * i + 0x14, 'I')[0]),
                             'sourceIndex': self.read(imports + 28 * i + 0x18, 'I')[0]}
                            for i in range(len(config.get('imports', [])))]}


CASES = [
    {'name': 'nested', 'nest': 2, 'counter': 1, 'objects': [{'name': 'a'}], 'imports': ['a']},
    {'name': 'empty'},
    {'name': 'two-passes', 'objects': [{'name': 'a'}, {'name': 'field', 'kind': 'Field'},
        {'name': 'struct', 'kind': 'Struct', 'flags': NEED_POST},
        {'name': 'function', 'kind': 'Function'}, {'name': 'already', 'flags': POSTED}]},
    {'name': 'preload-appends-relocated', 'objects': [{'name': 'a', 'preloadAppend': 'b'}, {'name': 'b'}], 'loaded': ['a']},
    {'name': 'log-appends-relocated', 'objects': [{'name': 'a'}], 'loaded': [], 'logAppend': 'a'},
    {'name': 'postload-appends-asserts', 'objects': [{'name': 'a', 'kind': 'Callback', 'postAppend': 'b'},
        {'name': 'b'}], 'loaded': ['a']},
    {'name': 'cleanup', 'counter': 2, 'objects': [{'name': 'ordinary'}, {'name': 'native', 'flags': NATIVE | NEED_POST},
        {'name': 'other-high-bit', 'flags': 0x80000000 | NEED_POST}], 'imports': ['ordinary', 'native', None, 'other-high-bit']},
    {'name': 'cleanup-skipped', 'objects': [{'name': 'a'}], 'imports': ['a']},
    {'name': 'needload-without-linker', 'objects': [{'name': 'a', 'noLinker': True}]},
    {'name': 'invalid-nest', 'nest': 0},
    {'name': 'conditional-clear-before-callback', 'conditional': 'a',
        'objects': [{'name': 'a', 'kind': 'Callback', 'flags': 0x81000204 | POSTED}]},
    {'name': 'conditional-skip', 'conditional': 'a', 'objects': [{'name': 'a', 'flags': POSTED | NEED_LOAD}]},
    {'name': 'conditional-reentry', 'conditional': 'a', 'objects': [{'name': 'a', 'kind': 'Reenter', 'flags': NEED_POST}]},
    {'name': 'missing-base-diagnostic', 'conditional': 'a',
        'objects': [{'name': 'a', 'kind': 'NoBase', 'flags': NEED_POST | POSTED}]},
    {'name': 'class-super-order', 'objects': [{'name': 'child', 'kind': 'Class', 'super': 'base'},
        {'name': 'base', 'kind': 'Class'}]},
    {'name': 'class-super-reread-after-bind', 'conditional': 'child', 'objects': [
        {'name': 'child', 'kind': 'Class', 'super': 'old', 'bindSuper': 'new'},
        {'name': 'old', 'kind': 'Class'}, {'name': 'new', 'kind': 'Class'}]},
    {'name': 'class-within-assert', 'conditional': 'child',
        'objects': [{'name': 'child', 'kind': 'Class', 'noWithin': True}]},
]

if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    print(json.dumps({'hashes': native.HASHES, 'cases': [probe.run(case) for case in CASES]}))
