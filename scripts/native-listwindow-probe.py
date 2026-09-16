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
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP


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
        self.blocks = {}           # live ptr -> size
        self.block_ids = {}        # ptr -> 'h<N>' (Malloc event order)
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

        # Fake XWindow vtable: only the selection-changed slot is used here.
        self.window_vtable = self.alloc(0x200)
        self.selection_stub = self.alloc(16)
        self.cpu.mem_write(self.selection_stub, b'\xc3')
        self.write(self.window_vtable + SELECTION_CHANGED_SLOT, 'I', self.selection_stub)

        self.cpu.hook_add(UC_HOOK_CODE, self.on_leaf)

    # ----- allocator model -------------------------------------------------
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
        self._cdecl_return(cpu, stack)

    def on_realloc(self, cpu):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        old, size, tag = self.read(stack + 4, '3I')
        if old:
            old_size = self.blocks.get(old, 0)
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
        self._cdecl_return(cpu, stack)

    def on_free(self, cpu):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        ptr = self.read(stack + 4, 'I')[0]
        self.events.append({'op': 'Free', 'block': self.canon(ptr)})
        self.blocks.pop(ptr, None)
        self.freed.add(ptr)
        self._cdecl_return(cpu, stack)

    @staticmethod
    def _cdecl_return(cpu, stack):
        ret = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(UC_X86_REG_ESP, stack + 4)
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
            ctx = self.alloc(0xc0)
            self.cpu.mem_write(ctx, b'\0' * 0xc0)
            self._contexts.append(ctx)
            self.events.append({'op': 'AcquireContext',
                                'object': self.canon(cpu.reg_read(UC_X86_REG_ECX)),
                                'ctx': self.canon(ctx)})
            cpu.reg_write(UC_X86_REG_EAX, ctx)
            self._cdecl_return(cpu, stack)
        elif address == RELEASE_CONTEXT:
            ctx = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'ReleaseContext',
                                'object': self.canon(cpu.reg_read(UC_X86_REG_ECX)),
                                'ctx': self.canon(ctx)})
            self._cdecl_return(cpu, stack)
        elif address == MEASURE_STRING:
            flags, out_w, out_h, text = self.read(stack + 4, '4I')
            string = self.wstring(text)
            width, height = self.measure_extents
            self.write(out_w, 'f', width)
            self.write(out_h, 'f', height)
            self.events.append({'op': 'MeasureString', 'flags': flags,
                                'text': string, 'width': width, 'height': height})
            self._cdecl_return(cpu, stack)
        elif address == self.selection_stub:
            receiver = cpu.reg_read(UC_X86_REG_ECX)
            sender, count, node = self.read(stack + 4, '3I')
            self.events.append({'op': 'SelectionChanged', 'receiver': self.canon(receiver),
                                'sender': self.canon(sender), 'count': count,
                                'node': self.canon(node)})
            cpu.reg_write(UC_X86_REG_EAX, self.selection_sink)
            self._cdecl_return(cpu, stack)
        elif address == self.assert_addr:
            expr, file_, line = self.read(stack + 4, '3I')
            raise RuntimeError('appFailAssert fired: line %d expr %s' % (line, expr))
        elif address == GET_PARENT:
            # Real body is a plain field read; it executes unchanged.
            pass
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
               flag_byte=0, packed=0, font=0, col_type=0, fmt=''):
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
        rdata = self.alloc(4 * len(rows)) if rows else 0
        if rows:
            self.write(rdata, str(len(rows)) + 'I', *rows)
        rmax = spec.get('rowMax', len(rows))
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
        self.write(address + OFF_CONTEXT, 'I', spec.get('context', 0))
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
                result = {'ptr': probe.canon(ret)}
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
