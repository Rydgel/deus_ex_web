"""Unicorn oracle for Extension.dll modal input grabs.

Runs the unchanged XModalWindow::VisibilityChanged (0x10037330),
XRootWindow::GrabKeyboardEvents (0x1003a110), UngrabKeyboardEvents
(0x1003a1b0), GrabMouseEvents (0x1003a1d0), UngrabMouseEvents (0x1003a270)
and IsMouseButton (0x1003a2c0) from the hash-checked Extension.dll, rebased
to 0x12000000 by the timer oracle's setup.

Host services:
  * ProcessScript (0x1004ded0) is a recorded event carrying the dword the
    parameter block points at (VisibilityChanged's bNewVisibility) and the
    third argument;
  * GetRootWindow (0x1004c5a0) is a recorded event that returns the case's
    root (or null).

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

BODY = {'visibilityChanged': rebase(0x10037330), 'grabKeyboard': rebase(0x1003a110),
        'ungrabKeyboard': rebase(0x1003a1b0), 'grabMouse': rebase(0x1003a1d0),
        'ungrabMouse': rebase(0x1003a270), 'isMouseButton': rebase(0x1003a2c0)}
PROCESS_SCRIPT = rebase(0x1004ded0)
GET_ROOT_WINDOW = rebase(0x1004c5a0)
ROOT_SIZE = 0x740
MODAL_SIZE = 0x588


class GrabOracle(_TIMER.TimerOracle):
    def __init__(self, root):
        super().__init__(root)
        self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, begin=GET_ROOT_WINDOW, end=GET_ROOT_WINDOW)

    def on_instruction(self, cpu, address, size, data):
        if address == PROCESS_SCRIPT:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            _name, params, third = self.read(stack + 4, '3I')
            this = cpu.reg_read(UC_X86_REG_ECX)
            self.events.append({'op': 'ProcessScript', 'window': self.names.get(this),
                                'value': self.read(params, 'I')[0], 'third': third})
            self.ret(cpu, 0, 12)
            return
        if address == GET_ROOT_WINDOW:
            this = cpu.reg_read(UC_X86_REG_ECX)
            self.events.append({'op': 'GetRootWindow', 'window': self.names.get(this)})
            self.ret(cpu, self.root if self.case.get('rootFound', True) else 0, 0)
            return
        super().on_instruction(cpu, address, size, data)

    def snapshot(self):
        return {'keyboardGrab': self.read(self.root + 0x5d0, 'i')[0],
                'mouseGrab': self.read(self.root + 0x5cc, 'i')[0],
                'keyDown': list(self.cpu.mem_read(self.root + 0x630, 0x100))}

    def run(self, case):
        self.case, self.events = case, []
        self.root = self.alloc(ROOT_SIZE)
        self.cpu.mem_write(self.root, bytes(ROOT_SIZE))
        self.write(self.root + 0x5d0, 'i', case.get('keyboardGrab', 0))
        self.write(self.root + 0x5cc, 'i', case.get('mouseGrab', 0))
        self.cpu.mem_write(self.root + 0x630, bytes(case.get('keyDown', [0] * 0x100)))
        self.modal = self.alloc(MODAL_SIZE)
        self.cpu.mem_write(self.modal, bytes(MODAL_SIZE))
        self.write(self.modal + 0x138, 'I', self.root if case.get('parent', True) else 0)
        self.names = {self.root: 'root', self.modal: 'modal'}
        steps = []
        for step in case['steps']:
            mark = len(self.events)
            op = step['op']
            try:
                if op == 'isMouseButton':
                    result = [self.call(BODY[op], self.root, struct.pack('<I', key)) for key in range(0x100)]
                elif op == 'visibilityChanged':
                    result = self.call(BODY[op], self.modal, struct.pack('<I', step['visible']))
                    result = None
                else:
                    self.call(BODY[op], self.root, b'')
                    result = None
                steps.append({'result': result, 'events': self.events[mark:], 'state': self.snapshot()})
            except (_TIMER.Stop, UcError, RuntimeError) as error:
                steps.append({'stopped': str(error), 'events': self.events[mark:]})
                break
        return {'steps': steps}


def main():
    cases = json.load(sys.stdin)['cases']
    oracle = GrabOracle(sys.argv[1])
    print(json.dumps({'results': [oracle.run(case) for case in cases]}))


if __name__ == '__main__':
    main()
