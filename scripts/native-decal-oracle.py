"""Execute original ADecal construction, AttachDecal gates and empty DetachDecal.

Argument evaluation and warning output are explicit host services. Positive
attachment cases stop before BSP work; they are not successful AttachDecal runs.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_EBP, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.actor = self.alloc(0x340)
        self.level = self.alloc(0x100)
        self.engine = self.alloc(0x100)
        self.client = self.alloc(0x100)
        self.frame = self.alloc(0x30)
        self.code = self.alloc(16)
        self.result = self.alloc(4)
        self.step = self.alloc(16)
        self.warning = self.alloc(16)
        self.cpu.mem_write(self.step, bytes.fromhex('c2 08 00'))
        self.cpu.mem_write(self.warning, b'\xc3')
        table = self.alloc(256 * 4)
        self.write(table + 0x10 * 4, 'I', self.step)
        self.write(0x10599a38, 'I', table)
        self.write(0x10599a68, 'I', self.warning)
        self.events = []
        self.boundary = None

    def on_instruction(self, cpu, address, size, data):
        sp = cpu.reg_read(UC_X86_REG_ESP)
        if address == self.step:
            frame, dst = self.read(sp + 4, '2I')
            index = self.read(frame + 12, 'I')[0] - self.code - 1
            value = self.arguments[index] if index < len(self.arguments) else None
            self.events.append({'op': 'Step', 'index': index, 'provided': value is not None})
            if value is not None:
                self.write(dst, 'f' if index == 0 else '3f', *([value] if index == 0 else value))
            return
        if address == self.warning:
            ptr = self.read(sp + 8, 'I')[0]
            words = []
            while self.read(ptr, 'H')[0]:
                words.append(chr(self.read(ptr, 'H')[0]))
                ptr += 2
            self.events.append({'op': 'Warning', 'format': ''.join(words)})
            return
        if address == 0x103e7357:
            # Clamp has been stored. Stop before any surface attachment work;
            # do not redirect to the native success/return path.
            bp = cpu.reg_read(UC_X86_REG_EBP)
            self.boundary = {'operation': 'AttachDecal.surfaces',
                             'distance': self.read(bp - 0x94, 'f')[0],
                             'direction': self.read(bp - 0x68, '3f')}
            cpu.emu_stop()
            return
        super().on_instruction(cpu, address, size, data)

    def constructor(self):
        before = b'\xa5' * 0x340
        self.cpu.mem_write(self.actor, before)
        self.call(0x10331090, self.actor, b'')
        after = bytes(self.cpu.mem_read(self.actor, 0x340))
        vtable = self.read(self.actor, 'I')[0]
        slots = [0x10, 0x24, 0x38, 0x74]
        return {'vtable': vtable, 'surfaces': self.read(self.actor + 0x320, '3I'),
                'changedOffsets': [i for i in range(len(before)) if before[i] != after[i]],
                'templateWords': self.read(self.actor + 0x318, '2I'),
                'startupSlots': [self.read(vtable + offset, 'I')[0] for offset in slots],
                'actorStartupSlots': [self.read(0x104268dc + offset, 'I')[0] for offset in slots]}

    def run(self, sample):
        self.events, self.boundary = [], None
        self.cpu.mem_write(self.actor, b'\0' * 0x340)
        self.write(self.actor + 0xac, 'I', self.level)
        self.write(self.level + 0x40, 'I', self.engine)
        self.write(self.engine + 0x44, 'I', 0 if sample.get('noClient') else self.client)
        self.write(self.client + 0x4c, 'I', sample.get('decals', 1))
        self.write(self.actor + 0x16c, 'I', 0 if sample.get('noTexture') else 0x1234)
        self.write(self.actor + 0x318, 'i', sample.get('depth', 4))
        self.write(self.result, 'I', 0xa5a5a5a5)
        detach = sample.get('detach', False)
        self.arguments = sample.get('args', [100])
        self.cpu.mem_write(self.code, b'\x16' if detach else b'\x10\x10\x16')
        self.write(self.frame + 8, '2I', self.actor, self.code)
        before = bytes(self.cpu.mem_read(self.actor, 0x340))
        self.write(0, 'I', 0)
        try:
            self.call(0x103e9a30 if detach else 0x103e7250, self.actor,
                      struct.pack('<2I', self.frame, self.result))
        except RuntimeError:
            if self.boundary is None or self.cpu.reg_read(native.UC_X86_REG_EIP) != 0x103e7357:
                raise
        after = bytes(self.cpu.mem_read(self.actor, 0x340))
        return {'name': sample['name'], 'result': self.read(self.result, 'I')[0],
                'depth': self.read(self.actor + 0x318, 'i')[0],
                'changedOffsets': [i for i in range(len(before)) if before[i] != after[i]],
                'codeAdvance': self.read(self.frame + 12, 'I')[0] - self.code,
                'events': self.events, 'boundary': self.boundary}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    constructor = probe.constructor()
    print(json.dumps({'hashes': native.HASHES, 'constructor': constructor,
                      'cases': [probe.run(case) for case in json.load(sys.stdin)]}))
