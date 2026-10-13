"""Execute the unchanged DeusEx ScriptedPawn carcass-memory natives.

Native 2108 HaveSeenCarcass (exec 0x100190a0 -> worker 0x1001a010) and native 2109 AddCarcass (exec 0x100190f0 -> worker 0x1001a040)
over a synthetic receiver whose Carcasses[4] (+0x9f4) and NumCarcasses (+0xa04) are controlled. Only the script-frame token dispatch table
is supplied (EX_Nothing / EX_IntConst / EX_ObjectConst / EX_NameConst from Core.dll); the receiver's full bytes and the exec's result slot
are checked.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
DEUSEX_HASH = 'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04'
CARCASSES, NUM_CARCASSES = 0x9f4, 0xa04
EXEC = {2108: 0x100190a0, 2109: 0x100190f0}


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root, {'DeusEx.dll': DEUSEX_HASH})
        core = native.Image(root / 'System' / 'Core.dll').exports()
        table = self.alloc(4096)
        self.write(0x100271a4, 'I', table)
        for token, name in [(0x0b, 'Nothing'), (0x1d, 'IntConst'), (0x20, 'ObjectConst'), (0x21, 'NameConst')]:
            self.write(table + token * 4, 'I', core[f'?exec{name}@UObject@@QAEXAAUFFrame@@QAX@Z'])
        self.frame, self.output, self.code = self.alloc(0x30), self.alloc(4), self.alloc(32)
        self.names = {'none': 0}

    def name(self, value):
        value = (value or 'None').lower()
        if value not in self.names:
            self.names[value] = len(self.names)
        return self.names[value]

    def run(self, sample):
        receiver = self.alloc(0x1000)
        self.cpu.mem_write(receiver, bytes(0x1000))
        for i, value in enumerate(sample.get('carcasses', [])):
            self.write(receiver + CARCASSES + 4 * i, 'I', self.name(value))
        self.write(receiver + NUM_CARCASSES, 'i', sample.get('num', len(sample.get('carcasses', []))))
        before = bytes(self.cpu.mem_read(receiver, 0x1000))
        index = sample['index']
        code = b'\x21' + struct.pack('<I', self.name(sample['name'])) + b'\x16'
        self.cpu.mem_write(self.code, code)
        self.write(self.frame + 8, '2I', receiver, self.code)
        self.write(self.output, 'I', 0x55555555)
        self.call(EXEC[index], receiver, struct.pack('<2I', self.frame, self.output))
        after = bytes(self.cpu.mem_read(receiver, 0x1000))
        advance = self.read(self.frame + 12, 'I')[0] - self.code
        assert advance == len(code)
        inverse = {value: key for key, value in self.names.items()}
        changed = [i for i in range(0x1000) if before[i] != after[i]]
        assert all(CARCASSES <= i < NUM_CARCASSES + 4 for i in changed), 'only the carcass list and its count may change'
        return {'result': self.read(self.output, 'I')[0],
                'carcasses': [inverse[v] for v in self.read(receiver + CARCASSES, '4I')],
                'num': self.read(receiver + NUM_CARCASSES, 'i')[0], 'advance': advance}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    print(json.dumps([probe.run(sample) for sample in json.load(sys.stdin)]))
