"""Execute unchanged DeusEx enemy/alliance workers and exec wrappers.

Only original literal evaluation and a controlled class/actor memory graph are
supplied. Full receiver/target bytes and exec result padding are checked.
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


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root, {'DeusEx.dll': DEUSEX_HASH})
        core = native.Image(root / 'System' / 'Core.dll').exports()
        table = self.alloc(4096)
        self.write(0x100271a4, 'I', table)
        for token, name in [(0x0b, 'Nothing'), (0x1d, 'IntConst'), (0x20, 'ObjectConst'), (0x21, 'NameConst')]:
            self.write(table + token * 4, 'I', core[f'?exec{name}@UObject@@QAEXAAUFFrame@@QAX@Z'])
        self.frame, self.output, self.code = self.alloc(0x30), self.alloc(4), self.alloc(32)
        self.cls = self.alloc(0x40)
        self.write(self.cls + 0x28, 'I', 0x1003c020)
        self.names = {'none': 0}
        self.events = []

    def name(self, value):
        value = (value or 'None').lower()
        if value not in self.names:
            self.names[value] = len(self.names)
        return self.names[value]

    def actor(self, fields):
        actor = self.alloc(0x1000)
        self.cpu.mem_write(actor, bytes(0x1000))
        self.write(actor + 0x24, 'I', self.cls if fields.get('scripted', True) else 0)
        self.write(actor + 0x28, 'I', 0x80 if fields.get('bDeleteMe') else 0)
        self.write(actor + 0x2c, 'I', 1 if fields.get('bDetectable', True) else 0)
        self.write(actor + 0x428, 'i', fields.get('Health', 100))
        self.write(actor + 0x5c4, 'I', self.name(fields.get('Alliance')))
        self.write(actor + 0x6c8, 'I', 0x100 if fields.get('bLikesNeutral') else 0)
        self.write(actor + 0x8ec, 'I', 1 if fields.get('bReverseAlliances') else 0)
        for i, entry in enumerate(fields.get('AlliancesEx', [])):
            at = actor + 0x7ec + i * 16
            self.write(at, 'IffI', self.name(entry.get('AllianceName')), entry.get('AllianceLevel', 0),
                       entry.get('AgitationLevel', 0), 0)
            for field, offset in [('AllianceLevel', 4), ('AgitationLevel', 8)]:
                if field + 'Bits' in entry:
                    self.write(at + offset, 'I', entry[field + 'Bits'])
        return actor

    def on_instruction(self, cpu, address, size, data):
        if address == 0x10019420:
            actor = cpu.reg_read(native.UC_X86_REG_ECX)
            name = self.read(cpu.reg_read(native.UC_X86_REG_ESP) + 4, 'I')[0]
            self.events.append([self.ids[actor], next(key for key, value in self.names.items() if value == name)])
        return super().on_instruction(cpu, address, size, data)

    def run(self, sample):
        receiver, target = self.actor(sample.get('receiver', {})), self.actor(sample.get('target', {}))
        self.ids = {receiver: 'receiver', target: 'target'}
        before = [bytes(self.cpu.mem_read(a, 0x1000)) for a in [receiver, target]]
        query = 0 if sample.get('null') else receiver if sample.get('self') else target
        index = sample.get('index', 2105)
        self.events = []
        if index == 2106:
            code = b'\x21' + struct.pack('<I', self.name(sample.get('name', 'UNATCO')))
        else:
            code = b'\x20' + struct.pack('<I', query)
            if index == 2105:
                code += b'\x1d' + struct.pack('<i', sample['check']) if 'check' in sample else b'\x0b'
        code += b'\x16'
        self.cpu.mem_write(self.code, code)
        self.write(self.frame + 8, '2I', receiver, self.code)
        self.write(self.output, 'I', 0x55555555)
        self.call({2105: 0x10018f80, 2106: 0x10019050, 2107: 0x10019000}[index], receiver,
                  struct.pack('<2I', self.frame, self.output))
        assert [bytes(self.cpu.mem_read(a, 0x1000)) for a in [receiver, target]] == before
        advance = self.read(self.frame + 12, 'I')[0] - self.code
        assert advance == len(code)
        if index != 2105:
            assert bytes(self.cpu.mem_read(self.output + 1, 3)) == b'\x55' * 3
        return {'result': self.read(self.output, 'I' if index == 2105 else 'B')[0],
                'output': bytes(self.cpu.mem_read(self.output, 4)).hex(), 'advance': advance, 'events': self.events}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    print(json.dumps([probe.run(sample) for sample in json.load(sys.stdin)]))
