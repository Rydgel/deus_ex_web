"""Execute original UModel/UPrimitive.GetCollisionBoundingBox, no substituted math."""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_brush', Path(__file__).with_name('native-brush-oracle.py'))
brush = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brush)

class NativeBounds(brush.NativeBrush):
    def bounds(self, case):
        primitive = self.alloc(0x200)
        bounds = case['bounds']
        self.write(primitive + 0x28, '6fB', *bounds['min'], *bounds['max'], bounds.get('valid', True))
        owner = case.get('owner')
        if owner is not None:
            self.owner(owner)
            self.write(self.actor + 0x1d4, '2f', owner.get('CollisionRadius', 0), owner.get('CollisionHeight', 0))
        output = self.alloc(28)
        self.call(0x103d8460 if case.get('primitive') else 0x103f0e70, primitive,
                  struct.pack('<II', output, self.actor if owner is not None else 0))
        data = self.read(output, '6fB')
        return {'min': list(data[:3]), 'max': list(data[3:6]), 'valid': bool(data[6])}

if __name__ == '__main__':
    native = NativeBounds(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes': brush.collision.HASHES, 'results': [native.bounds(case) for case in cases]}))
