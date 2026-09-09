"""Capture original ABrush.ToWorld coordinates and Core's full sine table."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('native_brush', Path(__file__).with_name('native-brush-oracle.py'))
brush = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brush)

if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-coords-oracle.py GAME_ROOT CASES_JSON')
    native = brush.NativeBrush(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes': brush.collision.HASHES,
                      'sineTable': native.read(0x101b32a4, '16384f'),
                      'coords': [native.owner(case) for case in cases]}))
