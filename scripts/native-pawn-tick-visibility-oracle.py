"""Execute original ShowSelf/CheckEnemyVisible and the complete LOS worker.

Only BSP traces, RNG, probe/event/validity services are controlled leaves.
Helper and LOS instructions are unchanged. Fixtures use zero rotation, whose
GMath sine/cosine table entries are exactly 0/1; no transcendental oracle is
needed. Unknown calls fail through the shared hash-checked Engine/Core runner.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

FLOATS = {'SightCounter': 0x320, 'LastSeenTime': 0x3c8, 'Stimulus': 0x3a0,
          'SightRadius': 0x3a4, 'PeripheralVision': 0x3a8, 'BaseEyeHeight': 0x3f4,
          'CollisionRadius': 0x1d4, 'CollisionHeight': 0x1d8, 'Skill': 0x458}
VECTORS = {'Location': 0x114, 'LastSeenPos': 0x3b0, 'LastSeeingPos': 0x3bc}
FLAGS = {'bIsPlayer': (0x318, 2), 'bLOSflag': (0x318, 0x80000), 'bHidden': (0x28, 2)}
REFS = {'Enemy': 0x3cc, 'nextPawn': 0x498}
NAMES = {0x154: 'SeePlayer', 0x155: 'EnemyNotVisible'}


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.stub_names, self.stub_next = {}, 0x700e0000
        self.level, self.info, self.model = self.alloc(0x1200), self.alloc(0x600), self.alloc(0x40)
        self.actor_vtable = self.alloc(0x100)
        self.write(self.actor_vtable + 0x10, 'I', self.stub('ProcessEvent', 12))
        self.write(self.info + 0x24, 'I', 0x1057bf00)
        array = self.alloc(4)
        self.write(array, 'I', self.info)
        self.write(self.level + 0x2c, '3I', array, 1, 1)
        self.write(self.level + 0x98, 'I', self.model)
        self.write(0x1058c160 + 0x28, 'I', 0x1058c660)
        self.write(0x10599a88, 'I', self.stub('FindFunctionChecked', 8))
        self.write(0x1059a02c, 'I', self.stub('IsProbing', 4))
        self.write(0x10599c9c, 'I', self.stub('IsValid'))
        self.write(0x10599a1c, 'I', self.stub('FailAssert'))
        self.write(0x105836ac, 'I', 0x154)
        self.write(0x105836a8, 'I', 0x155)
        self.write(self.read(0x10599dac, 'I')[0], 'I', 0)
        self.random_cell = self.alloc(4)
        self.random_stub = self.stub('Rand')
        self.cpu.mem_write(self.random_stub, b'\xd9\x05' + struct.pack('<I', self.random_cell) + b'\xc3')
        engine = native.Image(root / 'System' / 'Engine.dll')
        exports = engine.exports()
        assert exports['?ShowSelf@APawn@@QAEXXZ'] == 0x10301014
        assert exports['?CheckEnemyVisible@APawn@@QAEXXZ'] == 0x103014ce
        assert exports['?ENGINE_SeePlayer@@3VFName@@A'] == 0x105836ac
        assert exports['?ENGINE_EnemyNotVisible@@3VFName@@A'] == 0x105836a8
        assert engine.read(0x10429838 - engine.base, 'd')[0] == 0
        for dll, symbol, iat in engine.imports():
            if symbol == '?appFrand@@YAMXZ':
                self.write(iat, 'I', self.random_stub)
        # Required entries for the zero-rotation original FCoords/FRotator path.
        self.write(0x101b32a4, 'f', 0)
        self.write(0x101b32a4 + 4096 * 4, 'f', 1)

    def stub(self, name, pop=0):
        address = self.stub_next
        self.stub_next += 16
        self.stub_names[address] = name
        self.cpu.mem_write(address, b'\xc2' + struct.pack('<H', pop) if pop else b'\xc3')
        return address

    def set_fields(self, actor, values):
        for name, value in values.items():
            if name in FLOATS:
                self.write(actor + FLOATS[name], 'f', value)
            elif name in VECTORS:
                self.write(actor + VECTORS[name], '3f', *value)
            elif name in REFS:
                self.write(actor + REFS[name], 'I', self.actors.get(value, 0))
            elif name in FLAGS:
                offset, bit = FLAGS[name]
                flags = self.read(actor + offset, 'I')[0]
                self.write(actor + offset, 'I', (flags & ~bit) | (bit if value else 0))
            elif name == 'Visibility':
                self.write(actor + 0x398, 'B', value)
            elif name == 'SightCounterBits':
                self.write(actor + 0x320, 'I', value)
            else:
                raise ValueError(name)

    def state(self):
        return {name: {'SightCounter': bytes(self.cpu.mem_read(actor + 0x320, 4)).hex(),
                       'LastSeenTime': bytes(self.cpu.mem_read(actor + 0x3c8, 4)).hex(),
                       'Stimulus': bytes(self.cpu.mem_read(actor + 0x3a0, 4)).hex(),
                       'bLOSflag': bool(self.read(actor + 0x318, 'I')[0] & 0x80000)}
                for name, actor in self.actors.items()}

    def event(self, op, **values):
        self.events.append({'op': op, **values, 'state': self.state()})

    def return_leaf(self, pop):
        stack = self.cpu.reg_read(UC_X86_REG_ESP)
        self.cpu.reg_write(UC_X86_REG_EIP, self.read(stack, 'I')[0])
        self.cpu.reg_write(UC_X86_REG_ESP, stack + 4 + pop)

    def on_instruction(self, cpu, address, size, data):
        name = self.stub_names.get(address)
        stack, this = cpu.reg_read(UC_X86_REG_ESP), cpu.reg_read(UC_X86_REG_ECX)
        if name == 'FindFunctionChecked':
            index, global_lookup = self.read(stack + 4, '2I')
            assert global_lookup == 0 and index in NAMES
            self.event(name, actor=self.ids[this], name=NAMES[index])
            cpu.reg_write(UC_X86_REG_EAX, 0x30000000 + index)
            return
        if name == 'IsProbing':
            assert self.read(stack + 4, 'I')[0] == 0x154
            result = self.sample['actors'][self.ids[this]].get('probe', True)
            self.event(name, actor=self.ids[this], result=result)
            cpu.reg_write(UC_X86_REG_EAX, int(result))
            return
        if name == 'IsValid':
            result = self.sample['actors'][self.ids[this]].get('valid', True)
            self.event(name, actor=self.ids[this], result=result)
            cpu.reg_write(UC_X86_REG_EAX, int(result))
            return
        if name == 'FailAssert':
            line = self.read(stack + 12, 'I')[0]
            assert line == 0x6b4
            self.event(name, line=line)
            return
        if name == 'ProcessEvent':
            function, parameters, result = self.read(stack + 4, '3I')
            event = NAMES[function - 0x30000000]
            assert result == 0 and bool(parameters) == (event == 'SeePlayer')
            args = [self.ids[self.read(parameters, 'I')[0]]] if parameters else []
            self.event(event, actor=self.ids[this], args=args)
            key = self.ids[this] + '.' + event
            for action in self.sample.get('callbacks', {}).get(key, []):
                for target, fields in action.get('set', {}).items():
                    self.set_fields(self.actors[target], fields)
                if 'head' in action:
                    self.write(self.info + 0x54c, 'I', self.actors.get(action['head'], 0))
                if 'timeSeconds' in action:
                    self.write(self.level + 0xdc, 'd', action['timeSeconds'])
            return
        if address == 0x103beb50:
            other, fov, ignore = self.read(stack + 4, '3I')
            self.event('LOS', actor=self.ids[this], other=self.ids[other], fov=fov, ignore=ignore)
            # Observe the boundary, then execute the original complete worker.
        if address == 0x10301a37:
            assert this == self.model
            end, start = list(self.read(stack + 4, '3f')), list(self.read(stack + 16, '3f'))
            values = self.sample.get('fastLine', [1])
            assert self.trace_index < len(values), 'FastLineCheck queue exhausted'
            result = values[self.trace_index]
            self.trace_index += 1
            self.event('FastLineCheck', end=end, start=start, result=result)
            cpu.reg_write(UC_X86_REG_EAX, result)
            self.return_leaf(24)
            return
        if name == 'Rand':
            values = self.sample.get('rand', [])
            assert self.random_index < len(values), 'appFrand queue exhausted'
            value = values[self.random_index]
            self.random_index += 1
            self.write(self.random_cell, 'f', value)
            self.event('Rand', value=self.read(self.random_cell, 'f')[0])
            return
        super().on_instruction(cpu, address, size, data)

    def run(self, sample):
        self.sample = sample
        self.events, self.trace_index, self.random_index = [], 0, 0
        self.actors = {name: self.alloc(0x900) for name in sample['actors']}
        self.ids = {0: None, **{actor: name for name, actor in self.actors.items()}}
        for name, actor in self.actors.items():
            self.write(actor, 'I', self.actor_vtable)
            self.write(actor + 0x24, 'I', 0x1058c660)
            self.write(actor + 0xac, 'I', self.level)
            self.set_fields(actor, {'SightCounter': -0.1, 'LastSeenTime': -10, 'Stimulus': 0.125,
                                   'SightRadius': 2000, 'PeripheralVision': 0, 'BaseEyeHeight': 32,
                                   'CollisionRadius': 20, 'CollisionHeight': 40, 'Visibility': 128,
                                   **sample['actors'][name].get('fields', {})})
        chain = sample.get('pawnList', [])
        for i, name in enumerate(chain):
            self.write(self.actors[name] + 0x498, 'I', self.actors[chain[i + 1]] if i + 1 < len(chain) else 0)
        self.write(self.info + 0x54c, 'I', self.actors[chain[0]] if chain else 0)
        self.write(self.level + 0xdc, 'd', sample.get('timeSeconds', 12345.678912345))
        before = {name: bytes(self.cpu.mem_read(actor, 0x900)).hex() for name, actor in self.actors.items()}
        self.call({'ShowSelf': 0x103c0410, 'CheckEnemyVisible': 0x103c0280}[sample['body']],
                  self.actors[sample['this']], b'')
        return {'name': sample['name'], 'addresses': self.actors, 'before': before,
                'after': {name: bytes(self.cpu.mem_read(actor, 0x900)).hex() for name, actor in self.actors.items()},
                'events': self.events, 'traceCount': self.trace_index, 'randomCount': self.random_index,
                'head': self.ids[self.read(self.info + 0x54c, 'I')[0]]}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    print(json.dumps({'hashes': native.HASHES, 'cases': [probe.run(s) for s in json.load(sys.stdin)]}))
