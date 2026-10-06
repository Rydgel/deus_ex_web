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
    'intersect':                 {'exec': EXT + 0x2af40, 'method': EXT + 0x27000, 'kind': 'void'},
    'copyGC':                    {'exec': EXT + 0x2bef0, 'method': EXT + 0x27760, 'kind': 'void'},
    'pushGC':                    {'exec': EXT + 0x2bf60, 'method': EXT + 0x278d0, 'kind': 'execInt'},
    # PopGC's method pair is contiguous: PopGC(-1) at 0x100279f0 then
    # RestoreGC(n) at 0x10027a80.  Method-mode cases call RestoreGC directly
    # ('method'); 'methodBody' is the reported span start used by oracle_main.
    'popGC':                     {'exec': EXT + 0x2bfa0, 'method': EXT + 0x27a80,
                                  'methodBody': EXT + 0x279f0, 'kind': 'void'},
}

# Extension IAT slots: Core GNatives table import and Core GPropAddr import.
GNATIVES_IAT = EXT + 0x59064
GPROPADDR_IAT = EXT + 0x590d0

# Extension IAT slots the state-stack allocator model intercepts (Core bound
# imports; the slots are overwritten with scratch stubs the code hook serves).
STATIC_ALLOC_IAT = EXT + 0x5906c   # UObject::StaticAllocateObject (cdecl, caller cleans)
UOBJECT_CTOR_IAT = EXT + 0x5907c   # UObject::UObject (thiscall, no args)
FNAME_CTOR_IAT = EXT + 0x59124     # FName::FName(EName) (thiscall, 1 arg)
# 0x10059070 (GError data import) needs no interception: the operator-new
# wrapper 0x10002c40 only reads through it.
UGC_CLASS = EXT + 0xa28c8          # &UGC::PrivateStaticClass
UGC_VTABLE = EXT + 0x598dc

# Pointer fields canonicalised in graph-mode dumps.
GC_PTR_FIELDS = frozenset(('vtable', 'canvas', 'normalFont', 'boldFont',
                           'stackTop', 'freeList', 'owner'))

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
    UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP,
)


