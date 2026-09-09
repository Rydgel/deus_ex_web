"""Capture original ABrush.ToWorld and owner UModel.LineCheck instructions.

The original Core constructor initializes rotation tables. No transforms or
collision responses are supplied by Python. Minimal actor fields correspond to
the accesses in Engine.dll 0x1030f310; all other actor memory starts zeroed.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)


class NativeBrush(collision.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.call(0x10102978, 0x101b3218, b'')
        self.actor, self.vtable, self.coords = self.alloc(0x400), self.alloc(0x100), self.alloc(48)
        self.write(self.actor, 'I', self.vtable)
        self.write(self.vtable + 0x88, 'I', 0x1030f310)  # ABrush.ToWorld

    def owner(self, values):
        self.write(self.actor + 0x114, '3f', *values.get('Location', [0, 0, 0]))
        self.write(self.actor + 0x120, '3i', *values.get('Rotation', [0, 0, 0]))
        self.write(self.actor + 0x180, '3f', *values.get('PrePivot', [0, 0, 0]))
        for offset, key in [(0x32c, 'MainScale'), (0x340, 'PostScale')]:
            scale = values.get(key, {})
            self.write(self.actor + offset, '4fB', *scale.get('scale', [1, 1, 1]),
                       scale.get('shearRate', 0), scale.get('shearAxis', 0))
        self.call(0x1030f310, self.actor, struct.pack('<I', self.coords))
        return list(self.read(self.coords, '12f'))

    def owner_line(self, model, case):
        coords = self.owner(case['owner'])
        hit = self.alloc(48)
        self.write(hit + 36, 'f', 1)
        end = [a + b for a, b in zip(case['start'], case['delta'])]
        clear = self.call(0x103f3c20, model, struct.pack('<II9fI', hit, self.actor, *end,
                          *case['start'], *case['extent'], case.get('extraNodeFlags', 0)))
        return {'coords': coords, 'line': self.result(clear, hit)}


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit('Usage: native-brush-oracle.py GAME_ROOT MODEL_JSON CASES_JSON')
    native = NativeBrush(Path(sys.argv[1]))
    model = native.model(json.loads(Path(sys.argv[2]).read_text()))
    cases = json.loads(Path(sys.argv[3]).read_text())
    print(json.dumps({'hashes': collision.HASHES, 'results': [native.owner_line(model, case) for case in cases]}))
