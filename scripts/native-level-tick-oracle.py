"""Run complete original standalone ULevel.Tick with explicit callback leaves.

The scheduler, InitStats, UpdateTime, IsA and all loops/branches remain original
instructions. Actor.Tick, input/events, calendar and final cleanup are controlled
boundaries, not claims about those subsystems. No original assets are committed.
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


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.stubs = {}
        self.stub_next = 0x700e0000
        engine = native.Image(root / 'System' / 'Engine.dll')
        self.exports = engine.exports()
        assert self.exports['?Tick@ULevel@@UAEXW4ELevelTick@@M@Z'] == 0x10301104
        self.level = self.alloc(0x1200)
        self.info = self.alloc(0x600)
        self.engine = self.alloc(0x80)
        self.client = self.alloc(0x50)
        self.viewport = self.alloc(0x80)
        self.viewport_array = self.alloc(4)
        self.manager = self.alloc(0x40)
        self.level_vtable = self.alloc(0x100)
        self.actor_vtable = self.alloc(0x100)
        self.viewport_vtable = self.alloc(0x80)
        self.class_vtable = self.alloc(0x80)
        self.derived_class = self.alloc(0x100)
        self.write(self.level, 'I', self.level_vtable)
        self.write(self.level_vtable + 0xcc, 'I', 0x10302586)  # Original InitStats.
        self.write(self.level_vtable + 0xe0, 'I', 0x10301b18)  # Original UpdateTime.
        self.write(self.level_vtable + 0x98, 'I', self.stub('CleanupDestroyed', 4))
        self.write(self.actor_vtable + 0x64, 'I', self.stub('ActorTick', 8))
        self.write(self.actor_vtable + 0x10, 'I', self.stub('PlayerInput', 12))
        self.write(self.viewport_vtable + 0x54, 'I', self.stub('ReadInput', 4))
        self.write(self.viewport, 'I', self.viewport_vtable)
        self.write(self.viewport_array, 'I', self.viewport)
        self.write(self.client + 0x2c, '3I', self.viewport_array, 1, 1)
        self.write(self.engine + 0x44, 'I', self.client)
        self.write(self.level + 0x40, 'I', self.engine)
        self.write(self.info + 0x24, 'I', 0x1057bf00)
        self.write(0x1059a05c, 'I', self.stub('SystemTime'))
        self.write(0x10599a88, 'I', self.stub('FindFunctionChecked', 8))
        for address, (dll, symbol) in list(self.thunks.items()):
            if (dll, symbol) == ('msvcrt.dll', '_wcsicmp'):
                self.stubs[address] = 'WideCompare'
                self.cpu.mem_write(address, b'\xc3')
                del self.thunks[address]
        self.write(0x1058368c, 'I', 0x156)
        # appSqrt's explicit double ABI leaf; x87 result remains extended.
        square_root = self.stub('Sqrt')
        self.cpu.mem_write(square_root, bytes.fromhex('dd442404d9fac3'))
        self.write(0x10599ca4, 'I', square_root)
        self.write(self.read(0x10599dac, 'I')[0], 'I', 0)  # Deterministic profiling mode.
        self.write(self.read(0x10599da8, 'I')[0], 'd', 0.000000001)
        # Explicit metadata service: GetInheritanceSuper returns the class base.
        super_address = self.stub('GetInheritanceSuper')
        self.cpu.mem_write(super_address, bytes.fromhex('8b4128c3'))
        self.write(self.class_vtable + 0x68, 'I', super_address)
        for cls, base in [(self.derived_class, 0x1058c160), (0x1058c160, 0)]:
            self.write(cls, 'I', self.class_vtable)
            self.write(cls + 0x28, 'I', base)
        float_class = self.read(0x1059a018, 'I')[0]
        core = native.Image(root / 'System' / 'Core.dll').exports()
        int_class = core['?PrivateStaticClass@UIntProperty@@0VUClass@@A']
        self.properties = []
        for cls, specs in [(self.derived_class, [(0x680, 4, True), (0x684, 4, True),
                                               (0x68c, 4, False), (0x690, 0, True)]),
                           (0x1058c160, [(0x694, 4, True)])]:
            head = 0
            for offset, flags, floating in reversed(specs):
                prop = self.alloc(0x60)
                self.write(prop + 0x24, 'I', float_class if floating else int_class)
                self.write(prop + 0x2c, 'I', head)
                self.write(prop + 0x34, 'I', 2 if offset == 0x684 else 1)
                self.write(prop + 0x3c, 'I', flags)
                self.write(prop + 0x48, 'I', offset)
                head = prop
            self.write(cls + 0x38, 'I', head)

    def stub(self, name, pop=0):
        address = self.stub_next
        self.stub_next += 16
        self.stubs[address] = name
        self.cpu.mem_write(address, b'\xc2' + struct.pack('<H', pop) if pop else b'\xc3')
        return address

    def string(self, text):
        data = (text + '\0').encode('utf-16le')
        address = self.alloc(len(data))
        self.cpu.mem_write(address, data)
        return address

    def slots(self, names):
        address = self.alloc(max(4, len(names) * 4))
        for i, name in enumerate(names):
            self.write(address + i * 4, 'I', self.info if name == 'LevelInfo' else self.actors.get(name, 0))
        self.write(self.level + 0x2c, '3I', address, len(names), len(names))

    def slot_names(self):
        address, count = self.read(self.level + 0x2c, '2I')
        return [self.ids.get(self.read(address + i * 4, 'I')[0]) for i in range(count)]

    def fields(self, actor, values):
        for name, value in values.items():
            if name == 'Location':
                self.write(actor + 0x114, '3f', *value)
            elif name == 'bTicked':
                flags = self.read(actor + 0x28, 'I')[0]
                self.write(actor + 0x28, 'I', (flags & ~0x200) | (0x200 if value else 0))
            elif name == 'DistanceFromPlayer':
                self.write(actor + 0x38, 'f', value)
            elif name == 'inputs':
                self.write(actor + 0x680, '6f', *value)
            else:
                raise ValueError(name)

    def snapshot(self):
        return {'time': bytes(self.cpu.mem_read(self.level + 0xdc, 8)).hex(),
                'infoTime': bytes(self.cpu.mem_read(self.info + 0x478, 4)).hex(),
                'tickTag': self.read(self.level + 0x10c, 'I')[0],
                'inTick': self.read(self.level + 0x108, 'I')[0],
                'distances': {name: self.read(actor + 0x38, 'f')[0] for name, actor in self.actors.items()},
                'slots': self.slot_names()}

    def actions(self, actions):
        for action in actions:
            if 'array' in action:
                self.slots(action['array'])
            if 'append' in action:
                self.slots(self.slot_names() + action['append'])
            if 'slot' in action:
                index, name = action['slot']
                names = self.slot_names()
                names[index] = name
                self.slots(names)
            for name in action.get('defer', []):
                node = self.alloc(8)
                self.write(node, '2I', self.actors[name], self.read(self.level + 0x104, 'I')[0])
                self.nodes[name] = node
                self.write(self.level + 0x104, 'I', node)
            if 'cutNext' in action:
                self.write(self.nodes[action['cutNext']] + 4, 'I', 0)
            for name, values in action.get('set', {}).items():
                self.fields(self.actors[name], values)
            if 'pauser' in action:
                self.pauser(action['pauser'], action.get('allocatedEmpty', False))

    def pauser(self, value, allocated=False):
        count = len(value) + 1 if value or allocated else 0
        self.write(self.info + 0x4e0, '3I', self.string(value) if count else 0, count, count)

    def on_instruction(self, cpu, address, size, data):
        name = self.stubs.get(address)
        stack = cpu.reg_read(UC_X86_REG_ESP)
        this = cpu.reg_read(UC_X86_REG_ECX)
        if address in [0x103a06b0, 0x103a5b56]:
            self.events.append({'op': 'BeginTick' if address == 0x103a06b0 else 'EndTick', **self.snapshot()})
        if name == 'WideCompare':
            values = []
            for pointer in self.read(stack + 4, '2I'):
                value = ''
                while self.read(pointer, 'H')[0]:
                    value += chr(self.read(pointer, 'H')[0])
                    pointer += 2
                values.append(value.casefold())
            cpu.reg_write(UC_X86_REG_EAX, ((values[0] > values[1]) - (values[0] < values[1])) & 0xffffffff)
            return
        if name == 'SystemTime':
            pointers = self.read(stack + 4, '8I')
            assert list(pointers) == [self.info + x for x in [0x47c, 0x480, 0x488, 0x484, 0x48c, 0x490, 0x494, 0x498]]
            for pointer, value in zip(pointers, [2026, 9, 19, 6, 12, 34, 56, 789]):
                self.write(pointer, 'i', value)
            self.events.append({'op': name, **self.snapshot()})
            return
        if name == 'ActorTick':
            actor = self.ids[this]
            seconds, tick_type = self.read(stack + 4, 'fi')
            self.events.append({'op': name, 'actor': actor, 'seconds': seconds, 'type': tick_type, **self.snapshot()})
            step_index = self.calls.get(actor, 0)
            steps = self.sample['actors'][actor].get('steps', [])
            step = steps[step_index] if step_index < len(steps) else {}
            self.calls[actor] = step_index + 1
            if step.get('mark', True):
                self.fields(this, {'bTicked': bool(self.read(self.level + 0x10c, 'I')[0])})
            self.actions(step.get('actions', []))
            cpu.reg_write(UC_X86_REG_EAX, step.get('result', 1) & 0xffffffff)
            return
        if name == 'ReadInput':
            self.events.append({'op': name, 'seconds': self.read(stack + 4, 'f')[0], **self.snapshot()})
            return
        if name == 'FindFunctionChecked':
            assert self.read(stack + 4, '2I') == (0x156, 0)
            cpu.reg_write(UC_X86_REG_EAX, 0x12340000)
            return
        if name == 'PlayerInput':
            function, params, result = self.read(stack + 4, '3I')
            assert function == 0x12340000 and result == 0
            actor = self.ids[this]
            self.events.append({'op': name, 'actor': actor, 'seconds': self.read(params, 'f')[0], **self.snapshot()})
            self.actions(self.sample['actors'][actor].get('inputActions', []))
            return
        if address == 0x103828f0:  # Explicit UEventManager.Tick service leaf.
            assert this == self.manager
            self.events.append({'op': 'EventManager', 'seconds': self.read(stack + 4, 'f')[0], **self.snapshot()})
            self.actions(self.sample.get('eventActions', []))
            cpu.reg_write(UC_X86_REG_EIP, self.read(stack, 'I')[0])
            cpu.reg_write(UC_X86_REG_ESP, stack + 8)
            return
        if name == 'CleanupDestroyed':
            assert this == self.level and self.read(stack + 4, 'I')[0] == 0
            self.events.append({'op': name, **self.snapshot()})
            return
        super().on_instruction(cpu, address, size, data)

    def run(self, sample):
        self.sample = sample
        self.events, self.calls, self.nodes = [], {}, {}
        self.actors = {name: self.alloc(0x900) for name in sample['actors']}
        self.ids = {0: None, self.info: 'LevelInfo', **{p: name for name, p in self.actors.items()}}
        for name, actor in self.actors.items():
            values = sample['actors'][name]
            self.write(actor, 'I', self.actor_vtable)
            self.write(actor + 0x24, 'I', self.derived_class if values.get('playerPawn') else 0)
            self.write(actor + 0x5d4, 'I', self.viewport if values.get('controlled') else 0)
            self.write(actor + 0x1a0, 'I', 0x20 if values.get('alwaysTick') else 0)
            self.fields(actor, {'DistanceFromPlayer': -99, 'inputs': [1, 2, 3, 4, 5, 6], **values.get('fields', {})})
        self.slots(sample.get('slots', ['LevelInfo', *self.actors]))
        self.write(self.level + 0x110, 'I', sample.get('firstDynamicActor', 1))
        self.write(self.level + 0x10c, 'I', sample.get('tickTag', 1))
        self.write(self.level + 0x108, 'I', 0)
        self.write(self.level + 0xdc, 'd', sample.get('timeSeconds', 1))
        self.write(self.level + 0x104, 'I', 0)
        self.write(self.info + 0x478, 'f', sample.get('timeSeconds', 1))
        self.write(self.info + 0x474, 'f', sample.get('timeDilation', 1))
        self.write(self.info + 0x4f0, 'I', 4 if sample.get('playersOnly') else 0)
        self.write(self.info + 0x550, 'I', self.manager if sample.get('eventManager', True) else 0)
        self.write(self.info + 0x518, 'B', 0)
        self.pauser(sample.get('pauser', ''), sample.get('allocatedEmpty', False))
        self.write(self.viewport + 0x30, 'I', self.actors.get(sample.get('player'), 0))
        self.actions(sample.get('beforeActions', []))
        before = {name: bytes(self.cpu.mem_read(actor, 0x900)).hex() for name, actor in self.actors.items()}
        self.call(0x103a51a0, self.level, struct.pack('<if', sample.get('tickType', 2), sample.get('seconds', 0.125)))
        head = self.read(self.level + 0x104, 'I')[0]
        chain = []
        while head:
            actor, head = self.read(head, '2I')
            chain.append(self.ids[actor])
            assert len(chain) < 100
        return {'name': sample['name'], 'before': before, 'events': self.events,
                'after': {name: bytes(self.cpu.mem_read(actor, 0x900)).hex() for name, actor in self.actors.items()},
                'final': self.snapshot(), 'deferred': chain,
                'calendar': list(self.read(self.info + 0x47c, '8i'))}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    print(json.dumps({'hashes': native.HASHES, 'cases': [probe.run(s) for s in json.load(sys.stdin)]}))
