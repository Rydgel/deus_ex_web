"""Execute original MultiLineCheck and bundled CRT qsort with controlled queries.

The original DLLs perform shortening, mover recovery, time rescaling, collection
limits, sorting and result allocation. Only world/actor query responses are
supplied. No host-language sort or collision algorithm supplies expected results.
"""
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)
CRT_HASH = 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210'


def encode_numbers(value):
    if isinstance(value, float) and not math.isfinite(value):
        return {'number': 'NaN' if math.isnan(value) else '+Infinity' if value > 0 else '-Infinity'}
    if isinstance(value, dict):
        return {key: encode_numbers(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [encode_numbers(item) for item in value]
    return value


class NativeMultiLine(collision.NativeCollision):
    def __init__(self, root):
        self.active = False
        super().__init__(root, {'MSVCRT.dll': CRT_HASH})
        self.level, self.info, self.hash = self.alloc(0x200), self.alloc(0x200), self.alloc(0x40)
        self.model_ptr, model_table, hash_table = self.alloc(0x100), self.alloc(0x100), self.alloc(0x40)
        self.world_thunk, self.hash_thunk = 0x700fc000, 0x700fc010
        self.cpu.mem_write(self.world_thunk, bytes.fromhex('c2 30 00'))
        self.cpu.mem_write(self.hash_thunk, bytes.fromhex('c2 2c 00'))
        self.write(model_table + 0x58, 'I', self.world_thunk)
        self.write(hash_table + 0x10, 'I', self.hash_thunk)
        self.write(self.model_ptr, 'I', model_table)
        self.write(self.hash, 'I', hash_table)
        self.write(self.level + 0x98, 'I', self.model_ptr)
        self.write(self.info + 0xac, 'I', self.level)
        self.memory = self.read(0x10599bd8, 'I')[0]
        self.arena = self.alloc(0x100000)
        self.write(self.memory, '4I', self.arena, self.arena + 0x100000, 0, 0)
        self.scratch = self.free

    def write_hit(self, address, hit, next_hit=0):
        actor = self.actor_ptrs.get(hit.get('actor'), 0)
        self.write(address, 'II6fIfi', next_hit, actor, *hit['location'], *hit['normal'],
                   hit['primitive'], hit['time'], hit['item'])

    def read_hit(self, address):
        actor = self.read(address + 4, 'I')[0]
        return {'actor': self.actor_ids.get(actor), 'location': self.read(address + 8, '3f'),
                'normal': self.read(address + 20, '3f'), 'primitive': self.read(address + 32, 'I')[0],
                'time': self.read(address + 36, 'f')[0], 'item': self.read(address + 40, 'i')[0]}

    def on_instruction(self, cpu, address, size, data):
        if self.active:
            if address in [self.world_thunk, self.hash_thunk, 0x7802543d]:
                stack = cpu.reg_read(collision.UC_X86_REG_ESP)
            if address == self.world_thunk:
                result, owner = self.read(stack + 4, 'II')
                if owner:
                    raise RuntimeError('Unexpected owner in world query')
                self.events.append({'world': {'end': self.read(stack + 12, '3f'),
                    'start': self.read(stack + 24, '3f'), 'extent': self.read(stack + 36, '3f'),
                    'extra': self.read(stack + 48, 'I')[0]}})
                if self.case['worldHit'] is not None:
                    self.write_hit(result, self.case['worldHit'])
                cpu.reg_write(collision.UC_X86_REG_EAX, int(self.case['worldHit'] is None))
                return
            if address == self.hash_thunk:
                if self.read(stack + 4, 'I')[0] != self.memory:
                    raise RuntimeError('Unexpected GMem in actor query')
                self.events.append({'actors': {'end': self.read(stack + 8, '3f'),
                    'start': self.read(stack + 20, '3f'), 'extent': self.read(stack + 32, '3f'),
                    'extra': self.read(stack + 44, 'I')[0]}})
                cpu.reg_write(collision.UC_X86_REG_EAX, self.hit_ptrs[0] if self.hit_ptrs else 0)
                return
            if address == 0x7802543d:
                self.sort_pointer, self.sort_count, stride, comparator = self.read(stack + 4, '4I')
                if stride != 44 or comparator != 0x10303684 or self.sort_count > 64:
                    raise RuntimeError('Unexpected original sort contract')
                self.sort_input = [self.read_hit(self.sort_pointer + i * 44) for i in range(self.sort_count)]
            if address == 0x1039b724:
                self.sort_output = [self.read_hit(self.sort_pointer + i * 44) for i in range(self.sort_count)]
        return super().on_instruction(cpu, address, size, data)

    def multi(self, case):
        self.case = case
        self.free = self.scratch
        self.cpu.mem_write(self.scratch, bytes(0x20000))
        self.write(self.memory, 'I', self.arena)
        self.write(self.level + 0xf8, 'I', self.hash if case['hashPresent'] else 0)
        self.actor_ptrs = {actor['id']: self.alloc(0x200) for actor in case['actors']}
        self.actor_ids = {pointer: name for name, pointer in self.actor_ptrs.items()} | {self.info: '$world'}
        for actor in case['actors']:
            cls = 0x1058bb58 if actor['kind'] == 'Mover' else 0x1057cdf0
            for _ in range(actor.get('depth', 0)):
                derived = self.alloc(0x40)
                self.write(derived + 0x28, 'I', cls)
                cls = derived
            self.write(self.actor_ptrs[actor['id']] + 0x24, 'I', cls)
        self.hit_ptrs = [self.alloc(44) for _ in case['hits']]
        for i, hit in enumerate(case['hits']):
            self.write_hit(self.hit_ptrs[i], hit, self.hit_ptrs[i + 1] if i + 1 < len(self.hit_ptrs) else 0)
        if self.free > self.scratch + 0x20000:
            raise RuntimeError('Controlled input exceeds isolated scratch region')
        self.events, self.sort_input, self.sort_output = [], [], []
        self.active = True
        pointer = self.call(0x1039b220, self.level, struct.pack('<I9f3I', self.memory,
                            *case['end'], *case['start'], *case['extent'], case['checkActors'],
                            self.info if case['worldEnabled'] else 0, case['extra']))
        self.active = False
        results, seen = [], set()
        while pointer:
            if pointer in seen or len(results) >= 64:
                raise RuntimeError('Invalid original result list')
            seen.add(pointer)
            results.append(self.read_hit(pointer))
            next_hit = self.read(pointer, 'I')[0]
            if next_hit and next_hit != pointer + 44:
                raise RuntimeError('Original result list is not relinked contiguously')
            pointer = next_hit
        for i, address in enumerate(self.hit_ptrs):
            if self.read(address, 'I')[0] != (self.hit_ptrs[i + 1] if i + 1 < len(self.hit_ptrs) else 0):
                raise RuntimeError('Original actor list links changed')
        return {'hits': results, 'actorHitsAfter': [self.read_hit(p) for p in self.hit_ptrs],
                'events': self.events, 'sortInput': self.sort_input, 'sortOutput': self.sort_output}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-multiline-oracle.py GAME_ROOT CASES_JSON')
    native = NativeMultiLine(Path(sys.argv[1]))
    inputs = Path(sys.argv[2]).read_bytes()
    cases = json.loads(inputs)
    print(json.dumps(encode_numbers({'hashes': collision.HASHES | {'MSVCRT.dll': CRT_HASH},
                      'casesSha256': hashlib.sha256(inputs).hexdigest(),
                      'results': [native.multi(case) for case in cases]})))
