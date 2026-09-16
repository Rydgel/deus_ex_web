"""Shared Unicorn probe for the recovered Extension UGC drawing-state natives.

Maps hash-checked Extension.dll (rebased to 0x12000000) plus Core.dll and
Engine.dll at their preferred bases (from the NativeCollision base).  The
probe can execute both halves of a native: the registered exec trampoline
(param marshalling) and the real method body it tail-calls.

Exec runs use a fake FFrame: frame+0x8 is the object (`this`), frame+0xc is
a code pointer into a scratch byte buffer whose first byte is the token the
trampoline dispatches on.  The Extension IAT slot 0x12059064 (the
Core!GNatives import) is overwritten with a fake table whose every entry
points at a stub this probe intercepts, so `call [GNatives + token*4]`
lands here: the stub writes the per-case param dword through the result
pointer (or, for an out-param spec, sets the Core GPropAddr global reached
through IAT slot 0x120590d0 to the case out-slot address) and returns
popping 8 like the real thiscall expression evaluators.  Exec bodies are
`ret 8` over (frame, result).

Method runs call the recovered body directly (thiscall, `ret 4` per arg).

UGC object image: 0xb8 bytes padded to 0x100, filled with a per-case fill
byte (default 0xa5) so untouched bytes stay visible, then every field the
spec names is written as a raw bit pattern (ints for u32/u8, float fields
as 'bits' ints).  dump_state returns every layout field as raw bits keyed
by the model names plus the raw 0x28..0xb8 hex so the validator catches
stray writes.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys


_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
IMAGES = {
    'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE},
}

EXT = EXTENSION_BASE  # rebased rva -> address helper base
IMAGE_BASE = 0x10000000

# Exec trampolines / method bodies (rebased).
NATIVES = {
    'enableSmoothing':           {'exec': EXT + 0x2b030, 'method': EXT + 0x270e0, 'kind': 'void'},
    'isSmoothingEnabled':        {'exec': EXT + 0x2b0a0, 'method': None,          'kind': 'execInt'},
    'enableDrawing':             {'exec': EXT + 0x2b190, 'method': EXT + 0x27280, 'kind': 'void'},
    'isDrawingEnabled':          {'exec': EXT + 0x2b200, 'method': None,          'kind': 'execInt'},
    'enableMasking':             {'exec': EXT + 0x2b240, 'method': EXT + 0x272a0, 'kind': 'void'},
    'isMaskingEnabled':          {'exec': EXT + 0x2b2b0, 'method': None,          'kind': 'execInt'},
    'enableTranslucency':        {'exec': EXT + 0x2b2f0, 'method': EXT + 0x27330, 'kind': 'void'},
    'isTranslucencyEnabled':     {'exec': EXT + 0x2b360, 'method': None,          'kind': 'execInt'},
    'enableModulation':          {'exec': EXT + 0x2b3a0, 'method': EXT + 0x273c0, 'kind': 'void'},
    'isModulationEnabled':       {'exec': EXT + 0x2b410, 'method': None,          'kind': 'execInt'},
    'enableTranslucentText':     {'exec': EXT + 0x2b610, 'method': EXT + 0x27610, 'kind': 'void'},
    'isTranslucentTextEnabled':  {'exec': EXT + 0x2b680, 'method': None,          'kind': 'execInt'},
    'enableWordWrap':            {'exec': EXT + 0x2bd90, 'method': EXT + 0x27720, 'kind': 'void'},
    'isWordWrapEnabled':         {'exec': EXT + 0x2be00, 'method': None,          'kind': 'execInt'},
    'enableSpecialText':         {'exec': EXT + 0x2be40, 'method': EXT + 0x27740, 'kind': 'void'},
    'isSpecialTextEnabled':      {'exec': EXT + 0x2beb0, 'method': None,          'kind': 'execInt'},
    'setStyle':                  {'exec': EXT + 0x2b0e0, 'method': EXT + 0x27170, 'kind': 'void'},
    'getStyle':                  {'exec': EXT + 0x2b150, 'method': None,          'kind': 'execByte'},
    'setTileColor':              {'exec': EXT + 0x2b450, 'method': EXT + 0x274f0, 'kind': 'void'},
    'getTileColor':              {'exec': EXT + 0x2b4b0, 'method': None,          'kind': 'execOut'},
    'setTextColor':              {'exec': EXT + 0x2b530, 'method': EXT + 0x27580, 'kind': 'void'},
    'getTextColor':              {'exec': EXT + 0x2b590, 'method': None,          'kind': 'execOut'},
    'setFont':                   {'exec': EXT + 0x2b6c0, 'method': EXT + 0x27640, 'kind': 'void'},
    'setNormalFont':             {'exec': EXT + 0x2b730, 'method': EXT + 0x27660, 'kind': 'void'},
    'setBoldFont':               {'exec': EXT + 0x2b7a0, 'method': EXT + 0x27670, 'kind': 'void'},
    'setFonts':                  {'exec': EXT + 0x2b810, 'method': EXT + 0x27640, 'kind': 'void'},
    'getFonts':                  {'exec': EXT + 0x2b8a0, 'method': None,          'kind': 'outs',
                                  'outs': ['normalFont', 'boldFont']},
    'setBaselineData':           {'exec': EXT + 0x2b970, 'method': EXT + 0x27680, 'kind': 'void'},
    'setTextVSpacing':           {'exec': EXT + 0x2ba00, 'method': EXT + 0x276a0, 'kind': 'void'},
    'getTextVSpacing':           {'exec': EXT + 0x2ba70, 'method': None,          'kind': 'execFloat'},
    'setHorizontalAlignment':    {'exec': EXT + 0x2bab0, 'method': EXT + 0x276b0, 'kind': 'void'},
    'getHorizontalAlignment':    {'exec': EXT + 0x2bb20, 'method': None,          'kind': 'execByte'},
    'setVerticalAlignment':      {'exec': EXT + 0x2bb60, 'method': EXT + 0x276c0, 'kind': 'void'},
    'getVerticalAlignment':      {'exec': EXT + 0x2bbd0, 'method': None,          'kind': 'execByte'},
    'setAlignments':             {'exec': EXT + 0x2bc10, 'method': EXT + 0x276d0, 'kind': 'void'},
    'getAlignments':             {'exec': EXT + 0x2bcb0, 'method': EXT + 0x276f0, 'kind': 'outs',
                                  'outs': ['hAlign', 'vAlign']},
}

# Extension IAT slots: Core GNatives table import and Core GPropAddr import.
GNATIVES_IAT = EXT + 0x59064
GPROPADDR_IAT = EXT + 0x590d0

# UGC field layout: name -> (offset, struct fmt).  All values are raw bit
# patterns; '4I' fields take a list of four dword bit patterns.
GC_FIELDS = {
    'vtable':         (0x00, 'I'),
    'canvas':         (0x28, 'I'),
    'originX':        (0x2c, 'I'),
    'originY':        (0x30, 'I'),
    'clipX':          (0x34, 'I'),
    'clipY':          (0x38, 'I'),
    'clipWidth':      (0x3c, 'I'),
    'clipHeight':     (0x40, 'I'),
    'style':          (0x44, 'B'),
    'flags':          (0x48, 'I'),
    'polyFlags':      (0x4c, 'I'),
    'textPolyFlags':  (0x50, 'I'),
    'tileColor':      (0x54, 'I'),
    'tileFloats':     (0x58, '4I'),
    'textColor':      (0x68, 'I'),
    'textFloats':     (0x6c, '4I'),
    'normalFont':     (0x7c, 'I'),
    'boldFont':       (0x80, 'I'),
    'unknown84':      (0x84, 'I'),
    'underlineHeight': (0x88, 'I'),
    'baselineOffset': (0x8c, 'I'),
    'textVSpacing':   (0x90, 'I'),
    'hAlign':         (0x94, 'B'),
    'vAlign':         (0x95, 'B'),
    'textFlags':      (0x98, 'I'),
    'unknown9c':      (0x9c, 'I'),
    'unknownA0':      (0xa0, 'I'),
    'nodeFlags':      (0xa4, 'I'),
    'depth':          (0xa8, 'I'),
    'stackTop':       (0xac, 'I'),
    'freeList':       (0xb0, 'I'),
    'owner':          (0xb4, 'I'),
}

from unicorn.x86_const import (  # noqa: E402
    UC_X86_REG_EIP, UC_X86_REG_ESP,
)


class GcProbe(_NATIVE.NativeCollision):
    """Run one UGC drawing-state body against a constructed object image."""

    def __init__(self, root):
        super().__init__(Path(root), IMAGES)
        self.events = []
        self.exec_params = []
        self.out_refs = []

        # Fake GNatives table: every token dispatches to the eval stub, which
        # the code hook services with the per-case param dwords.
        self.gnative_stub = self.alloc(16)
        self.cpu.mem_write(self.gnative_stub, b'\xc3')
        self.gnatives = self.alloc(0x400)
        for i in range(0x100):
            self.write(self.gnatives + 4 * i, 'I', self.gnative_stub)
        self.write(GNATIVES_IAT, 'I', self.gnatives)

        # Core GPropAddr global (the address the IAT slot was bound to); an
        # out-param eval sets it to the case out-slot instead of writing the
        # result pointer.
        self.gprop_global = self.read(GPROPADDR_IAT, 'I')[0]
        self.out_slot = self.alloc(0x40)

    # ----- thiscall leaf returns -------------------------------------------
    @staticmethod
    def _cdecl_return(cpu, stack, arg_bytes=0):
        ret = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + arg_bytes)
        cpu.reg_write(UC_X86_REG_EIP, ret)

    # ----- leaf dispatch -----------------------------------------------------
    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address in self.thunks:
            raise RuntimeError(
                f'Unresolved import {self.thunks[address]}; trace {list(self.trace)}')
        self.trace.append(hex(address))
        if address == self.gnative_stub:
            self.on_gnative(cpu)

    def on_gnative(self, cpu):
        """Model one param expression eval: (ecx=object, frame, resultPtr)."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        _frame, result_ptr = self.read(stack + 4, '2I')
        if not self.exec_params:
            raise RuntimeError('GNatives eval with no configured param')
        spec = self.exec_params.pop(0)
        if isinstance(spec, dict):
            if 'out' in spec:
                self.write(self.gprop_global, 'I', spec['out'])
            elif 'value' in spec:
                self.write(result_ptr, 'I', spec['value'] & 0xffffffff)
            else:
                raise ValueError('unsupported exec param spec %r' % (spec,))
        else:
            self.write(result_ptr, 'I', spec & 0xffffffff)
        self._cdecl_return(cpu, stack, 8)

    # ----- object image ------------------------------------------------------
    def gc_object(self, spec):
        this = self.alloc(0x100)
        fill = spec.get('fill', 0xa5) & 0xff
        self.cpu.mem_write(this, bytes([fill]) * 0x100)
        for name, (offset, fmt) in GC_FIELDS.items():
            if name not in spec:
                continue
            value = spec[name]
            if fmt == '4I':
                self.write(this + offset, '4I',
                           *[v & 0xffffffff for v in value])
            elif fmt == 'B':
                self.write(this + offset, 'B', value & 0xff)
            else:
                self.write(this + offset, 'I', value & 0xffffffff)
        return this

    # ----- canonical dump ----------------------------------------------------
    def dump_state(self, this):
        state = {}
        for name, (offset, fmt) in GC_FIELDS.items():
            if fmt == '4I':
                state[name] = list(self.read(this + offset, '4I'))
            elif fmt == 'B':
                state[name] = self.read(this + offset, 'B')[0]
            else:
                state[name] = self.read(this + offset, 'I')[0]
        state['raw'] = bytes(self.cpu.mem_read(this + 0x28, 0x90)).hex()
        return state

    # ----- case drivers --------------------------------------------------------
    def _alloc_out(self, spec):
        """Allocate a 4-byte out slot for a {'out': init} arg spec."""
        slot = self.alloc(4)
        init = spec.get('out')
        self.write(slot, 'I', (init or 0) & 0xffffffff)
        return slot

    def run_method(self, native, this, args):
        body = NATIVES[native]['method']
        self.out_refs = []
        words = []
        for a in args:
            if isinstance(a, dict) and 'out' in a:
                slot = self._alloc_out(a)
                self.out_refs.append(slot)
                words.append(slot)
            else:
                self.out_refs.append(None)
                words.append((a & 0xffffffff) if not isinstance(a, dict)
                             else a['value'] & 0xffffffff)
        return self.call(body, this, struct.pack('<%dI' % len(words), *words))

    def run_exec(self, native, this, args):
        frame = self.alloc(0x20)
        self.cpu.mem_write(frame, b'\0' * 0x20)
        code = self.alloc(0x40)
        self.cpu.mem_write(code, b'\x1c' * 0x40)  # token byte for every position
        self.write(frame + 8, 'I', this)
        self.write(frame + 0xc, 'I', code)
        self.exec_params = []
        self.out_refs = []
        for a in args:
            if isinstance(a, dict) and 'out' in a:
                slot = self._alloc_out(a)
                self.exec_params.append({'out': slot})
                self.out_refs.append(slot)
            else:
                self.exec_params.append(a)
                self.out_refs.append(None)
        out = self.alloc(4)
        self.write(out, 'I', 0xdeadbeef)
        ret = self.call(NATIVES[native]['exec'], this,
                        struct.pack('<II', frame, out))
        return ret, out

    def _out_result(self, native):
        """Read the recorded out slots into the native's result shape."""
        names = NATIVES[native].get('outs')
        if names:
            return {names[i]: (self.read(slot, 'I')[0] if slot else None)
                    for i, slot in enumerate(self.out_refs[:len(names)])}
        for slot in self.out_refs:
            if slot:
                return self.read(slot, 'I')[0]
        return None

    def run_case(self, native, case):
        this = self.gc_object(case['spec'])
        self.events = []
        mode = case.get('mode', 'exec')
        kind = NATIVES[native]['kind']
        args = case.get('args', [])
        if mode == 'method':
            ret = self.run_method(native, this, args)
            result = self._out_result(native) if kind in ('outs', 'execOut') else None
            out = {'result': result, 'rawEax': ret}
        else:
            ret, out_addr = self.run_exec(native, this, args)
            if kind == 'execInt':
                out = {'ret': ret, 'result': self.read(out_addr, 'i')[0]}
            elif kind == 'execByte':
                out = {'ret': ret, 'result': self.read(out_addr, 'B')[0]}
            elif kind == 'execFloat':
                out = {'ret': ret, 'result': self.read(out_addr, 'I')[0]}
            elif kind in ('outs', 'execOut'):
                out = {'ret': ret, 'result': self._out_result(native)}
            else:
                out = {'result': None, 'rawEax': ret}
        out['events'] = list(self.events)
        out['state'] = self.dump_state(this)
        return out


def oracle_main(native_name, root=None):
    """Shared per-native driver: replay every JSON case through the real body."""
    probe = GcProbe(Path(root or sys.argv[1]))
    cases = json.loads(
        (Path(__file__).parent / 'gc-cases.json').read_text())[native_name]
    entry = NATIVES[native_name]
    results = {}
    for name, case in cases.items():
        if case.get('mode', 'exec') == 'method' and entry['method'] is None:
            raise ValueError('%s has no method body' % native_name)
        results[name] = probe.run_case(native_name, case)
    print(json.dumps({
        'hashes': {'Extension.dll': EXTENSION_HASH,
                   'Core.dll': _NATIVE.HASHES['Core.dll'],
                   'Engine.dll': _NATIVE.HASHES['Engine.dll']},
        'extensionBase': EXTENSION_BASE,
        'execBody': (entry['exec'] - EXT) + IMAGE_BASE,
        'methodBody': (entry['method'] - EXT) + IMAGE_BASE if entry['method'] else None,
        'cases': results,
    }))
