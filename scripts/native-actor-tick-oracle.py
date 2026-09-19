"""Original complete Actor.Tick execution for the standalone authority route.

Tick, InStasis, animation and timer arithmetic execute from original binaries.
Lookup, event/state execution, physics, destruction, memory allocation, viewport
input and Pawn visibility helpers are explicit service leaves. No instructions
inside Actor.Tick or InStasis are replaced. This does not emulate a whole world.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('tick', Path(__file__).with_name('native-animation-tick-oracle.py'))
tick = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tick)

FIELDS = {'LastRenderTime': (0x34, 'f'), 'DistanceFromPlayer': (0x38, 'f'),
          'TimerRate': (0x48, 'f'), 'TimerCounter': (0x4c, 'f'), 'LifeSpan': (0x50, 'f'),
          'Physics': (0x30, 'B'), 'Role': (0x31, 'B'), 'RemoteRole': (0x32, 'B'),
          'flags2': (0x2c, 'I'), 'pawnFlags': (0x318, 'I'), 'pawnFlags2': (0x31c, 'I'),
          'SightCounter': (0x320, 'f'), 'PainTime': (0x324, 'f'), 'SpeechTime': (0x328, 'f'),
          'cameraFlags': (0x5fc, 'I')}
NAMES = {0x105836b8: 'Tick', 0x10583718: 'Timer', 0x105836b0: 'Expired',
         0x105836a0: 'UpdateEyeHeight', 0x105836c4: 'PainTimer', 0x105836c0: 'SpeechTimer',
         0x105835c0: 'UpdateTactics', 0x1058368c: 'PlayerInput', 0x105836b4: 'PlayerTick'}
PARAMS = {'Tick', 'PlayerInput', 'PlayerTick', 'UpdateEyeHeight', 'UpdateTactics'}


class Probe(tick.Probe):
    def __init__(self, root):
        super().__init__(root)
        exports = tick.animation.native.Image(root / 'System' / 'Engine.dll').exports()
        for address, name in NAMES.items():
            assert exports[f'?ENGINE_{name}@@3VFName@@A'] == address
        self.actor = self.alloc(0x900)
        self.actor_vtable = self.alloc(0x100)
        self.level = self.alloc(0x200)
        self.level_info = self.alloc(0x600)
        self.model = self.alloc(0x800)
        self.owner = self.alloc(0x300)
        self.viewport = self.alloc(0x80)
        self.level_vtable = self.alloc(0x100)
        self.viewport_vtable = self.alloc(0x80)
        self.weapon = self.alloc(0x400)
        self.view_target = self.alloc(0x900)
        self.write(self.actor_vtable + 0x10, 'I', self.stub('ProcessEvent', b'\xc2\x0c\x00'))
        self.write(self.actor_vtable + 0x14, 'I', self.stub('ProcessState', b'\xc2\x04\x00'))
        self.write(self.actor_vtable + 0x8c, 'I', self.stub('PerformPhysics', b'\xc2\x04\x00'))
        self.write(self.level, 'I', self.level_vtable)
        self.write(self.level_vtable + 0x94, 'I', self.stub('DestroyActor', b'\xc2\x08\x00'))
        self.write(self.level_vtable + 0x8c, 'I', self.stub('FarMoveWeapon', b'\xc2\x18\x00'))
        self.write(self.viewport, 'I', self.viewport_vtable)
        self.write(self.viewport_vtable + 0x54, 'I', self.stub('ReadInput', b'\xc2\x04\x00'))
        self.write(0x1059a02c, 'I', self.stub('IsProbing', b'\xc2\x04\x00'))
        self.write(0x10599bd4, 'I', self.stub('PushBytes', b'\xc2\x08\x00'))
        self.write(0x1058c160 + 0x28, 'I', 0x1058c660)  # PlayerPawn : Pawn
        self.write(0x1057b510 + 0x28, 'I', 0x1058c160)  # Camera : PlayerPawn

    def set_actor(self, values):
        super().set_actor(values)
        for key, (offset, fmt) in FIELDS.items():
            if key in values:
                value = float(values[key]) if fmt == 'f' else values[key]
                self.write(self.actor + offset, fmt, value)
        for key, offset in [('Rotation', 0x120), ('ViewRotation', 0x3dc)]:
            if key in values:
                self.write(self.actor + offset, '3i', *values[key])
        if 'Location' in values:
            self.write(self.actor + 0x114, '3f', *values['Location'])

    def event(self, name, seconds=None):
        self.events.append({'op': name, 'seconds': seconds,
                            'AnimFrame': self.read(self.actor + 0x58, 'f')[0],
                            'TimerRate': self.read(self.actor + 0x48, 'f')[0],
                            'TimerCounter': self.read(self.actor + 0x4c, 'f')[0],
                            'LifeSpan': self.read(self.actor + 0x50, 'f')[0],
                            'SightCounter': self.read(self.actor + 0x320, 'f')[0],
                            'PainTime': self.read(self.actor + 0x324, 'f')[0],
                            'SpeechTime': self.read(self.actor + 0x328, 'f')[0]})
        if self.callback_index < len(self.callbacks):
            callback = self.callbacks[self.callback_index]
            if callback['event'].lower() == name.lower():
                self.set_actor(callback['actor'])
                self.callback_index += 1

    def on_instruction(self, cpu, address, size, data):
        name = self.stub_names.get(address)
        stack = cpu.reg_read(UC_X86_REG_ESP)
        if name == 'ProcessEvent':
            function, params, result = self.read(stack + 4, '3I')
            assert result == 0
            event = self.name_text[function - 0x30000000]
            assert bool(params) == (event in PARAMS)
            self.event(event, self.read(params, 'f')[0] if params else None)
            return
        if name in ['ProcessState', 'PerformPhysics', 'ReadInput']:
            self.event(name, self.read(stack + 4, 'f')[0])
            return
        if name == 'DestroyActor':
            actor, force = self.read(stack + 4, '2I')
            assert actor == self.actor and force == 0
            self.event(name)
            cpu.reg_write(UC_X86_REG_EAX, 1)
            return
        if name == 'FarMoveWeapon':
            actor = self.read(stack + 4, 'I')[0]
            assert actor == self.weapon
            assert self.read(stack + 20, '2I') == (0, 0)
            self.weapon_location = list(self.read(stack + 8, '3f'))
            self.event(name)
            cpu.reg_write(UC_X86_REG_EAX, 1)
            return
        if name == 'IsProbing':
            probe = self.read(stack + 4, 'I')[0]
            event = {0x150: 'Tick', 0x155: 'EnemyNotVisible'}[probe]
            found = event not in self.sample.get('disabledProbes', [])
            self.events.append({'op': 'IsProbing', 'name': event, 'result': found})
            cpu.reg_write(UC_X86_REG_EAX, int(found))
            return
        if name == 'PushBytes':
            assert self.read(stack + 4, '2I') == (8, 8)
            pointer = 0 if self.sample.get('allocationFails') else self.alloc(8)
            cpu.reg_write(UC_X86_REG_EAX, pointer)
            self.events.append({'op': 'DeferOwner', 'allocated': bool(pointer)})
            return
        if address in [0x103c0410, 0x103c0280]:
            self.event('ShowSelf' if address == 0x103c0410 else 'CheckEnemyVisible')
            cpu.reg_write(UC_X86_REG_EIP, self.read(stack, 'I')[0])
            cpu.reg_write(UC_X86_REG_ESP, stack + 4)
            return
        if name in ['FindFunction', 'FindFunctionChecked']:
            return super().on_instruction(cpu, address, size, data)
        # Avoid the animation-only oracle's phase-exit hook at 103a1fd2.
        tick.animation.Probe.on_instruction(self, cpu, address, size, data)

    def run(self, sample):
        self.sample = sample
        self.cpu.mem_write(self.actor, b'\0' * 0x900)
        self.setup(sample)
        self.weapon_location = None
        self.write(self.actor + 0xac, 'I', self.level)
        self.write(self.actor + 0xa8, 'I', self.level_info)
        self.write(self.actor + 0xd0, 'B', 2)
        self.write(self.level + 0xdc, 'd', sample.get('timeSeconds', 1))
        self.write(self.level + 0x98, 'I', self.model)
        self.write(self.model + 0x108 + 2 * 24, 'f', sample.get('zoneLastRenderTime', 0))
        self.write(self.level_info + 0x518, 'B', sample.get('netMode', 0))
        self.write(self.level + 0x10c, 'I', sample.get('tickTag', 1))
        self.write(self.level + 0x104, 'I', 0x12345678)
        self.write(self.owner + 0x28, 'I', 0x200 if sample.get('ownerTicked') else 0)
        self.write(self.actor + 0x3c, 'I', self.owner if 'ownerTicked' in sample else 0)
        kind = sample.get('kind', 'Actor')
        self.write(self.actor + 0x24, 'I', {'Actor': 0, 'Pawn': 0x1058c660,
                                          'PlayerPawn': 0x1058c160, 'Camera': 0x1057b510}[kind])
        self.write(self.actor + 0x5d4, 'I', self.viewport if sample.get('viewport') else 0)
        self.write(self.actor + 0x3d0, 'I', self.weapon if sample.get('weapon') else 0)
        self.write(self.actor + 0x60c, 'I', self.view_target if sample.get('viewTarget') else 0)
        if sample.get('viewTarget'):
            target = sample['viewTarget']
            self.write(self.view_target + 0x24, 'I', 0x1058c660)
            self.write(self.view_target + 0x3dc, '3i', *target['ViewRotation'])
            self.write(self.view_target + 0x3f8, 'f', target['EyeHeight'])
            self.write(self.view_target + 0x3d0, 'I', self.weapon if target.get('weaponOffset') else 0)
            if target.get('weaponOffset'):
                self.write(self.weapon + 0x34c, '3f', *target['weaponOffset'])
        for address, name in NAMES.items():
            self.write(address, 'I', self.name(name))
        before = bytes(self.cpu.mem_read(self.actor, 0x900)).hex()
        result = self.call(0x103a1aa0, self.actor, struct.pack('<fi', sample['seconds'], sample.get('tickType', 2)))
        head = self.read(self.level + 0x104, 'I')[0]
        deferred = None if head in [0, 0x12345678] else list(self.read(head, '2I'))
        return {'name': sample['name'], 'before': before,
                'after': bytes(self.cpu.mem_read(self.actor, 0x900)).hex(), 'result': result,
                'deferred': 'actor' if deferred == [self.actor, 0x12345678] else None,
                'deferredHeadCleared': head == 0, 'weaponLocation': self.weapon_location,
                'callbacks': self.callback_index, 'names': self.name_text, 'events': self.events}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    print(json.dumps({'hashes': tick.animation.native.HASHES,
                      'cases': [probe.run(case) for case in json.load(sys.stdin)]}))
