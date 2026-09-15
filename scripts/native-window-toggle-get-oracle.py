"""Execute Extension.dll's XToggleWindow::GetToggle body unchanged.

The x86 leaf body is run from the hash-checked Extension.dll image rebased to
0x12000000.  The probe records the +0x174 dword read and the dword result;
GetToggle has no callees, callbacks, or globals.
"""
import importlib.util
import json
from pathlib import Path
import sys

from unicorn import UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE, UC_MEM_READ


_SPEC = importlib.util.spec_from_file_location(
    'native_window_child', Path(__file__).with_name('native-window-child-oracle.py'))
_CHILD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_CHILD)
_NATIVE = _CHILD._NATIVE


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
EXTENSION = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE}}

GET_TOGGLE = EXTENSION_BASE + 0x49a50
GET_TOGGLE_END = EXTENSION_BASE + 0x49a5a
EXEC_BODY = EXTENSION_BASE + 0x49d80
EXEC_END = EXTENSION_BASE + 0x49d95
TOGGLE_FLAGS = 0x174


class WindowToggleGetProbe(_NATIVE.NativeCollision):
    """Run GetToggle and record the raw field access."""

    def __init__(self, root):
        # Extension.dll is deliberately rebased away from the preferred Core
        # and Engine images.  NativeCollision applies the original relocations.
        super().__init__(Path(root), EXTENSION)
        self.window = self.alloc(0x200)
        self.accesses = []
        self.running = False
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_access)

    def on_access(self, cpu, access, address, size, value, data):
        if not self.running or address != self.window + TOGGLE_FLAGS or size != 4:
            return
        self.accesses.append({
            'op': 'read' if access == UC_MEM_READ else 'write',
            'object': 'window',
            'offset': TOGGLE_FLAGS,
            'kind': 'u32',
            'size': size,
            'value': (int.from_bytes(cpu.mem_read(address, 4), 'little')
                      if access == UC_MEM_READ else value & 0xffffffff),
        })

    def case(self, flags):
        self.cpu.mem_write(self.window, b'\xaa' * 0x200)
        self.write(self.window + TOGGLE_FLAGS, 'I', flags)
        self.accesses = []
        self.running = True
        result = self.call(GET_TOGGLE, self.window, b'')
        self.running = False
        return {
            'result': result,
            'accesses': list(self.accesses),
            'final': self.read(self.window + TOGGLE_FLAGS, 'I')[0],
        }

    def run(self):
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'addresses': {
                'body': GET_TOGGLE,
                'end': GET_TOGGLE_END,
                'execBody': EXEC_BODY,
                'execEnd': EXEC_END,
            },
            'cases': {
                'clear': self.case(0),
                'set': self.case(1),
                'clearWithOtherBits': self.case(0xfffffffe),
                'setWithOtherBits': self.case(0xffffffff),
            },
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-toggle-get-oracle.py GAME_ROOT')
    print(json.dumps(WindowToggleGetProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
