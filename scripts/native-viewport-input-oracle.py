"""Unicorn oracle for WinDrv.dll's viewport window procedure: which input events a Windows message delivers.

Runs the unchanged UWindowsViewport::ViewportWndProc (0x11109b30) and UWindowsViewport::CauseInputEvent (0x11108d60, reached through
its thunk 0x111011f4) from the hash-checked WinDrv.dll (Window.dll beside it, Core and Engine at their bases) over a fake viewport,
client and engine. The engine's virtual InputEvent (vtable +0x74), Key (+0x70), MouseDelta (+0x80) and MousePosition (+0x84) and the
viewport's SetMouseCapture (+0x58) and Repaint (+0x8c) are recorded events; the user32 imports the bodies call (GetKeyState,
GetMessageTime, ClientToScreen, ...) are stubs that return the case's values. A case is one message (message, wParam, lParam);
the result is the ordered list of events, the procedure's return value and the viewport fields it changed.

Reads JSON {"cases": [...]} on stdin and prints {"results": [...]}. Optional research tool, never imported by the browser.
See docs/input-bindings.md.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UcError
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

_SPEC = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)

WINDRV_HASH = '9cf2861ca66dabf21db97e44e328aa0a42d85289a35dbad090271c0611f94e1f'
WINDOW_HASH = '3d40db1dd7467d94c17bf4ef0fa4cafd1a9d699ac7df7a5526b3961b4642e59d'
WNDPROC = 0x11109b30
TOGGLE_FULLSCREEN = 0x1110105a        # the thunk Alt+Enter calls (UWindowsViewport::ToggleFullscreen)
WINDOW_MESSAGE_MOUSE_WHEEL = '?WindowMessageMouseWheel@@3IA'   # Window.dll's registered MSWHEEL_ROLLMSG id
STUBS = 0x700a0000                     # inside the base class's thunk region (0x70000000 + 1 MiB)

# user32 imports the bodies reach: stdcall argument bytes. GetKeyState and GetMessageTime return the case's values.
IMPORT_POP = {'GetKeyState': 4, 'GetMessageTime': 0, 'ClientToScreen': 8, 'ReleaseCapture': 0, 'SetCapture': 4, 'ClipCursor': 4,
              'ShowCursor': 4, 'SetCursorPos': 8, 'GetCursorPos': 4, 'GetFocus': 0, 'GetClientRect': 8, 'MapWindowPoints': 16,
              'SetForegroundWindow': 4, 'GetCapture': 0, 'SetCursor': 4, 'GetForegroundWindow': 0}
# Virtual slots recorded as events: name, argument bytes the callee pops (thiscall: the callee cleans up).
ENGINE_SLOTS = {0x70: ('Key', 8), 0x74: ('InputEvent', 16), 0x80: ('MouseDelta', 16), 0x84: ('MousePosition', 16)}
VIEWPORT_SLOTS = {0x58: ('SetMouseCapture', 4), 0x8c: ('Repaint', 4)}


class Stop(Exception):
    pass


def f32(bits):
    return struct.unpack('<f', struct.pack('<I', bits))[0]


class ViewportInputOracle(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), {'Window.dll': {'hash': WINDOW_HASH, 'base': None}, 'WinDrv.dll': {'hash': WINDRV_HASH, 'base': None}})
        self.stub_next = STUBS
        self.stubs = {}
        self.events = []
        self.case = {}
        window = _NATIVE.Image(Path(root) / 'System' / 'Window.dll', WINDOW_HASH)
        self.wheel_message = window.exports()[WINDOW_MESSAGE_MOUSE_WHEEL]
        self.engine_vtable = self.vtable(ENGINE_SLOTS, 'engine')
        self.viewport_vtable = self.vtable(VIEWPORT_SLOTS, 'viewport')

    def stub(self, label, pop):
        address = self.stub_next
        self.stub_next += 16
        self.cpu.mem_write(address, b'\xc3')
        self.stubs[address] = (label, pop)
        return address

    def vtable(self, slots, owner):
        table = self.alloc(0x400)
        for slot in range(0, 0x400, 4):
            name, pop = slots.get(slot, (f'slot{slot:#x}', 0))
            self.write(table + slot, 'I', self.stub(f'{owner}.{name}', pop))
        return table

    def ret(self, cpu, value, pop):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        back = self.read(stack, 'I')[0]
        cpu.reg_write(UC_X86_REG_EAX, value & 0xffffffff)
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + pop)
        cpu.reg_write(UC_X86_REG_EIP, back)

    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        stack = cpu.reg_read(UC_X86_REG_ESP)
        if address in self.stubs:
            label, pop = self.stubs[address]
            args = self.read(stack + 4, f'{pop // 4}I') if pop else ()
            event = {'op': label}
            if label == 'engine.InputEvent':
                event.update({'key': args[1], 'action': args[2], 'delta': f32(args[3])})
            elif label == 'engine.Key':
                event.update({'key': args[1] & 0xff})
            elif label in ('engine.MouseDelta', 'engine.MousePosition'):
                event.update({'buttons': args[1], 'x': f32(args[2]), 'y': f32(args[3])})
            elif label in ('viewport.SetMouseCapture', 'viewport.Repaint'):
                event.update({'arg': args[0]})
            self.events.append(event)
            self.ret(cpu, 0, pop)
            return
        if address == TOGGLE_FULLSCREEN:
            self.events.append({'op': 'ToggleFullscreen'})
            self.ret(cpu, 0, 0)
            return
        if address in self.thunks:
            symbol = self.thunks[address][1]
            if symbol in IMPORT_POP:
                value = {'GetKeyState': self.case.get('keyState', {}).get(str(self.read(stack + 4, 'I')[0]), 0),
                         'GetMessageTime': self.case.get('messageTime', 1000)}.get(symbol, 0)
                if symbol == 'GetKeyState':
                    self.events.append({'op': 'GetKeyState', 'vk': self.read(stack + 4, 'I')[0]})
                self.ret(cpu, value, IMPORT_POP[symbol])
                return
            raise Stop(f'import {self.thunks[address]}')
        self.trace.append(hex(address))

    def run(self, case):
        self.case, self.events = case, []
        client, engine, viewport, actor, inp = (self.alloc(0x400), self.alloc(0x40), self.alloc(0x400), self.alloc(0x800), self.alloc(0x1000))
        for block, size in ((client, 0x400), (engine, 0x40), (viewport, 0x400), (actor, 0x800), (inp, 0x1000)):
            self.cpu.mem_write(block, bytes(size))
        viewports = self.alloc(16)
        self.write(viewports, 'I', viewport)
        self.write(engine, 'I', self.engine_vtable)
        self.write(client + 0x28, 'I', engine)
        self.write(client + 0x2c, 'I', viewports)
        self.write(client + 0x30, 'I', 1)
        self.write(client + 0xc8, 'I', case.get('inMenuLoop', 0))
        self.write(viewport, 'I', self.viewport_vtable)
        self.write(viewport + 0x18, 'I', client)
        self.write(viewport + 0x30, 'I', actor)
        self.write(viewport + 0x60, 'I', inp)
        self.write(viewport + 0x78, '2I', 640, 480)
        window = self.alloc(16)
        self.write(window + 4, 'I', 0xdead)
        self.write(viewport + 0xf8, 'I', window)
        self.write(viewport + 0x188, 'I', case.get('viewportFlags', 0))
        self.write(viewport + 0x1cc, 'i', -1)
        self.write(viewport + 0x1d0, 'i', -1)
        self.write(self.wheel_message, 'I', case.get('wheelMessage', 0xc123))
        self.write(actor + 0x5fc, 'I', case.get('showFlags', 0))
        before = bytes(self.cpu.mem_read(viewport, 0x400))
        message, wparam, lparam = case['message'], case['wParam'] & 0xffffffff, case['lParam'] & 0xffffffff
        try:
            result = self.call(WNDPROC, viewport, struct.pack('<3I', message, wparam, lparam))
        except (Stop, UcError, RuntimeError) as error:
            return {'stopped': str(error), 'events': self.events}
        after = bytes(self.cpu.mem_read(viewport, 0x400))
        changed = [{'offset': offset, 'before': struct.unpack_from('<I', before, offset)[0], 'after': struct.unpack_from('<I', after, offset)[0]}
                   for offset in range(0, 0x400, 4) if before[offset:offset + 4] != after[offset:offset + 4]]
        return {'result': result, 'events': self.events, 'changed': changed}


def main():
    cases = json.load(sys.stdin)['cases']
    oracle = ViewportInputOracle(sys.argv[1])
    print(json.dumps({'results': [oracle.run(case) for case in cases]}))


if __name__ == '__main__':
    main()
