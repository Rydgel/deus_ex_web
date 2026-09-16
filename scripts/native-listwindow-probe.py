"""Shared Unicorn probe for the recovered Extension XListWindow row/column model.

Maps hash-checked Extension.dll (rebased to 0x12000000), Core.dll and the
shipped MSVCRT.dll so the real FArray helpers, string functions and the CRT
qsort execute unchanged.  The engine allocator (Core GMalloc global, reached
through the Extension IAT) is modelled by a probe FMalloc whose Malloc /
Realloc / Free virtual slots are intercepted and serviced from the probe heap;
every allocator call is recorded as an event.

Leaves intercepted (all other code executes the real bodies):
  * AskParentForReconfigure 0x1004e060      -> event
  * XWindow virtual slot 0x10c (selectionChanged broadcast) -> event
  * acquire/release measure ctx 0x1004ddc0 / 0x1004de50 -> opaque ctx handle
  * text measure 0x10027bb0 (font metrics leaf) -> configured extents
  * Core appFailAssert -> assertion event + stop

Row node layout (24 bytes):   +0 rowId, +4 flags(bit0 selected),
  +8 fields FArray, +0x14 clientData.
Field element (24 bytes):     +0 FString{data,num,max}, +0xc numeric value,
  +0x10 measured width, +0x14 measured height.
Column element (0x38 bytes):  +0 index, +4 FString header, +0x10 sort priority,
  +0x14 sort flags(bit0 reverse, bit1 caseSensitive), +0x18 float width,
  +0x1c byte, +0x1d packed dword, +0x24 font, +0x28 type byte, +0x2c FString fmt.
Window fields used:           +0x14c delimiter FString, +0x170 rows FArray,
  +0x17c columns FArray, +0x180 numCols, +0x188 flags(bit0 sorting,
  bit1 autoExpand, bit2 multiSelect), +0x18c/+0x190 float padding,
  +0x19c float rowHeight, +0x1a8 numSelected, +0x1ac cachedSelected,
  +0x1b0 otherSelection, +0x130 style source, +0x134 measure ctx object,
  +0x138 parent, +0x3d packed column default, +0x54 default font.
Sort scratch globals:         0x100a6f28 column list (max 0x100),
  0x100a7348 count.  Static text buffers: 0x100a5f10, 0x100a380c, 0x100a5810.
"""
import importlib.util
import json
from decimal import Decimal, ROUND_HALF_UP, localcontext
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

# Method bodies (rebased).
BODIES = {
    'GetNumRows': 0x12034910,
    'GetNumSelectedRows': 0x12034950,
    'IndexToRowId': 0x1202ecf0,
    'GetSelectedRow': 0x1202f740,
    'GetField': 0x1202f250,
    'AddRow': 0x1202ed80,
    'DeleteAllRows': 0x1202f020,
    'SetNumColumns': 0x1202fa10,
    'SetColumnWidth': 0x1202fed0,
    'SetColumnType': 0x12030480,
    'EnableAutoExpandColumns': 0x12030fa0,
    'EnableMultiSelect': 0x12031040,
    'SetSortColumn': 0x12030860,
    'Sort': 0x12030c10,
}

# Intercepted Extension leaves.
ASK_RECONFIGURE = EXT + 0x4e060
ACQUIRE_CONTEXT = EXT + 0x4ddc0
RELEASE_CONTEXT = EXT + 0x4de50
MEASURE_STRING = EXT + 0x27bb0
GLYPH_ENTRY = EXT + 0x267e0
GET_PARENT = EXT + 0x4c550

# Extension IAT slots.
GMALLOC_IAT = EXT + 0x59060
FAIL_ASSERT_IAT = EXT + 0x59098
SPRINTF_IAT = EXT + 0x59138

# In-image scratch/static addresses.
SORT_LIST = EXT + 0xa6f28
SORT_COUNT = EXT + 0xa7348
EMPTY_WSTRING = EXT + 0x99ea8
FMT_DEFAULT = EXT + 0x988fc       # "%f"
FMT_TIME = EXT + 0x988e8          # "%02h:%02m"
TOKEN_BUFFER = EXT + 0xa5f10
SPRINTF_BUFFER = EXT + 0xa5810
FIELD_COPY_BUFFER = EXT + 0xa380c

# Window field offsets.
OFF_DELIM = 0x14c        # FString delimiter
OFF_ROWS = 0x170         # FArray of row node pointers {data,count,max}
OFF_COLS = 0x17c         # FArray of 0x38-byte columns {data,count@0x180,max@0x184}
OFF_NUMCOLS = 0x180      # the cols TArray count IS the column count
OFF_FLAGS = 0x188        # bit0 sorting, bit1 autoExpand, bit2 multiSelect
OFF_PAD_X = 0x18c        # float, doubled into field width requirement
OFF_PAD_Y = 0x190        # float, doubled into row height
OFF_ROW_HEIGHT = 0x19c   # float, computed
OFF_NUM_SELECTED = 0x1a8
OFF_SELECTED = 0x1ac     # cached selected node
OFF_SELECTED2 = 0x1b0
OFF_STYLE = 0x130        # style source copied by ctx acquire
OFF_CONTEXT = 0x134      # measure context object
OFF_PARENT = 0x138
OFF_COL_PACKED = 0x3d    # copied into new column +0x1d
OFF_DEF_FONT = 0x54      # copied into new column +0x24

SELECTION_CHANGED_SLOT = 0x10c


