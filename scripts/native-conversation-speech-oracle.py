"""Execute ConSys speech binding and clearing with an explicit CRT comparator."""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn import UC_HOOK_MEM_WRITE

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class SpeechProbe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root, {'ConSys.dll': 'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa'})
        self.compare = next(address for address, (_, name) in self.thunks.items() if name == '_wcsicmp')
        self.cpu.mem_write(self.compare, b'\xc3')
        del self.thunks[self.compare]
        self.event = None
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)

    def text(self, pointer):
        units = []
        while self.read(pointer, 'H')[0]:
            unit = self.read(pointer, 'H')[0]
            units.append(unit - 32 if 97 <= unit <= 122 else unit)
            pointer += 2
        return units

    def on_instruction(self, cpu, address, size, data):
        if address == self.compare:
            sp = cpu.reg_read(native.UC_X86_REG_ESP)
            a, b = self.read(sp + 4, '2I')
            left, right = self.text(a), self.text(b)
            cpu.reg_write(native.UC_X86_REG_EAX, 0 if left == right else (1 if left > right else 0xffffffff))
        return super().on_instruction(cpu, address, size, data)

    def on_write(self, cpu, access, address, size, value, data):
        if self.event is not None and address in [self.event + 0x40, self.event + 0x50]:
            self.writes.append([address - self.event, 'candidate' if value == self.actor else value])

    def string(self, address, text):
        raw = text.encode('utf-16-le') + b'\0\0'
        data = self.alloc(len(raw))
        self.cpu.mem_write(data, raw)
        count = len(raw) // 2 if text else 0
        self.write(address, '3I', data, count, count)

    def bind(self, case):
        self.event = self.alloc(0x70)
        self.actor = self.alloc(0x2d0)
        self.string(self.event + 0x44, case['speakerName'])
        self.string(self.event + 0x54, case['speakingToName'])
        self.string(self.actor + 0x2ac, case['BindName'])
        self.string(self.actor + 0x2b8, case['BarkBindName'])
        self.write(self.event + 0x40, 'I', 0x44444444)
        self.write(self.event + 0x50, 'I', 0x55555555)
        self.writes = []
        result = self.call(0x1000b070, self.event, struct.pack('<3I', self.actor if case['invoke'] else 0, self.actor, 0))
        bound = self.cpu.reg_read(native.UC_X86_REG_EAX) & 0xff
        fields = [self.read(self.event + offset, 'I')[0] for offset in [0x40, 0x50]]
        fields = ['candidate' if value == self.actor else value for value in fields]
        writes = list(self.writes)
        self.writes = []
        conversation = self.alloc(0x78)
        end = self.alloc(0x40)
        self.write(conversation + 0x58, 'I', self.event)
        self.write(self.event + 0x38, 'I', end)
        self.write(end + 0x38, 'I', 0)
        self.call(0x10010200, conversation, b'')
        conversation_clear_writes = list(self.writes)
        conversation_clear_fields = [self.read(self.event + offset, 'I')[0] for offset in [0x40, 0x50]]
        conversation_clear_fields = ['candidate' if value == self.actor else value for value in conversation_clear_fields]
        self.call(0x1000b180, self.event, b'')
        return {**case, 'result': bound, 'fields': fields, 'writes': writes, 'clearWrites': self.writes,
                'conversationClearWrites': conversation_clear_writes, 'conversationClearFields': conversation_clear_fields}


if __name__ == '__main__':
    probe = SpeechProbe(Path(sys.argv[1]))
    cases = [
        ('JaimeReyes', '', 'jaimereyes', 'JCDenton', False),
        ('JCDenton', '', 'JaimeReyes', 'jcdenton', False),
        ('Other', 'Alias', 'Alias', 'NoMatch', False),
        ('Other', 'Alias', 'alias', 'ALIAS', True),
        ('Other', 'Alias', 'NoMatch', 'Alias', True),
        ('', '', '', 'NoMatch', False),
    ]
    print(json.dumps([probe.bind(dict(zip(['BindName', 'BarkBindName', 'speakerName', 'speakingToName', 'invoke'], case))) for case in cases]))
