"""Engine's UModel::LineCheck over the level model the moving brush tracker
left (docs/mesh-lighting.md "LineCheck and the brush tracker").

Loads a native-brush-tracker-oracle.py request (the level model and every
mover with its brush polygons), sets the model's RootOutside (+0xf0), and
runs the unchanged UModel::LineCheck (Engine export
?LineCheck@UModel@@UAEHAAUFCheckResult@@PAVAActor@@VFVector@@22K@Z, the
level model's vtable slot 22) with Owner None, zero Extent and no extra node
flags, as SetupForActor's visibility test calls it (Render.dll
0x10b09583-0x10b0961f), at control word `checkControlWord` (0x007f, the
render pass). It runs every check on the static model first, then
GNewBrushTracker (Update(NULL) at `constructControlWord`, 0x037f, as Play
assumes), then every check again. stdin: the request plus
{"rootOutside": 0|1, "checks": [{"start": [3 float bits], "end": [3 float bits]}]}.
stdout: {"static": [UBOOL...], "tracked": [UBOOL...]} (1 clear, 0 blocked);
with "details": true in the request also "staticHits" and "trackedHits", the
FCheckResult each call left: {"time", "location", "normal", "item"} as float
bit words (Time +0x24, Location +8, Normal +0x14, Item +0x28 of the 0x2c-byte
result).

  native-tracked-linecheck-oracle.py < request.json
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

_SPEC = importlib.util.spec_from_file_location('tracker_oracle', Path(__file__).with_name('native-brush-tracker-oracle.py'))
_TRACKER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_TRACKER)

LINE_CHECK = '?LineCheck@UModel@@UAEHAAUFCheckResult@@PAVAActor@@VFVector@@22K@Z'
ROOT_OUTSIDE = 0xf0


def main():
    request = json.load(sys.stdin)
    oracle = _TRACKER.Tracker(request['gameRoot'])
    oracle.load(request)
    oracle.write(oracle.model + ROOT_OUTSIDE, 'I', request.get('rootOutside', 0))
    engine = _TRACKER.native.Image(Path(request['gameRoot']) / 'System' / 'Engine.dll')
    address = engine.exports()[LINE_CHECK]
    cw = request.get('checkControlWord', 0x007f)
    result = oracle.alloc(0x40)

    def checks():
        out, hits = [], []
        for check in request['checks']:
            oracle.cpu.mem_write(result, bytes(0x40))
            args = struct.pack('<II3I3I3fI', result, 0, *check['end'], *check['start'], 0.0, 0.0, 0.0, 0)
            out.append(oracle.call_native(address, oracle.model, args, cw) & 0xff)
            words = struct.unpack('<11I', bytes(oracle.cpu.mem_read(result, 0x2c)))
            hits.append({'location': list(words[2:5]), 'normal': list(words[5:8]), 'time': words[9], 'item': words[10]})
        return out, hits

    static, static_hits = checks()
    oracle.step({'op': 'construct', 'controlWord': request.get('constructControlWord', 0x037f)})
    tracked, tracked_hits = checks()
    answer = {'static': static, 'tracked': tracked}
    if request.get('details'):
        answer.update({'staticHits': static_hits, 'trackedHits': tracked_hits})
    json.dump(answer, sys.stdout)
    print()


if __name__ == '__main__':
    main()
