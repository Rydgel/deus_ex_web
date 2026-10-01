"""Execute original PlayAnim/LoopAnim/TweenAnim and original mesh sequence lookup.

Only parameter evaluation, warning output and CRT sqrt are external services.
Inputs describe already-loaded sequence records and actor storage. No exec body
or arithmetic instruction is replaced. Original assets/results stay outside Git.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

FIELDS = {'AnimSequence': 0x54, 'AnimFrame': 0x58, 'AnimRate': 0x5c,
          'TweenRate': 0x60, 'AnimLast': 0x220, 'AnimMinRate': 0x224, 'OldAnimRate': 0x228}
BODIES = {'PlayAnim': (0x103e0160, 3), 'LoopAnim': (0x103e05e0, 4), 'TweenAnim': (0x103e0bd0, 2),
          'IsAnimating': (0x103e15c0, 0)}


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.actor = self.alloc(0x400)
        self.frame = self.alloc(0x30)
        self.code = self.alloc(32)
        self.result = self.alloc(4)
        self.mesh = self.alloc(0x200)
        vt = self.alloc(0x100)
        self.write(self.mesh, 'I', vt)
        self.write(vt + 0x68, 'I', 0x1031c000)  # original UMesh sequence lookup
        self.stub_names = {}
        table = self.alloc(256 * 4)
        self.write(table + 0x10 * 4, 'I', self.stub('Step', b'\xc2\x08\x00'))
        self.write(0x10599a38, 'I', table)
        self.write(0x10599a68, 'I', self.stub('Warning', b'\xc3'))
        # CRT sqrt returns a double. Keep the FPU result across its ABI leaf.
        scratch = self.alloc(8)
        sqrt = b'\xdd\x44\x24\x04\xd9\xfa\xdd\x1d' + struct.pack('<I', scratch)
        sqrt += b'\xdd\x05' + struct.pack('<I', scratch) + b'\xc3'
        self.write(0x10599ca4, 'I', self.stub('Sqrt', sqrt))

    def stub(self, name, code):
        ptr = self.alloc(64)
        self.cpu.mem_write(ptr, code)
        self.stub_names[ptr] = name
        return ptr

    def name(self, value):
        text = str(value or 'None')
        key = text.lower()
        if key not in self.names:
            self.names[key] = len(self.names)
            self.name_text.append(text)
        return self.names[key]

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        name = self.stub_names.get(address)
        if name == 'Step':
            frame, dst = self.read(stack + 4, '2I')
            index = self.read(frame + 12, 'I')[0] - self.code - 1
            value = self.arguments[index] if index < len(self.arguments) else None
            self.events.append({'op': 'Step', 'index': index, 'provided': value is not None})
            if value is not None:
                if index == 0:
                    self.write(dst, 'I', self.name(value))
                else:
                    self.write(dst, 'f', float(value))
            return
        if name == 'Warning':
            fmt = self.read(stack + 8, 'I')[0]
            text, index = [], 0
            while True:
                word = self.read(fmt + index * 2, 'H')[0]
                if not word:
                    break
                text.append(chr(word))
                index += 1
            self.events.append({'op': 'Warning', 'format': ''.join(text)})
            return
        if name == 'Sqrt':
            self.events.append({'op': 'Sqrt', 'squared': self.read(stack + 4, 'd')[0]})
            return
        if address == 0x1031c000:
            self.events.append({'op': 'Sequence', 'name': self.read(stack + 4, 'I')[0]})
        super().on_instruction(cpu, address, size, data)

    def run(self, sample):
        self.names, self.name_text = {'none': 0}, ['None']
        self.events = []
        self.cpu.mem_write(self.actor, b'\0' * 0x400)
        initial = sample.get('actor', {})
        self.write(self.actor + 0x28, 'I', initial.get('animFlags', 0))
        for key, offset in FIELDS.items():
            value = initial.get(key, 'None' if key == 'AnimSequence' else 0)
            self.write(self.actor + offset, 'I' if key == 'AnimSequence' else 'f',
                       self.name(value) if key == 'AnimSequence' else float(value))
        self.write(self.actor + 0x144, '3f', *initial.get('Velocity', [0, 0, 0]))
        sim = initial.get('simAnim', {})
        self.write(self.actor + 0x22c, '4f', *[float(sim.get(k, 0)) for k in ['frame', 'rate', 'tween', 'last']])
        sequences = sample.get('sequences', [])
        seq_data = self.alloc(max(32, len(sequences) * 32))
        for i, seq in enumerate(sequences):
            self.write(seq_data + 32 * i, '4If3I', self.name(seq['name']), 0,
                       seq.get('startFrame', 0), seq['numFrames'], seq['rate'], 0, seq.get('notifyCount', 0), 0)
        self.write(self.mesh + 0x84, '3I', seq_data, len(sequences), len(sequences))
        self.write(self.mesh + 0x20, 'I', self.name('FixtureMesh'))
        self.write(self.actor + 0x174, 'I', 0 if sample.get('noMesh') else self.mesh)
        self.arguments = sample['args']
        if self.arguments:
            self.name(self.arguments[0])
        names = self.alloc(len(self.names) * 4)
        for i, text in enumerate(self.name_text):
            entry = self.alloc(12 + (len(text) + 1) * 2)
            self.cpu.mem_write(entry + 12, text.encode('utf-16le') + b'\0\0')
            self.write(names + 4 * i, 'I', entry)
        name_table = self.alloc(4)
        self.write(name_table, 'I', names)
        self.write(0x10599a70, 'I', name_table)
        body, count = BODIES[sample['native']]
        self.cpu.mem_write(self.code, b'\x10' * count + b'\x16')
        self.write(self.frame + 8, '2I', self.actor, self.code)
        before = bytes(self.cpu.mem_read(self.actor, 0x240)).hex()
        self.write(self.result, 'I', 0xcdcdcdcd)
        self.call(body, self.actor, struct.pack('<2I', self.frame, self.result))
        return {'name': sample['name'], 'before': before, 'result': self.read(self.result, 'I')[0],
                'after': bytes(self.cpu.mem_read(self.actor, 0x240)).hex(),
                'codeAdvance': self.read(self.frame + 12, 'I')[0] - self.code,
                'names': self.name_text, 'events': self.events}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    print(json.dumps({'hashes': native.HASHES, 'cases': [probe.run(case) for case in json.load(sys.stdin)]}))