class ListWindowProbe(_NATIVE.NativeCollision):
    """Run one XListWindow method body against a constructed window image."""

    def __init__(self, root):
        super().__init__(Path(root), IMAGES)
        self.events = []
        self.blocks = {}           # live GMalloc ptr -> size
        self.block_ids = {}        # ptr -> 'h<N>' (Malloc event order)
        self.sizes = {}            # EVERY allocation's requested size
        self.freed = set()
        self.seen_ids = {}         # ptr -> 'a<N>' (dump encounter order)
        self.measure_extents = (0.0, 0.0)
        self.selection_sink = 0    # return value for the selection virtual
        self._contexts = []

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

        # appSprintf leaf: the real Core body handles integer/string/Unreal
        # directives natively, but %f/%e/%g dive into MSVCRT's floating
        # conversion path which aborts without full CRT init (recovered:
        # _woutput -> _amsg_exit).  The leaf jumps to the real body for
        # non-float formats and formats float conversions in Python with
        # Decimal correctly-rounded/half-away digit generation, which matches
        # the real _fcvt on every probed value (incl. exact ties 0.5->1,
        # 2.5->3, 0.125->0.13).
        self.sprintf_stub = self.alloc(16)
        self.cpu.mem_write(self.sprintf_stub, b'\xc3')
        self.sprintf_real = self.read(SPRINTF_IAT, 'I')[0]
        self.write(SPRINTF_IAT, 'I', self.sprintf_stub)

        # Fake XWindow vtable: only the selection-changed slot is used here.
        self.window_vtable = self.alloc(0x200)
        self.selection_stub = self.alloc(16)
        self.cpu.mem_write(self.selection_stub, b'\xc3')
        self.write(self.window_vtable + SELECTION_CHANGED_SLOT, 'I', self.selection_stub)

        # The base code hook raises on every unresolved import; the ListWindow
        # model additionally services kernel32 calls issued by the real MSVCRT
        # _vsnwprintf path, so this probe installs its own dispatcher (leaf
        # hooks are reached through on_dispatch, not a second hook).
        self.cpu.hook_del(self.code_hook)
        self.tls = {}
        self.tls_next = 1
        self.kernel_calls = []
        self._getproc_stubs = {}
        self.k32_heap = {}
        self.k32_reserved_lo = 0
        self.k32_reserved_hi = 0
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
        if size == 0:
            # FMalloc::Realloc frees the block and returns NULL for size 0.
            if old:
                self.blocks.pop(old, None)
                self.freed.add(old)
            self.events.append({'op': 'Realloc', 'old': self.canon(old), 'size': 0,
                                'tag': self.wstring(tag), 'block': 0})
            cpu.reg_write(UC_X86_REG_EAX, 0)
            self._cdecl_return(cpu, stack, 12)
            return
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
                                'tag': self.wstring(tag), 'block': ident})
        else:
            new, ident = self._track_alloc(size)
            self.events.append({'op': 'Realloc', 'old': 0, 'size': size,
                                'tag': self.wstring(tag), 'block': ident})
        cpu.reg_write(UC_X86_REG_EAX, new)
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
        # that cleanup; varargs leaves (appSprintf) stay caller-cleaned.
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

    def on_leaf(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        if address == self.malloc_stub:
            self.on_malloc(cpu)
        elif address == self.realloc_stub:
            self.on_realloc(cpu)
        elif address == self.free_stub:
            self.on_free(cpu)
        elif address == ASK_RECONFIGURE:
            self.events.append({'op': 'AskParentForReconfigure',
                                'object': self.canon(cpu.reg_read(UC_X86_REG_ECX))})
            self._cdecl_return(cpu, stack)
        elif address == ACQUIRE_CONTEXT:
            # Real body returns this+0x134 after priming the pooled context;
            # the two ctx-object calls inside it are part of the leaf.
            window = cpu.reg_read(UC_X86_REG_ECX)
            ctx = self.read(window + OFF_CONTEXT, 'I')[0]
            self.events.append({'op': 'AcquireContext',
                                'object': self.canon(window),
                                'ctx': self.canon(ctx)})
            cpu.reg_write(UC_X86_REG_EAX, ctx)
            self._cdecl_return(cpu, stack)
        elif address == RELEASE_CONTEXT:
            ctx = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'ReleaseContext',
                                'object': self.canon(cpu.reg_read(UC_X86_REG_ECX)),
                                'ctx': self.canon(ctx)})
            self._cdecl_return(cpu, stack, 4)
        elif address == MEASURE_STRING:
            flags, out_w, out_h, text = self.read(stack + 4, '4I')
            string = self.wstring(text)
            width, height = self.measure_extents
            self.write(out_w, 'f', width)
            self.write(out_h, 'f', height)
            self.events.append({'op': 'MeasureString', 'flags': flags,
                                'text': string, 'width': width, 'height': height})
            self._cdecl_return(cpu, stack, 16)
        elif address == self.selection_stub:
            receiver = cpu.reg_read(UC_X86_REG_ECX)
            sender, count, node = self.read(stack + 4, '3I')
            self.events.append({'op': 'SelectionChanged', 'receiver': self.canon(receiver),
                                'sender': self.canon(sender), 'count': count,
                                'node': self.canon(node)})
            cpu.reg_write(UC_X86_REG_EAX, self.selection_sink)
            self._cdecl_return(cpu, stack, 12)
        elif address == self.sprintf_stub:
            self.on_sprintf(cpu)
        elif address == self.assert_addr:
            expr, file_, line = self.read(stack + 4, '3I')
            raise RuntimeError('appFailAssert fired: line %d expr %s' % (line, expr))
        elif address == GET_PARENT:
            # Real body is a plain field read; it executes unchanged.
            pass

    # ----- appSprintf leaf ----------------------------------------------------
    FLOAT_CONVS = frozenset('eEfgG')
    KNOWN_CONVS = frozenset('diuxXocspfFeEgGaAnm%')

    def on_sprintf(self, cpu):
        """Intercept Core appSprintf at the Extension IAT.

        Formats containing no float conversions jump straight to the real Core
        body (which executes natively); float formats are produced in Python.
        Varargs sit at esp+0xc: int/string args are 4 bytes, doubles 8 bytes.
        """
        stack = cpu.reg_read(UC_X86_REG_ESP)
        buf, fmt_ptr = self.read(stack + 4, '2I')
        fmt = self.wstring(fmt_ptr)
        specs = self._scan_formats(fmt)
        if not any(c in self.FLOAT_CONVS for c in specs):
            if any(c not in self.KNOWN_CONVS for c in specs):
                raise RuntimeError('appSprintf unhandled conversion in %r' % fmt)
            cpu.reg_write(UC_X86_REG_EIP, self.sprintf_real)
            return
        text = self._format(cpu, fmt, stack + 0xc)
        data = text.encode('utf-16-le') + b'\0\0'
        cpu.mem_write(buf, data)
        cpu.reg_write(UC_X86_REG_EAX, buf)
        self._cdecl_return(cpu, stack)

    @staticmethod
    def _scan_formats(fmt):
        """Return [(conv, argpos)] for each % conversion in order."""
        out = []
        i = 0
        while True:
            i = fmt.find('%', i)
            if i < 0:
                return out
            j = i + 1
            n = len(fmt)
            if j < n and fmt[j] == '%':
                i = j + 1
                continue
            while j < n and fmt[j] in '-+ #0':
                j += 1
            if j < n and fmt[j] == '*':
                j += 1
            else:
                while j < n and fmt[j].isdigit():
                    j += 1
            if j < n and fmt[j] == '.':
                j += 1
                if j < n and fmt[j] == '*':
                    j += 1
                else:
                    while j < n and fmt[j].isdigit():
                        j += 1
            while j < n and fmt[j] in 'hlLzI346':
                j += 1
            if j >= n:
                return out
            out.append(fmt[j])
            i = j + 1

    def _format(self, cpu, fmt, va):
        """Mini printf for float-containing formats; decimal digits come from
        exact binary expansion (CPython Decimal) with round-half-away, the same
        result MSVCRT _fcvt produced for every probed value."""
        args = []

        def read_arg():
            # width/precision '*' also consume int args; handled by caller
            pass

        out = []
        argp = va
        i = 0
        n = len(fmt)
        while i < n:
            ch = fmt[i]
            if ch != '%':
                out.append(ch)
                i += 1
                continue
            j = i + 1
            if fmt[j] == '%':
                out.append('%')
                i = j + 1
                continue
            flags = ''
            while j < n and fmt[j] in '-+ #0':
                flags += fmt[j]
                j += 1
            if j < n and fmt[j] == '*':
                width = struct.unpack('<i', cpu.mem_read(argp, 4))[0]
                argp += 4
                j += 1
            else:
                width = 0
                while j < n and fmt[j].isdigit():
                    width = width * 10 + int(fmt[j])
                    j += 1
            prec = None
            if j < n and fmt[j] == '.':
                j += 1
                if j < n and fmt[j] == '*':
                    prec = struct.unpack('<i', cpu.mem_read(argp, 4))[0]
                    argp += 4
                    j += 1
                else:
                    prec = 0
                    while j < n and fmt[j].isdigit():
                        prec = prec * 10 + int(fmt[j])
                        j += 1
            while j < n and fmt[j] in 'hlLzI346':
                j += 1
            conv = fmt[j] if j < n else ''
            j += 1
            i = j
            piece = ''
            if conv in 'fF':
                p = 6 if prec is None else prec
                value = struct.unpack('<d', cpu.mem_read(argp, 8))[0]
                argp += 8
                piece = self._fmt_f(value, p, flags, Decimal, ROUND_HALF_UP)
            elif conv in 'eE':
                p = 6 if prec is None else prec
                value = struct.unpack('<d', cpu.mem_read(argp, 8))[0]
                argp += 8
                piece = self._fmt_e(value, p, flags, conv == 'E',
                                    Decimal, ROUND_HALF_UP)
            elif conv in 'gG':
                p = 6 if prec is None else max(prec, 1)
                value = struct.unpack('<d', cpu.mem_read(argp, 8))[0]
                argp += 8
                piece = self._fmt_g(value, p, flags, conv == 'G',
                                    Decimal, ROUND_HALF_UP)
            elif conv in 'di':
                value = struct.unpack('<i', cpu.mem_read(argp, 4))[0]
                argp += 4
                piece = self._fmt_int(value, 10, flags, signed=True)
            elif conv == 'u':
                value = struct.unpack('<I', cpu.mem_read(argp, 4))[0]
                argp += 4
                piece = self._fmt_int(value, 10, flags, signed=False)
            elif conv in 'xX':
                value = struct.unpack('<I', cpu.mem_read(argp, 4))[0]
                argp += 4
                piece = self._fmt_int(value, 16, flags, signed=False)
                if conv == 'X':
                    piece = piece.upper()
            elif conv == 'o':
                value = struct.unpack('<I', cpu.mem_read(argp, 4))[0]
                argp += 4
                piece = self._fmt_int(value, 8, flags, signed=False)
            elif conv == 'c':
                value = struct.unpack('<I', cpu.mem_read(argp, 4))[0]
                argp += 4
                piece = chr(value & 0xffff)
            elif conv == 's':
                sptr = struct.unpack('<I', cpu.mem_read(argp, 4))[0]
                argp += 4
                piece = self.wstring(sptr)
            elif conv == 'p':
                value = struct.unpack('<I', cpu.mem_read(argp, 4))[0]
                argp += 4
                piece = '0x%08x' % value
            else:
                raise RuntimeError('appSprintf leaf unhandled %%%s in %r' % (conv, fmt))
            out.append(self._pad(piece, width, flags,
                                 numeric=conv not in 'sc'))
        return ''.join(out)

    @staticmethod
    def _fmt_f(value, prec, flags, Decimal, ROUND_HALF_UP):
        with localcontext() as ctx:
            ctx.prec = 200
            if value != value:
                return '-1.#QNAN' if struct.unpack('<q', struct.pack('<d', value))[0] < 0 else '1.#QNAN'
            if value in (float('inf'), float('-inf')):
                return ('-1.#INF' if value < 0 else '1.#INF')
            d = Decimal(value)
            q = d.quantize(Decimal(1).scaleb(-prec), rounding=ROUND_HALF_UP)
            body = format(q, 'f')
            if prec == 0 and '#' not in flags:
                body = body.split('.')[0]
            elif prec == 0:
                body = body + '.'
            if '.' not in body and prec > 0:
                body += '.' + '0' * prec
            if '.' in body:
                ip, fp = body.split('.')
                body = ip + '.' + fp.ljust(prec, '0')
            if body.startswith('-'):
                return body
            if '+' in flags:
                return '+' + body
            if ' ' in flags:
                return ' ' + body
            return body

    @staticmethod
    def _fmt_e(value, prec, flags, upper, Decimal, ROUND_HALF_UP):
        with localcontext() as ctx:
            ctx.prec = 200
            if value != value or value in (float('inf'), float('-inf')):
                return ListWindowProbe._fmt_f(value, prec, flags, Decimal, ROUND_HALF_UP)
            if value == 0:
                mant = '0' + ('.' + '0' * prec if prec or '#' in flags else '')
                sign = '-' if struct.unpack('<q', struct.pack('<d', value))[0] < 0 else ''
                body = sign + mant
            else:
                d = Decimal(abs(value))
                exp = int(d.log10().__floor__()) if d != 0 else 0
                # normalize mantissa to [1,10)
                mant_d = d.scaleb(-exp)
                q = mant_d.quantize(Decimal(1).scaleb(-prec), rounding=ROUND_HALF_UP)
                if q >= 10:
                    q = q / 10
                    exp += 1
                mant = format(q, 'f')
                if '.' not in mant and (prec or '#' in flags):
                    mant += '.' + '0' * prec
                elif '.' in mant:
                    ip, fp = mant.split('.')
                    mant = ip + '.' + fp.ljust(prec, '0')
                body = ('-' if value < 0 else '') + mant
            letter = 'E' if upper else 'e'
            body += letter + ('+' if exp >= 0 else '-') + '%02d' % abs(exp)
            if body.startswith('-'):
                return body
            if '+' in flags:
                return '+' + body
            if ' ' in flags:
                return ' ' + body
            return body

    @staticmethod
    def _fmt_g(value, prec, flags, upper, Decimal, ROUND_HALF_UP):
        with localcontext() as ctx:
            ctx.prec = 200
            if value != value or value in (float('inf'), float('-inf')):
                return ListWindowProbe._fmt_f(value, prec, flags, Decimal, ROUND_HALF_UP)
            if value == 0:
                body = '0'
            else:
                d = Decimal(abs(value))
                exp = int(d.log10().__floor__())
                if exp < -4 or exp >= prec:
                    p = prec - 1
                    mant_d = d.scaleb(-exp)
                    q = mant_d.quantize(Decimal(1).scaleb(-p), rounding=ROUND_HALF_UP)
                    if q >= 10:
                        q = q / 10
                        exp += 1
                    mant = format(q, 'f')
                    if '.' in mant:
                        ip, fp = mant.split('.')
                        mant = ip + '.' + fp.ljust(p, '0')
                    if '#' not in flags:
                        mant = mant.rstrip('0').rstrip('.') if '.' in mant else mant
                    body = mant + ('E' if upper else 'e') + ('+' if exp >= 0 else '-') + '%02d' % abs(exp)
                else:
                    p = prec - 1 - exp
                    q = d.quantize(Decimal(1).scaleb(-p), rounding=ROUND_HALF_UP)
                    mant = format(q, 'f')
                    if '#' not in flags and '.' in mant:
                        mant = mant.rstrip('0').rstrip('.')
                    body = mant
            if value < 0:
                body = '-' + body
            elif '+' in flags:
                body = '+' + body
            elif ' ' in flags:
                body = ' ' + body
            return body

    @staticmethod
    def _fmt_int(value, base, flags, signed):
        if base == 16:
            digits = '%x' % (value & 0xffffffff)
        elif base == 8:
            digits = '%o' % (value & 0xffffffff)
        else:
            digits = str(abs(value) if signed else value & 0xffffffff)
        if signed and value < 0:
            return '-' + digits
        if '+' in flags:
            return '+' + digits
        if ' ' in flags:
            return ' ' + digits
        return digits

    @staticmethod
    def _pad(piece, width, flags, numeric=True):
        if len(piece) >= width:
            return piece
        fill = '0' if ('0' in flags and '-' not in flags and numeric) else ' '
        padn = width - len(piece)
        if '-' in flags:
            return piece + ' ' * padn
        if fill == '0' and piece and piece[0] in '+- ':
            return piece[0] + '0' * padn + piece[1:]
        return fill * padn + piece

    # ----- dispatch + kernel32 bridge ----------------------------------------
    def on_dispatch(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        ent = self.thunks.get(address)
        if ent is not None:
            if ent[0] == 'kernel32.dll':
                self.on_kernel32(cpu, ent[1])
                return
            raise RuntimeError(f'Unresolved import {ent}; trace {list(self.trace)}')
        self.trace.append(hex(address))
        self.on_leaf(cpu, address, size, data)

    # kernel32 is stdcall: each stub pops its own arguments.  The table gives
    # the parameter byte count for every import the model services.
    KERNEL32_ARG_BYTES = {
        'TlsAlloc': 0, 'TlsGetValue': 4, 'TlsSetValue': 8, 'TlsFree': 4,
        'GetModuleFileNameA': 12, 'GetModuleFileNameW': 12,
        'GetModuleHandleA': 4, 'GetModuleHandleW': 4,
        'GetACP': 0, 'GetOEMCP': 0, 'GetUserDefaultLCID': 0,
        'GetSystemDefaultLangID': 0, 'GetSystemDefaultLCID': 0,
        'GetCPInfo': 8, 'GetCommandLineA': 0, 'GetVersion': 0,
        'GetCurrentThreadId': 0, 'GetCurrentProcess': 0,
        'GetCurrentThread': 0, 'GetCurrentProcessId': 0,
        'IsValidLocale': 8, 'IsValidCodePage': 4, 'GetTickCount': 0,
        'GetStartupInfoA': 4, 'InterlockedIncrement': 4,
        'InterlockedDecrement': 4, 'LoadLibraryA': 4, 'LoadLibraryW': 4,
        'GetProcAddress': 8, 'FreeLibrary': 4,
        'InitializeCriticalSection': 4, 'EnterCriticalSection': 4,
        'LeaveCriticalSection': 4, 'DeleteCriticalSection': 4,
        'SetLastError': 4, 'SetErrorMode': 4, 'SetHandleCount': 4,
        'GetLastError': 0, 'GetStdHandle': 4, 'GetLocaleInfoA': 12,
        'GetLocaleInfoW': 12, 'GetStringTypeA': 16, 'GetStringTypeW': 20,
        'SetEnvironmentVariableA': 8,
        'HeapCreate': 12, 'HeapAlloc': 12, 'HeapReAlloc': 16,
        'HeapSize': 12, 'HeapFree': 12, 'HeapDestroy': 4,
        'VirtualAlloc': 16, 'VirtualFree': 12,
        'MultiByteToWideChar': 24, 'WideCharToMultiByte': 32,
        'LCMapStringA': 20, 'LCMapStringW': 24, 'CompareStringA': 20,
        'CompareStringW': 20, 'GetLocalTime': 4, 'GetSystemTime': 4,
        'GetTimeZoneInformation': 4, 'SystemTimeToFileTime': 8,
        'FileTimeToLocalFileTime': 12, 'LocalFileTimeToFileTime': 8,
        'EnumSystemLocalesA': 8, 'IsBadReadPtr': 8, 'IsBadWritePtr': 8,
        'GetFileType': 4, 'GetConsoleMode': 8, 'WriteConsoleA': 16,
        'WriteFile': 20, 'FormatMessageA': 28, 'FormatMessageW': 28,
        'RaiseException': 16, 'RtlUnwind': 16, 'UnhandledExceptionFilter': 4,
        'SetUnhandledExceptionFilter': 4, 'ExitProcess': 4,
        'TerminateProcess': 8, 'Sleep': 4, 'Beep': 8,
        'GetEnvironmentStrings': 0, 'GetEnvironmentStringsW': 0,
        'FreeEnvironmentStringsA': 4, 'FreeEnvironmentStringsW': 4,
    }

    def on_kernel32(self, cpu, name):
        """Minimal kernel32 surface for the real MSVCRT _vsnwprintf path.

        Only calls the formatter actually issues are serviced; anything else
        stays an unresolved-import failure.  TLS slots, critical sections and
        the C-locale defaults model what MSVCRT needs to format %f/%d.
        """
        self.kernel_calls.append(name)
        stack = cpu.reg_read(UC_X86_REG_ESP)
        ret = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        args = [int.from_bytes(cpu.mem_read(stack + 4 + 4 * i, 4), 'little')
                for i in range(8)]
        eax = 0
        if name == 'TlsAlloc':
            eax = self.tls_next
            self.tls_next += 1
        elif name == 'TlsGetValue':
            eax = self.tls.get(args[0], 0)
        elif name == 'TlsSetValue':
            self.tls[args[0]] = args[1]
            eax = 1
        elif name == 'TlsFree':
            eax = 1
        elif name in ('GetModuleFileNameA', 'GetModuleFileNameW'):
            cpu.mem_write(args[1], b'\0' * 8)
        elif name == 'GetACP':
            eax = 1252
        elif name == 'GetOEMCP':
            eax = 437
        elif name in ('GetUserDefaultLCID', 'GetSystemDefaultLangID'):
            eax = 0x409
        elif name == 'GetCPInfo':
            cpu.mem_write(args[1], struct.pack('<I', 8) + b'\0' * 10)
            eax = 1
        elif name == 'GetCommandLineA':
            eax = self.write_wstring('probe.exe')
        elif name == 'GetVersion':
            eax = 0x0a280105
        elif name == 'GetCurrentThreadId':
            eax = 0x1234
        elif name in ('GetCurrentProcess', 'GetCurrentThread'):
            eax = 0xffffffff
        elif name == 'GetCurrentProcessId':
            eax = 0x1234
        elif name in ('IsValidLocale', 'IsValidCodePage'):
            eax = 1
        elif name == 'GetTickCount':
            eax = 1000
        elif name == 'GetStartupInfoA':
            cpu.mem_write(args[0], b'\0' * 0x44)
        elif name == 'InterlockedIncrement':
            value = int.from_bytes(cpu.mem_read(args[0], 4), 'little')
            value = (value + 1) & 0xffffffff
            cpu.mem_write(args[0], struct.pack('<I', value))
            eax = value if value < 0x80000000 else value - 0x100000000
        elif name == 'InterlockedDecrement':
            value = int.from_bytes(cpu.mem_read(args[0], 4), 'little')
            value = (value - 1) & 0xffffffff
            cpu.mem_write(args[0], struct.pack('<I', value))
            eax = value if value < 0x80000000 else value - 0x100000000
        elif name in ('LoadLibraryA', 'LoadLibraryW'):
            eax = 0x70010000
        elif name == 'GetProcAddress':
            # Record the requested symbol; callers may invoke the result, so a
            # named stub is installed that returns 0 as a cdecl no-op.
            sym = args[1]
            if sym & 0xffff0000:
                chars = []
                for i in range(0x40):
                    ch = int.from_bytes(cpu.mem_read(sym + i, 1), 'little')
                    if ch == 0:
                        break
                    chars.append(ch)
                symname = bytes(chars).decode('ascii', 'replace')
            else:
                symname = '#%d' % sym
            self.kernel_calls.append('GetProcAddress:%s' % symname)
            stub = self._getproc_stubs.get(symname)
            if stub is None:
                stub = self.alloc(16)
                cpu.mem_write(stub, b'\x31\xc0\xc2\x00\x00')  # xor eax,eax; ret 0
                self._getproc_stubs[symname] = stub
            eax = stub
        elif name == 'HeapCreate':
            eax = 0x780ff000
        elif name == 'HeapAlloc':
            eax = self.alloc(max(args[2], 4))
            self.k32_heap[eax] = args[2]
        elif name == 'HeapReAlloc':
            old = self.k32_heap.get(args[2], 0)
            eax = self.alloc(max(args[3], 4))
            self.k32_heap[eax] = args[3]
            keep = min(old, args[3])
            if keep:
                cpu.mem_write(eax, bytes(cpu.mem_read(args[2], keep)))
        elif name == 'HeapSize':
            eax = self.k32_heap.get(args[2], 0)
        elif name == 'HeapFree':
            self.k32_heap.pop(args[2], None)
            eax = 1
        elif name == 'HeapDestroy':
            eax = 1
        elif name == 'VirtualAlloc':
            # Reserve/commit from the probe heap region; the pages are already
            # mapped so a commit of reserved pages just echoes the address.
            requested = args[0]
            if requested and requested >= self.k32_reserved_lo and requested < self.k32_reserved_hi:
                eax = requested
            else:
                eax = self.alloc(max(args[1], 4))
                if requested == 0:
                    self.k32_reserved_lo = eax
                    self.k32_reserved_hi = eax + ((args[1] + 0xffff) & ~0xffff)
        elif name == 'VirtualFree':
            eax = 1
        elif name in ('InitializeCriticalSection', 'EnterCriticalSection',
                      'LeaveCriticalSection', 'DeleteCriticalSection',
                      'SetLastError', 'SetErrorMode', 'SetHandleCount',
                      'GetLastError', 'GetStdHandle', 'GetModuleHandleA',
                      'GetModuleHandleW', 'GetLocaleInfoA', 'GetLocaleInfoW',
                      'GetStringTypeA', 'GetStringTypeW', 'SetEnvironmentVariableA'):
            eax = 0
        else:
            raise RuntimeError(
                f'kernel32.{name} not modelled; trace {list(self.trace)}')
        cpu.reg_write(UC_X86_REG_EAX, eax & 0xffffffff)
        cpu.reg_write(UC_X86_REG_ESP,
                      stack + 4 + self.KERNEL32_ARG_BYTES[name])
        cpu.reg_write(UC_X86_REG_EIP, ret)
        return None

    # ----- window construction ----------------------------------------------
    def fstring(self, text):
        if text is None:
            return (0, 0, 0)
        data = self.write_wstring(text)
        count = len(text) + 1
        return (data, count, count)

    def field(self, text=None, value=0.0, width=0.0, height=0.0):
        address = self.alloc(24)
        data, num, maxn = self.fstring(text)
        self.write(address, '4I', data, num, maxn, 0)
        self.write(address + 0xc, 'f', value)
        self.write(address + 0x10, 'f', width)
        self.write(address + 0x14, 'f', height)
        return address

    def row(self, row_id=None, flags=0, client=None, fields=(), **kw):
        row_id = row_id if row_id is not None else kw.get('id', 0)
        client = client if client is not None else kw.get('clientData', 0)
        address = self.alloc(24)
        count = len(fields)
        data = self.alloc(24 * count) if count else 0
        for i, spec in enumerate(fields):
            f = self.field(spec.get('text'), spec.get('value', 0.0),
                           spec.get('width', 0.0), spec.get('height', 0.0))
            block = data + 24 * i
            self.cpu.mem_write(block, bytes(self.cpu.mem_read(f, 24)))
        self.write(address, '4I', row_id, flags, data, count)
        self.write(address + 0x10, 'I', count)
        self.write(address + 0x14, 'i', client)
        return address

    def column(self, index=0, header='', sort_priority=0, sort_flags=0, width=0.0,
               flag_byte=0, packed=0, font=0, col_type=0, fmt='', type=None):
        if type is not None:
            col_type = type
        address = self.alloc(0x38)
        self.cpu.mem_write(address, b'\0' * 0x38)
        hdata, hnum, hmax = self.fstring(header)
        fdata, fnum, fmax = self.fstring(fmt)
        self.write(address, 'I', index)
        self.write(address + 4, '3I', hdata, hnum, hmax)
        self.write(address + 0x10, 'i', sort_priority)
        self.write(address + 0x14, 'I', sort_flags)
        self.write(address + 0x18, 'f', width)
        self.write(address + 0x1c, 'B', flag_byte)
        self.write(address + 0x1d, 'I', packed)
        self.write(address + 0x24, 'I', font)
        self.write(address + 0x28, 'B', col_type)
        self.write(address + 0x2c, '3I', fdata, fnum, fmax)
        return address

    def font(self, advances, chars_per_row=16):
        """Craft a font object with a two-level glyph table for 0x100267e0."""
        rows = {}
        for ch, adv in advances.items():
            row, col = divmod(ch, chars_per_row)
            rows.setdefault(row, {})[col] = adv
        font = self.alloc(0x60)
        self.cpu.mem_write(font, b'\0' * 0x60)
        table = self.alloc(16 * len(rows))
        glyphs_base = self.alloc(16 * chars_per_row * len(rows))
        max_row = (max(rows) + 1) if rows else 0
        for row in range(max_row):
            record = table + 16 * row
            cells = rows.get(row, {})
            glyph_run = glyphs_base + 16 * chars_per_row * row
            self.write(record + 4, 'I', glyph_run)
            self.write(record + 8, 'I', max(cells) + 1 if cells else 0)
            for col, adv in cells.items():
                self.write(glyph_run + 16 * col + 0xc, 'i', adv)
        self.write(font + 0x28, 'I', chars_per_row)
        self.write(font + 0x2c, 'I', table)
        self.write(font + 0x30, 'I', max_row)
        return font

    def window(self, spec):
        """Build a window image from a spec dict."""
        address = self.alloc(0x700)
        self.cpu.mem_write(address, b'\0' * 0x700)
        self.write(address, 'I', self.window_vtable)
        ddata, dnum, dmax = self.fstring(spec.get('delimiter'))
        self.write(address + OFF_DELIM, '3I', ddata, dnum, dmax)
        rows = [self.row(**r) for r in spec.get('rows', [])]
        rmax = spec.get('rowMax', len(rows))
        rdata = self.alloc(4 * rmax) if rmax else 0
        if rows:
            self.write(rdata, str(len(rows)) + 'I', *rows)
        if spec.get('rowSlack'):
            if not rdata or rmax < len(rows) + len(spec['rowSlack']):
                raise ValueError('rowSlack needs rowMax >= len(rows)+len(rowSlack)')
            for i, value in enumerate(spec['rowSlack']):
                self.write(rdata + 4 * (len(rows) + i), 'I', value & 0xffffffff)
        self.write(address + OFF_ROWS, '3I', rdata, len(rows), rmax)
        cols = [self.column(index=i, packed=spec.get('colPacked', 0),
                            font=c.get('font', spec.get('defFont', 0)),
                            **{k: v for k, v in c.items() if k != 'font'})
                for i, c in enumerate(spec.get('cols', []))]
        cdata = self.alloc(0x38 * len(cols)) if cols else 0
        if cols:
            for i, c in enumerate(cols):
                self.cpu.mem_write(cdata + 0x38 * i, bytes(self.cpu.mem_read(c, 0x38)))
        cmax = spec.get('colMax', len(cols))
        num_cols = spec.get('numCols', len(cols))
        if num_cols != len(cols):
            raise ValueError('numCols must equal len(cols): 0x180 is the cols TArray count')
        self.write(address + OFF_COLS, '3I', cdata, num_cols, cmax)
        self.write(address + OFF_FLAGS, 'I', spec.get('flags', 0))
        self.write(address + OFF_PAD_X, 'f', spec.get('padX', 0.0))
        self.write(address + OFF_PAD_Y, 'f', spec.get('padY', 0.0))
        self.write(address + OFF_ROW_HEIGHT, 'f', spec.get('rowHeight', 0.0))
        self.write(address + OFF_NUM_SELECTED, 'i', spec.get('numSelected', 0))
        selected = spec.get('selected', 0)
        if spec.get('selectedRow') is not None:
            selected = rows[spec['selectedRow']]
        self.write(address + OFF_SELECTED, 'I', selected)
        self.write(address + OFF_SELECTED2, 'I', spec.get('selected2', 0))
        self.write(address + OFF_PARENT, 'I', spec.get('parent', 0))
        self.write(address + OFF_COL_PACKED, 'I', spec.get('colPacked', 0))
        self.write(address + OFF_DEF_FONT, 'I', spec.get('defFont', 0))
        style = self.alloc(0x60)
        self.cpu.mem_write(style, b'\0' * 0x60)
        self.write(address + OFF_STYLE, 'I', style)
        context = spec.get('context', 0)
        if context is True:
            context = self.alloc(0xc0)
            self.cpu.mem_write(context, b'\0' * 0xc0)
        self.write(address + OFF_CONTEXT, 'I', context)
        if spec.get('parent'):
            # Give the parent the same fake vtable so the broadcast walk can
            # continue past the first hop when requested.
            self.write(spec['parent'], 'I', self.window_vtable)
            self.write(spec['parent'] + OFF_PARENT, 'I', spec.get('grandParent', 0))
        self._window = address
        self._window_spec = spec
        return address

    # ----- canonical dump ----------------------------------------------------
    def dump_fstring(self, address):
        data, num, maxn = self.read(address, '3I')
        return {'text': self.wstring(data) if data else None, 'data': self.canon(data),
                'num': num, 'max': maxn}

    def dump_field(self, address):
        f = self.dump_fstring(address)
        value, width, height = self.read(address + 0xc, '3I')
        return {'str': f, 'value': value, 'width': width, 'height': height}

    def dump_row(self, node):
        row_id, flags = self.read(node, '2i')
        data, count, maxn = self.read(node + 8, '3I')
        client = self.read(node + 0x14, 'i')[0]
        fields = [self.dump_field(data + 24 * i) for i in range(count)] if data else []
        return {'id': row_id, 'flags': flags, 'clientData': client,
                'fields': fields, 'fieldsMax': maxn, 'node': self.canon(node)}

    def dump_column(self, address):
        index = self.read(address, 'i')[0]
        sort_priority, sort_flags = self.read(address + 0x10, 'iI')
        width = self.read(address + 0x18, 'I')[0]
        flag_byte = self.read(address + 0x1c, 'B')[0]
        packed = self.read(address + 0x1d, 'I')[0]
        font = self.read(address + 0x24, 'I')[0]
        col_type = self.read(address + 0x28, 'B')[0]
        return {'index': index, 'header': self.dump_fstring(address + 4),
                'sortPriority': sort_priority, 'sortFlags': sort_flags,
                'width': width, 'flagByte': flag_byte, 'packed': packed,
                'font': self.canon(font), 'type': col_type,
                'format': self.dump_fstring(address + 0x2c)}

    def dump_state(self, this):
        rdata, rcount, rmax = self.read(this + OFF_ROWS, '3I')
        cdata, ccount, cmax = self.read(this + OFF_COLS, '3I')
        num_cols = self.read(this + OFF_NUMCOLS, 'i')[0]
        rows = []
        for i in range(rcount):
            node = self.read(rdata + 4 * i, 'I')[0]
            rows.append(self.dump_row(node) if node else None)
        cols = [self.dump_column(cdata + 0x38 * i) for i in range(ccount)] if cdata else []
        sort_n = self.read(SORT_COUNT, 'i')[0]
        sort_cols = []
        for i in range(max(sort_n, 0)):
            ptr = self.read(SORT_LIST + 4 * i, 'I')[0]
            idx = (ptr - cdata) // 0x38 if cdata and ptr and (ptr - cdata) % 0x38 == 0 else None
            sort_cols.append({'col': self.canon(ptr), 'index': idx})
        return {
            'rowsData': self.canon(rdata), 'rowsCount': rcount, 'rowsMax': rmax,
            'colsData': self.canon(cdata), 'colsCount': ccount, 'colsMax': cmax,
            'numCols': num_cols,
            'flags': self.read(this + OFF_FLAGS, 'I')[0],
            'padX': self.read(this + OFF_PAD_X, 'I')[0],
            'padY': self.read(this + OFF_PAD_Y, 'I')[0],
            'rowHeight': self.read(this + OFF_ROW_HEIGHT, 'I')[0],
            'numSelected': self.read(this + OFF_NUM_SELECTED, 'i')[0],
            'selected': self.canon(self.read(this + OFF_SELECTED, 'I')[0]),
            'selected2': self.canon(self.read(this + OFF_SELECTED2, 'I')[0]),
            'rows': rows, 'cols': cols,
            'sortCount': sort_n, 'sortCols': sort_cols,
        }

    def run_method(self, name, this, arg_words=()):
        body = BODIES[name]
        return self.call(body, this, struct.pack('<%dI' % len(arg_words), *arg_words))

    def marshal_args(self, this, args):
        """Turn case-file arg specs into method-body stack words."""
        rdata = self.read(this + OFF_ROWS, 'I')[0]
        words = []
        for arg in args:
            if 'int' in arg:
                words.append(arg['int'] & 0xffffffff)
            elif 'float' in arg:
                words.append(struct.unpack('<I', struct.pack('<f', arg['float']))[0])
            elif 'string' in arg:
                words.append(self.write_wstring(arg['string']))
            elif 'row' in arg:
                words.append(self.read(rdata + 4 * arg['row'], 'I')[0])
            else:
                raise ValueError('unsupported arg %r' % (arg,))
        return words

    def begin_case(self, spec):
        this = self.window(spec)
        self.events = []
        self.block_ids = {}
        self.blocks = {}
        self.freed = set()
        self.seen_ids = {}
        # The sort-column list is process-global image scratch; a fresh case
        # models a process where no sort path has run yet.
        self.write(SORT_COUNT, 'i', 0)
        m = spec.get('measure', {})
        self.measure_extents = (m.get('width', 0.0), m.get('height', 0.0))
        self.selection_sink = spec.get('selectionSink', 0)
        return this

    def finish_case(self, this, result):
        return {'result': result, 'events': list(self.events),
                'state': self.dump_state(this)}

    def run_case(self, method, spec, args=()):
        this = self.begin_case(spec)
        words = self.marshal_args(this, args)
        ret = self.run_method(method, this, words)
        return self.finish_case(this, ret)

    def run_exec_int(self, exec_addr, this):
        """Run an inline field-read exec body: (frame, *result) -> int."""
        frame = self.alloc(0x20)
        self.cpu.mem_write(frame, b'\0' * 0x20)
        out = self.alloc(4)
        self.write(out, 'I', 0xdeadbeef)
        ret = self.call(exec_addr, this, struct.pack('<II', frame, out))
        return {'ret': ret, 'result': self.read(out, 'i')[0]}


def oracle_main(method, result_kind, section, root=None):
    """Shared per-native driver: replay every JSON case through the real body."""
    probe = ListWindowProbe(Path(root or sys.argv[1]))
    cases = json.loads(
        (Path(__file__).parent / 'listwindow-cases.json').read_text())[section]
    results = {}
    for name, case in cases.items():
        this = probe.begin_case(case['spec'])
        words = probe.marshal_args(this, case.get('args', []))
        if result_kind == 'execInt':
            out = probe.run_exec_int(BODIES[method], this)
            result = out
        else:
            ret = probe.run_method(method, this, words)
            if result_kind == 'ptr':
                rdata = probe.read(this + OFF_ROWS, 'I')[0]
                rcount = probe.read(this + OFF_ROWS + 4, 'i')[0]
                row_index = None
                for i in range(max(rcount, 0)):
                    if probe.read(rdata + 4 * i, 'I')[0] == ret:
                        row_index = i
                        break
                result = {'ptr': probe.canon(ret), 'rowIndex': row_index}
            elif result_kind == 'fieldstr':
                result = {'ptr': probe.canon(ret),
                          'text': probe.wstring(ret) if ret else None}
            else:
                result = {'value': struct.unpack('<i', struct.pack('<I', ret))[0]}
            out = {'result': result}
        out['events'] = list(probe.events)
        out['state'] = probe.dump_state(this)
        results[name] = out
    print(json.dumps({
        'hashes': {'Extension.dll': EXTENSION_HASH, 'MSVCRT.dll': MSVCRT_HASH},
        'extensionBase': EXTENSION_BASE,
        'body': BODIES[method],
        'cases': results,
    }))
