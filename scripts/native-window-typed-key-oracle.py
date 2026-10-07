"""Unicorn oracle for the typed-character route (WM_CHAR) into the windows.

Runs the unchanged Extension.dll XGameEngineExt::Key (0x10026650), Engine.dll
UEngine::Key (0x103813d0, reached through Extension's import), XInputExt::Key
(0x1002d2b0), XRootWindow::Key (0x1003b520), HandleKeyboard (0x1003b720),
XWindow::KeyPressed (0x10003830), XModalWindow::KeyPressed (0x10037510) with
IsCurrentModal (0x10036e20), GetAcceleratorWindow (0x100372a0) and the real
BuildAcceleratorTable / ClearAcceleratorTable / SetAcceleratorWindows, and
XWindow::AcceleratorKeyPressed (0x10003a80), over window images whose vtables
are the real rebased XWindow / XTextWindow / XButtonWindow / XToggleWindow /
XModalWindow / XRootWindow / XEditWindow / XListWindow tables, so every
virtual (KeyPressed +0xc8, AcceleratorKeyPressed +0xd0, HandleKeyboard +0x128)
dispatches as in the game. IsKeyDown, GetRootWindow, GetTopChild and
GetLowerSibling execute.

Host leaves (everything else executes):
  * XWindow::ProcessScript (0x1004ded0): a recorded event. KeyPressed and
    AcceleratorKeyPressed decode their FString parameter and receive the
    case's script result; the other names come from the mouse/focus oracle;
  * XEditWindow::KeyPressed (0x10021290) and XListWindow::KeyPressed
    (0x10033ae0): recorded calls with the case's result. Their bodies are
    compared by validate-text-layout-diff.mjs and validate-window-list-family.mjs;
  * Core UObject::FindFunctionChecked: records the FName index, returns a
    sentinel function; the fake Console's ProcessEvent (vtable +0x10) records
    the BYTE key parameter and writes the case's KeyType result;
  * GMalloc Malloc/Realloc/Free (the bridges' FString temporaries): a bump
    allocator, not compared.

The viewport, console, input and actor of an engine case are fake objects
holding only the fields the bodies read: viewport +0x30 Actor, +0x34 Console,
+0x60 Input; input +0x24 Class, +0xea0 Viewport; actor +0x24 Class, +0x894
root window. Class chains run through UStruct::SuperField (+0x28) to the
rebased XInputExt / APlayerPawnExt PrivateStaticClass objects.

Reads JSON {"cases": [...]} on stdin and prints {"results": [...]}. Optional
research tool, never imported by the browser. See docs/script-window-typed-keys.md.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE, UcError
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP

_SPEC = importlib.util.spec_from_file_location(
    'native_window_mouse_focus', Path(__file__).with_name('native-window-mouse-focus-oracle.py'))
_FOCUS = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_FOCUS)
_TIMER = _FOCUS._TIMER
rebase = _FOCUS.rebase

BODY = {name: rebase(address) for name, address in {
    'gameEngineKey': 0x10026650, 'inputExtKey': 0x1002d2b0, 'rootKey': 0x1003b520,
    'handleKeyboard': 0x1003b720, 'windowKeyPressed': 0x10003830, 'modalKeyPressed': 0x10037510,
    'acceleratorKeyPressed': 0x10003a80, 'isCurrentModal': 0x10036e20, 'getAcceleratorWindow': 0x100372a0}.items()}
EDIT_KEY_PRESSED, LIST_KEY_PRESSED = rebase(0x10021290), rebase(0x10033ae0)
PROCESS_SCRIPT = rebase(0x1004ded0)
KEY_NAMES = {rebase(0x1009b370): 'KeyPressed', rebase(0x1009b354): 'AcceleratorKeyPressed'}
INPUT_EXT_CLASS, PLAYER_PAWN_EXT_CLASS = rebase(0x100a2e00), rebase(0x100a7d70)
FIND_FUNCTION_CHECKED = 0x1010263f        # Core ?FindFunctionChecked@UObject@@QAEPAVUFunction@@VFName@@H@Z
FUNCTION_SENTINEL = 0x0f0f0f0f
_FOCUS.FAMILIES.update({'edit': (0x1005b50c, 0x28c), 'list': (0x1005b998, 0x1d0)})
# Every Extension window class vtable: KeyPressed +0xc8, AcceleratorKeyPressed
# +0xd0 and (root) HandleKeyboard +0x128, for the family table check.
CLASS_VTABLES = {'window': 0x10059930, 'textwindow': 0x1005a458, 'buttonwindow': 0x1005a324,
                 'togglewindow': 0x1005a7c8, 'checkboxwindow': 0x1005a8f0, 'tilewindow': 0x1005b760,
                 'tabgroupwindow': 0x10059a8c, 'radioboxwindow': 0x1005b87c, 'textlogwindow': 0x1005b63c,
                 'modalwindow': 0x10059ba8, 'rootwindow': 0x10059cc4, 'computerwindow': 0x1005b2c8,
                 'editwindow': 0x1005b50c, 'largetextwindow': 0x1005b3e8, 'listwindow': 0x1005b998}
NAMED_BODIES = {0x10003830: 'XWindow::KeyPressed', 0x10037510: 'XModalWindow::KeyPressed',
                0x10021290: 'XEditWindow::KeyPressed', 0x10033ae0: 'XListWindow::KeyPressed',
                0x10003a80: 'XWindow::AcceleratorKeyPressed', 0x1003b720: 'XRootWindow::HandleKeyboard'}


MSVCRT_HASH = 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210'


class TypedKeyOracle(_FOCUS.FocusOracle):
    def __init__(self, root):
        # The bridges' appStrlen reaches MSVCRT wcslen: load the shipped
        # MSVCRT.dll beside Core/Engine/Extension (the timer oracle's image set).
        native = _TIMER._NATIVE.NativeCollision
        original = native.__init__
        native.__init__ = lambda this, game_root, extra=None: original(this, game_root, {**(extra or {}), 'MSVCRT.dll': MSVCRT_HASH})
        try:
            super().__init__(root)
        finally:
            native.__init__ = original
        # Extension's appFailAssert import resolves into the loaded Core.dll.
        self.fail_assert = self.read(rebase(0x10059098), 'I')[0]
        for address in (EDIT_KEY_PRESSED, LIST_KEY_PRESSED, FIND_FUNCTION_CHECKED, self.fail_assert):
            self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, begin=address, end=address)
        for index, address in enumerate(KEY_NAMES, start=201):
            self.write(address, 'I', index)
            self.event_ids[index] = KEY_NAMES[address]
        self.process_event = self.keep(16)
        self.cpu.mem_write(self.process_event, b'\xc3')
        self.stubs[self.process_event] = ('process_event', 12)
        self.blocks = {}

    # ---- allocator: the bridges' FString temporaries ---------------------
    def on_malloc(self, cpu):
        size, _tag = self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, '2I')
        address = self.alloc(max(size, 4))
        self.blocks[address] = size
        self.ret(cpu, address, 8)

    def on_realloc(self, cpu):
        old, size, _tag = self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, '3I')
        if not size:
            self.blocks.pop(old, None)
            self.ret(cpu, 0, 12)
            return
        address = self.alloc(max(size, 4))
        if old:
            keep = min(self.blocks.pop(old, 0), size)
            self.cpu.mem_write(address, bytes(self.cpu.mem_read(old, keep)))
        self.blocks[address] = size
        self.ret(cpu, address, 12)

    def on_free(self, cpu):
        self.blocks.pop(self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, 'I')[0], None)
        self.ret(cpu, 0, 4)

    def on_process_event(self, cpu):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        function, parms, result = self.read(stack + 4, '3I')
        self.events.append({'op': 'ProcessEvent', 'object': self.ref(cpu.reg_read(UC_X86_REG_ECX)),
                            'function': self.functions.get(function, function), 'key': self.read(parms, 'B')[0],
                            'result': result})
        self.write(parms + 4, 'I', self.step_case.get('keyType', 0))
        self.ret(cpu, 0, 12)

    def wstring(self, data, num):
        if not num or not data:
            return ''
        units = self.read(data, '%dH' % num)
        text = ''
        for unit in units:
            if not unit:
                break
            text += chr(unit)
        return text

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        this = cpu.reg_read(UC_X86_REG_ECX)
        if address == PROCESS_SCRIPT:
            name_id, params, third = self.read(stack + 4, '3I')
            name = self.event_ids.get(name_id)
            if name in ('KeyPressed', 'AcceleratorKeyPressed'):
                data, num, maximum = self.read(params, '3I')
                self.events.append({'op': 'ProcessScript', 'window': self.ref(this), 'name': name,
                                    'params': [self.wstring(data, num), num, maximum], 'third': third})
                result = self.case.get('scriptResults', {}).get('%s:%s' % (self.ref(this), name), 0)
                self.write(params + 0xc, 'I', result)
                self.ret(cpu, 0, 12)
                return
        if address in (EDIT_KEY_PRESSED, LIST_KEY_PRESSED):
            key = self.read(stack + 4, 'I')[0]
            family = 'edit' if address == EDIT_KEY_PRESSED else 'list'
            self.events.append({'op': 'KeyPressed', 'family': family, 'window': self.ref(this), 'key': key & 0xffff})
            self.ret(cpu, self.case.get('keyResults', {}).get(self.ref(this), 0), 4)
            return
        if address == self.fail_assert:
            raise _TIMER.Stop('appFailAssert line 0x%x' % self.read(stack + 12, 'I')[0])
        if address == FIND_FUNCTION_CHECKED:
            name, global_ = self.read(stack + 4, '2I')
            self.functions[FUNCTION_SENTINEL] = 'FindFunctionChecked(%d,%d)' % (name, global_)
            self.events.append({'op': 'FindFunctionChecked', 'object': self.ref(this), 'name': name, 'global': global_})
            self.ret(cpu, FUNCTION_SENTINEL, 8)
            return
        super().on_instruction(cpu, address, size, data)

    # ---- world -------------------------------------------------------------
    def build(self, case):
        super().build(case)
        self.functions = {}
        for spec in case.get('windows', []):
            win = self.windows[spec['id']]
            self.write(win + 0xb4, 'H', spec.get('acceleratorKey', 0))
            family = self.families[spec['id']]
            if family in ('modal', 'root'):
                self.write(win + 0x584, 'I', spec.get('acceleratorDirty', 1))
            if family == 'root':
                self.write(win + 0x5d0, 'i', spec.get('keyboardGrab', 0))
                for key in spec.get('keysDown', []):
                    self.write(win + 0x630 + key, 'B', 1)

    def snapshot(self):
        state = {}
        for key, win in self.windows.items():
            entry = {'flags': self.read(win + 0x30, 'I')[0]}
            family = self.families[key]
            if family in ('modal', 'root'):
                table = self.read(win + 0x188, '255I')
                entry['acceleratorDirty'] = self.read(win + 0x584, 'I')[0]
                entry['accelerators'] = {str(i): self.ref(w) for i, w in enumerate(table) if w}
            if family == 'root':
                entry['focus'] = self.ref(self.read(win + 0x5c8, 'I')[0])
                entry['keyboardGrab'] = self.read(win + 0x5d0, 'i')[0]
                entry['keysDown'] = [k for k, b in enumerate(self.read(win + 0x630, '255B')) if b]
            state[key] = entry
        return state

    def klass(self, target):
        """A fake UClass whose SuperField (+0x28) is `target` (or none)."""
        address = self.alloc(0x40)
        self.cpu.mem_write(address, bytes(0x40))
        self.write(address + 0x28, 'I', target)
        return address

    def engine_objects(self, step):
        viewport, input_, actor = self.alloc(0x100), self.alloc(0xf00), self.alloc(0x900)
        for address, size in ((viewport, 0x100), (input_, 0xf00), (actor, 0x900)):
            self.cpu.mem_write(address, bytes(size))
        self.ids.update({viewport: 'viewport', input_: 'input', actor: 'actor'})
        if step.get('console', True):
            console, table = self.alloc(0x40), self.alloc(0x40)
            self.cpu.mem_write(console, bytes(0x40))
            self.cpu.mem_write(table, bytes(0x40))
            self.write(table + 0x10, 'I', self.process_event)
            self.write(console, 'I', table)
            self.write(viewport + 0x34, 'I', console)
            self.ids[console] = 'console'
        if step.get('input', True):
            self.write(viewport + 0x60, 'I', input_)
        self.write(input_ + 0x24, 'I', self.klass(self.klass(INPUT_EXT_CLASS) if step.get('inputExt', True) else 0))
        self.write(input_ + 0xea0, 'I', viewport)
        if step.get('actor', True):
            self.write(viewport + 0x30, 'I', actor)
        self.write(actor + 0x24, 'I', self.klass(PLAYER_PAWN_EXT_CLASS if step.get('playerPawnExt', True) else 0))
        self.write(actor + 0x894, 'I', self.windows.get(step.get('root'), 0))
        return viewport, input_

    def step(self, step):
        op, W = step['op'], self.windows
        self.step_case = step
        key = step.get('key', 0) & 0xffffffff
        if op == 'gameEngineKey':
            viewport, _ = self.engine_objects(step)
            return self.call(BODY[op], 0, struct.pack('<II', viewport, key))
        if op == 'inputExtKey':
            _, input_ = self.engine_objects(step)
            return self.call(BODY[op], input_, struct.pack('<I', key))
        if op in ('rootKey', 'handleKeyboard'):
            return self.call(BODY[op], W[step['root']], struct.pack('<I', key))
        if op in ('keyPressed', 'acceleratorKeyPressed'):
            table = self.read(W[step['win']], 'I')[0]
            slot = self.read(table + (0xc8 if op == 'keyPressed' else 0xd0), 'I')[0]
            return self.call(slot, W[step['win']], struct.pack('<I', key))
        if op == 'isCurrentModal':
            return self.call(BODY[op], W[step['win']], b'')
        if op == 'getAcceleratorWindow':
            return self.ref(self.call(BODY[op], W[step['win']], struct.pack('<I', key)))
        if op == 'keyDown':
            self.write(W[step['root']] + 0x630 + step['key'], 'B', step.get('value', 1))
            return None
        return super().step(step)

    def run(self, case):
        self.step_case = {}
        return super().run(case)

    def vtables(self):
        out = {}
        for name, table in CLASS_VTABLES.items():
            slots = {}
            # +0x128 exists only in XRootWindow's (longer) table.
            for offset in (0xc8, 0xd0) + ((0x128,) if name == 'rootwindow' else ()):
                target = self.read(rebase(table) + offset, 'I')[0]
                code = bytes(self.cpu.mem_read(target, 5))
                if code[0] == 0xe9:   # an incremental-link thunk
                    target = target + 5 + struct.unpack('<i', code[1:5])[0]
                body = target - rebase(0x10000000) + 0x10000000
                slots['0x%x' % offset] = NAMED_BODIES.get(body, '0x%08x' % body)
            out[name] = slots
        return out


def main():
    request = json.load(sys.stdin)
    oracle = TypedKeyOracle(sys.argv[1])
    print(json.dumps({'vtables': oracle.vtables(), 'results': [oracle.run(case) for case in request['cases']]}))


if __name__ == '__main__':
    main()
