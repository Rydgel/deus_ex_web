"""Run original Core InitProperties with explicit raw storage and one copy leaf."""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('collision', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root))
        self.leaf = self.alloc(32)
        # Copy one dword; this explicit leaf stands in for virtual +90.
        self.cpu.mem_write(self.leaf, bytes.fromhex('8b4424048b5424088b128910c7415400000000c20800'))
        self.callbacks = []

    def on_instruction(self, cpu, address, size, data):
        if address == self.leaf:
            stack = cpu.reg_read(native.UC_X86_REG_ESP)
            destination, source = self.read(stack + 4, 'II')
            self.callbacks.append({'before': self.read(destination, 'I')[0], 'source': self.read(source, 'I')[0]})
        return super().on_instruction(cpu, address, size, data)

    def run_case(self, mode):
        destination, source, cls = self.alloc(0x40), self.alloc(0x40), self.alloc(0x500)
        self.cpu.mem_write(destination, bytes([0xa5]) * 0x40)
        self.cpu.mem_write(source, bytes(range(0x40)))
        self.cpu.mem_write(cls, bytes(0x500))
        self.write(cls + 0x4d4, 'II', source, 0x30 if mode == 'fallback' else 0)
        defaults, prop_size = (source, 0x35) if mode == 'explicit' else (0, 0x40)
        if mode == 'fallback':
            prop, vtable = self.alloc(0x60), self.alloc(0x94)
            self.cpu.mem_write(prop, bytes(0x60))
            self.write(prop, 'I', vtable)
            self.write(prop + 0x34, 'II', 1, 4)
            self.write(prop + 0x48, 'I', 0x2c)
            self.write(prop + 0x54, 'I', prop)
            self.write(vtable + 0x90, 'I', self.leaf)
            self.write(cls + 0x68, 'I', prop)
        self.callbacks = []
        self.call(0x101520d0, 0, struct.pack('<IIIII', destination, 0x40, cls, defaults, prop_size))
        return {'bytes': list(self.cpu.mem_read(destination, 0x40)), 'callbacks': self.callbacks}


if __name__ == '__main__':
    probe = Probe(sys.argv[1])
    print(json.dumps({'hashes': native.HASHES, 'cases': {
        mode: probe.run_case(mode) for mode in ['explicit', 'fallback', 'empty']}}))
