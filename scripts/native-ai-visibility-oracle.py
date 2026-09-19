"""Complete original AIGetLightLevel/AIVisibility workers and exec wrappers.

Original radius, brightness/saturation and Core sqrt execute unchanged. Only
SingleLineCheck is a recorded leaf; optional callback mutations exercise live
array/field reads. Full actor storage and extended return multiplication are
compared by validate-ai-visibility.mjs. No original assets are copied into Git.
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
FLOATS = {'TimeSeconds': 0x478, 'VisUpdateTime': 0x2e8, 'CurrentVisibility': 0x2ec, 'LastVisibility': 0x2f0}
VECTORS = {'Location': 0x114, 'Velocity': 0x144}
BYTES = {'LightType': 0x1e0, 'LightBrightness': 0x1e2, 'LightHue': 0x1e3,
         'LightSaturation': 0x1e4, 'LightRadius': 0x1e5, 'AmbientBrightness': 0x38c, 'AmbientSaturation': 0x38e}
FLAGS = {'bStatic': (0x28, 1), 'bUnlit': (0x194, 1)}


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.level, self.vtable, self.level_vtable = self.alloc(0x1200), self.alloc(0x100), self.alloc(0x100)
        self.write(self.vtable + 0x60, 'I', 0x10303f7b)
        self.trace_stub = 0x700e0000
        self.cpu.mem_write(self.trace_stub, bytes.fromhex('c22400'))
        self.write(self.level_vtable + 0xc0, 'I', self.trace_stub)
        self.write(self.level, 'I', self.level_vtable)
        self.frame, self.output, self.code, self.bridge = self.alloc(0x30), self.alloc(32), self.alloc(32), 0x700e1000
        self.factor = self.alloc(4)
        self.write(self.factor, 'f', 0.7132515907287598)
        # Run the original Core literal evaluators, including EX_Nothing.
        core = native.Image(root / 'System' / 'Core.dll').exports()
        table = self.alloc(4096)
        self.write(0x10599a38, 'I', table)
        for token, symbol in [(0x0b, 'Nothing'), (0x1d, 'IntConst'), (0x23, 'VectorConst')]:
            self.write(table + 4 * token, 'I', core[f'?exec{symbol}@UObject@@QAEXAAUFFrame@@QAX@Z'])
        self.exec_addresses = {700: 0x1036d350, 701: 0x1036d3d0}
        engine = native.Image(root / 'System' / 'Engine.dll')
        for name, address in [('AIGetLightLevel', 0x10303ee0), ('AIVisibility', 0x10302135)]:
            signature = 'VFVector@@' if name == 'AIGetLightLevel' else 'H'
            assert engine.exports()[f'?{name}@AActor@@QAEM{signature}@Z'] == address
        assert engine.read(0x10426988 - engine.base, 'd')[0] == 25
        self.constants = {hex(a): engine.read(a-engine.base, 'd')[0]
                          for a in [0x10426988, 0x1042ad88, 0x1042ad78, 0x1042ad68]}

    def set_fields(self, actor, fields):
        for name, value in fields.items():
            if name in FLOATS:
                self.write(actor + FLOATS[name], 'f', value)
            elif name.endswith('Bits') and name[:-4] in FLOATS:
                self.write(actor + FLOATS[name[:-4]], 'I', value)
            elif name in VECTORS:
                self.write(actor + VECTORS[name], '3f', *value)
            elif name in BYTES:
                self.write(actor + BYTES[name], 'B', value)
            elif name in FLAGS:
                offset, bit = FLAGS[name]
                flags = self.read(actor + offset, 'I')[0]
                self.write(actor + offset, 'I', (flags & ~bit) | (bit if value else 0))
            elif name == 'Zone':
                self.write(actor + 0xc8, 'I', self.actors[value])
            else:
                raise ValueError(name)

    def set_array(self, names):
        array = self.alloc(4 * len(names))
        for i, name in enumerate(names):
            self.write(array + i * 4, 'I', self.actors.get(name, 0))
        self.write(self.level + 0x2c, '3I', array, len(names), len(names))

    def state(self):
        return {name: bytes(self.cpu.mem_read(actor + 0x2e8, 12)).hex() for name, actor in self.actors.items()}

    def on_instruction(self, cpu, address, size, data):
        stack, this = cpu.reg_read(UC_X86_REG_ESP), cpu.reg_read(UC_X86_REG_ECX)
        if address == self.trace_stub:
            hit, source, end, start, flags = self.read(stack + 4, '5I')
            assert this == self.level and hit and flags == 6
            assert self.read(stack + 24, '4I') == (0, 0, 0, 0)
            query = self.sample.get('traces', [1])[self.trace_count]
            self.events.append({'op': 'trace', 'source': self.ids[source],
                                'end': list(self.read(end, '3f')), 'start': list(self.read(start, '3f')),
                                'result': query, 'state': self.state()})
            action = self.sample.get('callbacks', {}).get(str(self.trace_count), {})
            for name, fields in action.get('set', {}).items():
                self.set_fields(self.actors[name], fields)
            if 'actors' in action:
                self.set_array(action['actors'])
            self.trace_count += 1
            cpu.reg_write(UC_X86_REG_EAX, query)
            return
        if address == 0x1036b980:
            self.events.append({'op': 'light', 'actor': self.ids[this],
                                'point': list(self.read(stack + 4, '3f')), 'state': self.state()})
        super().on_instruction(cpu, address, size, data)

    def run(self, sample):
        self.sample, self.events, self.trace_count = sample, [], 0
        fields = {'info': {'TimeSeconds': sample.get('time', 100)}, 'zone': {}, 'subject': {},
                  **sample.get('objects', {})}
        self.actors = {name: self.alloc(0x700) for name in fields}
        self.ids = {address: name for name, address in self.actors.items()}
        for name, actor in self.actors.items():
            self.write(actor, 'I', self.vtable)
            self.write(actor + 0x24, 'I', 0x1057bf00 if name == 'info' else 0)
            self.write(actor + 0xac, 'I', self.level)
            self.write(actor + 0xc8, 'I', self.actors['zone'])
            self.set_fields(actor, fields[name])
        self.set_array(sample.get('actors', ['info', 'subject', *[n for n in fields if n not in ['info', 'subject', 'zone']]]))
        before = {name: bytes(self.cpu.mem_read(actor, 0x700)).hex() for name, actor in self.actors.items()}
        index = sample.get('native', 700)
        args = struct.pack('<3f', *sample.get('point', [0, 0, 0])) if index == 700 else struct.pack('<i', sample.get('velocity', 1))
        if sample.get('exec'):
            code = (b'\x23' + args) if index == 700 else (b'\x0b' if sample.get('nothing') else b'\x1d' + args)
            self.cpu.mem_write(self.code, code + b'\x16')
            self.write(self.frame + 8, '2I', self.actors['subject'], self.code)
            self.call(self.exec_addresses[index], self.actors['subject'], struct.pack('<2I', self.frame, self.output))
            extended, multiplied = None, None
            advance = self.read(self.frame + 12, 'I')[0] - self.code
            assert advance == len(code) + 1
        else:
            # Capture ST0 before conversion, plus the caller's retained-ST0
            # multiplication, matching AICanSee's FST/FMUL/FSTP boundary.
            bridge = b''.join(b'\x68' + args[i:i+4] for i in range(len(args)-4, -1, -4))
            body = 0x1036b980 if index == 700 else 0x1036bca0
            bridge += b'\xb8' + struct.pack('<I', body) + b'\xff\xd0'
            bridge += b'\xd9\x15' + struct.pack('<I', self.output)
            bridge += b'\xd9\xc0\xdb\x3d' + struct.pack('<I', self.output + 8)
            bridge += b'\xd8\x0d' + struct.pack('<I', self.factor)
            bridge += b'\xd9\x1d' + struct.pack('<I', self.output + 4) + b'\xc3'
            self.cpu.mem_write(self.bridge, bridge)
            self.cpu.ctl_remove_cache(self.bridge, self.bridge + 256)
            self.call(self.bridge, self.actors['subject'], b'')
            extended = bytes(self.cpu.mem_read(self.output + 8, 10)).hex()
            multiplied = bytes(self.cpu.mem_read(self.output + 4, 4)).hex()
            advance = None
        return {'name': sample['name'], 'addresses': self.actors, 'before': before,
                'after': {name: bytes(self.cpu.mem_read(actor, 0x700)).hex() for name, actor in self.actors.items()},
                'events': self.events, 'result': bytes(self.cpu.mem_read(self.output, 4)).hex(),
                'extended': extended, 'multiplied': multiplied, 'codeAdvance': advance}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    print(json.dumps({'constants': probe.constants, 'cases': [probe.run(c) for c in json.load(sys.stdin)]}))
