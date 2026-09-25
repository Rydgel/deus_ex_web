"""Focused original LoadMap touch clearing and Render actor timestamp stores.

Fixtures supply the pointer graph; all instructions between the stated entry
and exit addresses execute unchanged. This is not a complete renderer probe.
"""
import importlib.util
import json
import struct
from pathlib import Path
import sys
from unicorn.x86_const import UC_X86_REG_EIP, UC_X86_REG_EDI, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
RENDER_HASH = '607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1'


class Probe(native.NativeCollision):
    stop = None
    event_calls = None

    def on_instruction(self, cpu, address, size, data):
        # Observe the Actor wrapper's call edge, not a synthetic event body.
        # The Core event implementation is covered by the event/frame oracles.
        if address == 0x1013f7d0 and self.event_calls is not None:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            self.event_calls.append((cpu.reg_read(UC_X86_REG_ECX),
                                     self.read(stack + 4, '3I')))
            cpu.reg_write(UC_X86_REG_ESP, stack + 16)
            cpu.reg_write(UC_X86_REG_EIP, self.read(stack, 'I')[0])
            return
        if address == self.stop:
            cpu.reg_write(UC_X86_REG_EIP, self.done)
            return
        return super().on_instruction(cpu, address, size, data)

    def actor_event_gate(self):
        actor, info = self.alloc(0x200), self.alloc(0x600)
        self.write(actor + 0xa8, 'I', info)
        cases = []
        self.stop = None
        for flags, function in [(0, 0), (0x40, 0), (2, 0x12345678), (0x42, 0x12345678)]:
            self.write(info + 0x4f0, 'I', flags)
            self.event_calls = []
            args = (function, 0x23456789, 0x3456789a)
            self.call(0x10369100, actor, struct.pack('<3I', *args))
            cases.append({'flags': flags, 'coreCalls': len(self.event_calls),
                          'forwarded': all(receiver == actor and values == args
                                           for receiver, values in self.event_calls),
                          'stackClean': self.cpu.reg_read(UC_X86_REG_ESP) == self.stack + 16})
        self.event_calls = None
        return cases

    def capture(self):
        engine, level, array = self.alloc(256), self.alloc(256), self.alloc(8)
        actor, other, info, sprite = [self.alloc(2048) for _ in range(4)]
        self.write(engine + 0x68, 'I', level)
        self.write(level + 0x2c, '2I', array, 2)
        self.write(array, '2I', actor, 0)  # Live actor followed by a null slot.
        self.write(actor + 0xe8, '4I', 111, 222, 333, 444)
        self.write(actor + 0xf8, 'I', 555)  # Neighbor must survive the clear.
        self.cpu.reg_write(UC_X86_REG_EDI, engine)
        self.cpu.reg_write(UC_X86_REG_EBX, 0)
        self.stop = 0x1038d824
        self.call(0x1038d7f7, 0, b'')
        touching = self.read(actor + 0xe8, '5I')

        self.write(array, '2I', info, actor)
        self.write(info + 0x478, 'f', 17.125)
        self.write(sprite + 0x94, 'I', actor)
        self.write(actor + 0x34, 'f', -10)
        self.write(other + 0x34, 'f', -10)
        self.cpu.reg_write(UC_X86_REG_EBX, level)
        self.cpu.reg_write(UC_X86_REG_EDI, sprite)
        self.stop = 0x10b25164
        self.call(0x10b25150, 0, b'')
        return {'touching': touching[:4], 'neighbor': touching[4],
                'drawn': self.read(actor + 0x34, 'f')[0],
                'undrawn': self.read(other + 0x34, 'f')[0],
                'actorEventGate': self.actor_event_gate()}


if __name__ == '__main__':
    print(json.dumps(Probe(Path(sys.argv[1]), {'Render.dll': RENDER_HASH}).capture()))
