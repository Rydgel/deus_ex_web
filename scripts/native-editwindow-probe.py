"""Shared Unicorn probe for the recovered Extension XEditWindow edit model.

Maps hash-checked Extension.dll (rebased to 0x12000000), Core.dll and the
shipped MSVCRT.dll so the real FArray helpers, string functions and the
SEH funclets execute unchanged.  The engine allocator (Core GMalloc global,
reached through the Extension IAT) is modelled by a probe FMalloc whose
Malloc / Realloc / Free virtual slots are intercepted and serviced from the
probe heap; every allocator call is recorded as an event.

Leaves intercepted (all other code executes the real bodies):
  * UpdateCaret 0x1001f680                  -> event {op:'UpdateCaret', sticky}
  * ResetBlink 0x1001ef40                   -> event {op:'ResetBlink'}
  * ColumnFromX 0x1001e7f0                  -> event + configured column queue
  * AskParentForReconfigure 0x1004e060      -> event
  * XWindow virtual slot 0x114 (TextChanged broadcast) -> event
  * Core UObject::FindFunction (IAT 0x100590e0) -> event + 0 (no script
    FilterChar override is modelled)
  * Extension atexit thunk 0x100546da       -> 0 (cdecl no-op)
  * Core appFailAssert                      -> oracle failure

The fake window vtable is a byte copy of the real XEditWindow vtable
(0x1005b50c, 0x140 bytes) with slot +0x114 replaced by the TextChanged
recording stub; parent objects share it so the broadcast chain keeps
walking.

Window fields used (docs/script-edit-model.md):
  +0x168/+0x16c/+0x170 text FString, +0x194/+0x198/+0x19c line table A
  (0x24-byte records {x,start,visibleLen,fullLen}), +0x1b8/+0x1bc/+0x1c0
  table B, +0x17c/+0x180/+0x184 pending relayout A, +0x1a0/+0x1a4/+0x1a8
  pending B, +0x150 textFlags(bit0 wordWrap), +0x1d0 edit flags
  (bit0 editing, bit1 singleLine, bit2 uppercase), +0x1d4 insertion point,
  +0x1d8 anchor, +0x1dc ip type byte, +0x1e0/+0x1e4 selection,
  +0x1e8 maxSize, +0x1ec..+0x218 caret/selection style cells,
  +0x21c/+0x220/+0x224 undo FArray of 0x1c records {pos,old,new FStrings},
  +0x228 undoPos, +0x22c maxUndos, +0x230 savedUndoPos,
  +0x23c/+0x240 blink start/period floats, +0x244 state flags,
  +0x270 stickyX, +0x138 parent, +0xe8 height, +0x174/+0x178 line metrics.
Process-global scratch: clipboard FString 0x1009ae00, convertPipes static
0x100aead0 + flag 0x100aeac8, empty wstring 0x10099ea8.
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

# Method bodies (rebased).  execInt natives run their exec body instead.
BODIES = {
    'EnableEditing': 0x1201d600,
    'IsEditingEnabled': 0x12021e20,        # execInt
    'EnableSingleLineEditing': 0x1201d620,
    'IsSingleLineEditingEnabled': 0x12021ed0,  # execInt
    'EnableUppercaseOnly': 0x1201d7d0,
    'ClearTextChangedFlag': 0x1201dd50,
    'SetTextChangedFlag': 0x1201ddc0,
    'HasTextChanged': 0x12022020,          # execInt
    'SetMaxSize': 0x1201d980,
    'SetMaxUndos': 0x1201da60,
    'SetInsertionPointBlinkRate': 0x1201d960,
}

# Intercepted Extension leaves.
UPDATE_CARET = EXT + 0x1f680
RESET_BLINK = EXT + 0x1ef40
COLUMN_FROM_X = EXT + 0x1e7f0
ASK_RECONFIGURE = EXT + 0x4e060
ATEXIT_THUNK = EXT + 0x546da

# Extension IAT slots.
GMALLOC_IAT = EXT + 0x59060
FAIL_ASSERT_IAT = EXT + 0x59098
FIND_FUNCTION_IAT = EXT + 0x590e0

# In-image scratch/static addresses.
CLIPBOARD = EXT + 0x9ae00          # process-global clipboard FString
EMPTY_WSTRING = EXT + 0x99ea8      # shared L"" buffer
CONVERT_BUFFER = EXT + 0xaead0     # exec convertPipes static FString
CONVERT_FLAG = EXT + 0xaeac8
EDIT_VTABLE = EXT + 0x5b50c        # real XEditWindow vtable (copied)

TEXT_CHANGED_SLOT = 0x114          # vtable slot for the TextChanged broadcast

# Object field offsets.
O = {
    'height': 0xe8, 'parent': 0x138, 'textFlags': 0x150,
    'text': 0x168, 'textNum': 0x16c, 'textMax': 0x170,
    'lineSpacing': 0x174, 'lineHeight': 0x178,
    'relayoutFlags': 0x17c, 'pendingPos': 0x180, 'pendingLen': 0x184,
    'linesData': 0x194, 'linesCount': 0x198, 'linesMax': 0x19c,
    'relayoutFlags2': 0x1a0, 'pendingPos2': 0x1a4, 'pendingLen2': 0x1a8,
    'lines2Data': 0x1b8, 'lines2Count': 0x1bc, 'lines2Max': 0x1c0,
    'flags': 0x1d0, 'ip': 0x1d4, 'anchor': 0x1d8, 'ipType': 0x1dc,
    'selStart': 0x1e0, 'selEnd': 0x1e4, 'maxSize': 0x1e8,
    'ipTexture': 0x1ec, 'ipColor': 0x1f0,
    'selTexture': 0x1f4, 'selColor': 0x1f8, 'selTextColor': 0x1fc,
    'cursor': 0x200, 'sounds': 0x20c,
    'undoData': 0x21c, 'undoNum': 0x220, 'undoMax': 0x224,
    'undoPos': 0x228, 'maxUndos': 0x22c, 'savedUndoPos': 0x230,
    'blinkOn': 0x23c, 'blinkOff': 0x240,
    'stateFlags': 0x244, 'stickyX': 0x270,
}
LINE_SIZE = 0x24
UNDO_SIZE = 0x1c
WINDOW_SIZE = 0x400


class EditWindowProbe(_NATIVE.NativeCollision):
    """Run one XEditWindow method body against a constructed window image."""

    def __init__(self, root):
        super().__init__(Path(root), IMAGES)
        self.events = []
        self.blocks = {}           # live GMalloc ptr -> size
        self.block_ids = {}        # ptr -> 'h<N>' (Malloc event order)
        self.sizes = {}            # EVERY allocation's requested size
        self.freed = set()
        self.seen_ids = {}         # ptr -> 'a<N>' (dump encounter order)
        self.text_changed_sink = 0
        self.columns = []

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

        # UObject::FindFunction (script FilterChar override lookup) is left
        # unmodelled: the stub reports "no override" so the default FilterChar
        # path runs.  A body that tries to consume a real override would need
        # a script VM; it is an explicit boundary instead.
        self.find_function_stub = self.alloc(16)
        self.cpu.mem_write(self.find_function_stub, b'\xc3')
        self.write(FIND_FUNCTION_IAT, 'I', self.find_function_stub)

        # Fake XEditWindow vtable: byte copy of the real one with the
        # TextChanged slot redirected at the recording stub.  All other slots
        # (SetText +0x11c, InsertText +0x124, FilterChar +0x12c) keep pointing
        # at the real Extension bodies so the whole edit chain runs natively.
        self.window_vtable = self.alloc(0x140)
        self.cpu.mem_write(self.window_vtable,
                           bytes(self.cpu.mem_read(EDIT_VTABLE, 0x140)))
        self.text_changed_stub = self.alloc(16)
        self.cpu.mem_write(self.text_changed_stub, b'\xc3')
        self.write(self.window_vtable + TEXT_CHANGED_SLOT, 'I',
                   self.text_changed_stub)

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

    def on_dispatch(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        ent = self.thunks.get(address)
        if ent is not None:
            raise RuntimeError(f'Unresolved import {ent}; trace {list(self.trace)}')
        self.trace.append(hex(address))
        self.on_leaf(cpu, address, size, data)

    def on_leaf(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        if address == self.malloc_stub:
            self.on_malloc(cpu)
        elif address == self.realloc_stub:
            self.on_realloc(cpu)
        elif address == self.free_stub:
            self.on_free(cpu)
        elif address == UPDATE_CARET:
            sticky = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'UpdateCaret', 'sticky': sticky})
            self._cdecl_return(cpu, stack, 4)
        elif address == RESET_BLINK:
            self.events.append({'op': 'ResetBlink'})
            self._cdecl_return(cpu, stack)
        elif address == COLUMN_FROM_X:
            line, x_bits = self.read(stack + 4, '2I')
            value = self.columns.pop(0) if self.columns else 0
            self.events.append({'op': 'ColumnFromX', 'line': line, 'x': x_bits})
            cpu.reg_write(UC_X86_REG_EAX, value & 0xffffffff)
            self._cdecl_return(cpu, stack, 8)
        elif address == ASK_RECONFIGURE:
            self.events.append({'op': 'AskParentForReconfigure',
                                'object': self.canon(cpu.reg_read(UC_X86_REG_ECX))})
            self._cdecl_return(cpu, stack)
        elif address == self.text_changed_stub:
            receiver = cpu.reg_read(UC_X86_REG_ECX)
            sender, changed = self.read(stack + 4, '2I')
            self.events.append({'op': 'TextChanged',
                                'receiver': self.canon(receiver),
                                'sender': self.canon(sender),
                                'changed': changed})
            cpu.reg_write(UC_X86_REG_EAX, self.text_changed_sink & 0xffffffff)
            self._cdecl_return(cpu, stack, 8)
        elif address == self.find_function_stub:
            self.events.append({'op': 'FindFunction'})
            cpu.reg_write(UC_X86_REG_EAX, 0)
            self._cdecl_return(cpu, stack, 8)
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

    def line_table(self, records, maxn=None):
        count = len(records)
        cap = count if maxn is None else maxn
        data = self.alloc(LINE_SIZE * cap) if cap else 0
        for i, rec in enumerate(records):
            base = data + i * LINE_SIZE
            self.write(base, 'f', rec.get('x', 0.0))
            self.write(base + 4, 'i', rec.get('start', 0))
            self.write(base + 8, 'i', rec.get('visible', 0))
            self.write(base + 0xc, 'i', rec.get('full', 0))
        return data, count, cap

    def undo_record(self, rec, base):
        self.write(base, 'i', rec.get('pos', 0))
        odata, onum, omax = self.fstring(rec.get('old'), rec.get('oldMax'))
        ndata, nnum, nmax = self.fstring(rec.get('new'), rec.get('newMax'))
        self.write(base + 4, '3I', odata, onum, omax)
        self.write(base + 0x10, '3I', ndata, nnum, nmax)

    def window(self, spec):
        """Build an XEditWindow image from a spec dict."""
        address = self.alloc(WINDOW_SIZE)
        self.cpu.mem_write(address, b'\0' * WINDOW_SIZE)
        self.write(address, 'I', self.window_vtable)

        tdata, tnum, tmax = self.fstring(spec.get('text'), spec.get('textMax'))
        self.write(address + O['text'], '3I', tdata, tnum, tmax)

        ldata, lcount, lmax = self.line_table(spec.get('lines', []),
                                            spec.get('linesMax'))
        self.write(address + O['linesData'], '3I', ldata, lcount, lmax)
        l2data, l2count, l2max = self.line_table(spec.get('lines2', []),
                                               spec.get('lines2Max'))
        self.write(address + O['lines2Data'], '3I', l2data, l2count, l2max)

        self.write(address + O['flags'], 'I', spec.get('flags', 1))
        self.write(address + O['ip'], 'i', spec.get('ip', 0))
        self.write(address + O['anchor'], 'i', spec.get('anchor', 0))
        self.write(address + O['ipType'], 'B', spec.get('ipType', 0))
        self.write(address + O['selStart'], 'i', spec.get('selStart', 0))
        self.write(address + O['selEnd'], 'i', spec.get('selEnd', 0))
        self.write(address + O['maxSize'], 'i', spec.get('maxSize', 200000))
        self.write(address + O['ipTexture'], 'I', spec.get('ipTexture', 0))
        self.write(address + O['ipColor'], 'I', spec.get('ipColor', 0))
        self.write(address + O['selTexture'], 'I', spec.get('selTexture', 0))
        self.write(address + O['selColor'], 'I', spec.get('selColor', 0))
        self.write(address + O['selTextColor'], 'I', spec.get('selTextColor', 0))
        for i, value in enumerate(spec.get('cursor', [0, 0, 0])):
            self.write(address + O['cursor'] + 4 * i, 'I', value)
        for i, value in enumerate(spec.get('sounds', [0, 0, 0, 0])):
            self.write(address + O['sounds'] + 4 * i, 'I', value)

        undo = spec.get('undo', [])
        ucap = spec.get('undoMax', len(undo))
        udata = self.alloc(UNDO_SIZE * ucap) if ucap else 0
        for i, rec in enumerate(undo):
            self.undo_record(rec, udata + i * UNDO_SIZE)
        self.write(address + O['undoData'], '3I', udata, len(undo), ucap)
        self.write(address + O['undoPos'], 'i', spec.get('undoPos', 0))
        self.write(address + O['maxUndos'], 'i', spec.get('maxUndos', 64))
        self.write(address + O['savedUndoPos'], 'i', spec.get('savedUndoPos', 0))

        self.write(address + O['textFlags'], 'I', spec.get('textFlags', 0))
        self.write(address + O['relayoutFlags'], 'I', spec.get('relayoutFlags', 0))
        self.write(address + O['pendingPos'], 'i', spec.get('pendingPos', 0))
        self.write(address + O['pendingLen'], 'i', spec.get('pendingLen', 0))
        self.write(address + O['relayoutFlags2'], 'I', spec.get('relayoutFlags2', 0))
        self.write(address + O['pendingPos2'], 'i', spec.get('pendingPos2', 0))
        self.write(address + O['pendingLen2'], 'i', spec.get('pendingLen2', 0))
        self.write(address + O['height'], 'f', spec.get('height', 0.0))
        self.write(address + O['lineSpacing'], 'f', spec.get('lineSpacing', 0.0))
        self.write(address + O['lineHeight'], 'f', spec.get('lineHeight', 0.0))
        self.write(address + O['stateFlags'], 'I', spec.get('stateFlags', 1))
        self.write(address + O['blinkOn'], 'f', spec.get('blinkOn', 0.75))
        self.write(address + O['blinkOff'], 'f', spec.get('blinkOff', 1.0))
        self.write(address + O['stickyX'], 'f', spec.get('stickyX', 0.0))

        parent = spec.get('parent', 0)
        if isinstance(parent, dict) or parent is True:
            parent = self.window(parent if isinstance(parent, dict) else {})
        self.write(address + O['parent'], 'I', parent)
        self._window = address
        self._window_spec = spec
        return address

    # ----- canonical dump ----------------------------------------------------
    def dump_fstring(self, address):
        data, num, maxn = self.read(address, '3I')
        return {'text': self.wstring(data) if data else None,
                'data': self.canon(data), 'num': num, 'max': maxn}

    def dump_line(self, address):
        x, start, visible, full = self.read(address, 'I3i')
        return {'x': x, 'start': start, 'visible': visible, 'full': full}

    def dump_undo(self, address):
        pos = self.read(address, 'i')[0]
        return {'pos': pos, 'old': self.dump_fstring(address + 4),
                'new': self.dump_fstring(address + 0x10)}

    def dump_state(self, this):
        tdata, tnum, tmax = self.read(this + O['text'], '3I')
        text = {'text': self.wstring(tdata) if tdata else None,
                'data': self.canon(tdata), 'num': tnum, 'max': tmax}
        ldata, lcount, lmax = self.read(this + O['linesData'], '3I')
        lines = [self.dump_line(ldata + i * LINE_SIZE)
                 for i in range(lcount)] if ldata else []
        l2data, l2count, l2max = self.read(this + O['lines2Data'], '3I')
        lines2 = [self.dump_line(l2data + i * LINE_SIZE)
                  for i in range(l2count)] if l2data else []
        udata, unum, umax = self.read(this + O['undoData'], '3I')
        undo = [self.dump_undo(udata + i * UNDO_SIZE)
                for i in range(unum)] if udata else []
        return {
            'flags': self.read(this + O['flags'], 'I')[0],
            'ip': self.read(this + O['ip'], 'i')[0],
            'anchor': self.read(this + O['anchor'], 'i')[0],
            'ipType': self.read(this + O['ipType'], 'B')[0],
            'selStart': self.read(this + O['selStart'], 'i')[0],
            'selEnd': self.read(this + O['selEnd'], 'i')[0],
            'maxSize': self.read(this + O['maxSize'], 'i')[0],
            'ipTexture': self.canon(self.read(this + O['ipTexture'], 'I')[0]),
            'ipColor': self.read(this + O['ipColor'], 'I')[0],
            'selTexture': self.canon(self.read(this + O['selTexture'], 'I')[0]),
            'selColor': self.read(this + O['selColor'], 'I')[0],
            'selTextColor': self.read(this + O['selTextColor'], 'I')[0],
            'cursor': list(self.read(this + O['cursor'], '3I')),
            'sounds': list(self.read(this + O['sounds'], '4I')),
            'undoData': self.canon(udata), 'undoNum': unum, 'undoMax': umax,
            'undoPos': self.read(this + O['undoPos'], 'i')[0],
            'maxUndos': self.read(this + O['maxUndos'], 'i')[0],
            'savedUndoPos': self.read(this + O['savedUndoPos'], 'i')[0],
            'blinkOn': self.read(this + O['blinkOn'], 'I')[0],
            'blinkOff': self.read(this + O['blinkOff'], 'I')[0],
            'stateFlags': self.read(this + O['stateFlags'], 'I')[0],
            'stickyX': self.read(this + O['stickyX'], 'I')[0],
            'height': self.read(this + O['height'], 'I')[0],
            'lineSpacing': self.read(this + O['lineSpacing'], 'I')[0],
            'lineHeight': self.read(this + O['lineHeight'], 'I')[0],
            'textFlags': self.read(this + O['textFlags'], 'I')[0],
            'relayoutFlags': self.read(this + O['relayoutFlags'], 'I')[0],
            'pendingPos': self.read(this + O['pendingPos'], 'i')[0],
            'pendingLen': self.read(this + O['pendingLen'], 'i')[0],
            'relayoutFlags2': self.read(this + O['relayoutFlags2'], 'I')[0],
            'pendingPos2': self.read(this + O['pendingPos2'], 'i')[0],
            'pendingLen2': self.read(this + O['pendingLen2'], 'i')[0],
            'text': text,
            'linesData': self.canon(ldata), 'linesCount': lcount, 'linesMax': lmax,
            'lines': lines,
            'lines2Data': self.canon(l2data), 'lines2Count': l2count, 'lines2Max': l2max,
            'lines2': lines2,
            'undo': undo,
            'parent': self.canon(self.read(this + O['parent'], 'I')[0]),
            'clipboard': self.dump_fstring(CLIPBOARD),
            'convert': self.dump_fstring(CONVERT_BUFFER),
            'convertFlag': self.read(CONVERT_FLAG, 'B')[0],
        }

    def run_method(self, name, this, arg_words=()):
        body = BODIES[name]
        return self.call(body, this, struct.pack('<%dI' % len(arg_words), *arg_words))

    def marshal_args(self, this, args):
        """Turn case-file arg specs into method-body stack words."""
        words = []
        for arg in args:
            if 'int' in arg:
                words.append(arg['int'] & 0xffffffff)
            elif 'float' in arg:
                words.append(struct.unpack('<I', struct.pack('<f', arg['float']))[0])
            elif 'string' in arg:
                words.append(self.write_wstring(arg['string']))
            elif 'bytes' in arg:
                data = bytes(arg['bytes'])
                ptr = self.alloc(max(len(data), 4))
                self.cpu.mem_write(ptr, data)
                words.append(ptr)
            else:
                raise ValueError('unsupported arg %r' % (arg,))
        return words

    def begin_case(self, spec):
        # Process-global scratch: a fresh case models a process where no edit
        # path has run yet, unless the spec supplies clipboard contents.
        cdata, cnum, cmax = self.fstring(spec.get('clipboard'))
        self.write(CLIPBOARD, '3I', cdata, cnum, cmax)
        self.write(CONVERT_BUFFER, '3I', 0, 0, 0)
        self.write(CONVERT_FLAG, 'B', 0)
        this = self.window(spec)
        self.events = []
        self.block_ids = {}
        self.blocks = {}
        self.freed = set()
        self.seen_ids = {}
        self.text_changed_sink = spec.get('textChangedSink', 0)
        self.columns = list(spec.get('columns', []))
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
    probe = EditWindowProbe(Path(root or sys.argv[1]))
    cases = json.loads(
        (Path(__file__).parent / 'editwindow-cases.json').read_text())[section]
    results = {}
    for name, case in cases.items():
        this = probe.begin_case(case['spec'])
        words = probe.marshal_args(this, case.get('args', []))
        if result_kind == 'execInt':
            out = probe.run_exec_int(BODIES[method], this)
        else:
            ret = probe.run_method(method, this, words)
            if result_kind == 'void':
                # The export returns no value; the leftover EAX is recorded as
                # evidence but is not observable through the script VM.
                out = {'result': None, 'rawEax': ret}
            elif result_kind == 'int':
                out = {'result': struct.unpack('<i', struct.pack('<I', ret))[0]}
            elif result_kind == 'outPair':
                # Two out-ints through stack slots (phase-2 natives).
                out = {'result': [struct.unpack('<i', struct.pack('<I', w))[0]
                                  for w in words]}
            else:
                raise ValueError('unsupported result kind %r' % (result_kind,))
        out['events'] = list(probe.events)
        out['state'] = probe.dump_state(this)
        results[name] = out
    print(json.dumps({
        'hashes': {'Extension.dll': EXTENSION_HASH, 'MSVCRT.dll': MSVCRT_HASH},
        'extensionBase': EXTENSION_BASE,
        'body': BODIES[method],
        'cases': results,
    }))
