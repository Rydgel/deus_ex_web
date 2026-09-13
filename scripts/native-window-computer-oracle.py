"""Focused x86 oracle for Extension.dll XComputerWindow.

The Extension image is the installed, hash-checked binary rebased to
0x12000000.  Engine-owned window graph calls and FArray/allocator calls are
intercepted as narrow leaves; the XComputerWindow bodies themselves execute
unchanged.  This keeps the fixture deterministic while exposing the exact
field/event postconditions needed by the JavaScript translation.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_MEM_WRITE
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)

EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
EXTENSION = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE}}

INTERNAL = EXTENSION_BASE + 0x191e0
CONSTRUCTOR = EXTENSION_BASE + 0xd4d0
INIT = EXTENSION_BASE + 0xd530
SET_TEXT_SIZE = EXTENSION_BASE + 0xd8f0
SET_TEXT_FONT = EXTENSION_BASE + 0xd970
SET_CURSOR_COLOR = EXTENSION_BASE + 0xdab0
SHOW_TEXT_CURSOR = EXTENSION_BASE + 0xdaf0
SET_TEXT_TIMING = EXTENSION_BASE + 0xdb10
ENABLE_WORD_WRAP = EXTENSION_BASE + 0xdbc0
CLEAR_SCREEN = EXTENSION_BASE + 0xdcb0
PRINT = EXTENSION_BASE + 0xddb0
SET_FADE_SPEED = EXTENSION_BASE + 0x31320

BASE_INIT = EXTENSION_BASE + 0x4bb30
GET_ROOT = EXTENSION_BASE + 0x4c5a0
GET_PLAYER = EXTENSION_BASE + 0x4c5c0
CREATE_WINDOW = EXTENSION_BASE + 0x4df70
RESIZE = EXTENSION_BASE + 0x4cf70
ALIGN = EXTENSION_BASE + 0x4d300
MARGINS = EXTENSION_BASE + 0x46070
BLINK = EXTENSION_BASE + 0x1d960
SELECTABLE = EXTENSION_BASE + 0x4c390

O_FLAGS = 0x190
O_TIME_INTERVAL = 0x14c
O_TIME_NEXT = 0x150
O_TIME_LAST = 0x154
O_TIME_CURRENT = 0x158
O_FONT = 0x174
O_FONT_WIDTH = 0x178
O_FONT_HEIGHT = 0x17c
O_CURSOR_FLAGS = 0x1c0
O_CURSOR_BLINK = 0x1bc
O_TEXT_WINDOW = 0x1cc
O_PLAYER = 0x1d0
O_DISPLAY = 0x1d4
O_QUEUE = 0x1e0
O_TEXT_X = 0x1f0
O_TEXT_Y = 0x1f4
O_INPUT_WINDOW = 0x210
O_INPUT_FLAGS = 0x214


class ComputerWindowProbe(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), EXTENSION)
        self.window = None
        self.object_size = 0
        self.events = []
        self.writes = []
        self.children = []
        self.root_window = 0
        self.player = 0
        self.player_name = ''
        self.text_child = 0
        self.input_child = 0
        self.running = False
        self.array_events = {}
        self.array_data = {}
        self.original_imports = {
            'addZeroed': self.read(EXTENSION_BASE + 0x590d4, 'I')[0],
            'realloc': self.read(EXTENSION_BASE + 0x5909c, 'I')[0],
            'appStrcpy': self.read(EXTENSION_BASE + 0x590d8, 'I')[0],
            'appStricmp': self.read(EXTENSION_BASE + 0x590c8, 'I')[0],
        }
        self.add_zeroed = self.original_imports['addZeroed']
        self.realloc = self.original_imports['realloc']
        self.strcpy = self.original_imports['appStrcpy']
        self.stricmp = self.original_imports['appStricmp']
        self.gmalloc_global = self.read(EXTENSION_BASE + 0x59060, 'I')[0]
        self.malloc_object = self.alloc(8)
        self.malloc_vtable = self.alloc(4)
        self.malloc_stub = self.alloc(16)
        self.write(self.malloc_object, 'I', self.malloc_vtable)
        self.write(self.malloc_vtable, 'I', self.malloc_stub)
        self.cpu.mem_write(self.malloc_stub, b'\xc3')
        self.write(self.gmalloc_global, 'I', self.malloc_object)
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)

    @staticmethod
    def _return(cpu, stack, argument_bytes=0):
        address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + argument_bytes)
        cpu.reg_write(UC_X86_REG_EIP, address)

    def on_write(self, cpu, access, address, size, value, data):
        if self.window is None or not (self.window <= address < self.window + self.object_size):
            return
        self.writes.append({'offset': address - self.window, 'size': size, 'value': value})

    def _new(self, size=0x240, seed=0xa5):
        address = self.alloc(size)
        self.cpu.mem_write(address, bytes([seed]) * size)
        return address

    def _set(self, address, offset, value):
        self.write(address + offset, 'I', value & 0xffffffff)

    def _label(self, value):
        return {
            self.window: 'window', self.root_window: 'root', self.player: 'player',
            self.text_child: 'textWindow', self.input_child: 'inputWindow',
        }.get(value, value)

    def _array(self, pointer, count, size):
        data, old_num, old_max = self.read(pointer, 'III')
        new_num = old_num + count
        if data == 0 or old_max < new_num:
            new_max = max(new_num, old_max * 2, 4)
            new_data = self.alloc(new_max * size)
            self.cpu.mem_write(new_data, b'\0' * (new_max * size))
            if data and old_num:
                self.cpu.mem_write(new_data, self.cpu.mem_read(data, old_num * size))
            self.write(pointer, 'I', new_data)
            data, old_max = new_data, new_max
        self.write(pointer + 4, 'I', new_num)
        self.write(pointer + 8, 'I', old_max)
        self.array_data[pointer] = data
        return data, old_num

    def _event(self, array, index):
        data = self.array_data.get(array) or self.read(array, 'I')[0]
        base = data + index * 0x20
        return {
            'type': self.read(base, 'I')[0],
            'time': self.read(base + 4, 'f')[0],
            'charCode': self.read(base + 8, 'H')[0],
            'param0': self.read(base + 0x10, 'I')[0],
            'param1': self.read(base + 0x14, 'I')[0],
            'flags': self.read(base + 0x18, 'I')[0],
        }

    def _write_utf16(self, address, text):
        raw = b''.join(struct.pack('<H', ord(char)) for char in text) + b'\0\0'
        self.cpu.mem_write(address, raw)

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        if address == BASE_INIT:
            self.events.append({'op': 'XWindow::Init', 'object': 'window',
                                'parent': self._label(self.read(stack + 4, 'I')[0])})
            self._return(cpu, stack, 4)
            return
        if address == GET_ROOT:
            self.events.append({'op': 'GetRootWindow', 'object': 'window'})
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, self.root_window)
            self._return(cpu, stack)
            return
        if address == GET_PLAYER:
            self.events.append({'op': 'GetPlayerPawn', 'root': 'root'})
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, self.player)
            self._return(cpu, stack)
            return
        if address == CREATE_WINDOW:
            cls, parent, show = self.read(stack + 4, 'III')
            child = self.text_child if cls == EXTENSION_BASE + 0xae5b8 else self.input_child
            self.children.append({'class': cls, 'parent': self._label(parent), 'bShow': show,
                                  'child': self._label(child)})
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, child)
            self._return(cpu, stack, 12)
            return
        if address == RESIZE:
            width, height = self.read(stack + 4, '2f')
            self.events.append({'op': 'Resize', 'object': self._label(cpu.reg_read(UC_X86_REG_ECX)),
                                'width': width, 'height': height})
            self._return(cpu, stack, 8)
            return
        if address == ALIGN:
            args = self.read(stack + 4, '6I')
            self.events.append({'op': 'SetWindowAlignments', 'object': self._label(cpu.reg_read(UC_X86_REG_ECX)),
                                'args': list(args)})
            self._return(cpu, stack, 24)
            return
        if address == MARGINS:
            args = self.read(stack + 4, '2f')
            self.events.append({'op': 'SetTextMargins', 'object': self._label(cpu.reg_read(UC_X86_REG_ECX)),
                                'args': list(args)})
            self._return(cpu, stack, 8)
            return
        if address == BLINK:
            args = self.read(stack + 4, '2f')
            self.events.append({'op': 'SetInsertionPointBlinkRate', 'object': self._label(cpu.reg_read(UC_X86_REG_ECX)),
                                'args': list(args)})
            self._return(cpu, stack, 8)
            return
        if address == SELECTABLE:
            value = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'SetSelectability', 'object': self._label(cpu.reg_read(UC_X86_REG_ECX)),
                                'value': value})
            self._return(cpu, stack, 4)
            return
        if address == self.add_zeroed:
            array = cpu.reg_read(UC_X86_REG_ECX)
            element_size, count = self.read(stack + 4, '2I')
            data_ptr, index = self._array(array, count, element_size)
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, index)
            self._return(cpu, stack, 8)
            return
        if address == self.realloc:
            array = cpu.reg_read(UC_X86_REG_ECX)
            element_size = self.read(stack + 4, 'I')[0]
            data = self.read(array, 'I')[0]
            self.write(array + 4, 'I', 0)
            self.write(array + 8, 'I', 0)
            if data:
                self.array_data.pop(array, None)
            self.events.append({'op': 'Realloc', 'array': self._label(array), 'elementSize': element_size})
            self._return(cpu, stack, 4)
            return
        if address == self.strcpy:
            destination, source = self.read(stack + 4, '2I')
            chars = []
            cursor = source
            while True:
                value = self.read(cursor, 'H')[0]
                if not value:
                    break
                chars.append(value)
                cursor += 2
            self._write_utf16(destination, ''.join(chr(value) for value in chars))
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, destination)
            self._return(cpu, stack)
            return
        if address == self.stricmp:
            left, right = self.read(stack + 4, '2I')
            def read_text(pointer):
                chars = []
                while True:
                    value = self.read(pointer, 'H')[0]
                    if value == 0:
                        return ''.join(chr(item) for item in chars)
                    chars.append(value)
                    pointer += 2
            a, b = read_text(left), read_text(right)
            result = 0 if a.casefold() == b.casefold() else (-1 if a.casefold() < b.casefold() else 1)
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, result & 0xffffffff)
            self._return(cpu, stack)
            return
        if address == self.malloc_stub:
            size_arg = self.read(stack + 4, 'I')[0]
            pointer = self.alloc(size_arg)
            self.cpu.mem_write(pointer, b'\0' * size_arg)
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, pointer)
            self._return(cpu, stack, 8)
            return
        return super().on_instruction(cpu, address, size, data)

    def constructor_case(self, internal=False):
        self.window = self._new(0x220)
        self.object_size = 0x220
        self.cpu.mem_write(self.window, b'\xa5' * self.object_size)
        self._set(self.window, O_FLAGS, 0xa1b2c3d4)
        self._set(self.window, O_CURSOR_FLAGS, 0x55667788)
        self.writes = []
        self.events = []
        result = self.call(INTERNAL if internal else CONSTRUCTOR, self.window,
                           struct.pack('<I', 0x21000000))
        return {'result': result, 'bytes': list(self.cpu.mem_read(self.window, self.object_size)),
                'writes': list(self.writes)}

    def init_case(self):
        self.window = self._new()
        self.object_size = 0x240
        self.root_window = self._new()
        self.player = self._new()
        viewport = self._new(0x500)
        self._set(self.player, 0xa8, viewport)
        self._set(viewport, 0x4e4, 0)
        self.text_child = self._new(0x80)
        self.input_child = self._new(0x80)
        self.children = []
        self.events = []
        self.writes = []
        self._set(self.window, O_FONT, 0x21212121)
        self._set(self.window, O_FONT_WIDTH, 8)
        self._set(self.window, O_FONT_HEIGHT, 12)
        self._set(self.window, 0x16c, 40)
        self._set(self.window, 0x170, 25)
        self.write(self.window + O_CURSOR_BLINK, 'f', 0.25)
        self._set(self.window, O_INPUT_FLAGS, 0x80000001)
        # Init's appStricmp call is replaced by an empty/nonempty player name
        # graph fixture through the direct string leaf below.
        self._set(self.window, O_PLAYER, 0)
        self.running = True
        result = self.call(INIT, self.window, struct.pack('<I', self._new()))
        self.running = False
        state = {
            'player': self._label(self.read(self.window + O_PLAYER, 'I')[0]),
            'textWindow': self._label(self.read(self.window + O_TEXT_WINDOW, 'I')[0]),
            'inputWindow': self._label(self.read(self.window + O_INPUT_WINDOW, 'I')[0]),
            'inputFlags': self.read(self.window + O_INPUT_FLAGS, 'I')[0],
        }
        return {'result': result, 'state': state, 'events': list(self.events),
                'children': list(self.children), 'writes': list(self.writes)}

    def method_case(self, name):
        self.window = self._new()
        self.object_size = 0x240
        self.events = []
        self.writes = []
        self._set(self.window, O_FLAGS, 0xa5a5a5a5)
        self._set(self.window, O_CURSOR_FLAGS, 0x11223344)
        self._set(self.window, O_INPUT_FLAGS, 0x80000021)
        self._set(self.window, O_QUEUE, 0)
        self._set(self.window, O_QUEUE + 4, 0)
        self._set(self.window, O_QUEUE + 8, 0)
        self._set(self.window, O_DISPLAY, 0x20000000)
        self._set(self.window, O_DISPLAY + 4, 3)
        self._set(self.window, O_DISPLAY + 8, 3)
        self._set(self.window, O_FONT, 0x21400000)
        self._set(self.window, O_TEXT_WINDOW, 0x21401000)
        self._set(self.window, O_FONT_WIDTH, 8)
        self._set(self.window, O_FONT_HEIGHT, 12)
        self._set(self.window, 0x16c, 40)
        self._set(self.window, 0x170, 25)
        self.write(self.window + O_TIME_INTERVAL, 'f', 0.25)
        self.write(self.window + O_TIME_NEXT, 'f', 1.5)
        self.write(self.window + O_TIME_CURRENT, 'f', 10.0)
        self.write(self.window + O_CURSOR_BLINK, 'f', 0.5)
        args = {
            'size': struct.pack('<ii', 80, 30),
            'font': struct.pack('<IiiI', 0x21402000, 9, 14, 0x7f2040ff),
            'timing': struct.pack('<f', 0.75), 'fade': struct.pack('<f', 1.25),
            'cursor': struct.pack('<I', 0xff00a040), 'show': struct.pack('<I', 0),
            'wrap': struct.pack('<I', 0), 'clear': b'',
        }
        if name == 'print':
            text = self.alloc(16)
            self._write_utf16(text, 'A^B')
            string = self.alloc(8)
            self.write(string, 'II', text, 4)
            call_args = struct.pack('<II', string, 0)
        else:
            call_args = args[name]
        address = {'size': SET_TEXT_SIZE, 'font': SET_TEXT_FONT, 'timing': SET_TEXT_TIMING,
                   'fade': SET_FADE_SPEED, 'cursor': SET_CURSOR_COLOR, 'show': SHOW_TEXT_CURSOR,
                   'wrap': ENABLE_WORD_WRAP, 'clear': CLEAR_SCREEN, 'print': PRINT}[name]
        result = self.call(address, self.window, call_args)
        state = {
            'flags': self.read(self.window + O_FLAGS, 'I')[0],
            'cursorFlags': self.read(self.window + O_CURSOR_FLAGS, 'I')[0],
            'inputFlags': self.read(self.window + O_INPUT_FLAGS, 'I')[0],
            'timeNext': self.read(self.window + O_TIME_NEXT, 'f')[0],
            'timeLast': self.read(self.window + O_TIME_LAST, 'f')[0],
            'textX': self.read(self.window + O_TEXT_X, 'I')[0],
            'textY': self.read(self.window + O_TEXT_Y, 'I')[0],
            'textCols': self.read(self.window + 0x16c, 'i')[0],
            'textRows': self.read(self.window + 0x170, 'i')[0],
            'fontWidth': self.read(self.window + O_FONT_WIDTH, 'i')[0],
            'fontHeight': self.read(self.window + O_FONT_HEIGHT, 'i')[0],
        }
        queue = self.read(self.window + O_QUEUE, 'III')
        events = [self._event(self.window + O_QUEUE, i) for i in range(queue[1])]
        return {'result': result, 'state': state, 'events': events, 'writes': list(self.writes),
                'queue': queue}

    def run(self):
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'addresses': {
                'internalConstructor': INTERNAL, 'constructor': CONSTRUCTOR, 'init': INIT,
                'setTextSize': SET_TEXT_SIZE, 'setTextFont': SET_TEXT_FONT,
                'setTextTiming': SET_TEXT_TIMING, 'setFadeSpeed': SET_FADE_SPEED,
                'setCursorColor': SET_CURSOR_COLOR, 'showTextCursor': SHOW_TEXT_CURSOR,
                'clearScreen': CLEAR_SCREEN, 'print': PRINT, 'enableWordWrap': ENABLE_WORD_WRAP,
            },
            'imports': self.original_imports,
            'constructors': {'direct': self.constructor_case(False), 'internal': self.constructor_case(True)},
            'init': self.init_case(),
            'methods': {name: self.method_case(name) for name in
                        ('size', 'font', 'timing', 'fade', 'cursor', 'show', 'wrap', 'clear', 'print')},
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-computer-oracle.py GAME_ROOT')
    print(json.dumps(ComputerWindowProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
