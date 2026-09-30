"""Run bounded actor-visibility gates in the hash-pinned original Render.dll.

JSON stdin supplies admission and/or meshSetup cases. This runs original
instruction segments, stopping before moving lights, moving brushes, render
iterators, sprites, or bounding-box virtual calls; none are faked as visible.
See docs/render-visibility.md. This optional local research tool never ships
original code or assets and is not imported by the browser.
"""
import importlib.util
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_ESI, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('light_oracle', Path(__file__).with_name('native-dynamic-light-oracle.py'))
light_oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(light_oracle)


class Oracle(light_oracle.Oracle):
    def segment(self, start, stops):
        result = []

        def stop(cpu, address, size, data):
            if address in stops:
                result.append(stops[address])
                cpu.emu_stop()

        hook = self.cpu.hook_add(UC_HOOK_CODE, stop)
        try:
            self.run(start, light_oracle.RETURN, count=10000)
        finally:
            self.cpu.hook_del(hook)
        if not result:
            raise RuntimeError('Original visibility segment did not reach a declared boundary')
        return result[0]

    def view(self, case):
        frame, viewport, view_actor = self.alloc(0x180), self.alloc(0x100), self.alloc(0x800)
        self.write(frame, 'I', viewport)
        self.write(frame + 0x1c, 'I', case.get('recursion', 0))
        self.write(viewport + 0x30, 'I', view_actor)
        self.write(view_actor + 0x318, 'I', int(case.get('behindView', False)))
        self.write(view_actor + 0x5fc, 'I', 0x8 | (0x20 if case.get('actorIcons') else 0))
        self.write(view_actor + 0x600, 'I', case.get('rendMap', 5))
        self.write(frame + 0x34, 'fff', *case.get('origin', [0, 0, 0]))
        self.write(frame + 0x58, 'fff', *case.get('zAxis', [1, 0, 0]))
        return frame, view_actor

    def admission(self, case):
        frame, view_actor = self.view(case)
        actor = view_actor if case.get('isViewActor') else self.alloc(0x800)
        if case.get('nullActor'):
            actor = 0
        if actor:
            flags = ((0x100000 if case.get('highDetail') else 0)
                     | (2 if case.get('hidden') else 0) | (1 if case.get('static') else 0))
            self.write(actor + 0x28, 'I', flags)
            self.write(actor + 0x15c, 'I', int(case.get('hiddenEd', False)))
            self.write(actor + 0x1a0, 'I', (4 if case.get('onlyOwnerSee') else 0)
                       | (2 if case.get('ownerNoSee') else 0))
            owner = view_actor if case.get('owned') else 0
            for _ in range(case.get('ownerDepth', 0)):
                link = self.alloc(0x800)
                self.write(link + 0x3c, 'I', owner)
                owner = link
            self.write(actor + 0x3c, 'I', owner)
            if case.get('viewTarget'):
                self.write(view_actor + 0x60c, 'I', actor)
            brush_class, actor_class = self.alloc(0x40), self.alloc(0x40)
            self.write(0x10b5d708, 'I', brush_class)
            self.write(actor_class + 0x28, 'I', brush_class if case.get('brushClass') else 0)
            self.write(actor + 0x24, 'I', actor_class)
            self.write(actor + 0x178, 'I', self.alloc(16) if case.get('brush') else 0)
        for slot, value in [(0x10b5d4b4, case.get('editor', False)),
                            (0x10b5d5ec, case.get('running', True))]:
            target = self.alloc(4)
            self.write(target, 'I', int(value))
            self.write(slot, 'I', target)
        ebp = self.frame()
        self.write(ebp + 0xc, 'I', actor if case.get('excluded') else 0)
        self.write(ebp - 0x1c, 'I', int(case.get('highDetailActors', True)))
        self.cpu.reg_write(UC_X86_REG_EBX, frame)
        self.cpu.reg_write(UC_X86_REG_ESI, actor)
        return self.segment(0x10b22e1f, {
            0x10b232f4: 'skip-actor', 0x10b230e8: 'lights-only',
            0x10b230d5: 'moving-brush', 0x10b22f42: 'render-interface',
        })

    def mesh_setup(self, case):
        frame, _ = self.view(case)
        actor, sprite = self.alloc(0x800), self.alloc(0xe0)
        self.write(actor + 0x164, 'B', case.get('drawType', 2))
        self.write(actor + 0x174, 'I', self.alloc(16) if case.get('mesh', True) else 0)
        self.write(actor + 0x114, 'fff', *case.get('location', [100, 0, 0]))
        self.write(actor + 0x17c, 'f', 1)
        self.write(sprite + 0x94, 'I', actor)
        esp = self.frame() - 0x800
        self.write(esp, 'II', light_oracle.RETURN, frame)
        self.cpu.reg_write(UC_X86_REG_ESP, esp)
        self.cpu.reg_write(UC_X86_REG_ECX, sprite)
        route = self.segment(0x10b23910, {
            0x10b23ada: 'sprite', 0x10b23add: 'sprite',
            0x10b23d94: 'rejected', 0x10b23a4c: 'mesh-bounds',
        })
        return {'route': route, 'depthBits': self.read(sprite + 8, 'I')[0]}


