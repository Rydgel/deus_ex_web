"""Unicorn oracle for Extension XRootWindow's raw background clip list.

Executes the hash-checked Extension.dll (rebased to 0x12000000) bodies
unchanged: the clip-rect subtraction 0x1003c1d0 and GetRawBackgroundClipList
0x1003c5f0 with its reset 0x1003c0c0 and child walk 0x1004c740/0x1004c680.
The list is a real TArray<XClipRect> grown by Core's FArray::Add/Remove through
the list-window probe's FMalloc model. Reads JSON cases on stdin:

  {"kind": "subtract", "cut": [6 u32], "list": [[6 u32], ...]}
  {"kind": "clipList", "windows": [{"flags": u8, "surface": u8, "clip": [6 u32],
     "children": [indices]}, ...], "root": {"renderFlags": u32, "render": [4 u32]}}

windows[0] is the root. Prints {"results": [[[6 u32], ...], ...]}.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

_SPEC = importlib.util.spec_from_file_location(
    'listwindow_probe', Path(__file__).with_name('native-listwindow-probe.py'))
_PROBE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PROBE)

EXT = _PROBE.EXTENSION_BASE
SUBTRACT = EXT + 0x3c1d0
CLIP_LIST = EXT + 0x3c5f0
WINDOW_SIZE = 0x800
FLAGS, SURFACE, CLIP = 0x30, 0x38, 0xd4
FIRST_CHILD, LAST_CHILD, PREV_SIBLING, NEXT_SIBLING = 0x13c, 0x140, 0x144, 0x148
RENDER_FLAGS, RENDER = 0x5d8, 0x5dc


def make_list(probe, rects):
    array = probe.alloc(12)
    data = probe.alloc(max(len(rects), 1) * 24) if rects else 0
    for i, rect in enumerate(rects):
        probe.write(data + 24 * i, '6I', *rect)
    probe.write(array, '3i', data, len(rects), len(rects))
    return array


def read_list(probe, array):
    data, num, _ = probe.read(array, '3i')
    return [list(probe.read(data + 24 * i, '6I')) for i in range(num)]


def build_windows(probe, windows, root_spec):
    addresses = []
    for spec in windows:
        address = probe.alloc(WINDOW_SIZE)
        probe.cpu.mem_write(address, b'\0' * WINDOW_SIZE)
        probe.write(address + FLAGS, 'B', spec.get('flags', 1))
        probe.write(address + SURFACE, 'B', spec.get('surface', 0))
        probe.write(address + CLIP, '6I', *spec['clip'])
        addresses.append(address)
    for parent, spec in zip(addresses, windows):
        children = [addresses[i] for i in spec.get('children', [])]
        if children:
            probe.write(parent + FIRST_CHILD, 'I', children[0])
            probe.write(parent + LAST_CHILD, 'I', children[-1])
        for prev, child, nxt in zip([0] + children[:-1], children, children[1:] + [0]):
            probe.write(child + PREV_SIBLING, 'I', prev)
            probe.write(child + NEXT_SIBLING, 'I', nxt)
    root = addresses[0]
    probe.write(root + RENDER_FLAGS, 'I', root_spec.get('renderFlags', 0))
    probe.write(root + RENDER, '4I', *root_spec.get('render', [0, 0, 0, 0]))
    return root


def main():
    probe = _PROBE.ListWindowProbe(Path(sys.argv[1]))
    cases = json.load(sys.stdin)
    results = []
    for case in cases:
        probe.events.clear()
        if case['kind'] == 'subtract':
            cut = probe.alloc(24)
            probe.write(cut, '6I', *case['cut'])
            array = make_list(probe, case['list'])
            probe.call(SUBTRACT, 0, struct.pack('<2I', cut, array))
        else:
            root = build_windows(probe, case['windows'], case['root'])
            array = make_list(probe, case.get('list', [[0] * 6, [0] * 6]))
            probe.call(CLIP_LIST, root, struct.pack('<2I', 0, array))
        if any(event.get('op') == 'assert' for event in probe.events):
            raise RuntimeError(f'appFailAssert in case {len(results)}')
        results.append(read_list(probe, array))
    print(json.dumps({'results': results}))


if __name__ == '__main__':
    main()
