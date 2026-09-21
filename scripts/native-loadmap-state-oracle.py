"""Focused original LoadMap touch clearing and Render actor timestamp stores.

Fixtures supply the pointer graph; all instructions between the stated entry
and exit addresses execute unchanged. This is not a complete renderer probe.
"""
import importlib.util
import json
from pathlib import Path
import sys
from unicorn.x86_const import UC_X86_REG_EIP, UC_X86_REG_EDI, UC_X86_REG_EBX

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
RENDER_HASH = '607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1'


class Probe(native.NativeCollision):
    stop = None

    def on_instruction(self, cpu, address, size, data):
        if address == self.stop:
            cpu.reg_write(UC_X86_REG_EIP, self.done)
            return
        return super().on_instruction(cpu, address, size, data)

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
                'undrawn': self.read(other + 0x34, 'f')[0]}


if __name__ == '__main__':
    print(json.dumps(Probe(Path(sys.argv[1]), {'Render.dll': RENDER_HASH}).capture()))
