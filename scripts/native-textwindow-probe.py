"""Shared Unicorn probe for the recovered Extension XTextWindow /
XTextLogWindow / XLargeTextWindow text-display model.

Maps hash-checked Extension.dll (rebased to 0x12000000), Core.dll and the
shipped MSVCRT.dll so the real FArray helpers, FString::Mid, appStrlen /
appStrcpy / appStricmp and the SEH funclets execute unchanged.  The engine
allocator (Core GMalloc global, reached through the Extension IAT) is
modelled by a probe FMalloc whose Malloc / Realloc / Free virtual slots are
intercepted and serviced from the probe heap; every allocator call is
recorded as an event.

Leaves intercepted (all other code executes the real bodies):
  * AskParentForReconfigure 0x1004e060   -> event {op:'AskParentForReconfigure'}
  * GetTime leaf 0x1004fda0              -> patched `push; push; fld qword
    [esp]; add esp,8; ret` stub returning the per-case `now` double in ST0
    (the real leaf reaches rdtsc through 0x1003a3b0 and is nondeterministic)
  * GNatives readers (Core ?GNatives@@ table at 0x101f41b8) -> positional
    marshal queue.  The table is runtime-initialised by Core process startup
    (the file image is zero-filled), so parameter marshalling is a documented
    boundary: a dword reader writes the marshalled word; the out-string
    reader deep-copies the destination FString into the exec local and sets
    GPropAddr, which is exactly the observed contract the exec bodies use.
  * Extension atexit thunk 0x100546da    -> 0 (cdecl no-op)
  * Core appFailAssert                   -> oracle failure

exec bodies run as the real code for GetText, GetTextLength, GetTextPart and
PauseLog (the whole native is the exec trampoline).  For SetText / AppendText
the oracle replays the exec's own sequence: convertPipes (0x10050710) on the
string argument, then the real method body — matching how the dispatch table
drives it.

Window fields used (docs/script-text-model.md):
  +0x28 windowType byte, +0xb4 accelKey dword,
  +0x138 parent, +0x14c/+0x14d h/v alignment bytes, +0x150 textFlags
  (bit0 wordWrap, bit1 textAccelerator), +0x154/+0x158 h/v margins (f32),
  +0x15c/+0x160 min/max lines (i32), +0x164 minWidth (f32),
  +0x168/+0x16c/+0x170 text FString, +0x174 spacing f32 (XTextLogWindow
  textTimeout / XLargeTextWindow vertical spacing — shared slot),
  +0x178/+0x17c/+0x180 log line TArray of 0x14-byte records
  {expire f32, FString text, color}, +0x184 logFlags (bit2 pause),
  +0x584 accelerator-dirty flag on the first ancestor with windowType >= 2.
Process globals: shared empty wstring 0x10099ea8, log separator 0x10098e58
(L"\\n"), convertPipes static 0x100aead0 + flag 0x100aeac8 + run scratch
0x100add98, Core GPropAddr 0x101e32f8, Core GNatives 0x101f41b8.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE
from unicorn.x86_const import (
    UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP,
)


_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
MSVCRT_HASH = 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210'
IMAGES = {
    'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE},
    'MSVCRT.dll': MSVCRT_HASH,
}

EXT = EXTENSION_BASE  # rebased rva -> address helper base

# Every native runs its real GNatives exec trampoline so the marshal itself is
# exercised: the masking on byte params (SetTextAlignments &0xff), the dword
# prefills, the exec-local FString copy/teardown allocator traffic for the
# string marshals, and the frame->Code advancement (one opcode byte per
# marshalled param plus the result-eat) are all observable.
NATIVES = {
    'SetText': {'mode': 'exec', 'body': EXT + 0x46a30, 'kind': 'execVoid'},
    'AppendText': {'mode': 'exec', 'body': EXT + 0x46b80, 'kind': 'execVoid'},
    'GetText': {'mode': 'exec', 'body': EXT + 0x46cd0, 'kind': 'execString'},
    'GetTextLength': {'mode': 'exec', 'body': EXT + 0x46d70, 'kind': 'execInt'},
    'GetTextPart': {'mode': 'exec', 'body': EXT + 0x46dc0, 'kind': 'execPart'},
    'SetWordWrap': {'mode': 'exec', 'body': EXT + 0x46f90, 'kind': 'execVoid'},
    'SetTextAlignments': {'mode': 'exec', 'body': EXT + 0x47000, 'kind': 'execVoid'},
    'SetTextMargins': {'mode': 'exec', 'body': EXT + 0x470a0, 'kind': 'execVoid'},
    'SetLines': {'mode': 'exec', 'body': EXT + 0x47130, 'kind': 'execVoid'},
    'SetMinLines': {'mode': 'exec', 'body': EXT + 0x471c0, 'kind': 'execVoid'},
    'SetMaxLines': {'mode': 'exec', 'body': EXT + 0x47230, 'kind': 'execVoid'},
    'ResetLines': {'mode': 'exec', 'body': EXT + 0x472a0, 'kind': 'execVoid'},
    'SetMinWidth': {'mode': 'exec', 'body': EXT + 0x472d0, 'kind': 'execVoid'},
    'ResetMinWidth': {'mode': 'exec', 'body': EXT + 0x47340, 'kind': 'execVoid'},
    'EnableTextAsAccelerator': {'mode': 'exec', 'body': EXT + 0x47370, 'kind': 'execVoid'},
    'AddLog': {'mode': 'exec', 'body': EXT + 0x48010, 'kind': 'execVoid'},
    'ClearLog': {'mode': 'exec', 'body': EXT + 0x48170, 'kind': 'execVoid'},
    'SetTextTimeout': {'mode': 'exec', 'body': EXT + 0x481a0, 'kind': 'execVoid'},
    'PauseLog': {'mode': 'exec', 'body': EXT + 0x48210, 'kind': 'execVoid'},
    'SetVerticalSpacing': {'mode': 'exec', 'body': EXT + 0x2e7b0, 'kind': 'execVoid'},
}

# The SetText/AppendText execs dispatch through the object vtable at +0x11c /
# +0x120 after marshalling; window() plants a fake vtable holding the real
# method bodies so the virtual calls resolve to original code.
VTABLE_SETTEXT = EXT + 0x45d50
VTABLE_APPENDTEXT = EXT + 0x45e60

# Intercepted / patched leaves.
ASK_RECONFIGURE = EXT + 0x4e060
ATEXIT_THUNK = EXT + 0x546da
GET_TIME = EXT + 0x4fda0

# Extension IAT slots.
GMALLOC_IAT = EXT + 0x59060
FAIL_ASSERT_IAT = EXT + 0x59098
GNATIVES_IAT = EXT + 0x59064
GPROP_IAT = EXT + 0x590d0

# In-image scratch/static addresses.
EMPTY_WSTRING = EXT + 0x99ea8        # shared L"" buffer
LOG_SEPARATOR = EXT + 0x98e58        # L"\n" separator for log rebuild
CONVERT_BUFFER = EXT + 0xaead0       # exec convertPipes static FString
CONVERT_FLAG = EXT + 0xaeac8

# Object field offsets.
O = {
    'windowType': 0x28, 'accelKey': 0xb4,
    'parent': 0x138, 'hAlign': 0x14c, 'vAlign': 0x14d, 'textFlags': 0x150,
    'hMargin': 0x154, 'vMargin': 0x158,
    'minLines': 0x15c, 'maxLines': 0x160, 'minWidth': 0x164,
    'text': 0x168, 'textNum': 0x16c, 'textMax': 0x170,
    'lineSpacing': 0x174,
    'logData': 0x178, 'logNum': 0x17c, 'logMax': 0x180,
    'logFlags': 0x184, 'accelFlags': 0x584,
}
LOG_SIZE = 0x14            # {expire f32 @0, FString text @4, color @0x10}
WINDOW_SIZE = 0x600


class TextWindowProbe(_NATIVE.NativeCollision):
    """Run one text-window body against a constructed window image."""

    def __init__(self, root):
        super().__init__(Path(root), IMAGES)
        self.events = []
        self.blocks = {}           # live GMalloc ptr -> size
        self.block_ids = {}        # ptr -> 'h<N>' (Malloc event order)
        self.sizes = {}            # EVERY allocation's requested size
        self.freed = set()
        self.seen_ids = {}         # ptr -> 'a<N>' (dump encounter order)
        self.readers = []          # GNatives marshal queue for exec bodies

        # Fake FMalloc: object points at vtable; slots 0/4/8 intercepted.
        self.malloc_vtable = self.alloc(32)
        self.malloc_obj = self.alloc(16)
        self.malloc_stub = self.alloc(16)
        self.realloc_stub = self.alloc(16)
        self.free_stub = self.alloc(16)
        self.cpu.mem_write(self.malloc_stub, b'\xc3')
        self.cpu.mem_write(self.realloc_stub, b'\xc3')
        self.cpu.mem_write(self.free_stub, b'\xc3')
        self.write(self.malloc_vtable + 0, 'I', self.malloc_stub)
        self.write(self.malloc_vtable + 4, 'I', self.realloc_stub)
        self.write(self.malloc_vtable + 8, 'I', self.free_stub)
        self.write(self.malloc_obj, 'I', self.malloc_vtable)
        gmalloc_global = self.read(GMALLOC_IAT, 'I')[0]
        self.write(gmalloc_global, 'I', self.malloc_obj)

        # appFailAssert resolves to a real Core body; trap it so an assertion
        # surfaces as an explicit oracle failure instead of GError dereference.
        self.assert_addr = self.read(FAIL_ASSERT_IAT, 'I')[0]

        # The Core GNatives table (0x101f41b8) is runtime-initialised — the
        # file image is zero.  Populate all 256 entries with positional `ret 8`
        # stubs so exec parameter reads are serviced from the marshal queue.
        self.gnatives = self.read(GNATIVES_IAT, 'I')[0]
        self.gprop_addr = self.read(GPROP_IAT, 'I')[0]
        self.reader_stubs = self.alloc(0x400)
        for i in range(256):
            stub = self.reader_stubs + i * 4
            self.cpu.mem_write(stub, b'\xc2\x08\x00\x90')
            self.write(self.gnatives + i * 4, 'I', stub)

        # The base code hook raises on every unresolved import; this probe
        # installs its own dispatcher so the leaf stubs are serviced through
        # on_dispatch instead.
        self.cpu.hook_del(self.code_hook)
        self.cpu.hook_add(UC_HOOK_CODE, self.on_dispatch)

    # ----- allocator model -------------------------------------------------
    def alloc(self, size):
        address = super().alloc(size)
        self.sizes[address] = size
        return address

    def _track_alloc(self, size):
        address = self.alloc(max(size, 4))
        ident = 'h%d' % len(self.block_ids)
        self.block_ids[address] = ident
        self.blocks[address] = size
        return address, ident

    def fake_realloc(self, old, size, tag='FArray'):
        """The FMalloc::Realloc semantics for marshal-side copies: the GNatives
        out-string reader's FString assign allocates through GMalloc, so the
        event must land in the same stream the real allocator would emit."""
        if size == 0:
            if old:
                self.blocks.pop(old, None)
                self.freed.add(old)
            self.events.append({'op': 'Realloc', 'old': self.canon(old), 'size': 0,
                                'tag': tag, 'block': 0})
            return 0
        if old:
            old_size = self.sizes.get(old, 0)
            new, ident = self._track_alloc(size)
            keep = min(old_size, size)
            data = bytes(self.cpu.mem_read(old, keep)) if keep else b''
            if keep:
                self.cpu.mem_write(new, data)
            if size > keep:
                self.cpu.mem_write(new + keep, b'\0' * (size - keep))
            self.blocks.pop(old, None)
            self.freed.add(old)
            self.events.append({'op': 'Realloc', 'old': self.canon(old), 'size': size,
                                'tag': tag, 'block': ident})
            return new
        new, ident = self._track_alloc(size)
        self.events.append({'op': 'Realloc', 'old': 0, 'size': size,
                            'tag': tag, 'block': ident})
        return new

    def on_malloc(self, cpu):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        size, tag = self.read(stack + 4, '2I')
        address, ident = self._track_alloc(size)
        self.events.append({'op': 'Malloc', 'size': size, 'tag': self.wstring(tag),
                            'block': ident})
        cpu.reg_write(UC_X86_REG_EAX, address)
        self._cdecl_return(cpu, stack, 8)

    def on_realloc(self, cpu):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        old, size, tag = self.read(stack + 4, '3I')
        result = self.fake_realloc(old, size, self.wstring(tag))
        cpu.reg_write(UC_X86_REG_EAX, result)
        self._cdecl_return(cpu, stack, 12)

    def on_free(self, cpu):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        ptr = self.read(stack + 4, 'I')[0]
        self.events.append({'op': 'Free', 'block': self.canon(ptr)})
        self.blocks.pop(ptr, None)
        self.freed.add(ptr)
        self._cdecl_return(cpu, stack, 4)

    @staticmethod
    def _cdecl_return(cpu, stack, arg_bytes=0):
        # FMalloc vtable slots and the intercepted member functions are MSVC
        # thiscall: the callee pops its stack arguments.  arg_bytes models
        # that cleanup; cdecl leaves (atexit) stay caller-cleaned.
        ret = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + arg_bytes)
        cpu.reg_write(UC_X86_REG_EIP, ret)

    # ----- helpers ----------------------------------------------------------
    def canon(self, ptr):
        """Stable pointer label: GMalloc blocks keep their event id, everything
        else is labelled in encounter order so both runtimes agree."""
        if ptr == 0:
            return 0
        for base in list(self.block_ids):
            size = self.blocks.get(base, 0)
            if base <= ptr < base + max(size, 4):
                label = self.block_ids[base]
                if base not in self.blocks:
                    label += '!'
                return label + ('+%x' % (ptr - base) if ptr != base else '')
        if ptr in self.seen_ids:
            return self.seen_ids[ptr]
        label = 'a%d' % len(self.seen_ids)
        self.seen_ids[ptr] = label
        return label

    def wstring(self, address, limit=0x800):
        out = []
        for i in range(limit):
            ch = self.read(address + 2 * i, 'H')[0]
            if ch == 0:
                break
            out.append(ch)
        return ''.join(chr(c) for c in out)

    def write_wstring(self, text):
        data = text.encode('utf-16-le') + b'\0\0'
        address = self.alloc(len(data))
        self.cpu.mem_write(address, data)
        return address

    def patch_gettime(self, now):
        """Replace the GetTime leaf body with a stub that loads the configured
        f64 `now` into ST0: push hi; push lo; fld qword [esp]; add esp,8; ret.
        The real body calls appSecondsSlow (rdtsc) and is nondeterministic."""
        lo, hi = struct.unpack('<2I', struct.pack('<d', float(now)))
        stub = (b'\x68' + struct.pack('<I', hi) + b'\x68' + struct.pack('<I', lo)
                + b'\xdd\x04\x24\x83\xc4\x08\xc3')
        self.cpu.mem_write(GET_TIME, stub)

    def accel_root(self, this):
        """0x1004c580 walk: first ancestor (or self) with windowType >= 2."""
        addr = this
        while addr and self.read(addr + O['windowType'], 'B')[0] < 2:
            addr = self.read(addr + O['parent'], 'I')[0]
        return addr

    def on_dispatch(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        ent = self.thunks.get(address)
        if ent is not None:
            raise RuntimeError(f'Unresolved import {ent}; trace {list(self.trace)}')
        self.trace.append(hex(address))
        self.on_leaf(cpu, address, size, data)

    def on_param_read(self, cpu, out):
        """GNatives marshal queue: the real readers decode bytecode operands;
        here the case supplies the marshalled values positionally.  The
        out-string read deep-copies the destination FString into the exec
        local (one Realloc event) and records the lvalue in GPropAddr."""
        ent = self.readers.pop(0)
        if 'dword' in ent:
            self.write(out, 'I', ent['dword'] & 0xffffffff)
            return
        dest = ent['fstring']
        data, num, _maxn = self.read(dest, '3I') if dest else (0, 0, 0)
        self.write(out + 4, 'I', num)
        self.write(out + 8, 'I', num)
        old = self.read(out, 'I')[0]
        self.write(out, 'I', self.fake_realloc(old, num * 2))
        if num:
            self.cpu.mem_write(self.read(out, 'I')[0], bytes(self.cpu.mem_read(data, num * 2)))
        self.write(self.gprop_addr, 'I', dest)

    def on_leaf(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        if address == self.malloc_stub:
            self.on_malloc(cpu)
        elif address == self.realloc_stub:
            self.on_realloc(cpu)
        elif address == self.free_stub:
            self.on_free(cpu)
        elif self.reader_stubs <= address < self.reader_stubs + 0x400:
            frame, out = self.read(stack + 4, '2I')
            self.on_param_read(cpu, out)
            self._cdecl_return(cpu, stack, 8)
        elif address == ASK_RECONFIGURE:
            self.events.append({'op': 'AskParentForReconfigure',
                                'object': self.canon(cpu.reg_read(UC_X86_REG_ECX))})
            self._cdecl_return(cpu, stack)
        elif address == ATEXIT_THUNK:
            cpu.reg_write(UC_X86_REG_EAX, 0)
            self._cdecl_return(cpu, stack)
        elif address == self.assert_addr:
            expr, file_, line = self.read(stack + 4, '3I')
            raise RuntimeError('appFailAssert fired: line %d expr %s' % (line, expr))

    # ----- window construction ----------------------------------------------
    def fstring(self, text, maxn=None):
        if text is None:
            return (0, 0, 0)
        data = self.write_wstring(text)
        count = len(text) + 1
        return (data, count, maxn if maxn is not None else count)

    def window(self, spec):
        """Build an XTextWindow/XTextLogWindow/XLargeTextWindow image."""
        address = self.alloc(WINDOW_SIZE)
        self.cpu.mem_write(address, b'\0' * WINDOW_SIZE)

        # Fake vtable: only the two slots the SetText/AppendText execs read
        # (+0x11c / +0x120) resolve to the real method bodies.
        vtable = self.alloc(0x128)
        self.cpu.mem_write(vtable, b'\0' * 0x128)
        self.write(vtable + 0x11c, 'I', VTABLE_SETTEXT)
        self.write(vtable + 0x120, 'I', VTABLE_APPENDTEXT)
        self.write(address, 'I', vtable)

        tdata, tnum, tmax = self.fstring(spec.get('text'), spec.get('textMax'))
        self.write(address + O['text'], '3I', tdata, tnum, tmax)

        self.write(address + O['windowType'], 'B', spec.get('windowType', 0))
        self.write(address + O['accelKey'], 'I', spec.get('accelKey', 0))
        self.write(address + O['hAlign'], 'B', spec.get('hAlign', 0))
        self.write(address + O['vAlign'], 'B', spec.get('vAlign', 0))
        self.write(address + O['textFlags'], 'I', spec.get('textFlags', 0))
        self.write(address + O['hMargin'], 'I', spec.get('hMarginBits', 0))
        self.write(address + O['vMargin'], 'I', spec.get('vMarginBits', 0))
        self.write(address + O['minLines'], 'i', spec.get('minLines', -1))
        self.write(address + O['maxLines'], 'i', spec.get('maxLines', -1))
        self.write(address + O['minWidth'], 'I', spec.get('minWidthBits', 0))
        self.write(address + O['lineSpacing'], 'I', spec.get('lineSpacingBits', 0))
        self.write(address + O['logFlags'], 'I', spec.get('logFlags', 0))
        self.write(address + O['accelFlags'], 'I', spec.get('accelFlags', 0))

        log = spec.get('log', [])
        lcap = spec.get('logMax', len(log))
        ldata = self.alloc(LOG_SIZE * lcap) if lcap else 0
        for i, rec in enumerate(log):
            base = ldata + i * LOG_SIZE
            self.write(base, 'I', rec.get('expireBits', 0))
            rdata, rnum, rmax = self.fstring(rec.get('text'), rec.get('textMax'))
            self.write(base + 4, '3I', rdata, rnum, rmax)
            self.write(base + 0x10, 'I', rec.get('color', 0))
        self.write(address + O['logData'], '3I', ldata, len(log), lcap)

        parent = spec.get('parent', 0)
        if isinstance(parent, dict) or parent is True:
            parent = self.window(parent if isinstance(parent, dict) else {})
        self.write(address + O['parent'], 'I', parent)
        return address

    # ----- canonical dump ----------------------------------------------------
    def dump_fstring(self, address):
        data, num, maxn = self.read(address, '3I')
        return {'text': self.wstring(data) if data else None,
                'data': self.canon(data), 'num': num, 'max': maxn}

    def dump_log_record(self, address):
        expire = self.read(address, 'I')[0]
        color = self.read(address + 0x10, 'I')[0]
        return {'expire': expire, 'text': self.dump_fstring(address + 4),
                'color': color}

    def dump_state(self, this):
        ldata, lnum, lmax = self.read(this + O['logData'], '3I')
        log = [self.dump_log_record(ldata + i * LOG_SIZE)
               for i in range(lnum)] if ldata else []
        root = self.accel_root(this)
        return {
            'windowType': self.read(this + O['windowType'], 'B')[0],
            'accelKey': self.read(this + O['accelKey'], 'I')[0],
            'hAlign': self.read(this + O['hAlign'], 'B')[0],
            'vAlign': self.read(this + O['vAlign'], 'B')[0],
            'textFlags': self.read(this + O['textFlags'], 'I')[0],
            'hMargin': self.read(this + O['hMargin'], 'I')[0],
            'vMargin': self.read(this + O['vMargin'], 'I')[0],
            'minLines': self.read(this + O['minLines'], 'i')[0],
            'maxLines': self.read(this + O['maxLines'], 'i')[0],
            'minWidth': self.read(this + O['minWidth'], 'I')[0],
            'lineSpacing': self.read(this + O['lineSpacing'], 'I')[0],
            'logData': self.canon(ldata), 'logNum': lnum, 'logMax': lmax,
            'log': log,
            'logFlags': self.read(this + O['logFlags'], 'I')[0],
            'text': self.dump_fstring(this + O['text']),
            'parent': self.canon(self.read(this + O['parent'], 'I')[0]),
            'accelRoot': self.canon(root),
            'accelRootFlags': self.read(root + O['accelFlags'], 'I')[0] if root else 0,
            'convert': self.dump_fstring(CONVERT_BUFFER),
            'convertFlag': self.read(CONVERT_FLAG, 'B')[0],
            'gprop': self.canon(self.read(self.gprop_addr, 'I')[0]),
        }

    # ----- marshalling -------------------------------------------------------
    def build_out_fstring(self, text, maxn):
        """Pre-filled FString cell for the GetText out parameter."""
        cell = self.alloc(12)
        data, num, cap = self.fstring(text, maxn)
        self.write(cell, '3I', data, num, cap)
        return cell

    def begin_case(self, spec):
        # Process-global scratch: a fresh case models a process where no
        # convertPipes run has happened yet, unless the spec seeds it.
        cdata, cnum, cmax = self.fstring(spec.get('convert'), spec.get('convertMax'))
        self.write(CONVERT_BUFFER, '3I', cdata, cnum, cmax)
        self.write(CONVERT_FLAG, 'B', spec.get('convertFlag', 0))
        self.write(self.gprop_addr, 'I', 0)
        self.patch_gettime(spec.get('now', 0.0))
        this = self.window(spec)
        self.events = []
        self.block_ids = {}
        self.blocks = {}
        self.freed = set()
        self.seen_ids = {}
        self.readers = []
        return this

    def run_exec(self, info, this, args, spec):
        """Drive a real exec body: (frame, out) -> result.  Reader entries are
        built from the case args in parameter order; the out cell shape
        depends on the result kind."""
        dest = 0
        for arg in args:
            if 'int' in arg:
                self.readers.append({'dword': arg['int']})
            elif 'float' in arg:
                bits = struct.unpack('<I', struct.pack('<f', arg['float']))[0]
                self.readers.append({'dword': bits})
            elif 'floatBits' in arg:
                self.readers.append({'dword': arg['floatBits'] & 0xffffffff})
            elif 'string' in arg:
                # An input string param: the case supplies the marshalled
                # FString cell; the reader copies it into the exec local.
                cell = self.build_out_fstring(arg['string'], arg.get('max'))
                self.readers.append({'fstring': cell})
            elif 'outString' in arg:
                dest = self.build_out_fstring(arg['outString'], arg.get('outMax'))
                self.readers.append({'fstring': dest})
            elif 'outNone' in arg:
                self.readers.append({'fstring': 0})
            else:
                raise ValueError('unsupported exec arg %r' % (arg,))
        frame = self.alloc(0x20)
        self.cpu.mem_write(frame, b'\0' * 0x20)
        code = self.alloc(16)
        self.cpu.mem_write(code, bytes(len(self.readers)) + b'\0' * 8)
        self.write(frame + 8, 'I', this)       # FFrame.Object (reader context)
        self.write(frame + 0xc, 'I', code)     # FFrame.Code cursor
        kind = info['kind']
        code_after = lambda: self.read(frame + 0xc, 'I')[0] - code
        if kind == 'execString':
            out = self.build_out_fstring(spec.get('outText'), spec.get('outMax'))
            ret = self.call(info['body'], this, struct.pack('<II', frame, out))
            return {'result': self.dump_fstring(out), 'ret': ret,
                    'code': code_after()}
        out = self.alloc(4)
        self.write(out, 'I', 0xdeadbeef)
        ret = self.call(info['body'], this, struct.pack('<II', frame, out))
        if kind == 'execInt':
            return {'result': self.read(out, 'i')[0], 'ret': ret,
                    'code': code_after()}
        if kind == 'execPart':
            return {'result': {'value': self.read(out, 'i')[0],
                               'out': self.dump_fstring(dest) if dest else None},
                    'ret': ret, 'code': code_after()}
        return {'result': None, 'rawEax': ret, 'code': code_after()}

    def run_case(self, name, case):
        info = NATIVES[name]
        spec = case['spec']
        args = case.get('args', [])
        this = self.begin_case(spec)
        out = self.run_exec(info, this, args, spec)
        out['events'] = list(self.events)
        out['state'] = self.dump_state(this)
        return out


def oracle_main(method, section, root=None):
    """Shared per-native driver: replay every JSON case through the real body."""
    probe = TextWindowProbe(Path(root or sys.argv[1]))
    cases = json.loads(
        (Path(__file__).parent / 'textwindow-cases.json').read_text())[section]
    results = {}
    for name, case in cases.items():
        results[name] = probe.run_case(method, case)
    print(json.dumps({
        'hashes': {'Extension.dll': EXTENSION_HASH, 'MSVCRT.dll': MSVCRT_HASH},
        'extensionBase': EXTENSION_BASE,
        'body': NATIVES[method]['body'],
        'cases': results,
    }))
