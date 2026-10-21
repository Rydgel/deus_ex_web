"""Unicorn oracle for Extension.dll mouse position, hit testing and focus.

Runs the unchanged XWindow::SetCursorPos (0x1004cca0), XRootWindow::
SetRootCursorPos (0x10039d80, with the original ClampMousePosition),
ProcessMouseMove (0x1003af50), GetMouseWindow (0x1003b0d0), XWindow::
FindWindowByPoint (0x1004f740), FindWindow (0x1004f650), IsPointInWindow (0x1004f830), SetFocusWindow
(0x1004f0e0), AskParentToShowArea (0x1004e230), XClipRect::Intersect
(0x10002b10), ConvertCoordinates (0x1004fbe0), and the ToggleWindow mouse and
PressButton overrides (0x10049a80/0x10049b30/0x10049c30) over window images whose
vtables are the real rebased XWindow / XButtonWindow / XToggleWindow /
XModalWindow / XRootWindow tables, so every virtual (QueryPointInWindow,
Mouse*/Focus* events, ChildRequestedShowArea) runs its original body.

Host services:
  * ProcessScript (0x1004ded0) is a recorded event. The Extension event FName
    globals are seeded with distinct ids so each event is named, and its
    parameter block is decoded per event;
  * ChangeButtonAppearance (0x10008380) and PlaySound (0x1004ffb0) are
    recorded events.

Reads JSON {"cases": [...]} on stdin and prints {"results": [...]}. Optional
research tool, never imported by the browser. See docs/script-window-input.md.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE, UcError
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP

_SPEC = importlib.util.spec_from_file_location(
    'native_window_timer', Path(__file__).with_name('native-window-timer-oracle.py'))
_TIMER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_TIMER)
rebase = _TIMER.rebase

BODY = {name: rebase(address) for name, address in {
    'setCursorPos': 0x1004cca0, 'setRootCursorPos': 0x10039d80, 'processMouseMove': 0x1003af50,
    'getMouseWindow': 0x1003b0d0, 'findWindowByPoint': 0x1004f740, 'findWindow': 0x1004f650, 'isPointInWindow': 0x1004f830,
    'setFocusWindow': 0x1004f0e0, 'askParentToShowArea': 0x1004e230, 'intersect': 0x10002b10,
    'convertCoordinates': 0x1004fbe0, 'moveFocus': 0x1004ef30, 'checkFocusWindow': 0x10050b80,
    'handleButtons': 0x1003b960, 'toggleMousePressed': 0x10049a80,
    'toggleMouseReleased': 0x10049b30, 'togglePressButton': 0x10049c30}.items()}
PROCESS_SCRIPT = rebase(0x1004ded0)
CHANGE_BUTTON_APPEARANCE = rebase(0x10008380)
PLAY_SOUND = rebase(0x1004ffb0)
# Extension event FName globals read by the XWindow/XButtonWindow bridges.
EVENT_NAMES = {0x1009b3e0: 'MouseMoved', 0x1009b3c8: 'MouseEnteredWindow', 0x1009b3d0: 'MouseLeftWindow',
               0x1009b3a8: 'FocusEnteredWindow', 0x1009b3d4: 'FocusLeftWindow',
               0x1009b344: 'FocusEnteredDescendant', 0x1009b3dc: 'FocusLeftDescendant',
               0x1009b334: 'ChildRequestedShowArea', 0x1009b360: 'RawMouseButtonPressed',
               0x1009b340: 'MouseButtonPressed', 0x1009b394: 'MouseButtonReleased',
               0x1009b32c: 'ButtonActivated', 0x1009b3bc: 'ButtonActivatedRight',
               0x1009b368: 'ToggleChanged'}
FAMILIES = {'window': (0x10059930, 0x160), 'text': (0x1005a458, 0x174), 'button': (0x1005a324, 0x1ec),
            'toggle': (0x1005a7c8, 0x1f4), 'modal': (0x10059ba8, 0x588), 'root': (0x10059cc4, 0x744)}


def bits(value):
    return struct.unpack('<I', struct.pack('<f', value))[0]


def F(value):
    """A float field: a JSON number, or {"bits": n} for NaN/-0 exactness."""
    if isinstance(value, dict):
        return struct.unpack('<f', struct.pack('<I', value['bits']))[0]
    return value


class FocusOracle(_TIMER.TimerOracle):
    def __init__(self, root):
        super().__init__(root)
        # ProcessScript and ChangeButtonAppearance are already hooked by the
        # timer oracle; a second hook at one address would run each stub twice.
        self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, begin=PLAY_SOUND, end=PLAY_SOUND)
        self.event_ids = {}
        for index, (address, name) in enumerate(EVENT_NAMES.items(), start=101):
            self.write(rebase(address), 'I', index)
            self.event_ids[index] = name

    def ref(self, address):
        return self.ids.get(address, None if address == 0 else f'0x{address:08x}')

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        this = cpu.reg_read(UC_X86_REG_ECX)
        if address == PROCESS_SCRIPT:
            name_id, params, third = self.read(stack + 4, '3I')
            name = self.event_ids.get(name_id, name_id)
            if name == 'MouseMoved':
                values = list(self.read(params, '2I'))
            elif name == 'RawMouseButtonPressed':
                x, y, key_action = self.read(params, '3I')
                values = [x, y, key_action & 0xff, (key_action >> 8) & 0xff]
            elif name in ('MouseButtonPressed', 'MouseButtonReleased'):
                x, y, key, count = self.read(params, '4I')
                values = [x, y, key & 0xff, count]
            elif name in ('ButtonActivated', 'ButtonActivatedRight'):
                values = [self.ref(self.read(params, 'I')[0])]
            elif name == 'ToggleChanged':
                source, toggle = self.read(params, '2I')
                values = [self.ref(source), toggle]
            elif name in ('FocusEnteredDescendant', 'FocusLeftDescendant'):
                values = [self.ref(self.read(params, 'I')[0])]
            elif name == 'ChildRequestedShowArea':
                child, *rest = self.read(params, '5I')
                values = [self.ref(child), *rest]
            else:
                values = []
            self.events.append({'op': 'ProcessScript', 'window': self.ref(this), 'name': name,
                                'params': values, 'third': third})
            self.ret(cpu, 0, 12)
            return
        if address == CHANGE_BUTTON_APPEARANCE:
            self.events.append({'op': 'ChangeButtonAppearance', 'window': self.ref(this)})
            self.ret(cpu, 0, 0)
            return
        if address == PLAY_SOUND:
            sound, volume, pitch = self.read(stack + 4, '3I')
            self.events.append({'op': 'PlaySound', 'window': self.ref(this), 'sound': sound,
                                'volume': volume, 'pitch': pitch})
            self.ret(cpu, 0, 12)
            return
        super().on_instruction(cpu, address, size, data)

    def build(self, case):
        self.windows, self.ids, self.families = {}, {}, {}
        for spec in case.get('windows', []):
            vtable, size = FAMILIES[spec.get('family', 'window')]
            address = self.alloc(size)
            self.cpu.mem_write(address, bytes(size))
            self.write(address, 'I', rebase(vtable))
            self.windows[spec['id']] = address
            self.ids[address] = spec['id']
            self.families[spec['id']] = spec.get('family', 'window')
        for spec in case.get('windows', []):
            win = self.windows[spec['id']]
            self.write(win + 0x28, 'B', spec.get('type', 0))
            self.write(win + 0x30, 'I', spec.get('flags', 7))
            for offset, key in [(0x78, 'x'), (0x7c, 'y'), (0x80, 'width'), (0x84, 'height')]:
                self.write(win + offset, 'f', F(spec.get(key, 0)))
            for i, value in enumerate(spec.get('clip', [0, 0, 0, 0, 0, 0])):
                self.write(win + 0xd4 + 4 * i, 'f', F(value))
            self.write(win + 0x104, 'I', spec.get('focusSound', 0))
            self.write(win + 0x108, 'I', spec.get('unfocusSound', 0))
            parent = spec.get('parent')
            if parent is not None:
                p = self.windows[parent]
                self.write(win + 0x138, 'I', p)
                last = self.read(p + 0x140, 'I')[0]
                if last:
                    self.write(last + 0x148, 'I', win)
                    self.write(win + 0x144, 'I', last)
                else:
                    self.write(p + 0x13c, 'I', win)
                self.write(p + 0x140, 'I', win)
            for offset, key in [(0x11c, 'rowIndex'), (0x120, 'colIndex')]:
                self.write(win + offset, 'i', spec.get(key, 0))
            family = self.families[spec['id']]
            if 'tabIndex' in spec:
                self.write(win + 0x168, 'i', spec['tabIndex'])
            if 'tabFlags' in spec:
                self.write(win + 0x164, 'I', spec['tabFlags'])
            if family in ('modal', 'root'):
                self.write(win + 0x174, 'B', spec.get('focusMode', 0))
                self.write(win + 0x178, 'I', self.windows.get(spec.get('preferredFocus'), 0))
            if family in ('button', 'toggle'):
                self.write(win + 0x174, 'I', spec.get('buttonFlags', 0))
                for offset, key in [(0x17c, 'repeatDelay'), (0x19c, 'repeatAt')]:
                    self.write(win + offset, 'f', F(spec.get(key, 0)))
                for offset, key in [(0x190, 'pressSound'), (0x194, 'clickSound')]:
                    self.write(win + offset, 'I', spec.get(key, 0))
                self.write(win + 0x1a0, 'B', spec.get('inputKey', 0))
            if family == 'toggle':
                self.write(win + 0x1ec, 'I', spec.get('enableSound', 0))
                self.write(win + 0x1f0, 'I', spec.get('disableSound', 0))
            if family == 'root':
                for offset, key in [(0x590, 'mouseX'), (0x594, 'mouseY'), (0x598, 'lastX'), (0x59c, 'lastY')]:
                    self.write(win + offset, 'f', F(spec.get(key, 0)))
                self.write(win + 0x5a4, 'I', spec.get('mouseFlags', 0))
                for offset, key, default in [(0x610, 'multiClickTime', .5), (0x614, 'multiClickDistance', 10),
                                             (0x620, 'clickDeadline', 0), (0x628, 'clickX', -1), (0x62c, 'clickY', -1)]:
                    self.write(win + offset, 'f', F(spec.get(key, default)))
                self.write(win + 0x618, 'i', spec.get('clickIndex', 0))
                self.write(win + 0x61c, 'i', spec.get('lastKey', 0))
                self.write(win + 0x624, 'I', self.windows.get(spec.get('lastWindow'), 0))
        # Tab tables: FArray {Data, Num, Max} of window pointers.
        for spec in case.get('windows', []):
            for offset, key in [(0x14c, 'rowTable'), (0x158, 'colTable'), (0x17c, 'groupTable')]:
                if key in spec:
                    ids = spec[key]
                    data = self.alloc(max(4, 4 * len(ids)))
                    for i, ident in enumerate(ids):
                        self.write(data + 4 * i, 'I', self.windows[ident])
                    self.write(self.windows[spec['id']] + offset, '3I', data, len(ids), len(ids))
        for spec in case.get('windows', []):
            if self.families[spec['id']] == 'root':
                win = self.windows[spec['id']]
                for offset, key in [(0x5a0, 'mouseWindow'), (0x5c4, 'grabbed'), (0x5c8, 'focus')]:
                    self.write(win + offset, 'I', self.windows.get(spec.get(key), 0))

    def snapshot(self):
        state = {}
        for key, win in self.windows.items():
            entry = {'flags': self.read(win + 0x30, 'I')[0]}
            family = self.families[key]
            if family in ('modal', 'root'):
                entry['preferredFocus'] = self.ref(self.read(win + 0x178, 'I')[0])
                entry['groupLocation'] = list(self.read(win + 0x16c, '2I'))
            if family in ('button', 'toggle'):
                entry.update({'buttonFlags': self.read(win + 0x174, 'I')[0],
                              'repeatAt': self.read(win + 0x19c, 'I')[0],
                              'inputKey': self.read(win + 0x1a0, 'B')[0]})
            if family == 'root':
                entry.update({'mouseX': self.read(win + 0x590, 'I')[0], 'mouseY': self.read(win + 0x594, 'I')[0],
                              'lastX': self.read(win + 0x598, 'I')[0], 'lastY': self.read(win + 0x59c, 'I')[0],
                              'mouseWindow': self.ref(self.read(win + 0x5a0, 'I')[0]),
                              'mouseFlags': self.read(win + 0x5a4, 'I')[0],
                              'focus': self.ref(self.read(win + 0x5c8, 'I')[0]),
                              'grabbed': self.ref(self.read(win + 0x5c4, 'I')[0]),
                              'clickIndex': self.read(win + 0x618, 'i')[0],
                              'lastKey': self.read(win + 0x61c, 'i')[0],
                              'clickDeadline': self.read(win + 0x620, 'I')[0],
                              'lastWindow': self.ref(self.read(win + 0x624, 'I')[0]),
                              'clickX': self.read(win + 0x628, 'I')[0], 'clickY': self.read(win + 0x62c, 'I')[0]})
            state[key] = entry
        return state

    def step(self, step):
        op, W = step['op'], self.windows
        out = self.alloc(16)
        self.write(out, '4I', 0, 0, 0, 0)
        if op == 'intersect':
            a, b = self.alloc(24), self.alloc(24)
            self.write(a, '6f', *map(F, step['a']))
            self.write(b, '6f', *map(F, step['b']))
            self.call(BODY[op], a, struct.pack('<I', b))
            return list(self.read(a, '6I'))
        if op == 'convertCoordinates':
            self.call(BODY[op], 0, struct.pack('<IffIII', W[step['from']], F(step['x']), F(step['y']), W[step['to']], out, out + 4))
            return list(self.read(out, '2I'))
        if op == 'findWindow':
            result = self.call(BODY[op], W[step['win']], struct.pack('<ffII', F(step['x']), F(step['y']), out, out + 4))
            return [self.ref(result), *self.read(out, '2I')]
        if op == 'findWindowByPoint':
            result = self.call(BODY[op], W[step['win']], struct.pack('<ffII', F(step['x']), F(step['y']), out, out + 4))
            return [self.ref(result), *self.read(out, '2I')]
        if op == 'getMouseWindow':
            result = self.call(BODY[op], W[step['root']], struct.pack('<III', W.get(step.get('modal'), 0), out, out + 4))
            return [self.ref(result), *self.read(out, '2I')]
        if op == 'isPointInWindow':
            return self.call(BODY[op], W[step['win']], struct.pack('<ff', F(step['x']), F(step['y'])))
        if op == 'setCursorPos':
            self.call(BODY[op], W[step['win']], struct.pack('<ff', F(step['x']), F(step['y'])))
            return None
        if op == 'setRootCursorPos':
            self.call(BODY[op], W[step['root']], struct.pack('<ff', F(step['x']), F(step['y'])))
            return None
        if op == 'processMouseMove':
            self.call(BODY[op], W[step['root']], b'')
            return None
        if op == 'setFocusWindow':
            return self.call(BODY[op], W[step['win']], struct.pack('<I', W.get(step.get('target'), 0)))
        if op == 'moveFocus':
            return self.ref(self.call(BODY[op], W[step['win']], struct.pack('<II', step['direction'], step.get('wrap', 0))))
        if op == 'checkFocusWindow':
            self.call(BODY[op], W[step['win']], b'')
            return None
        if op == 'askParentToShowArea':
            self.call(BODY[op], W[step['win']], struct.pack('<4f', *map(F, (step['x'], step['y'], step['w'], step['h']))))
            return None
        if op == 'handleButtons':
            return self.call(BODY[op], W[step['root']], struct.pack('<II', step['key'], step['action']))
        if op in ('toggleMousePressed', 'toggleMouseReleased'):
            return self.call(BODY[op], W[step['win']], struct.pack('<ffII', F(step['x']), F(step['y']), step['key'], step['count']))
        if op == 'togglePressButton':
            self.call(BODY[op], W[step['win']], struct.pack('<I', step.get('key', 0x20)))
            return None
        if op == 'set':
            self.write(W[step['win']] + step['offset'], step.get('fmt', 'I'), step['value'])
            return None
        if op == 'setWindow':
            self.write(W[step['win']] + step['offset'], 'I', W[step['windowRef']])
            return None
        raise _TIMER.Stop(f'unknown op {op}')

    def run(self, case):
        self.case, self.events = case, []
        self.write(self.now, 'd', case.get('now', 1.0))
        self.write(_TIMER.LAST_TICK, 'd', case.get('lastTick', 0.0))
        self.build(case)
        steps = []
        for step in case['steps']:
            mark = len(self.events)
            try:
                result = self.step(step)
                steps.append({'result': result, 'events': self.events[mark:], 'state': self.snapshot()})
            except (_TIMER.Stop, UcError, RuntimeError) as error:
                steps.append({'stopped': str(error), 'events': self.events[mark:]})
                break
        return {'steps': steps}


def main():
    cases = json.load(sys.stdin)['cases']
    oracle = FocusOracle(sys.argv[1])
    print(json.dumps({'results': [oracle.run(case) for case in cases]}))


if __name__ == '__main__':
    main()
