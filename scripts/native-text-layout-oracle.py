"""Unicorn oracle for the Extension XLargeTextWindow / XEditWindow bodies.

The JavaScript validator (scripts/validate-text-layout-diff.mjs) builds the
whole object world — window, UGC, fonts, textures, canvas and render
interface — in the window-host native heap at its real addresses
(0x21000000..). Each case hands that heap image, the method and its dword
arguments to this probe, which maps the image at the same addresses and runs
the real Extension.dll body (rebased to 0x12000000) with Core.dll and
MSVCRT.dll executing unchanged. Only host leaves are intercepted:

  * GMalloc (Malloc/Realloc/Free) -> probe blocks at 0x22000000..
  * XWindow::GetGC / ReleaseGC            -> the case GC / nothing
  * XWindow::Draw (script DrawWindow)     -> event
  * XWindow::ProcessScript                -> event (FName globals preset to
    sentinels naming the event) + the case's script result
  * XWindow::ParentRequestedGranularity   -> event
  * XWindow::AskParentForReconfigure / AskParentToShowArea / SetSelectability
    / PlaySound (5 args)                   -> events
  * XWindow::GetTickOffset / IsFocusWindow / GetRootWindow / IsKeyDown /
    GetCursorPos                           -> case values
  * window vtable +0x9c MouseMoved, +0x114 TextChanged, +0x118 EditActivated
    (a patched copy of the real class vtable) -> events + case results
  * Core UObject::FindFunction            -> 0 (no script FilterChar)
  * texture vtable Lock/Unlock, canvas DrawTile (+0x5c) and render-interface
    glyph DrawTile (+0x7c)                 -> recorded argument blocks
  * the Extension atexit thunk            -> 0

Input: JSON on stdin {cases: [...]}; output: per case the events, EAX, the
out cells, the post-call image and the live probe blocks.
"""
import base64
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)

EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
MSVCRT_HASH = 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210'
EXT = 0x12000000
IMAGES = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXT}, 'MSVCRT.dll': MSVCRT_HASH}
R = lambda address: address - 0x10000000 + EXT   # preferred-base address -> oracle

METHODS = {
    'largeText.configurationChanged': R(0x1002e430), 'largeText.preferredSize': R(0x1002e1d0),
    'largeText.granularity': R(0x1002e380), 'largeText.draw': R(0x1002e500),
    'largeText.setText': R(0x1002d6b0), 'largeText.appendText': R(0x1002d730),
    'edit.computeCursorConfig': R(0x1001f680), 'edit.showCursor': R(0x1001ef40), 'edit.tick': R(0x100207d0),
    'edit.cursorRequested': R(0x10020940), 'edit.preferredSize': R(0x10020ac0),
    'edit.configurationChanged': R(0x10020ba0), 'edit.visibilityChanged': R(0x10020c60), 'edit.draw': R(0x10020d00),
    'edit.keyPressed': R(0x10021290), 'edit.virtualKeyPressed': R(0x10021480),
    'edit.mouseButtonPressed': R(0x10021570), 'edit.mouseMoved': R(0x100216b0),
    'edit.mouseButtonReleased': R(0x10021760), 'edit.appendText': R(0x1001e310),
    'edit.xToCol': R(0x1001e7f0), 'edit.yToRow': R(0x1001e740), 'edit.xyToPos': R(0x1001ec10),
    'edit.playEditSound': R(0x1001dca0), 'window.enableSpecialText': R(0x1004dbe0),
}
VTABLES = {'largeText': R(0x1005b3e8), 'edit': R(0x1005b50c)}
# ProcessScript FName globals (preset to sentinel indices) and their events.
SCRIPT_NAMES = {R(0x1009b388): 'CursorRequested', R(0x1009b3a0): 'VisibilityChanged', R(0x1009b370): 'KeyPressed',
                R(0x1009b39c): 'VirtualKeyPressed', R(0x1009b340): 'MouseButtonPressed', R(0x1009b3e0): 'MouseMoved',
                R(0x1009b394): 'MouseButtonReleased'}
