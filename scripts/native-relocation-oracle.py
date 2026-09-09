"""Original FarMoveActor/SetCollisionSize with explicit scene callback fixtures."""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('collision', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class Relocation(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.level, self.actor, self.world = self.alloc(0x1200), self.alloc(0x600), self.alloc(0x600)
        self.level_table, self.hash, self.hash_table = self.alloc(0x100), self.alloc(0x20), self.alloc(0x40)
        self.write(self.level, 'I', self.level_table)
        self.write(self.hash, 'I', self.hash_table)
        self.write(self.actor + 0xac, 'I', self.level)
        self.write(self.world + 0x24, 'I', 0x1057bf00)
        self.callbacks = {}
        for i, (table, offset, name, pop) in enumerate([
            (self.level_table, 0xb0, 'findSpot', 24), (self.level_table, 0xb8, 'encroachment', 32),
            (self.level_table, 0xac, 'zone', 12), (self.hash_table, 8, 'add', 4), (self.hash_table, 12, 'remove', 4),
        ]):
            address = 0x700fc000 + i * 16
            self.write(table + offset, 'I', address)
            self.callbacks[address] = (name, pop)
        self.callbacks[0x10301285] = ('setBase', 8)
        self.active = False

    def state(self):
        return {'position': self.read(self.actor + 0x114, '3f'), 'oldLocation': self.read(self.actor + 0x12c, '3f'),
                'radius': self.read(self.actor + 0x1d4, 'f')[0], 'height': self.read(self.actor + 0x1d8, 'f')[0],
                'motionFlags': self.read(self.actor + 0x1ec, 'I')[0], 'registered': self.registered}

    def on_instruction(self, cpu, address, size, data):
        if not self.active or address not in self.callbacks:
            return super().on_instruction(cpu, address, size, data)
        name, pop = self.callbacks[address]
        sp = cpu.reg_read(native.UC_X86_REG_ESP)
        event = {'event': name, 'before': self.state()}
        result = 1
        if name == 'remove':
            self.registered = False
        elif name == 'add':
            self.registered = True
        elif name == 'findSpot':
            position, actors, first = self.read(sp + 16, '3I')
            event['extent'] = self.read(sp + 4, '3f')
            event['position'] = self.read(position, '3f')
            event['options'] = [actors, first]
            self.write(position, '3f', *self.case.get('fitted', event['position']))
            result = self.case.get('fitSuccess', True)
        elif name == 'encroachment':
            event['position'] = self.read(sp + 8, '3f')
            event['rotation'] = self.read(sp + 20, '3i')
            event['notify'] = self.read(sp + 32, 'I')[0]
            result = self.case.get('encroached', False)
        elif name == 'setBase':
            actor = cpu.reg_read(native.UC_X86_REG_ECX)
            target, notify = self.read(sp + 4, '2I')
            event.update({'actor': self.child_ids[actor], 'base': target, 'notify': notify})
            self.write(actor + 0xc4, 'I', target)
        elif name == 'zone':
            event['options'] = self.read(sp + 8, '2I')
        self.events.append(event)
        cpu.reg_write(native.UC_X86_REG_EAX, int(result))
        cpu.reg_write(native.UC_X86_REG_EIP, self.read(sp, 'I')[0])
        cpu.reg_write(native.UC_X86_REG_ESP, sp + 4 + pop)

    def capture(self, case):
        self.case, self.events, self.child_ids = case, [], {}
        flags = case.get('collisionFlags', 3)
        self.registered = bool(case.get('hashPresent', True) and flags & 1)
        self.write(self.level + 0xf8, 'I', self.hash if case.get('hashPresent', True) else 0)
        self.write(self.actor + 0x28, 'I', case.get('actorFlags', 0x80000))
        self.write(self.actor + 0x1dc, 'I', flags)
        self.write(self.actor + 0x1ec, 'I', case.get('motionFlags', 0))
        self.write(self.actor + 0x114, '3f', *case.get('position', [1,2,3]))
        self.write(self.actor + 0x12c, '3f', *case.get('oldLocation', [4,5,6]))
        self.write(self.actor + 0x120, '3i', *case.get('rotation', [0,16384,0]))
        self.write(self.actor + 0x1d4, '2f', *case.get('extent', [20,43]))
        self.write(self.actor + 0xd8, 'B', case.get('standingCount', 0))
        self.write(self.world + 0x518, 'B', case.get('netMode', 0))
        self.write(self.read(0x10599c94, 'I')[0], 'I', case.get('editor', False))
        actors = [self.world, self.actor]
        for i, based in enumerate(case.get('children', [])):
            child = self.alloc(0x200)
            self.child_ids[child] = i
            self.write(child + 0xc4, 'I', self.actor if based else self.world)
            actors.append(child)
        table = self.alloc(4 * len(actors))
        self.write(table, str(len(actors)) + 'I', *actors)
        self.write(self.level + 0x2c, '3I', table, len(actors), len(actors))
        self.active = True
        if 'newSize' in case:
            self.call(0x10369320, self.actor, struct.pack('<2f', *case['newSize']))
            success = None
        else:
            success = bool(self.call(0x10398ba0, self.level, struct.pack('<I3fII', self.actor,
                *case.get('destination', [100,200,300]), case.get('test', 0), case.get('noCheck', 0))))
        self.active = False
        return {'success': success, **self.state(), 'events': self.events,
                'childrenBased': [self.read(actor + 0xc4, 'I')[0] == self.actor for actor in self.child_ids]}


if __name__ == '__main__':
    oracle = Relocation(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes': native.HASHES, 'results': [oracle.capture(case) for case in cases]}))
