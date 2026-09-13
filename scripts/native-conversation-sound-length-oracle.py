"""Unchanged ConSys timing bodies; explicit strncmp, Logf and audio-lookup leaves.

LoadSpecial and generic lazy Load execute unchanged with already-loaded bytes.
An external caller trampoline stores the returned x87 value as float32.
"""
import base64
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
CONSYS_HASH = 'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa'


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), {'ConSys.dll': CONSYS_HASH})
        self.events = []
        self.compare = self.alloc(16)
        self.log = self.alloc(16)
        self.cpu.mem_write(self.compare, b'\xc3')
        self.cpu.mem_write(self.log, b'\xc3')
        self.write(0x10013184, 'I', self.compare)
        self.write(0x10013108, 'I', self.log)
        self.log_receiver = self.alloc(16)
        self.write(self.read(0x1001310c, 'I')[0], 'I', self.log_receiver)
        # GetSpeechAudio's loading/temporary ownership remains an explicit leaf.
        self.cpu.mem_write(0x10010210, b'\xc2\x04\x00')
        self.speech_sound = 0
        self.result = self.alloc(4)

    def text(self, address):
        values = []
        while True:
            value = self.read(address, 'H')[0]
            if not value:
                return ''.join(map(chr, values))
            values.append(value)
            address += 2

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(native.UC_X86_REG_ESP)
        if address == self.compare:
            left, right, count = self.read(stack + 4, '3I')
            a = bytes(cpu.mem_read(left, count)).split(b'\0', 1)[0]
            b = bytes(cpu.mem_read(right, count)).split(b'\0', 1)[0]
            cpu.reg_write(native.UC_X86_REG_EAX, (0 if a == b else 1))
        elif address == self.log:
            receiver, message = self.read(stack + 4, '2I')
            if receiver != self.log_receiver:
                raise RuntimeError('Wrong native Logf receiver')
            self.events.append({'op': 'log', 'text': self.text(message)})
        elif address == 0x1036f700:
            self.events.append({'op': 'LoadSpecial'})
        elif address == 0x1030cbb0:
            self.events.append({'op': 'LazyLoad'})
        elif address == 0x10010210:
            self.events.append({'op': 'GetSpeechAudio', 'soundID': self.read(stack + 4, 'i')[0]})
            cpu.reg_write(native.UC_X86_REG_EAX, self.speech_sound)
        return super().on_instruction(cpu, address, size, data)

    def invoke_float(self, body, argument):
        # push argument; call original; fstp float32 [result]; ret to oracle.
        caller = self.alloc(32)
        code = b'\x68' + struct.pack('<I', argument & 0xffffffff)
        code += b'\xe8' + struct.pack('<i', body - (caller + 10))
        code += b'\xd9\x1d' + struct.pack('<I', self.result) + b'\xc3'
        self.cpu.mem_write(caller, code)
        self.call(caller, 0, b'')
        return self.read(self.result, 'f')[0]

    def case(self, record):
        data = base64.b64decode(record['bytesBase64']) if record.get('bytesBase64') is not None else None
        sound = 0
        if not record.get('nullSound', False):
            sound = self.alloc(0x54)
            pointer = 0
            if data is not None:
                pointer = self.alloc(max(len(data), 4))
                self.cpu.mem_write(pointer, data)
            self.write(sound + 0x30, 'i', -1)
            self.write(sound + 0x34, '3I', pointer, record.get('num', len(data or b'')), len(data or b''))
            self.write(sound + 0x48, '2I', 0x13572468, 0x24681357)
        self.events = []
        self.speech_sound = sound
        value = self.invoke_float(0x10010430 if 'soundID' in record else 0x10010460,
                                  record.get('soundID', sound))
        if sound and self.read(sound + 0x48, '2I') != (0x13572468, 0x24681357):
            raise RuntimeError('Unexpected sound owner writes')
        return {'name': record['name'], 'value': value, 'events': list(self.events)}


probe = Probe(sys.argv[1])
cases = json.loads(Path(sys.argv[2]).read_text())
print(json.dumps({'conSysHash': CONSYS_HASH, 'bitrates': probe.read(0x1001d9d0, '80i'),
                  'cases': [probe.case(record) for record in cases]}))