class BoundsOracle(light_oracle.native.NativeCollision):
    """Complete original mesh-box and perspective BoundVisible calls.

    Fixtures supply serialized mesh boxes and actor/frame fields. Original
    GetAnimSeq, Core rotation/box math and every renderer branch execute;
    unknown imports retain the common probe's trap.
    """
    def __init__(self, root):
        super().__init__(Path(root), {'Render.dll': light_oracle.RENDER_HASH})
        table = b''.join(struct.pack('<f', math.sin(i * 0.0003834951969714103)) for i in range(16384))
        assert hashlib.sha256(table).hexdigest() == '9893d14bd21e5c4194832659571b30363ddfb08d468ed662a4b6d5ae172262dc'
        self.cpu.mem_write(0x101b32a4, table)

    def box(self, address, value):
        self.write(address, '6fB', *value['min'], *value['max'], int(value.get('valid', True)))

    def mesh_bounds(self, case):
        mesh, actor, result, vtable = self.alloc(0x140), self.alloc(0x800), self.alloc(28), self.alloc(0x100)
        self.write(mesh, 'I', vtable)
        self.write(vtable + 0x68, 'I', 0x10301e29)
        self.box(mesh + 0x28, case['box'])
        self.write(mesh + 0x100, '3f', *case.get('scale', [1, 1, 1]))
        self.write(mesh + 0x10c, '3f', *case.get('origin', [0, 0, 0]))
        self.write(mesh + 0x118, '3i', *case.get('rotation', [0, 0, 0]))
        boxes = case.get('boxes', [])
        data = self.alloc(max(1, len(boxes)) * 28)
        for i, box in enumerate(boxes):
            self.box(data + i * 28, box)
        self.write(mesh + 0xa8, '3I', data, len(boxes), len(boxes))
        sequences = case.get('sequences', [])
        data = self.alloc(max(1, len(sequences)) * 32)
        for i, seq in enumerate(sequences):
            self.write(data + i * 32, '5I', seq['name'], 0, seq['startFrame'], seq['numFrames'], 0)
        self.write(mesh + 0x84, '3I', data, len(sequences), len(sequences))
        fields = case.get('actor', {})
        self.write(actor + 0x54, 'If', fields.get('sequence', 0), fields.get('frame', 0))
        self.write(actor + 0x114, '3f', *fields.get('location', [0, 0, 0]))
        self.write(actor + 0x120, '3i', *fields.get('rotation', [0, 0, 0]))
        self.write(actor + 0x17c, 'f', fields.get('drawScale', 1))
        self.write(actor + 0x180, '3f', *fields.get('prePivot', [0, 0, 0]))
        self.write(actor + 0x194, 'I', 4 if fields.get('particles') else 0)
        self.call(0x103a6850, mesh, struct.pack('<3I', result, actor, int(case.get('exact', False))))
        return {'bits': list(self.read(result, '6I')), 'valid': self.read(result + 24, 'B')[0],
                'min': list(self.read(result, '3f')), 'max': list(self.read(result + 12, '3f'))}

    def bound_visible(self, case):
        frame, viewport, actor = self.alloc(0x200), self.alloc(0x100), self.alloc(0x800)
        bound, screen = self.alloc(28), self.alloc(20)
        self.write(frame, 'I', viewport)
        self.write(viewport + 0x30, 'I', actor)
        self.write(actor + 0x600, 'I', 5)
        self.box(bound, case['box'])
        value = case['frame']
        if 'coordsBits' in value:
            self.write(frame + 0x34, '12I', *value['coordsBits'])
        else:
            self.write(frame + 0x34, '12f', *value['coords'])
        self.write(frame + 0xa8, '2i', value['width'], value['height'])
        self.write(frame + 0xb8, '2f', value['width'], value['height'])
        self.write(frame + 0xc8, '2f', *value['center'])
        self.write(frame + 0xdc, 'f', value['projectionZ'])
        self.write(frame + 0xec, '4f', *value['clip'])
        visible = self.call(0x10b162e0, 0, struct.pack('<4I', frame, bound, 0, screen))
        return {'visible': bool(visible), 'bits': list(self.read(screen, '5I')),
                'screen': list(self.read(screen, '5f'))}


if __name__ == '__main__':
    root = sys.argv[1]
    word = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x037f
    oracle = Oracle(root, word)
    request = json.load(sys.stdin)
    result = {'controlWord': word}
    if 'admission' in request:
        result['admission'] = [oracle.admission(case) for case in request['admission']]
    if 'meshSetup' in request:
        result['meshSetup'] = [oracle.mesh_setup(case) for case in request['meshSetup']]
    if 'meshBounds' in request or 'boundVisible' in request:
        if word != 0x037f:
            raise ValueError('Bounds oracle currently admits only the established 0x037f control word')
        bounds = BoundsOracle(root)
        if 'meshBounds' in request:
            result['meshBounds'] = [bounds.mesh_bounds(case) for case in request['meshBounds']]
        if 'boundVisible' in request:
            result['boundVisible'] = [bounds.bound_visible(case) for case in request['boundVisible']]
    if 'sceneFrames' in request:
        scene_spec = importlib.util.spec_from_file_location('scene', Path(__file__).with_name('native-window-scene-frame-oracle.py'))
        scene = importlib.util.module_from_spec(scene_spec)
        scene_spec.loader.exec_module(scene)
        producer = scene.Probe(root, request['tangents'])
        frames = []
        for case in request['sceneFrames']:
            address = producer.free
            frame = producer.run(case)
            frame['clipBits'] = list(producer.read(address + 0xec, '4I'))
            frames.append(frame)
        result['sceneFrames'] = frames
    json.dump(result, sys.stdout, separators=(',', ':'))
    print()
