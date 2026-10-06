"""Unicorn oracle for the Extension XListWindow family.

scripts/validate-window-list-family.mjs builds the list window, its rows and
columns, fonts, textures, GCs, canvas, render interface and parent windows in
the window-host native heap at its real addresses (0x21000000..). Each case
hands that heap image, the live heap block sizes and either one registered
exec body (a native, with its parameters) or one XListWindow method (a
virtual, with dword arguments) to this probe, which maps the image at the same
addresses and runs the original Extension.dll body (rebased to 0x12000000)
with Core.dll and MSVCRT.dll executing unchanged.

The allocator, the appSprintf float leaf and the kernel32 bridges are the
ones of scripts/native-listwindow-probe.py (ListWindowProbe), with GMalloc
blocks placed at 0x22000000... Only host leaves are intercepted:

  * GNatives (every entry)               -> the case's next parameter, at its
    width; a string is an FString over a probe buffer whose later
    Realloc/Free is not an allocator event (VM parameter temporaries); an out
    parameter points GPropAddr at a result cell
  * XWindow::Init / CleanUp              -> events
  * XWindow::ProcessScript               -> event (FName globals preset to
    sentinels naming the event) + the case's script result
  * XWindow::Draw (script DrawWindow)    -> event
  * XWindow::ParentRequestedGranularity  -> event
  * AskParentForReconfigure / AskParentToShowArea / SetSelectability /
    PlaySound (both overloads)           -> events
  * IsKeyDown / IsFocusWindow / GetTickOffset / GetCursorPos -> case values
  * vtable +0x9c MouseMoved, +0x108 ListRowActivated, +0x10c
    ListSelectionChanged (patched copies of the real XListWindow and XWindow
    tables)                              -> events + case results
  * Core UObject::UObject / ConditionalDestroy / ~UObject -> events (the
    constructor and destructor cases)
  * texture Lock/Unlock, canvas DrawTile (+0x5c), render-interface glyph
    DrawTile (+0x7c)                     -> recorded argument blocks

XWindow::GetGC/ReleaseGC, every XGC body (PushGC/PopGC/CopyGC, SetFonts,
GetTextExtent, Intersect, DrawText, DrawPattern, DrawBox...), GetCharSize,
the FArray/FString code, appStrcmp/appStricmp, appMemmove and qsort execute.

Input: JSON on stdin {cases: [...]}; output: per case the events, EAX, the
out cells, the result slot, the post-call image and the in-call blocks.
Research tool; never imported by the browser.
"""
import base64
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

_SPEC = importlib.util.spec_from_file_location(
    'listwindow_probe', Path(__file__).with_name('native-listwindow-probe.py'))
_PROBE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PROBE)

EXT = 0x12000000
R = lambda address: address - 0x10000000 + EXT
IMAGE_BASE, BLOCK_BASE, BLOCK_END = 0x21000000, 0x22000000, 0x23000000
GNATIVES_IAT = R(0x10059064)
GPROPADDR = 0x101e32f8                       # Core ?GPropAddr@@3PAEA
UOBJECT_CTOR_IAT, CONDITIONAL_DESTROY_IAT, UOBJECT_DTOR_IAT = R(0x1005907c), R(0x10059078), R(0x10059074)

METHODS = {
    'construct': R(0x10016300), 'destruct': R(0x10015de0), 'init': R(0x1002e900), 'cleanUp': R(0x1002ead0),
    'preferredSize': R(0x10033260), 'granularity': R(0x100332c0), 'draw': R(0x10033350),
    'mouseButtonPressed': R(0x10033750), 'mouseMoved': R(0x100338c0), 'mouseButtonReleased': R(0x100339c0),
    'keyPressed': R(0x10033ae0), 'virtualKeyPressed': R(0x10033ca0), 'visibilityChanged': R(0x10033d90),
    'tick': R(0x10033e50),
}
LIST_VTABLE, WINDOW_VTABLE = R(0x1005b998), R(0x10059930)
SCRIPT_NAMES = {R(0x1009b340): 'MouseButtonPressed', R(0x1009b3e0): 'MouseMoved', R(0x1009b394): 'MouseButtonReleased',
                R(0x1009b370): 'KeyPressed', R(0x1009b39c): 'VirtualKeyPressed', R(0x1009b3a0): 'VisibilityChanged',
                R(0x1009b3f0): 'ListRowActivated', R(0x1009b384): 'ListSelectionChanged'}
SCRIPT_LAYOUT = {'MouseButtonPressed': ('4I', 0x10), 'MouseButtonReleased': ('4I', 0x10), 'MouseMoved': ('2I', None),
                 'KeyPressed': ('3I', 0xc), 'VirtualKeyPressed': ('2I', 8), 'VisibilityChanged': ('I', None)}
