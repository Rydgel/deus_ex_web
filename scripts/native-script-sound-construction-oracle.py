"""Run the original USound constructor with its Realloc call explicitly recorded."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class SoundConstructorProbe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.realloc = self.alloc(16)
        self.cpu.mem_write(self.realloc, bytes.fromhex('c2 04 00'))
        self.write(0x10599a20, 'I', self.realloc)
        self.events = []

    def on_instruction(self, cpu, address, size, data):
        if address == self.realloc:
            array = cpu.reg_read(native.UC_X86_REG_ECX)
            sp = cpu.reg_read(native.UC_X86_REG_ESP)
            self.events.append({'arrayOffset': array - self.sound,
                                'elementSize': self.read(sp + 4, 'I')[0],
                                'array': self.read(array, '3I'),
                                'soundVtable': self.read(self.sound, 'I')[0],
                                'external': self.read(self.sound + 0x2c, 'I')[0]})
        return super().on_instruction(cpu, address, size, data)

    def construct(self):
        self.sound = self.alloc(0x54)
        self.cpu.mem_write(self.sound, b'\xa5' * 0x54)
        self.write(self.sound + 0x44, '4I', 21, 23, 0x12345678, 25)
        self.call(0x1034cdc0, self.sound, b'')
        return {'vtable': self.read(self.sound, 'I')[0],
                'soundData': self.read(self.sound + 0x28, '6I'),
                'ownerIsSelf': self.read(self.sound + 0x40, 'I')[0] == self.sound,
                'format': self.read(self.sound + 0x44, 'I')[0],
                'byteCount': self.read(self.sound + 0x48, 'I')[0],
                'duration': self.read(self.sound + 0x4c, 'f')[0],
                'tail': self.read(self.sound + 0x50, 'I')[0],
                'events': self.events}


if __name__ == '__main__':
    print(json.dumps(SoundConstructorProbe(Path(sys.argv[1])).construct()))
