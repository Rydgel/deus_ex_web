"""Execute original SingleLineCheck against controlled MultiLineCheck lists.

All class/owner/filter decisions and result copies run in the original DLL.
Python supplies input actor metadata and an ordered linked list, so these cases
do not establish the hash, primitive query algorithms or native sorting.
"""
import importlib.util
import hashlib
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)

CLASSES = {'Actor': 0x1057cdf0, 'LevelInfo': 0x1057bf00, 'Pawn': 0x1058c660,
           'Mover': 0x1058bb58, 'ZoneInfo': 0x1057b018}


class NativeLineFilter(collision.NativeCollision):
    def __init__(self, root):
        self.active = False
        super().__init__(root)
        self.level, self.level_vtable, self.info = self.alloc(0x200), self.alloc(0x200), self.alloc(0x200)
        self.actor_table = self.alloc(4)
        self.write(self.level, 'I', self.level_vtable)
        self.write(self.level + 0x2c, 'III', self.actor_table, 1, 1)
        self.write(self.actor_table, 'I', self.info)
        self.write(self.info + 0x24, 'I', CLASSES['LevelInfo'])
        # Controlled class metadata, with the original exported identities.
        # LevelInfo's ZoneInfo ancestry tests the native priority of these rules.
        for name, address in CLASSES.items():
            parent = 0 if name == 'Actor' else CLASSES['ZoneInfo' if name == 'LevelInfo' else 'Actor']
            self.write(address + 0x28, 'I', parent)
        self.multi_thunk = 0x700fd000
        self.cpu.mem_write(self.multi_thunk, bytes.fromhex('c2 34 00'))
        self.write(self.level_vtable + 0xc8, 'I', self.multi_thunk)
        self.memory = self.read(0x10599bd8, 'I')[0]
        arena = self.alloc(0x1000)
        self.write(self.memory, '4I', arena, arena + 0x1000, 0, 0)
        self.scratch = self.free

    def on_instruction(self, cpu, address, size, data):
        if self.active and address == self.multi_thunk:
            stack = cpu.reg_read(collision.UC_X86_REG_ESP)
            memory = self.read(stack + 4, 'I')[0]
            if memory != self.memory:
                raise RuntimeError('Unexpected GMem argument')
            check_actors, info, extra = self.read(stack + 44, '3I')
            if info not in [0, self.info]:
                raise RuntimeError('Unexpected world actor')
            self.events.append({'end': self.read(stack + 8, '3f'), 'start': self.read(stack + 20, '3f'),
                                'extent': self.read(stack + 32, '3f'), 'checkActors': check_actors,
                                'world': bool(info), 'extra': extra})
            cpu.reg_write(collision.UC_X86_REG_EAX, self.hit_ptrs[0] if self.hit_ptrs else 0)
            return
        return super().on_instruction(cpu, address, size, data)

    def check(self, case):
        # Reuse an isolated, zeroed scratch region; class identities are global.
        self.free = self.scratch
        self.cpu.mem_write(self.scratch, bytes(0x20000))
        actors = {actor['id']: self.alloc(0x200) for actor in case['actors']}
        actors['sentinel'] = self.alloc(0x200)
        for actor in case['actors']:
            address = actors[actor['id']]
            cls = CLASSES[actor['kind']]
            for _ in range(actor.get('depth', 0)):
                derived = self.alloc(0x40)
                self.write(derived + 0x28, 'I', cls)
                cls = derived
            self.write(address + 0x24, 'I', cls)
            self.write(address + 0x3c, 'I', actors.get(actor.get('owner'), 0))
            self.write(address + 0x1dc, 'I', actor.get('collisionBits', 0))
        self.hit_ptrs = [self.alloc(44) for _ in case['hits']]
        for index, hit in enumerate(case['hits']):
            next_hit = self.hit_ptrs[index + 1] if index + 1 < len(self.hit_ptrs) else 0
            self.write(self.hit_ptrs[index], 'II6fIfi', next_hit, actors[hit['actor']],
                       *hit['location'], *hit['normal'], hit['primitive'], hit['time'], hit['item'])
        result, start, end = self.alloc(44), self.alloc(12), self.alloc(12)
        initial = case['initial']
        self.write(result, 'II6fIfi', 0xdeadbeef, actors['sentinel'], *initial['location'],
                   *initial['normal'], initial['primitive'], initial['time'], initial['item'])
        self.write(start, '3f', *case['start'])
        self.write(end, '3f', *case['end'])
        self.events, self.active = [], True
        outside = self.call(0x1039aed0, self.level, struct.pack('<5I3fI', result,
                            actors.get(case['source'], 0), end, start, case['flags'],
                            *case['extent'], case['extra']))
        self.active = False
        next_hit, actor = self.read(result, 'II')
        next_index = self.hit_ptrs.index(next_hit) if next_hit in self.hit_ptrs else 'sentinel' if next_hit else None
        actor_ids = {address: name for name, address in actors.items()}
        output = {'next': next_index, 'actor': actor_ids.get(actor),
                  'location': self.read(result + 8, '3f'), 'normal': self.read(result + 20, '3f'),
                  'primitive': self.read(result + 32, 'I')[0], 'time': self.read(result + 36, 'f')[0],
                  'item': self.read(result + 40, 'i')[0]}
        return {'outside': outside, 'hit': output, 'events': self.events}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-line-filter-oracle.py GAME_ROOT CASES_JSON')
    native = NativeLineFilter(Path(sys.argv[1]))
    inputs = Path(sys.argv[2]).read_bytes()
    cases = json.loads(inputs)
    print(json.dumps({'hashes': collision.HASHES, 'casesSha256': hashlib.sha256(inputs).hexdigest(),
                      'results': [native.check(case) for case in cases]}))
