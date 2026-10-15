"""Execute the unchanged Extension.dll Window.SetBackgroundSmoothing path.

XWindow::SetBackgroundSmoothing 0x1004d700 (called by exec 0x10051dc0) and
XGC::EnableSmoothing 0x100270e0 run as native x86; only GeneratePolyFlags
0x1002af00 is intercepted as the explicit synchronous leaf, as in
native-window-background-style-oracle.py (which this reuses).
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

_SPEC = importlib.util.spec_from_file_location(
    'bg_style_oracle', Path(__file__).with_name('native-window-background-style-oracle.py'))
_STYLE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_STYLE)

BASE = _STYLE.EXTENSION_BASE
SET_BACKGROUND_SMOOTHING = BASE + 0x4d700
WINDOW_FLAGS = 0x38
WINDOW_GC = 0x130
GC_FLAGS = 0x48


class SmoothingProbe(_STYLE.WindowBackgroundStyleProbe):
    def on_memory(self, cpu, access, address, size, value, data):
        if not self.running:
            return
        region = self._region(address, size)
        if region is None:
            return
        name, offset = region
        if (name == 'window' and offset not in (WINDOW_FLAGS, WINDOW_GC)) or (name == 'gc' and offset != GC_FLAGS):
            return
        actual = value & ((1 << (size * 8)) - 1) if access != _STYLE.UC_MEM_READ else int.from_bytes(
            cpu.mem_read(address, size), 'little')
        self.accesses.append({'op': 'read' if access == _STYLE.UC_MEM_READ else 'write', 'region': name,
                              'offset': offset, 'size': size, 'value': actual})

    def smoothing_case(self, window_flags, gc_flags, argument, gc):
        self.cpu.mem_write(self.window, b'\xaa' * 0x200)
        self.cpu.mem_write(self.gc, b'\xaa' * 0x200)
        self.write(self.window + WINDOW_FLAGS, 'I', window_flags)
        self.write(self.window + WINDOW_GC, 'I', self.gc if gc else 0)
        self.write(self.gc + GC_FLAGS, 'I', gc_flags)
        self.accesses = []
        self.events = []
        self.running = True
        self.call(SET_BACKGROUND_SMOOTHING, self.window, struct.pack('<I', argument & 0xffffffff))
        self.running = False
        return {
            'windowFlags': window_flags, 'gcFlags': gc_flags, 'argument': argument, 'gc': gc,
            'accesses': list(self.accesses), 'events': list(self.events),
            'final': {'windowFlags': self.read(self.window + WINDOW_FLAGS, 'I')[0],
                      'gcFlags': self.read(self.gc + GC_FLAGS, 'I')[0]},
        }

    def run_smoothing(self):
        cases = []
        for window_flags in (0, 0xffffffff, 0xa5a5a5a5, 0x00000004, 0xfffffffb):
            for gc_flags in (0, 1, 0xffffffff, 0x12345678, 0xfffffffe):
                for argument in (0, 1, 2, 3, -1, 0x7fffffff, -0x80000000):
                    for gc in (False, True):
                        cases.append(self.smoothing_case(window_flags, gc_flags, argument, gc))
        return {'cases': cases}


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-background-smoothing-oracle.py GAME_ROOT')
    print(json.dumps(SmoothingProbe(Path(sys.argv[1])).run_smoothing()))


if __name__ == '__main__':
    main()
