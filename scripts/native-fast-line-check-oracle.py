"""Execute original UModel::FastLineCheck (Engine.dll export 0x10301a37 -> 0x103f3280) on a whole level model.

The model JSON is a level's BSP as Play holds it (validate-fast-line-check-tracked.mjs: the static map model, or Level->Model
with the moving brush tracker's fragment nodes, docs/brush-tracker.md); every node is written into the emulated FBspNode array
(native-collision-oracle.py NativeCollision.model), RootOutside at +0xf0, and each case calls the wrapper with its two
by-value FVectors in the original's order (first, second) at the game thread's control word (0x037f unless a case names one).

    python native-fast-line-check-oracle.py GAME_ROOT MODEL_JSON CASES_JSON
"""
import importlib.util, json, struct, sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def main():
    if len(sys.argv) != 4:
        sys.exit('Usage: native-fast-line-check-oracle.py GAME_ROOT MODEL_JSON CASES_JSON')
    native = m.NativeCollision(Path(sys.argv[1]))
    model = native.model(json.loads(Path(sys.argv[2]).read_text()))
    results = []
    for case in json.loads(Path(sys.argv[3]).read_text()):
        native.control_word = int(case.get('controlWord', '0x037f'), 16)
        args = struct.pack('<6I', *case['firstBits'], *case['secondBits'])
        results.append(native.call(0x103f3280, model, args) & 0xff)
    print(json.dumps({'hashes': m.HASHES, 'results': results}))


if __name__ == '__main__':
    main()