class GcProbe(_NATIVE.NativeCollision):
    """Run one UGC drawing-state body against a constructed object image."""

    def __init__(self, root):
        super().__init__(Path(root), IMAGES)
        # GC natives run from DrawWindow during PaintWindows, inside the render
        # pass (PostRenderFlash -> PostRenderWindows): precision control 24
        # (0x007f) unless ORACLE_CW says otherwise.
        self.control_word = _NATIVE.render_control_word(0x007f)
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

        # Allocator model for PushGC: the Core imports used on the allocation
        # path are replaced with scratch stubs the code hook services.
        # StaticAllocateObject is cdecl (the operator-new wrapper cleans its
        # seven args with `add esp,0x1c`), so its stub must not pop them; the
        # ctor leaves are thiscall and pop their own args.
        self.static_alloc_stub = self._stub()
        self.write(STATIC_ALLOC_IAT, 'I', self.static_alloc_stub)
        self.uobject_ctor_stub = self._stub()
        self.write(UOBJECT_CTOR_IAT, 'I', self.uobject_ctor_stub)
        self.fname_ctor_stub = self._stub()
        self.write(FNAME_CTOR_IAT, 'I', self.fname_ctor_stub)

        self.cur_this = 0
        self.node_addrs = []
        self.has_nodes = False
        self.block_ids = {}
        self.blocks = {}
        self.seen_ids = {}
        self.alloc_returns_null = False

    def _stub(self):
        stub = self.alloc(16)
        self.cpu.mem_write(stub, b'\xc3')
        return stub

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
        elif address == self.static_alloc_stub:
            self.on_static_alloc(cpu)
        elif address == self.uobject_ctor_stub:
            self.on_uobject_ctor(cpu)
        elif address == self.fname_ctor_stub:
            self.on_fname_ctor(cpu)

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

    # ----- allocator-model leaves --------------------------------------------
    def on_static_alloc(self, cpu):
        """UObject::StaticAllocateObject(Class, Outer, Name, SetFlags,
        Template, Error, Ptr) -- cdecl; the caller cleans all 7 args."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        cls, outer, name, set_flags, template, _error, ptr = \
            self.read(stack + 4, '7I')
        self.events.append({'op': 'StaticAllocateObject',
                            'class': self.canon(cls),
                            'outer': self.canon(outer),
                            'name': name,
                            'setFlags': set_flags,
                            'template': self.canon(template),
                            'ptr': self.canon(ptr)})
        address = 0
        if not self.alloc_returns_null:
            address = self.alloc(0x100)
            self.cpu.mem_write(address, b'\0' * 0x100)
            self.block_ids[address] = 'h%d' % len(self.block_ids)
            self.blocks[address] = 0xb8
        cpu.reg_write(UC_X86_REG_EAX, address)
        self._cdecl_return(cpu, stack)

    def on_uobject_ctor(self, cpu):
        """UObject::UObject() -- thiscall with no stack args."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        self.events.append({'op': 'UObject::UObject',
                            'object': self.canon(cpu.reg_read(UC_X86_REG_ECX))})
        self._cdecl_return(cpu, stack)

    def on_fname_ctor(self, cpu):
        """FName::FName(EName) -- thiscall with one arg; writes the name index
        into *ecx (records no event)."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        ename = self.read(stack + 4, 'I')[0]
        self.write(cpu.reg_read(UC_X86_REG_ECX), 'I', ename)
        self._cdecl_return(cpu, stack, 4)

    def canon(self, ptr):
        """Stable pointer label shared with the JS heap: 'this' for the case
        object, 'n<i>' for spec nodes, 'h<N>' for StaticAllocateObject blocks,
        'a<N>' for anything else in encounter order."""
        if not ptr:
            return 0
        if ptr in (UGC_VTABLE, IMAGE_BASE + 0x598dc):
            return 'UGC::vtable'
        if ptr in (UGC_CLASS, IMAGE_BASE + 0xa28c8):
            return 'UGC::PrivateStaticClass'
        if ptr == self.cur_this:
            return 'this'
        if ptr in self.node_addrs:
            return 'n%d' % self.node_addrs.index(ptr)
        if ptr in self.block_ids:
            return self.block_ids[ptr]
        if ptr in self.seen_ids:
            return self.seen_ids[ptr]
        label = 'a%d' % len(self.seen_ids)
        self.seen_ids[ptr] = label
        return label

    # ----- object image ------------------------------------------------------
    def _resolve_ref(self, value):
        """Resolve {'node': i} / 'this' case-spec references to addresses."""
        if isinstance(value, dict) and 'node' in value:
            return self.node_addrs[value['node']]
        if value == 'this':
            return self.cur_this
        return value

    def _write_fields(self, base, fields):
        for name, (offset, fmt) in GC_FIELDS.items():
            if name not in fields:
                continue
            value = self._resolve_ref(fields[name])
            if fmt == '4I':
                self.write(base + offset, '4I',
                           *[v & 0xffffffff for v in value])
            elif fmt == 'B':
                self.write(base + offset, 'B', value & 0xff)
            else:
                self.write(base + offset, 'I', value & 0xffffffff)

    def gc_object(self, spec):
        node_specs = spec.get('nodes')
        this = self.alloc(0x100)
        self.cur_this = this
        self.node_addrs = [self.alloc(0x100) for _ in node_specs or ()]
        self.has_nodes = node_specs is not None
        fill = spec.get('fill', 0xa5) & 0xff
        self.cpu.mem_write(this, bytes([fill]) * 0x100)
        for node in self.node_addrs:
            self.cpu.mem_write(node, bytes([fill]) * 0x100)
        self._write_fields(this, spec)
        for addr, fields in zip(self.node_addrs, node_specs or ()):
            self._write_fields(addr, fields)
        return this

    # ----- canonical dump ----------------------------------------------------
    def _dump_object(self, base, canon_ptrs):
        state = {}
        for name, (offset, fmt) in GC_FIELDS.items():
            if fmt == '4I':
                state[name] = list(self.read(base + offset, '4I'))
            elif fmt == 'B':
                state[name] = self.read(base + offset, 'B')[0]
            else:
                value = self.read(base + offset, 'I')[0]
                state[name] = (self.canon(value)
                               if canon_ptrs and name in GC_PTR_FIELDS else value)
        raw = bytearray(self.cpu.mem_read(base + 0x28, 0x90))
        if canon_ptrs:
            # Raw addresses differ between the oracle heap and the JS heap;
            # the canonicalised pointer fields carry the graph identity, so
            # the pointer slots are zeroed in the hex.
            for name in GC_PTR_FIELDS:
                offset = GC_FIELDS[name][0]
                if 0x28 <= offset <= 0xb4:
                    raw[offset - 0x28:offset - 0x24] = b'\0' * 4
        state['raw'] = raw.hex()
        return state

    def dump_state(self, this):
        """Flat dump for plain specs; graph dump when the spec declared nodes
        or the run allocated blocks: 'this', every spec node (n<i>), every
        extra node reachable through the stackTop/freeList +0xac chains, and
        every StaticAllocateObject block, with pointer fields canonicalised
        and the pointer slots zeroed in the raw hex."""
        if not self.has_nodes and not self.block_ids:
            return self._dump_object(this, False)
        state = {'this': self._dump_object(this, True), 'nodes': {}}
        seen = {this}
        for i, addr in enumerate(self.node_addrs):
            seen.add(addr)
            state['nodes']['n%d' % i] = self._dump_object(addr, True)
        for chain in (0xac, 0xb0):
            addr = self.read(this + chain, 'I')[0]
            while addr and addr not in seen:
                seen.add(addr)
                state['nodes'][self.canon(addr)] = self._dump_object(addr, True)
                addr = self.read(addr + 0xac, 'I')[0]
        for addr, label in self.block_ids.items():
            if addr not in seen:
                state['nodes'][label] = self._dump_object(addr, True)
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
        self.seen_ids = {}
        self.block_ids = {}
        self.blocks = {}
        self.alloc_returns_null = bool(case['spec'].get('allocReturnsNull'))
        this = self.gc_object(case['spec'])
        self.events = []
        mode = case.get('mode', 'exec')
        kind = NATIVES[native]['kind']
        args = [self._resolve_ref(a) for a in case.get('args', [])]
        if mode == 'method':
            ret = self.run_method(native, this, args)
            if kind in ('outs', 'execOut'):
                result = self._out_result(native)
            elif kind == 'execInt':
                result = ret
            else:
                result = None
            out = {'result': result, 'rawEax': ret, 'ret': ret}
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
        'methodBody': ((entry.get('methodBody', entry['method']) - EXT) + IMAGE_BASE
                       if entry['method'] else None),
        'cases': results,
    }))