WINDOW_INIT, WINDOW_CLEANUP, PROCESS_SCRIPT, WINDOW_DRAW = R(0x1004bb30), R(0x1004bec0), R(0x1004ded0), R(0x10003bf0)
GRANULARITY_BRIDGE, ASK_RECONFIGURE, SHOW_AREA, SET_SELECTABILITY = R(0x10050450), R(0x1004e060), R(0x1004e230), R(0x1004c390)
PLAY_SOUND5, PLAY_SOUND3 = R(0x10050050), R(0x1004ffb0)
IS_KEY_DOWN, IS_FOCUS, TICK_OFFSET, CURSOR_POS = R(0x1004c980), R(0x1004ca20), R(0x1004fda0), R(0x1004cbf0)
ATEXIT_THUNK = R(0x100546da)
TEXCACHE_RECORDS, TEXCACHE_STATIC = R(0x100a2630), R(0x100aeb20)
F = lambda word: struct.unpack('<f', struct.pack('<I', word & 0xffffffff))[0]


class ListFamilyOracle(_PROBE.ListWindowProbe):
    def __init__(self, root):
        super().__init__(root)
        stub = lambda code: self._stub(code)
        self.gnative_stub = stub(b'\xc3')
        table = self.alloc(0x400)
        for i in range(0x100):
            self.write(table + 4 * i, 'I', self.gnative_stub)
        self.write(GNATIVES_IAT, 'I', table)
        self.ctor_stub, self.cdestroy_stub, self.dtor_stub = stub(b'\xc3'), stub(b'\xc3'), stub(b'\xc3')
        self.write(UOBJECT_CTOR_IAT, 'I', self.ctor_stub)
        self.write(CONDITIONAL_DESTROY_IAT, 'I', self.cdestroy_stub)
        self.write(UOBJECT_DTOR_IAT, 'I', self.dtor_stub)
        self.lock_stub, self.unlock_stub = stub(b'\xc2\x14\x00'), stub(b'\xc2\x04\x00')
        self.drawtile_stub, self.glyph_stub = stub(b'\xc2\x50\x00'), stub(b'\xc2\x54\x00')
        self.mouse_moved_stub, self.row_activated_stub, self.selection_stub2 = stub(b'\xc3'), stub(b'\xc3'), stub(b'\xc3')
        self.tick_cell = self.alloc(16)
        self.cpu.mem_write(TICK_OFFSET, b'\xd9\x05' + struct.pack('<I', self.tick_cell) + b'\xc3')
        for index, address in enumerate(SCRIPT_NAMES):
            self.write(address, 'I', 0x5c000 + index)
        self.script_names = {0x5c000 + i: name for i, name in enumerate(SCRIPT_NAMES.values())}
        self.list_vtable = self._vtable(LIST_VTABLE)
        self.parent_vtable = self._vtable(WINDOW_VTABLE)
        self.leaves = {
            self.gnative_stub: self.on_gnative,
            self.ctor_stub: lambda c, s, e: self.ret(s, 0, ev={'op': 'UObject::UObject', 'object': self.canon(e)}),
            self.cdestroy_stub: lambda c, s, e: self.ret(s, 0, 1, ev={'op': 'ConditionalDestroy', 'object': self.canon(e)}),
            self.dtor_stub: lambda c, s, e: self.ret(s, 0, ev={'op': 'UObject::~UObject', 'object': self.canon(e)}),
            WINDOW_INIT: lambda c, s, e: self.ret(s, 4, ev={'op': 'XWindow::Init', 'parent': self.canon(self.arg(s, 0))}),
            WINDOW_CLEANUP: lambda c, s, e: self.ret(s, 0, ev={'op': 'XWindow::CleanUp'}),
            PROCESS_SCRIPT: self.on_process_script,
            WINDOW_DRAW: lambda c, s, e: self.ret(s, 4, ev={'op': 'DrawWindow', 'gc': self.canon(self.arg(s, 0))}),
            GRANULARITY_BRIDGE: self.on_granularity,
            ASK_RECONFIGURE: lambda c, s, e: self.ret(s, 0, ev={'op': 'AskParentForReconfigure', 'object': self.canon(e)}),
            SHOW_AREA: lambda c, s, e: self.ret(s, 16, ev={'op': 'AskParentToShowArea', 'area': list(self.read(s + 4, '4I'))}),
            SET_SELECTABILITY: lambda c, s, e: self.ret(s, 4, ev={'op': 'SetSelectability', 'value': self.arg(s, 0)}),
            PLAY_SOUND5: lambda c, s, e: self.ret(s, 20, ev={'op': 'PlaySound', 'args': [self.canon(self.arg(s, 0))] + list(self.read(s + 8, '4I'))}),
            PLAY_SOUND3: lambda c, s, e: self.ret(s, 12, ev={'op': 'PlaySound', 'args': [self.canon(self.arg(s, 0))] + list(self.read(s + 8, '2I'))}),
            IS_KEY_DOWN: lambda c, s, e: self.ret(s, 4, self.case.get('keys', {}).get(str(self.arg(s, 0)), 0)),
            IS_FOCUS: lambda c, s, e: self.ret(s, 0, self.case.get('isFocus', 0)),
            CURSOR_POS: self.on_cursor_pos,
            ATEXIT_THUNK: lambda c, s, e: self.ret(s, 0, 0),
            self.mouse_moved_stub: lambda c, s, e: self.ret(s, 8, ev={'op': 'MouseMoved', 'window': self.canon(e), 'args': list(self.read(s + 4, '2I'))}),
            self.row_activated_stub: self.on_row_activated,
            self.selection_stub2: self.on_selection_changed,
            self.lock_stub: self.on_lock, self.unlock_stub: self.on_unlock,
            self.drawtile_stub: self.on_drawtile, self.glyph_stub: self.on_glyph,
        }

    # ----- helpers -----------------------------------------------------------
    def _stub(self, code):
        address = self.alloc(16)
        self.cpu.mem_write(address, code)
        return address

    def _vtable(self, real):
        copy = self.alloc(0x140)
        self.cpu.mem_write(copy, bytes(self.cpu.mem_read(real, 0x140)))
        self.write(copy + 0x9c, 'I', self.mouse_moved_stub)
        self.write(copy + 0x108, 'I', self.row_activated_stub)
        self.write(copy + 0x10c, 'I', self.selection_stub2)
        return copy

    def arg(self, stack, i):
        return self.read(stack + 4 + 4 * i, 'I')[0]

    def ret(self, stack, arg_bytes=0, eax=None, ev=None):
        if ev is not None:
            self.events.append(ev)
        if eax is not None:
            self.cpu.reg_write(UC_X86_REG_EAX, eax & 0xffffffff)
        self.cpu.reg_write(UC_X86_REG_ESP, stack + 4 + arg_bytes)
        self.cpu.reg_write(UC_X86_REG_EIP, self.read(stack, 'I')[0])

    def _track_alloc(self, size):
        address = self.block_next
        self.block_next += (max(size, 4) + 15) & ~15
        if self.block_next >= BLOCK_END:
            raise MemoryError('probe block region exhausted')
        self.cpu.mem_write(address, b'\0' * max(size, 4))
        self.sizes[address] = size
        ident = 'h%d' % len(self.block_ids)
        self.block_ids[address] = ident
        self.blocks[address] = size
        return address, ident

    def canon(self, ptr):
        """In-call GMalloc blocks by allocation order (h<N>, '!' once freed);
        every other pointer is its address, the same in both runtimes."""
        if not ptr:
            return 0
        for base, ident in self.block_ids.items():
            size = self.sizes.get(base, 0)
            if base <= ptr < base + max(size, 4):
                label = ident + ('' if base in self.blocks else '!')
                return label + ('+%x' % (ptr - base) if ptr != base else '')
        return ptr

    # ----- leaves --------------------------------------------------------------
    def on_leaf(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        if address == self.malloc_stub:
            return self.on_malloc(cpu)
        if address == self.realloc_stub:
            old, new_size = self.read(stack + 4, '2I')
            if old in self.param_strings or (not old and not new_size):
                # A VM parameter temporary, or Realloc(NULL, 0): no allocator effect.
                self.param_strings.discard(old)
                cpu.reg_write(UC_X86_REG_EAX, 0)
                return self._cdecl_return(cpu, stack, 12)
            return self.on_realloc(cpu)
        if address == self.free_stub:
            if self.read(stack + 4, 'I')[0] in self.param_strings:
                return self._cdecl_return(cpu, stack, 4)
            return self.on_free(cpu)
        if address == self.sprintf_stub:
            return self.on_sprintf(cpu)
        if address == self.assert_addr:
            raise RuntimeError('appFailAssert fired; trace %s' % list(self.trace))
        handler = self.leaves.get(address)
        if handler:
            handler(cpu, stack, cpu.reg_read(UC_X86_REG_ECX))

    def on_realloc(self, cpu):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        old = self.read(stack + 4, 'I')[0]
        if old and old not in self.sizes and old in self.case_blocks:
            self.sizes[old] = self.case_blocks[old]
        return super().on_realloc(cpu)

    def on_gnative(self, cpu, stack, ecx):
        _frame, result = self.read(stack + 4, '2I')
        if not self.params:
            raise RuntimeError('extra parameter evaluation')
        param = self.params.pop(0)
        if 'out' in param:
            self.write(GPROPADDR, 'I', self.cells + 4 * param['out'])
        elif 'string' in param:
            text = param['string']
            data = 0
            if text:
                raw = text.encode('utf-16-le') + b'\0\0'
                data = self.alloc(len(raw))
                self.cpu.mem_write(data, raw)
                self.param_strings.add(data)
            count = len(text) + 1 if text else 0
            self.write(result, '3I', data, count, count)
        elif not param.get('skip'):
            self.cpu.mem_write(result, bytes.fromhex(param['bytes']))
        self.ret(stack, 8)

    def on_process_script(self, cpu, stack, ecx):
        name, parms, _flag = self.read(stack + 4, '3I')
        event = self.script_names.get(name)
        if event not in SCRIPT_LAYOUT:
            raise RuntimeError('ProcessScript with an unexpected name %x (%s)' % (name, event))
        layout, result_offset = SCRIPT_LAYOUT[event]
        words = list(self.read(parms, layout))
        if event == 'KeyPressed':
            data, num, _max = words
            words = [self.wstring(data) if num else '']
        elif event in ('MouseButtonPressed', 'MouseButtonReleased'):
            words[2] &= 0xff
        elif event == 'VirtualKeyPressed':
            words[0] &= 0xff
        self.events.append({'op': 'ProcessScript', 'event': event, 'window': self.canon(ecx), 'args': words})
        if result_offset is not None:
            self.write(parms + result_offset, 'I', self.case.get('scriptResult', 0))
        self.ret(stack, 12)

    def on_granularity(self, cpu, stack, ecx):
        h, v = self.read(stack + 4, '2I')
        self.events.append({'op': 'ParentRequestedGranularity', 'h': self.read(h, 'I')[0], 'v': self.read(v, 'I')[0]})
        self.ret(stack, 8)

    def on_cursor_pos(self, cpu, stack, ecx):
        x, y = self.read(stack + 4, '2I')
        self.write(x, 'I', self.case['cursorPos'][0])
        self.write(y, 'I', self.case['cursorPos'][1])
        self.ret(stack, 8)

    def on_row_activated(self, cpu, stack, ecx):
        sender, row = self.read(stack + 4, '2I')
        self.events.append({'op': 'ListRowActivated', 'receiver': self.canon(ecx), 'list': self.canon(sender), 'row': self.canon(row)})
        self.ret(stack, 8, self.case.get('activateResults', {}).get(str(ecx), 0))

    def on_selection_changed(self, cpu, stack, ecx):
        sender, count, focus = self.read(stack + 4, '3I')
        self.events.append({'op': 'ListSelectionChanged', 'receiver': self.canon(ecx), 'list': self.canon(sender),
                            'count': count, 'focus': self.canon(focus)})
        self.ret(stack, 12, self.case.get('selectionResults', {}).get(str(ecx), 0))

    def record_label(self, address):
        if address == TEXCACHE_STATIC:
            return 'recStatic'
        index, rest = divmod(address - TEXCACHE_RECORDS, 0x84)
        return 'rec%d' % index if 0 <= index < 5 and not rest else address

    def on_lock(self, cpu, stack, ecx):
        record, b0, b4, minus_one, ri = self.read(stack + 4, '5I')
        self.events.append({'op': 'TextureLock', 'texture': ecx, 'record': self.record_label(record),
                            'b0': b0, 'b4': b4, 'arg3': minus_one, 'ri': ri})
        self.write(record, 'I', ecx)

    def on_unlock(self, cpu, stack, ecx):
        self.events.append({'op': 'TextureUnlock', 'texture': ecx, 'record': self.record_label(self.read(stack + 4, 'I')[0])})

    def on_drawtile(self, cpu, stack, ecx):
        words = self.read(stack + 4, '20I')
        self.events.append({'op': 'DrawTile', 'canvas': ecx, 'texture': words[0], 'coords': list(words[1:9]),
                            'span': words[9], 'z': words[10], 'color': list(words[11:15]), 'fog': list(words[15:19]),
                            'polyFlags': words[19]})

    def on_glyph(self, cpu, stack, ecx):
        words = self.read(stack + 4, '21I')
        self.events.append({'op': 'DrawGlyphTile', 'ri': ecx, 'node': words[0], 'record': self.record_label(words[1]),
                            'texture': self.read(words[1], 'I')[0], 'coords': list(words[2:10]), 'span': words[10],
                            'z': words[11], 'color': list(words[12:16]), 'fog': list(words[16:20]), 'polyFlags': words[20]})

    # ----- one case ------------------------------------------------------------------
    def run(self, case):
        self.case, self.events = case, []
        self.blocks, self.block_ids, self.freed, self.seen_ids = {}, {}, set(), {}
        self.sizes = {}
        self.block_next = BLOCK_BASE
        self.param_strings = set()
        self.case_blocks = {int(a): s for a, s in case.get('blocks', [])}
        image = base64.b64decode(case['image'])
        self.cpu.mem_write(IMAGE_BASE, image)
        self.write(_PROBE.SORT_COUNT, 'i', 0)
        # The DrawText texture cache (records 0x100a2630, head 0x100a2dc8,
        # count 0x100a2dc4, static record 0x100aeb20) is process state; each
        # case starts with it empty, like its fresh JavaScript world.
        self.cpu.mem_write(TEXCACHE_RECORDS, b'\0' * (5 * 0x84))
        self.cpu.mem_write(TEXCACHE_STATIC, b'\0' * 0x84)
        self.write(R(0x100a2dc8), 'I', 0)
        self.write(R(0x100a2dc4), 'I', 0)
        for table in case.get('textureVtables', []):
            self.write(table + 0x54, 'I', self.lock_stub)
            self.write(table + 0x58, 'I', self.unlock_stub)
        if case.get('canvasTable'):
            self.write(case['canvasTable'] + 0x5c, 'I', self.drawtile_stub)
        if case.get('renderTable'):
            self.write(case['renderTable'] + 0x7c, 'I', self.glyph_stub)
        self.write(case['window'], 'I', self.list_vtable)
        for parent in case.get('parents', []):
            self.write(parent, 'I', self.parent_vtable)
        self.write(self.tick_cell, 'I', case.get('tickOffset', 0))
        self.cells = self.alloc(64)
        self.cpu.mem_write(self.cells, b'\0' * 64)
        result = self.alloc(0x20)
        self.cpu.mem_write(result, b'\0' * 0x20 if case.get('resultString') else b'\xcd' * 0x20)
        self.control_word = case.get('controlWord', 0x037f)
        if 'exec' in case:
            self.params = list(case['params'])
            code = self.alloc(0x40)
            self.cpu.mem_write(code, bytes(0x40))
            frame = self.alloc(0x40)
            self.cpu.mem_write(frame, bytes(0x40))
            self.write(frame + 8, 'I', case['window'])
            self.write(frame + 0xc, 'I', code)
            eax = self.call(R(case['exec']), case['window'], struct.pack('<II', frame, result))
            left = len(self.params)
            advance = self.read(frame + 0xc, 'I')[0] - code
        else:
            words = []
            for arg in case['args']:
                if isinstance(arg, dict):
                    self.write(self.cells + 4 * arg['cell'], 'I', arg['value'])
                    words.append(self.cells + 4 * arg['cell'])
                else:
                    words.append(arg & 0xffffffff)
            eax = self.call(METHODS[case['method']], case['window'], struct.pack('<%dI' % len(words), *words))
            left, advance = 0, None
        events = self.events
        if case.get('resultString'):
            data = self.read(result, 'I')[0]
            label = self.canon(data)
            events = [e for e in events if not (e.get('op') in ('Realloc', 'Malloc') and e.get('block') == label)]
        allocs = [[a, self.sizes.get(a, 0), ident, a in self.blocks] for a, ident in self.block_ids.items()]
        return {'events': events, 'eax': eax, 'cells': list(self.read(self.cells, '16I')),
                'result': bytes(self.cpu.mem_read(result, 0x20)).hex(), 'paramsLeft': left, 'codeAdvance': advance,
                'image': base64.b64encode(bytes(self.cpu.mem_read(IMAGE_BASE, len(image)))).decode(),
                'allocs': allocs,
                'blocks': {str(a): base64.b64encode(bytes(self.cpu.mem_read(a, max(s, 4)))).decode()
                           for a, s in self.blocks.items()}}


def main():
    root = sys.argv[1]
    request = json.load(sys.stdin)
    probe = ListFamilyOracle(root)
    out = {'extensionBase': EXT, 'cases': {}}
    for case in request['cases']:
        try:
            out['cases'][case['name']] = probe.run(case)
        except Exception as error:  # reported per case, compared as a failure
            out['cases'][case['name']] = {'error': '%s; trace %s' % (error, list(probe.trace)[-8:])}
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
