"""Unicorn oracle for Extension.dll window timers and the button activate timer.

Runs the unchanged XWindow::AddTimer (0x1004fc20), RemoveTimer (0x1004fd20),
InvokeTimers (0x10051340) and XButtonWindow::AddActivateTimer (0x10008510) /
RemoveActivateTimer (0x10008480) from the hash-checked Extension.dll (rebased
to 0x12000000; Core/Engine at their bases) over window images whose vtables are
the real rebased XWindow / XButtonWindow tables, so InvokeTimers' Timer virtual
reaches the original XButtonWindow::Timer (0x100080e0).

Host services:
  * GMalloc: a bump allocator (timer nodes, 0x20 bytes);
  * GetWindowsTickOffset: Core GTimestamp is cleared, so the body calls the
    appSecondsSlow import, which returns the case's `now` (double) in st0; the
    function's static last-tick double (Extension 0x100aa900) holds `last`;
  * ProcessScript (0x1004ded0), ChangeButtonAppearance (0x10008380) and
    SafeDestroy (0x1004c0b0, reached from UnlockWindow) are recorded events.
    A case may make a ProcessScript event set the window's
    flags (a script destroying the window from inside its timer function).
  * appFailAssert stops the run.

Reads JSON {"cases": [...]} on stdin and prints {"results": [...]}. Optional
research tool, never imported by the browser. See docs/script-window-input.md.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE, UcError
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)

EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
IMAGE_BASE = 0x10000000
EXT = 0x12000000
rebase = lambda address: address - IMAGE_BASE + EXT
GMALLOC = 0x101a7c44          # Core ?GMalloc@@3PAVFMalloc@@A
GTIMESTAMP_IAT = rebase(0x10059174)
SECONDS_SLOW_IAT = rebase(0x1005916c)  # Core ?appSecondsSlow@@YANXZ
LAST_TICK = rebase(0x100aa900)
BODY = {'addTimer': rebase(0x1004fc20), 'removeTimer': rebase(0x1004fd20),
        'invokeTimers': rebase(0x10051340), 'addActivateTimer': rebase(0x10008510),
        'removeActivateTimer': rebase(0x10008480)}
EVENTS = {rebase(0x1004ded0): ('ProcessScript', 12), rebase(0x10008380): ('ChangeButtonAppearance', 0),
          rebase(0x1004c0b0): ('SafeDestroy', 0)}
VTABLES = {'window': rebase(0x10059930), 'button': rebase(0x1005a324)}
SIZES = {'window': 0x160, 'button': 0x1ec}
PERSIST = 0x2f000000


class Stop(Exception):
    pass


def f32(bits):
    return struct.unpack('<f', struct.pack('<I', bits))[0]


class TimerOracle(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXT}})
        self.cpu.hook_del(self.code_hook)
        self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, begin=PERSIST, end=PERSIST + 0xfff)
        self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, begin=0x70000000, end=0x700fffff)
        for address in EVENTS:
            self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, begin=address, end=address)
        self.cpu.mem_map(PERSIST, 0x10000)
        self.persist_next = PERSIST
        self.stubs = {}
        for name, pop in [('malloc', 8), ('realloc', 12), ('free', 4)]:
            address = self.keep(16)
            self.cpu.mem_write(address, b'\xc3')
            self.stubs[address] = (name, pop)
            setattr(self, f'stub_{name}', address)
        gmalloc, vtable = self.keep(16), self.keep(32)
        self.write(vtable, '3I', self.stub_malloc, self.stub_realloc, self.stub_free)
        self.write(gmalloc, 'I', vtable)
        self.write(GMALLOC, 'I', gmalloc)
        # GTimestamp is imported by address: clear the Core variable it names.
        self.write(self.read(GTIMESTAMP_IAT, 'I')[0], 'I', 0)
        # appSecondsSlow returns its double in st0: a stub that loads `now`.
        self.now = self.keep(8)
        self.seconds_stub = self.keep(16)
        self.cpu.mem_write(self.seconds_stub, b'\xdd\x05' + struct.pack('<I', self.now) + b'\xc3')
        self.seconds_thunks = {self.read(SECONDS_SLOW_IAT, 'I')[0]}
        for address in self.seconds_thunks:
            self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, begin=address, end=address)
        self.fail_thunks = {a for a, (_dll, sym) in self.thunks.items() if sym == '?appFailAssert@@YAXPBD0H@Z'}

    def keep(self, size):
        address = self.persist_next
        self.persist_next += (size + 15) & ~15
        return address

    # ---- hooks ---------------------------------------------------------
    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address in self.seconds_thunks:
            cpu.reg_write(UC_X86_REG_EIP, self.seconds_stub)
            return
        if address in self.fail_thunks:
            raise Stop('appFailAssert')
        if address in self.thunks:
            raise Stop(f'import {self.thunks[address][1]}')
        stub = self.stubs.get(address)
        if stub:
            getattr(self, f'on_{stub[0]}')(cpu)
            return
        if address in EVENTS:
            self.on_event(cpu, address)

    def ret(self, cpu, value, pop):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        back = self.read(stack, 'I')[0]
        cpu.reg_write(UC_X86_REG_EAX, value & 0xffffffff)
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + pop)
        cpu.reg_write(UC_X86_REG_EIP, back)

    def on_malloc(self, cpu):
        size, _tag = self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, '2I')
        address = self.alloc(size)
        self.cpu.mem_write(address, b'\xcd' * size)
        self.allocations.append(address)
        self.events.append({'op': 'Malloc', 'size': size})
        self.ret(cpu, address, 8)

    def on_realloc(self, cpu):
        raise Stop('GMalloc Realloc')

    def on_free(self, cpu):
        raise Stop('GMalloc Free')

    def on_event(self, cpu, address):
        name, pop = EVENTS[address]
        stack = cpu.reg_read(UC_X86_REG_ESP)
        this = cpu.reg_read(UC_X86_REG_ECX)
        event = {'op': name, 'window': self.window_names.get(this, f'0x{this:08x}')}
        if name == 'ProcessScript':
            fname, params, _flag = self.read(stack + 4, '3I')
            timer, invocations, client = self.read(params, '3I')
            event.update({'name': self.names[fname], 'timer': self.node_ref(timer),
                          'invocations': invocations, 'clientData': client})
            action = self.case.get('onScript', {}).get(f"{event['name']}#{invocations}")
            if action is not None:
                self.write(this + 0x30, 'I', action['flags'])
        self.events.append(event)
        self.ret(cpu, 0, pop)

    # ---- state ---------------------------------------------------------
    def node_ref(self, address):
        if address == 0:
            return None
        return self.allocations.index(address) if address in self.allocations else f'0x{address:08x}'

    def timer_list(self, head):
        nodes, seen = [], set()
        while head:
            if head in seen:
                raise Stop('cyclic timer list')
            seen.add(head)
            timeout, remaining, name, loop, client, in_use, removed, nxt = self.read(head, '8I')
            nodes.append({'node': self.node_ref(head), 'timeout': timeout, 'remaining': remaining,
                          'name': self.names[name] if name < len(self.names) else name, 'loop': loop,
                          'clientData': client, 'inUse': in_use, 'removed': removed})
            head = nxt
        return nodes

    def snapshot(self):
        windows = {}
        for key, address in self.windows.items():
            state = {'flags': self.read(address + 0x30, 'I')[0],
                     'timers': self.timer_list(self.read(address + 0x128, 'I')[0]),
                     'free': self.timer_list(self.read(address + 0x12c, 'I')[0])}
            if self.families[key] == 'button':
                state['buttonFlags'] = self.read(address + 0x174, 'I')[0]
                state['activateTimer'] = self.node_ref(self.read(address + 0x198, 'I')[0])
            windows[key] = state
        return windows

    # ---- driver --------------------------------------------------------
    def run(self, case):
        self.case, self.events, self.allocations = case, [], []
        self.names = ['None'] + case.get('names', [])
        self.windows, self.families, self.window_names = {}, {}, {}
        for spec in case['windows']:
            family = spec.get('family', 'window')
            address = self.alloc(SIZES[family])
            self.cpu.mem_write(address, bytes(SIZES[family]))
            self.write(address, 'I', VTABLES[family])
            self.write(address + 0x30, 'I', spec.get('flags', 0))
            if family == 'button':
                self.write(address + 0x174, 'I', spec.get('buttonFlags', 0))
                self.write(address + 0x178, 'I', spec.get('activateDelay', 0))
            self.windows[spec['id']] = address
            self.families[spec['id']] = family
            self.window_names[address] = spec['id']
        self.write(self.now, 'd', case.get('now', 0.0))
        self.write(LAST_TICK, 'd', case.get('last', 0.0))
        steps = []
        for step in case['steps']:
            mark = len(self.events)
            win = self.windows[step['win']]
            op = step['op']
            try:
                if op == 'addTimer':
                    name = self.names.index(step['name']) if step.get('name') else 0
                    value = self.call(BODY['addTimer'], win, struct.pack('<4I', step['timeout'],
                                                                         step.get('loop', 0), step.get('clientData', 0) & 0xffffffff, name))
                    result = self.node_ref(value)
                elif op == 'removeTimer':
                    target = step['timer']
                    # An allocation index names a node; any other value is a raw ID.
                    address = (self.allocations[target] if isinstance(target, int) and 0 <= target < len(self.allocations)
                               else (target or 0) & 0xffffffff)
                    self.call(BODY['removeTimer'], win, struct.pack('<I', address))
                    result = None
                elif op == 'invoke':
                    self.call(BODY['invokeTimers'], win, struct.pack('<I', step['delta']))
                    result = None
                elif op == 'setFlags':
                    self.write(win + 0x30, 'I', step['flags'])
                    result = None
                elif op in ('addActivateTimer', 'removeActivateTimer'):
                    self.call(BODY[op], win, b'')
                    result = None
                else:
                    raise Stop(f'unknown op {op}')
                steps.append({'result': result, 'events': self.events[mark:], 'state': self.snapshot()})
            except (Stop, UcError, RuntimeError) as error:
                steps.append({'stopped': str(error), 'events': self.events[mark:]})
                break
        return {'steps': steps}


def main():
    root = sys.argv[1]
    cases = json.load(sys.stdin)['cases']
    oracle = TimerOracle(root)
    print(json.dumps({'results': [oracle.run(case) for case in cases]}))


if __name__ == '__main__':
    main()