GET_GC, RELEASE_GC, WINDOW_DRAW = R(0x1004ddc0), R(0x1004de50), R(0x10003bf0)
PROCESS_SCRIPT, GRANULARITY_BRIDGE = R(0x1004ded0), R(0x10050450)
ASK_RECONFIGURE, SHOW_AREA, SET_SELECTABILITY, PLAY_SOUND = R(0x1004e060), R(0x1004e230), R(0x1004c390), R(0x10050050)
TICK_OFFSET, IS_FOCUS, ROOT_WINDOW, IS_KEY_DOWN, CURSOR_POS = R(0x1004fda0), R(0x1004ca20), R(0x1004c5a0), R(0x1004c980), R(0x1004cbf0)
ATEXIT_THUNK = R(0x100546da)
GMALLOC_IAT, FAIL_ASSERT_IAT, FIND_FUNCTION_IAT = R(0x10059060), R(0x10059098), R(0x100590e0)
TEXCACHE_RECORDS, TEXCACHE_STATIC = R(0x100a2630), R(0x100aeb20)
IMAGE_BASE, BLOCK_BASE = 0x21000000, 0x22000000


class TextLayoutProbe(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), IMAGES)
        self.blocks = {}
        self.block_next = BLOCK_BASE
        stub = lambda ret: self._stub(ret)
        self.malloc_stub, self.realloc_stub, self.free_stub = stub(b'\xc3'), stub(b'\xc3'), stub(b'\xc3')
        vtable, malloc = self.alloc(32), self.alloc(16)
        self.write(vtable, '3I', self.malloc_stub, self.realloc_stub, self.free_stub)
        self.write(malloc, 'I', vtable)
        self.write(self.read(GMALLOC_IAT, 'I')[0], 'I', malloc)
        self.assert_addr = self.read(FAIL_ASSERT_IAT, 'I')[0]
        self.find_function_stub = stub(b'\xc3')
        self.write(FIND_FUNCTION_IAT, 'I', self.find_function_stub)
        self.lock_stub, self.unlock_stub = stub(b'\xc2\x14\x00'), stub(b'\xc2\x04\x00')
        self.drawtile_stub, self.glyph_stub = stub(b'\xc2\x50\x00'), stub(b'\xc2\x54\x00')
        self.mouse_moved_stub, self.text_changed_stub, self.edit_activated_stub = stub(b'\xc3'), stub(b'\xc3'), stub(b'\xc3')
        # GetTickOffset returns its float in ST0: `fld dword [cell]; ret`.
        self.tick_cell = self.alloc(16)
        self.cpu.mem_write(TICK_OFFSET, b'\xd9\x05' + struct.pack('<I', self.tick_cell) + b'\xc3')
        for index, address in enumerate(SCRIPT_NAMES):
            self.write(address, 'I', 0x5c000 + index)
        self.script_names = {0x5c000 + i: name for i, name in enumerate(SCRIPT_NAMES.values())}
        self.vtables = {}
        for family, real in VTABLES.items():
            copy = self.alloc(0x140)
            self.cpu.mem_write(copy, bytes(self.cpu.mem_read(real, 0x140)))
            self.write(copy + 0x9c, 'I', self.mouse_moved_stub)
            self.write(copy + 0x114, 'I', self.text_changed_stub)
            self.write(copy + 0x118, 'I', self.edit_activated_stub)
            self.vtables[family] = copy
        self.cpu.hook_del(self.code_hook)
        self.cpu.hook_add(UC_HOOK_CODE, self.on_dispatch)

    def _stub(self, code):
        address = self.alloc(16)
        self.cpu.mem_write(address, code)
        return address

    @staticmethod
    def _ret(cpu, stack, arg_bytes=0, eax=None):
        if eax is not None:
            cpu.reg_write(UC_X86_REG_EAX, eax & 0xffffffff)
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + arg_bytes)
        cpu.reg_write(UC_X86_REG_EIP, int.from_bytes(cpu.mem_read(stack, 4), 'little'))

    def new_block(self, size):
        address = self.block_next
        self.block_next += (max(size, 4) + 15) & ~15
        if self.block_next >= 0x23000000:
            raise MemoryError('probe block region exhausted')
        self.cpu.mem_write(address, b'\0' * max(size, 4))
        self.blocks[address] = size
        return address

    def record(self, event):
        self.events.append(event)

    def on_dispatch(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address in self.thunks:
            raise RuntimeError(f'Unresolved import {self.thunks[address]}; trace {list(self.trace)}')
        self.trace.append(hex(address))
        stack = cpu.reg_read(UC_X86_REG_ESP)
        ecx = cpu.reg_read(UC_X86_REG_ECX)
        args = lambda fmt: self.read(stack + 4, fmt)
        case = self.case
        if address == self.malloc_stub:
            size, _tag = args('2I')
            self._ret(cpu, stack, 8, self.new_block(size))
        elif address == self.realloc_stub:
            old, size, _tag = args('3I')
            if size == 0:
                self.blocks.pop(old, None)
                return self._ret(cpu, stack, 12, 0)
            new = self.new_block(size)
            if old:
                keep = min(self.blocks.get(old, size), size)
                self.cpu.mem_write(new, bytes(self.cpu.mem_read(old, keep)))
                self.blocks.pop(old, None)
            self._ret(cpu, stack, 12, new)
        elif address == self.free_stub:
            self.blocks.pop(args('I')[0], None)
            self._ret(cpu, stack, 4)
        elif address == self.assert_addr:
            raise RuntimeError('appFailAssert fired; trace %s' % list(self.trace))
        elif address == self.find_function_stub:
            self._ret(cpu, stack, 8, 0)
        elif address == ATEXIT_THUNK:
            self._ret(cpu, stack, 0, 0)
        elif address == GET_GC:
            self._ret(cpu, stack, 0, case.get('gc', 0))
        elif address == RELEASE_GC:
            self._ret(cpu, stack, 4)
        elif address == WINDOW_DRAW:
            self.record({'op': 'DrawWindow', 'gc': args('I')[0]})
            self._ret(cpu, stack, 4)
        elif address == PROCESS_SCRIPT:
            name, parms, _flag = args('3I')
            event = self.script_names.get(name)
            if event is None:
                raise RuntimeError('ProcessScript with an unexpected name %x' % name)
            layout = {'CursorRequested': '7I', 'VisibilityChanged': 'I', 'KeyPressed': '3I',
                      'VirtualKeyPressed': 'II', 'MouseButtonPressed': '4I', 'MouseMoved': '2I',
                      'MouseButtonReleased': '4I'}[event]
            words = list(self.read(parms, layout))
            if event == 'KeyPressed':
                data, num, _max = words
                words = [self.wstring(data) if num else '']
            elif event in ('VirtualKeyPressed', 'MouseButtonPressed', 'MouseButtonReleased'):
                words[0 if event == 'VirtualKeyPressed' else 2] &= 0xff
            self.record({'op': 'ProcessScript', 'event': event, 'args': words})
            result = case.get('scriptResult', 0)
            offset = {'CursorRequested': 0x1c, 'KeyPressed': 0xc, 'VirtualKeyPressed': 8,
                      'MouseButtonPressed': 0x10, 'MouseButtonReleased': 0x10}.get(event)
            if offset is not None:
                self.write(parms + offset, 'I', result)
            self._ret(cpu, stack, 12)
        elif address == GRANULARITY_BRIDGE:
            h, v = args('2I')
            self.record({'op': 'ParentRequestedGranularity', 'h': self.read(h, 'I')[0], 'v': self.read(v, 'I')[0]})
            self._ret(cpu, stack, 8)
        elif address == ASK_RECONFIGURE:
            self.record({'op': 'AskParentForReconfigure', 'window': ecx})
            self._ret(cpu, stack)
        elif address == SHOW_AREA:
            self.record({'op': 'AskParentToShowArea', 'area': list(args('4I'))})
            self._ret(cpu, stack, 16)
        elif address == SET_SELECTABILITY:
            self.record({'op': 'SetSelectability', 'value': args('I')[0]})
            self._ret(cpu, stack, 4)
        elif address == PLAY_SOUND:
            self.record({'op': 'PlaySound', 'args': list(args('5I'))})
            self._ret(cpu, stack, 20)
        elif address == IS_FOCUS:
            self._ret(cpu, stack, 0, case.get('isFocus', 0))
        elif address == ROOT_WINDOW:
            self._ret(cpu, stack, 0, case.get('root', 0))
        elif address == IS_KEY_DOWN:
            self._ret(cpu, stack, 4, case.get('keys', {}).get(str(args('I')[0]), 0))
        elif address == CURSOR_POS:
            x, y = args('2I')
            self.write(x, 'I', case['cursorPos'][0])
            self.write(y, 'I', case['cursorPos'][1])
            self._ret(cpu, stack, 8)
        elif address == self.mouse_moved_stub:
            self.record({'op': 'MouseMoved', 'window': ecx, 'args': list(args('2I'))})
            self._ret(cpu, stack, 8)
        elif address == self.text_changed_stub:
            self.record({'op': 'TextChanged', 'window': ecx, 'args': list(args('2I'))})
            self._ret(cpu, stack, 8, case.get('textChangedResult', 0))
        elif address == self.edit_activated_stub:
            self.record({'op': 'EditActivated', 'window': ecx, 'args': list(args('2I'))})
            self._ret(cpu, stack, 8, case.get('editActivatedResult', 0))
        elif address == self.lock_stub:
            record, b0, b4, minus_one, ri = args('5I')
            self.record({'op': 'TextureLock', 'texture': ecx, 'record': self.record_label(record),
                         'b0': b0, 'b4': b4, 'arg3': minus_one, 'ri': ri})
            self.write(record, 'I', ecx)
        elif address == self.unlock_stub:
            self.record({'op': 'TextureUnlock', 'texture': ecx, 'record': self.record_label(args('I')[0])})
        elif address == self.drawtile_stub:
            words = args('20I')
            self.record({'op': 'DrawTile', 'canvas': ecx, 'texture': words[0], 'coords': list(words[1:9]),
                         'span': words[9], 'z': words[10], 'color': list(words[11:15]), 'fog': list(words[15:19]),
                         'polyFlags': words[19]})
        elif address == self.glyph_stub:
            words = args('21I')
            self.record({'op': 'DrawGlyphTile', 'ri': ecx, 'node': words[0], 'record': self.record_label(words[1]),
                         'texture': self.read(words[1], 'I')[0], 'coords': list(words[2:10]), 'span': words[10],
                         'z': words[11], 'color': list(words[12:16]), 'fog': list(words[16:20]), 'polyFlags': words[20]})

    def record_label(self, address):
        if address == TEXCACHE_STATIC:
            return 'recStatic'
        index, rest = divmod(address - TEXCACHE_RECORDS, 0x84)
        return 'rec%d' % index if 0 <= index < 5 and not rest else address

    def wstring(self, address):
        out = []
        while True:
            unit = self.read(address + 2 * len(out), 'H')[0]
            if not unit:
                return ''.join(map(chr, out))
            out.append(unit)

    def run(self, case):
        self.case, self.events, self.blocks, self.block_next = case, [], {}, BLOCK_BASE
        image = base64.b64decode(case['image'])
        self.cpu.mem_write(IMAGE_BASE, image)
        for table in case.get('textureVtables', []):
            self.write(table + 0x54, 'I', self.lock_stub)
            self.write(table + 0x58, 'I', self.unlock_stub)
        if case.get('canvasTable'):
            self.write(case['canvasTable'] + 0x5c, 'I', self.drawtile_stub)
        if case.get('renderTable'):
            self.write(case['renderTable'] + 0x7c, 'I', self.glyph_stub)
        self.write(case['window'], 'I', self.vtables[case['family']])
        for parent in case.get('parents', []):
            self.write(parent, 'I', self.vtables['largeText'])
        self.write(self.tick_cell, 'I', case.get('tickOffset', 0))
        cells = self.alloc(64)
        self.cpu.mem_write(cells, b'\0' * 64)
        words = []
        for arg in case['args']:
            if isinstance(arg, dict):
                self.write(cells + 4 * arg['cell'], 'I', arg['value'])
                words.append(cells + 4 * arg['cell'])
            else:
                words.append(arg & 0xffffffff)
        eax = self.call(METHODS[case['method']], case['window'], struct.pack('<%dI' % len(words), *words))
        return {'events': self.events, 'eax': eax, 'cells': list(self.read(cells, '16I')),
                'image': base64.b64encode(bytes(self.cpu.mem_read(IMAGE_BASE, len(image)))).decode(),
                'blocks': {str(a): base64.b64encode(bytes(self.cpu.mem_read(a, max(s, 4)))).decode()
                           for a, s in self.blocks.items()}}


def main():
    root = sys.argv[1]
    request = json.load(sys.stdin)
    probe = TextLayoutProbe(root)
    out = {'extensionBase': EXT, 'cases': {}}
    for case in request['cases']:
        try:
            out['cases'][case['name']] = probe.run(case)
        except Exception as error:  # reported per case, compared as a failure
            out['cases'][case['name']] = {'error': str(error)}
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
