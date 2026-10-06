"""Execute Extension.dll's XWindow::BoundsUpdate / SortWindowLists unchanged.

BoundsUpdate 0x10051160 (the x87 absolute-bounds/clip computation, the GC copy
0x10026f00 and the child recursion), SortWindowLists 0x10045140 and the two
qsort comparators run from the hash-checked Extension.dll image rebased to
0x12000000. Only the emulator's own memory/stack back the window objects; every
instruction executed is the original DLL's.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_COLLISION = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_COLLISION)
NativeCollision = _COLLISION.NativeCollision
UC_X86_REG_ESP = _COLLISION.UC_X86_REG_ESP
UC_X86_REG_ECX = _COLLISION.UC_X86_REG_ECX
UC_X86_REG_EAX = _COLLISION.UC_X86_REG_EAX
UC_X86_REG_FPCW = _COLLISION.UC_X86_REG_FPCW
UC_X86_REG_FPSW = _COLLISION.UC_X86_REG_FPSW
UC_X86_REG_FPTAG = _COLLISION.UC_X86_REG_FPTAG

EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
EXTENSION = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE}}

BOUNDS_UPDATE = EXTENSION_BASE + 0x51160
SORT_WINDOW_LISTS = EXTENSION_BASE + 0x45140
COMPARE_DRAW = EXTENSION_BASE + 0x45250
COMPARE_INPUT = EXTENSION_BASE + 0x452d0

WINDOW_SIZE = 0x800
# Offsets in the native XWindow object.
X, Y, WIDTH, HEIGHT = 0x78, 0x7c, 0x80, 0x84
ABS = 0xd4  # absX, absY, clipLeft, clipTop, clipWidth, clipHeight (6 f32)
GC = 0x130
PARENT, FIRST_CHILD, NEXT_SIBLING = 0x138, 0x13c, 0x148
DRAW_LIST, DRAW_COUNT = 0x14c, 0x150
INPUT_LIST, INPUT_COUNT = 0x158, 0x15c
INVALID_W, INVALID_H = 0x16c, 0x170
TYPE = 0x28
GC_BOUNDS = 0x2c


def f32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


class BoundsProbe(NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), EXTENSION)

    def window(self, fields):
        address = self.alloc(WINDOW_SIZE)
        self.cpu.mem_write(address, b'\x00' * WINDOW_SIZE)
        for offset, key in ((X, 'x'), (Y, 'y'), (WIDTH, 'width'), (HEIGHT, 'height')):
            self.write(address + offset, 'f', f32(fields.get(key, 0.0)))
        for i, key in enumerate(('absX', 'absY', 'clipLeft', 'clipTop', 'clipWidth', 'clipHeight')):
            if key in fields:
                self.write(address + ABS + i * 4, 'f', f32(fields[key]))
        self.write(address + TYPE, 'B', fields.get('type', 0))
        return address

    def call_void(self, address, this):
        for reg, value in ((UC_X86_REG_ESP, self.stack), (UC_X86_REG_ECX, this),
                           (UC_X86_REG_FPCW, _COLLISION.render_control_word()), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)):
            self.cpu.reg_write(reg, value)
        self.write(self.stack, 'I', self.done)
        self.cpu.emu_start(address, self.done + 1, count=4000000)
        if self.cpu.reg_read(_COLLISION.UC_X86_REG_EIP) != self.done:
            raise RuntimeError('Native instruction budget exceeded')

    def call_cdecl2(self, address, arg0, arg1):
        for reg, value in ((UC_X86_REG_ESP, self.stack), (UC_X86_REG_ECX, 0),
                           (UC_X86_REG_FPCW, _COLLISION.render_control_word()), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)):
            self.cpu.reg_write(reg, value)
        self.write(self.stack, 'I', self.done)
        self.write(self.stack + 4, 'II', arg0, arg1)
        self.cpu.emu_start(address, self.done + 1, count=4000000)
        if self.cpu.reg_read(_COLLISION.UC_X86_REG_EIP) != self.done:
            raise RuntimeError('Native instruction budget exceeded')
        result = self.cpu.reg_read(UC_X86_REG_EAX)
        return result - 0x100000000 if result >= 0x80000000 else result

    def read_bounds(self, address):
        return [struct.unpack('<f', self.cpu.mem_read(address + ABS + i * 4, 4))[0] for i in range(6)]

    def read_gc_bounds(self, gc):
        return [struct.unpack('<f', self.cpu.mem_read(gc + GC_BOUNDS + i * 4, 4))[0] for i in range(6)]


def build_tree(probe, node, parent_addr=0):
    address = probe.window(node['fields'])
    probe.write(address + PARENT, 'I', parent_addr)
    if node.get('gc'):
        gc = probe.alloc(0x100)
        probe.cpu.mem_write(gc, b'\x00' * 0x100)
        probe.write(address + GC, 'I', gc)
        node['gcAddr'] = gc
    node['addr'] = address
    prev = 0
    for child in node.get('children', []):
        child_addr = build_tree(probe, child, address)
        if prev == 0:
            probe.write(address + FIRST_CHILD, 'I', child_addr)
        else:
            probe.write(prev + NEXT_SIBLING, 'I', child_addr)
        prev = child_addr
    return address


def collect(node, out):
    out[node['label']] = {
        'bounds': node['boundsResult'],
        'gc': node.get('gcResult'),
    }
    for child in node.get('children', []):
        collect(child, out)


def bounds_fixture(probe, tree):
    build_tree(probe, tree)
    probe.call_void(BOUNDS_UPDATE, tree['addr'])

    def record(node):
        node['boundsResult'] = probe.read_bounds(node['addr'])
        if node.get('gc'):
            node['gcResult'] = probe.read_gc_bounds(node['gcAddr'])
        for child in node.get('children', []):
            record(child)
    record(tree)
    out = {}
    collect(tree, out)
    return out


FIXTURES = {
    'rootOnly': {'label': 'root', 'fields': {'width': 100.0, 'height': 50.0}},
    'oneChild': {'label': 'root', 'fields': {'width': 800.0, 'height': 600.0}, 'children': [
        {'label': 'child', 'fields': {'x': 10.0, 'y': 20.0, 'width': 100.0, 'height': 40.0}}]},
    'clipped': {'label': 'root', 'fields': {'width': 40.0, 'height': 40.0}, 'children': [
        {'label': 'child', 'fields': {'x': 20.0, 'y': 20.0, 'width': 50.0, 'height': 50.0}}]},
    'leftOutside': {'label': 'root', 'fields': {'width': 40.0, 'height': 40.0}, 'children': [
        {'label': 'child', 'fields': {'x': -30.0, 'y': 5.0, 'width': 10.0, 'height': 10.0}}]},
    'nested': {'label': 'root', 'fields': {'width': 800.0, 'height': 600.0}, 'children': [
        {'label': 'a', 'fields': {'x': 100.0, 'y': 50.0, 'width': 400.0, 'height': 300.0}, 'children': [
            {'label': 'b', 'fields': {'x': 10.0, 'y': 20.0, 'width': 100.0, 'height': 40.0}}]}]},
    'siblings': {'label': 'root', 'fields': {'width': 800.0, 'height': 600.0}, 'children': [
        {'label': 's1', 'fields': {'x': 5.0, 'y': 5.0, 'width': 50.0, 'height': 30.0}},
        {'label': 's2', 'fields': {'x': 60.0, 'y': 5.0, 'width': 50.0, 'height': 30.0}}]},
    'withGC': {'label': 'root', 'fields': {'width': 800.0, 'height': 600.0}, 'children': [
        {'label': 'child', 'gc': True,
         'fields': {'x': 12.0, 'y': 24.0, 'width': 431.0, 'height': 114.0}}]},
    'fractional': {'label': 'root', 'fields': {'width': 700.5, 'height': 480.25}, 'children': [
        {'label': 'child', 'fields': {'x': 10.5, 'y': 20.25, 'width': 100.125, 'height': 40.0625}}]},
}


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else 'Deus Ex GOTY Edition'
    result = {'hashes': {}, 'base': EXTENSION_BASE, 'fixtures': {}}
    for name, tree in FIXTURES.items():
        probe = BoundsProbe(root)
        result['hashes']['Extension.dll'] = EXTENSION_HASH
        result['fixtures'][name] = bounds_fixture(probe, json.loads(json.dumps(tree)))

    # SortWindowLists with empty lists + zero invalid region is a no-op that
    # must return cleanly (both counts 0, both accumulated extents 0).
    probe = BoundsProbe(root)
    root_addr = probe.window({'type': 3, 'width': 800.0, 'height': 600.0})
    probe.write(root_addr + PARENT, 'I', 0)
    probe.write(root_addr + DRAW_COUNT, 'I', 0)
    probe.write(root_addr + INPUT_COUNT, 'I', 0)
    probe.write(root_addr + INVALID_W, 'f', 0.0)
    probe.write(root_addr + INVALID_H, 'f', 0.0)
    probe.call_void(SORT_WINDOW_LISTS, root_addr)
    result['sortEmpty'] = {'ok': True,
                           'invalidWidth': struct.unpack('<f', probe.cpu.mem_read(root_addr + INVALID_W, 4))[0],
                           'invalidHeight': struct.unpack('<f', probe.cpu.mem_read(root_addr + INVALID_H, 4))[0]}

    # The two qsort comparators over pointer-to-pointer slots.
    probe = BoundsProbe(root)
    a = probe.window({'absX': 10.0, 'absY': 20.0})
    b = probe.window({'absX': 10.0, 'absY': 40.0})
    c = probe.window({'absX': 30.0, 'absY': 20.0})
    slot_a, slot_b, slot_c = probe.alloc(4), probe.alloc(4), probe.alloc(4)
    probe.write(slot_a, 'I', a)
    probe.write(slot_b, 'I', b)
    probe.write(slot_c, 'I', c)
    result['comparators'] = {
        'drawA_vs_B': probe.call_cdecl2(COMPARE_DRAW, slot_a, slot_b),   # same X, aY<bY -> -1
        'drawB_vs_A': probe.call_cdecl2(COMPARE_DRAW, slot_b, slot_a),   # -> +1
        'drawA_vs_C': probe.call_cdecl2(COMPARE_DRAW, slot_a, slot_c),   # same Y, aX<cX -> -1
        'inputA_vs_C': probe.call_cdecl2(COMPARE_INPUT, slot_a, slot_c),  # aX<cX -> -1
        'inputA_vs_B': probe.call_cdecl2(COMPARE_INPUT, slot_a, slot_b),  # same X, aY<bY -> -1
    }
    print(json.dumps(result))


if __name__ == '__main__':
    main()
