"""Probe the original ProcessEvent ownership/gate branches with a bound body.

The original wrapper and FString destructors execute from hash-verified DLLs.
Only the event implementation and IsPendingKill result are harness services;
the existing destruction probe supplies a logging, non-reclaiming allocator.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location(
    'destroy_probe', Path(__file__).with_name('native-property-destroy-oracle.py'))
destroy_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(destroy_module)
native_module = destroy_module._native_collision


class FrameProbe(destroy_module.DestroyProbe):
    def __init__(self, root):
        super().__init__(root)
        self.body = self.alloc(16)
        self.pending = self.alloc(16)
        self.cpu.mem_write(self.body, bytes.fromhex('c2 08 00'))
        self.frame_events = []
        self.local_block = None
        self.properties = {}

    def on_instruction(self, cpu, address, size, data):
        if address == self.body:
            sp = cpu.reg_read(native_module.UC_X86_REG_ESP)
            frame = self.read(sp + 4, 'I')[0]
            self.local_block = self.read(frame + 0x10, 'I')[0]
            self.frame_events.append({'op': 'body',
                'initialParameter': self.words(self.local_block),
                'resultPointerOffset': self.read(sp + 8, 'I')[0] - self.local_block,
                'initialLocals': self.words(self.local_block + self.param_bytes,
                    (36 - self.param_bytes) // 4)})
            for index, value in enumerate(self.body_values):
                self.cpu.mem_write(self.local_block + index * 12,
                    bytes(self.cpu.mem_read(value, 12)))
        elif address == 0x10167ba0:
            prop = cpu.reg_read(native_module.UC_X86_REG_ECX)
            self.frame_events.append({'op': 'destroy', 'field': self.properties[prop],
                'callerParameter': self.words(self.params),
                'callerReturn': self.words(self.params + 12) if self.has_return else None})
        return super().on_instruction(cpu, address, size, data)

    def event(self, pending, native_index, has_return=False):
        self.has_return = has_return
        self.param_bytes = 24 if has_return else 12
        # New code address per case avoids reusing Unicorn's translated block.
        self.pending = self.alloc(16)
        self.cpu.mem_write(self.pending, b'\xb8' + struct.pack('<I', pending) + b'\xc3')
        actor = self.alloc(0x40)
        vtable = self.alloc(0x40)
        self.write(vtable + 0x2c, 'I', self.pending)
        self.write(actor, 'I', vtable)
        function = self.alloc(0x80)
        self.write(function + 0x3c, 'I', 36)
        self.write(function + 0x70, 'H', native_index)
        self.write(function + 0x76, 'H', self.param_bytes)
        self.write(function + 0x78, 'H', 12 if has_return else 0xffff)
        self.write(function + 0x7c, 'I', self.body)
        chain = []
        names = ['parameter', 'return', 'local0'] if has_return else ['parameter', 'local0', 'local1']
        for index, name in enumerate(names):
            prop = self.property(destroy_module.STR_VTABLE,
                **{'0x34': 1, '0x38': 12, '0x48': index * 12})
            self.properties[prop] = name
            chain.append(prop)
        self.write(function + 0x68, 'I', chain[0])
        for first, second in zip(chain, chain[1:]):
            self.write(first + 0x54, 'I', second)
        self.params = self.alloc(self.param_bytes)
        self.cpu.mem_write(self.params, bytes(self.cpu.mem_read(self.fstring('input'), 12)))
        if has_return:
            self.cpu.mem_write(self.params + 12,
                bytes(self.cpu.mem_read(self.fstring('initial return'), 12)))
        initial = self.words(self.params)
        self.body_values = [self.fstring(text) for text in ['changed', 'first', 'second']]
        expected = [self.words(value) for value in self.body_values]
        self.write(0x101e5540, 'I', 1)
        self.write(0x101e556c, 'I', 0)
        self.frame_events = []
        self.events = []
        self.local_block = None
        self.call(0x1013f7d0, actor, struct.pack('<III', function, self.params, 0))
        return {'pendingKill': pending, 'nativeIndex': native_index,
            'initialParameter': initial, 'bodyValues': expected,
            'events': self.frame_events, 'allocatorEvents': self.events,
            'parameterAfter': self.words(self.params),
            'returnAfter': self.words(self.params + 12) if has_return else None,
            'localsAfter': self.words(self.local_block, 9) if self.local_block else None,
            'depthAfter': self.read(0x101e556c, 'I')[0]}


if __name__ == '__main__':
    probe = FrameProbe(Path(sys.argv[1]))
    print(json.dumps({'cases': [probe.event(pending, native_index)
        for pending, native_index in [(0, 0), (1, 1), (0, 1), (0x10000, 0)]],
        'returnCase': probe.event(0, 0, True)}))
