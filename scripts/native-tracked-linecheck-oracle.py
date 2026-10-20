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
A check may carry "extent" (3 float bits, default zero) and
"extraNodeFlags" (default 0): the box branch of the same LineCheck, as
ULevel::MultiLineCheck's world check calls it for MoveActor and the traces
(docs/brush-tracker.md "Collision"). The model's LeafHulls (+0xcc, the
request model's "leafHulls" words) are loaded for that branch. A request may
also carry "points": [{"position": [3 float bits], "extent": [3 float bits]}],
run through the unchanged UModel::PointCheck (0x103f1570, vtable slot 21;
Owner None, no extra node flags), as ULevel::MultiPointCheck's world check
calls it. Each FCheckResult starts with Time 1.0 and Item -1, as
native-extent-oracle.py's do.
stdout: {"static": [UBOOL...], "tracked": [UBOOL...]} (1 clear, 0 blocked);
with "details": true in the request also "staticHits" and "trackedHits", the
FCheckResult each call left: {"time", "location", "normal", "item"} as float
bit words (Time +0x24, Location +8, Normal +0x14, Item +0x28 of the 0x2c-byte
result). With "points": "staticPoints"/"trackedPoints" (UBOOL, 1 outside)
and, with "details", "staticPointHits"/"trackedPointHits". With "moves" (tracker
steps run after construction: native-brush-tracker-oracle.py's "set" and op
"frame"/"update"), every check and point again: "moved", "movedPoints",
"movedHits", "movedPointHits".

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
POINT_CHECK = 0x103f1570
ROOT_OUTSIDE = 0xf0
LEAF_HULLS = 0xcc
ONE = 0x3f800000


def main():
    request = json.load(sys.stdin)
    oracle = _TRACKER.Tracker(request['gameRoot'])
    oracle.load(request)
    oracle.write(oracle.model + ROOT_OUTSIDE, 'I', request.get('rootOutside', 0))
    hulls = request['model'].get('leafHulls', [])
    oracle.array(oracle.model + LEAF_HULLS, struct.pack(f'<{len(hulls)}i', *hulls), len(hulls), 4)
    engine = _TRACKER.native.Image(Path(request['gameRoot']) / 'System' / 'Engine.dll')
    address = engine.exports()[LINE_CHECK]
    cw = request.get('checkControlWord', 0x007f)
    result = oracle.alloc(0x40)

    def fresh():
        oracle.cpu.mem_write(result, bytes(0x40))
        oracle.write(result + 0x24, 'Ii', ONE, -1)

    def left():
        words = struct.unpack('<11I', bytes(oracle.cpu.mem_read(result, 0x2c)))
        return {'location': list(words[2:5]), 'normal': list(words[5:8]), 'time': words[9], 'item': words[10]}

    def checks():
        out, hits = [], []
        for check in request['checks']:
            fresh()
            args = struct.pack('<II3I3I3II', result, 0, *check['end'], *check['start'], *check.get('extent', [0, 0, 0]),
                               check.get('extraNodeFlags', 0))
            out.append(oracle.call_native(address, oracle.model, args, cw) & 0xff)
            hits.append(left())
        return out, hits

    def points():
        out, hits = [], []
        for point in request.get('points', []):
            fresh()
            args = struct.pack('<II3I3II', result, 0, *point['position'], *point['extent'], 0)
            out.append(oracle.call_native(POINT_CHECK, oracle.model, args, cw) & 0xff)
            hits.append(left())
        return out, hits

    static, static_hits = checks()
    static_points, static_point_hits = points()
    oracle.step({'op': 'construct', 'controlWord': request.get('constructControlWord', 0x037f)})
    tracked, tracked_hits = checks()
    tracked_points, tracked_point_hits = points()
    answer = {'static': static, 'tracked': tracked}
    if 'points' in request:
        answer.update({'staticPoints': static_points, 'trackedPoints': tracked_points})
    if request.get('details'):
        answer.update({'staticHits': static_hits, 'trackedHits': tracked_hits})
        if 'points' in request:
            answer.update({'staticPointHits': static_point_hits, 'trackedPointHits': tracked_point_hits})
    # "moves": tracker steps after construction (native-brush-tracker-oracle.py
    # step: "set" positions, op "frame" or "update"), then every check again.
    if request.get('moves'):
        for step in request['moves']:
            oracle.step(step)
        moved, moved_hits = checks()
        moved_points, moved_point_hits = points()
        answer['moved'] = moved
        if 'points' in request:
            answer['movedPoints'] = moved_points
        if request.get('details'):
            answer['movedHits'] = moved_hits
            if 'points' in request:
                answer['movedPointHits'] = moved_point_hits
    json.dump(answer, sys.stdout)
    print()


if __name__ == '__main__':
    main()
