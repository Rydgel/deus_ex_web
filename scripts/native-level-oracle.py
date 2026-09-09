"""Original level registration, rays and placement with real world/actor geometry.

Uses the original hash, bounds, brush transforms, primitive queries, level join,
CRT sort and filter. The hash factory returns an already originally constructed
hash; SetActorCollision itself registers actors in the original level-array order.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_hash', Path(__file__).with_name('native-hash-oracle.py'))
hash_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hash_module)
base = hash_module.base


class NativeLevel(hash_module.NativeHash):
    def __init__(self, root, scene, seed=1):
        self.events = None
        self.pending = []
        self.registration = []
        super().__init__(root, seed)
        self.call(0x10102978, 0x101b3218, b'')
        self.level, self.level_table, self.info = self.alloc(0x200), self.alloc(0x200), self.alloc(0x400)
        self.location = self.alloc(12)
        self.write(self.level, 'I', self.level_table)
        for offset, address in [(0xb4, 0x10398360), (0xbc, 0x1039aac0), (0xc0, 0x1039aed0),
                                (0xc4, 0x1039acc0), (0xc8, 0x1039b220)]:
            self.write(self.level_table + offset, 'I', address)
        self.write(self.info + 0x24, 'I', 0x1057bf00)
        self.write(self.info + 0xac, 'I', self.level)
        self.write(0x1057bf00 + 0x28, 'I', 0x1057b018)
        for cls in [0x1057b018, 0x1058bb58, 0x1058c660]:
            self.write(cls + 0x28, 'I', 0x1057cdf0)
        self.model_table, self.primitive_table, self.brush_table = self.alloc(0x100), self.alloc(0x100), self.alloc(0x100)
        for table, entries in [(self.model_table, [(0x54, 0x103f1570), (0x58, 0x103f3c20), (0x64, 0x103f0e70)]),
                               (self.primitive_table, [(0x54, 0x103d87e0), (0x58, 0x103d8af0), (0x64, 0x103d8460)]),
                               (self.brush_table, [(0x88, 0x1030f310)])]:
            for offset, address in entries:
                self.write(table + offset, 'I', address)
        world = self.real_model(scene['model'])
        self.write(self.level + 0x98, 'I', world)
        self.memory = self.read(0x10599bd8, 'I')[0]
        self.write(self.memory, '4I', *self.read(self.memstack, '4I'))
        self.memstack = self.memory
        self.actor_ptrs = {}
        pointers = [self.info]
        for fixture in scene['actors']:
            actor = self.alloc(0x400)
            self.actors[actor] = fixture
            self.actor_ptrs[fixture['id']] = actor
            pointers.append(actor)
            self.write(actor + 0xac, 'I', self.level)
            self.write(actor + 0x114, '3f', *fixture['values']['Location'])
            self.write(actor + 0x1d4, '2f', fixture['values'].get('CollisionRadius', 0), fixture['values'].get('CollisionHeight', 0))
            self.write(actor + 0x1dc, 'I', fixture['collisionBits'])
            kind = fixture['kind']
            self.write(actor + 0x24, 'I', {'Mover': 0x1058bb58, 'Pawn': 0x1058c660, 'ZoneInfo': 0x1057b018}.get(kind, 0x1057cdf0))
            if fixture.get('model'):
                self.write(actor, 'I', self.brush_table)
                self.write(actor + 0x178, 'I', self.real_model(fixture['model']))
                self.set_brush_values(actor, fixture['values'])
            else:
                primitive = self.alloc(0x60)
                self.write(primitive, 'I', self.primitive_table)
                self.write(actor + 0x174, 'I', primitive)
        for fixture in scene['actors']:
            self.write(self.actor_ptrs[fixture['id']] + 0x3c, 'I', self.actor_ptrs.get(fixture.get('owner'), 0))
        table = self.alloc(len(pointers) * 4)
        self.write(table, str(len(pointers)) + 'I', *pointers)
        self.write(self.level + 0x2c, 'III', table, len(pointers), len(pointers))
        self.call(0x1039d390, self.level, struct.pack('<I', 1))
        self.actor_ids = {pointer: name for name, pointer in self.actor_ptrs.items()} | {self.info: '$world'}

    def real_model(self, model):
        result = self.model(model)
        self.write(result, 'I', self.model_table)
        bounds = model['bounds']
        self.write(result + 0x28, '6fB', *bounds['min'], *bounds['max'], bounds.get('valid', True))
        return result

    def set_brush_values(self, actor, values):
        self.write(actor + 0x114, '3f', *values['Location'])
        self.write(actor + 0x120, '3i', *values.get('Rotation', [0, 0, 0]))
        self.write(actor + 0x180, '3f', *values.get('PrePivot', [0, 0, 0]))
        for offset, key in [(0x32c, 'MainScale'), (0x340, 'PostScale')]:
            scale = values.get(key, {})
            self.write(actor + offset, '4fB', *scale.get('scale', [1, 1, 1]), scale.get('shearRate', 0), scale.get('shearAxis', 0))

    def result(self, clear, hit):
        output = super().result(clear, hit)
        output['actor'] = self.actor_ids.get(self.read(hit + 4, 'I')[0])
        output['item'] = self.read(hit + 40, 'i')[0]
        return output

    def on_instruction(self, cpu, address, size, data):
        if address == 0x10301b59 and hasattr(self, 'level'):
            sp = cpu.reg_read(hash_module.UC_X86_REG_ESP)
            cpu.reg_write(hash_module.UC_X86_REG_EAX, self.hash)
            cpu.reg_write(hash_module.UC_X86_REG_EIP, self.read(sp, 'I')[0])
            cpu.reg_write(hash_module.UC_X86_REG_ESP, sp + 4)
            return
        if address == 0x103580b0 and hasattr(self, 'level'):
            sp = cpu.reg_read(hash_module.UC_X86_REG_ESP)
            self.registration.append(self.actors[self.read(sp + 4, 'I')[0]]['id'])
        if self.events is not None:
            sp = cpu.reg_read(hash_module.UC_X86_REG_ESP)
            if self.pending and address == self.pending[-1]['return']:
                pending = self.pending.pop()
                self.events[pending['index']]['result'] = self.result(cpu.reg_read(hash_module.UC_X86_REG_EAX), pending['hit'])
            if address in [0x1039aed0, 0x1039aac0]:
                hit = self.read(sp + 4, 'I')[0]
                if address == 0x1039aed0:
                    source, end, start, flags = self.read(sp + 8, '4I')
                    event = {'line': {'start': self.read(start, '3f'), 'end': self.read(end, '3f'),
                        'extent': self.read(sp + 24, '3f'), 'flags': flags, 'extra': self.read(sp + 36, 'I')[0],
                        'source': self.actor_ids.get(source)}}
                else:
                    flags, actor, extra = self.read(sp + 32, '3I')
                    event = {'point': {'position': self.read(sp + 8, '3f'), 'extent': self.read(sp + 20, '3f'),
                        'flags': flags, 'extra': extra}}
                self.pending.append({'return': self.read(sp, 'I')[0], 'hit': hit, 'index': len(self.events)})
                self.events.append(event)
        return super().on_instruction(cpu, address, size, data)

    def trace_case(self, case):
        hit, start, end = self.alloc(44), self.alloc(12), self.alloc(12)
        self.write(hit + 36, 'f', 1)
        self.write(start, '3f', *case['start'])
        self.write(end, '3f', *case['end'])
        clear = self.call(0x1039aed0, self.level, struct.pack('<5I3fI', hit,
            self.actor_ptrs.get(case.get('source'), 0), end, start, case['flags'], *case['extent'], case.get('extra', 0)))
        return self.result(clear, hit)

    def fit(self, case):
        self.write(self.location, '3f', *case['position'])
        self.events = []
        success = self.call(0x10398480, self.level, struct.pack('<3fI2I', *case['extent'], self.location, *case['options']))
        result = {'success': bool(success), 'position': self.read(self.location, '3f'), 'events': self.events}
        self.events = None
        return result


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit('Usage: native-level-oracle.py GAME_ROOT SCENE_JSON CASES_JSON')
    scene_bytes, case_bytes = Path(sys.argv[2]).read_bytes(), Path(sys.argv[3]).read_bytes()
    native = NativeLevel(Path(sys.argv[1]), json.loads(scene_bytes))
    cases = json.loads(case_bytes)
    print(json.dumps({'hashes': base.HASHES | {'MSVCRT.dll': hash_module.CRT_HASH},
        'sceneSha256': hashlib.sha256(scene_bytes).hexdigest(), 'casesSha256': hashlib.sha256(case_bytes).hexdigest(),
        'registration': native.registration, 'rays': [native.trace_case(case) for case in cases['rays']],
        'fitting': [native.fit(case) for case in cases['fitting']]}))
