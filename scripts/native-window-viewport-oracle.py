"""Unicorn oracle for the Extension XViewportWindow family.

Runs the unchanged Extension.dll XViewportWindow bodies (rebased to
0x12000000) over window and actor images: Init 0x10049f10, CleanUp
0x1004a070, SetViewportActor 0x1004a170, SetViewportLocation 0x1004a300,
SetWatchActor 0x1004a400, SetRotation 0x1004a570, EnableViewport,
SetFOVAngle, ShowViewportActor, ShowWeapons, SetRelativeLocation,
SetRelativeRotation, SetDefaultTexture, ClearZBuffer, Draw 0x1004a770,
PostDraw 0x1004af20, CalcView 0x1004b180 (through the real vtable),
RenderFrame 0x1004b260, GetRenderer 0x1004b2f0 and ConvertVectorToCoordinates
0x1004afc0. XWindow GetRootWindow, GetPlayerPawn, Add/RemoveActorRef and
IsActorValid run with APlayerPawnExt's table (+0x898/+0x998); Engine's
APlayerPawn::AddAdditionalView 0x103ba540 / RemoveAdditionalView 0x103ba4c0
run through the player's vtable (+0xac/+0xb0); Core FVector::Rotation,
FCoords /= FRotator, appSqrt and MSVCRT execute.

Host leaves, recorded as events:
  * XWindow::Init / CleanUp / Draw (script DrawWindow) / PostDraw;
  * ProcessScript (CalcView decodes origin, watch and the two outs; a case may
    overwrite the outs);
  * the renderer (player.XLevel+0xac -> +0x40 Engine -> +0x48 Render) vtable
    CreateMasterFrame +0x64 (returns a zeroed frame block), FinishMasterFrame
    +0x6c and DrawWorld +0x70; Engine FSceneNode::ComputeRenderSize; the
    viewport's RenDev (+0x64) ClearZ (+0x90). Each records the frame's X, Y,
    XB, YB and the player's bBehindView / FovAngle and the origin's bHidden at
    that moment;
  * the XGC fallback PushGC, SetStyle, SetTileColor, DrawPattern, PopGC.

Reads JSON {"cases": [...]} on stdin and prints {"results": [...]}. Research
tool, never imported by the browser. docs/script-window-viewport.md.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE, UcError
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP, UC_X86_REG_EAX, UC_X86_REG_EIP

_SPEC = importlib.util.spec_from_file_location(
    'native_window_typed_key', Path(__file__).with_name('native-window-typed-key-oracle.py'))
_TYPED = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_TYPED)
_FOCUS, _TIMER = _TYPED._FOCUS, _TYPED._TIMER
rebase = _TYPED.rebase

BODY = {name: rebase(address) for name, address in {
    'init': 0x10049f10, 'cleanUp': 0x1004a070, 'setViewportActor': 0x1004a170,
    'setViewportLocation': 0x1004a300, 'setWatchActor': 0x1004a400, 'setRotation': 0x1004a570,
    'enableViewport': 0x1004a640, 'setFOVAngle': 0x1004a660, 'showViewportActor': 0x1004a6b0,
    'showWeapons': 0x1004a6d0, 'setRelativeLocation': 0x1004a6f0, 'setRelativeRotation': 0x1004a710,
    'setDefaultTexture': 0x1004a730, 'clearZBuffer': 0x1004a750, 'draw': 0x1004a770,
    'postDraw': 0x1004af20, 'convertVectorToCoordinates': 0x1004afc0}.items()}
LEAVES = {rebase(a): n for a, n in {
    0x1004bb30: 'XWindow::Init', 0x1004bec0: 'XWindow::CleanUp', 0x10003bf0: 'XWindow::Draw',
    0x10003c80: 'XWindow::PostDraw', 0x100278d0: 'PushGC', 0x10027170: 'SetStyle',
    0x100274f0: 'SetTileColor', 0x10028a60: 'DrawPattern', 0x100279f0: 'PopGC'}.items()}
CALC_VIEW_NAME = rebase(0x1009b33c)
_FOCUS.FAMILIES['viewport'] = (0x1005be08, 0x1b4)
F = lambda bits: struct.unpack('<f', struct.pack('<I', bits & 0xffffffff))[0]
U = lambda value: struct.unpack('<I', struct.pack('<f', value))[0]


class ViewportOracle(_TYPED.TypedKeyOracle):
    def __init__(self, root):
        super().__init__(root)
        imports = lambda slot: self.read(rebase(slot), 'I')[0]
        self.pawn_class, self.player_pawn_class = imports(0x10059394), imports(0x10059334)
        self.compute_render_size = imports(0x10059324)
        engine = {n: a for n, a in self.engine_exports().items()}
        self.add_view, self.remove_view = engine['?AddAdditionalView@APlayerPawn@@UAE_NPAVAActor@@@Z'], engine['?RemoveAdditionalView@APlayerPawn@@UAEXPBVAActor@@@Z']
        for address in list(LEAVES) + [self.compute_render_size]:
            self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, begin=address, end=address)
        self.render_stubs = {}
        for name, pop in [('createMasterFrame', 0x20), ('finishMasterFrame', 0), ('drawWorld', 4), ('clearZ', 4)]:
            address = self.keep(16)
            self.cpu.mem_write(address, b'\xc3')
            self.stubs[address] = (name, pop)
            self.render_stubs[name] = address
        # Core's FGlobalMath constructor (thunk 0x10102978) on GMath
        # (0x101b3218) fills the sine table FCoords /= FRotator reads.
        self.call(0x10102978, 0x101b3218, b'')
        # The static classes are unconstructed in the image: link the chain.
        self.write(self.player_pawn_class + 0x28, 'I', self.pawn_class)
        self.write(self.pawn_class + 0x28, 'I', 0)
        self.write(CALC_VIEW_NAME, 'I', 301)
        self.event_ids[301] = 'CalcView'

    def engine_exports(self):
        from pathlib import Path as _P
        import hashlib
        path = _P(sys.argv[1]) / 'System' / 'Engine.dll'
        image = _TIMER._NATIVE.Image(path, hashlib.sha256(path.read_bytes()).hexdigest())
        return image.exports()

    # ---- leaves ----------------------------------------------------------
    def frame_state(self, frame):
        state = {'frame': self.ref(frame)}
        if frame:
            x, y, xb, yb = self.read(frame + 0xa8, '4i')
            state.update({'x': x, 'y': y, 'xb': xb, 'yb': yb})
        if self.player:
            state.update({'behindView': self.read(self.player + 0x318, 'I')[0] & 1, 'fov': self.read(self.player + 0x410, 'I')[0]})
        origin = self.read(self.windows[self.viewport_id] + 0x15c, 'I')[0] if self.viewport_id else 0
        if origin:
            state['originHidden'] = (self.read(origin + 0x28, 'I')[0] >> 1) & 1
        return state

    def on_createMasterFrame(self, cpu):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        viewport, lx, ly, lz, rp, ry, rr, bounds = self.read(stack + 4, '8I')
        frame = self.alloc(0x100)
        self.cpu.mem_write(frame, bytes(0x100))
        self.ids[frame] = 'frame%d' % len([k for k in self.ids.values() if str(k).startswith('frame')])
        self.events.append({'op': 'CreateMasterFrame', 'renderer': self.ref(cpu.reg_read(UC_X86_REG_ECX)),
                            'viewport': self.ref(viewport), 'location': [lx, ly, lz],
                            'rotation': [rp - (1 << 32) if rp & 0x80000000 else rp, ry - (1 << 32) if ry & 0x80000000 else ry,
                                         rr - (1 << 32) if rr & 0x80000000 else rr]})
        self.ret(cpu, frame if not self.case.get('noFrame') else 0, 0x20)

    def on_finishMasterFrame(self, cpu):
        self.events.append({'op': 'FinishMasterFrame', 'renderer': self.ref(cpu.reg_read(UC_X86_REG_ECX))})
        self.ret(cpu, 0, 0)

    def on_drawWorld(self, cpu):
        frame = self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, 'I')[0]
        canvas = self.canvas
        event = {'op': 'DrawWorld', **self.frame_state(frame)}
        x, y = self.read(canvas + 0x60, '2i')
        cx, cy, cframe = self.read(canvas + 0x3c, 'I')[0], self.read(canvas + 0x40, 'I')[0], self.read(canvas + 0x7c, 'I')[0]
        event.update({'canvas': [x, y, cx, cy, self.ref(cframe)]})
        self.events.append(event)
        self.ret(cpu, 0, 4)

    def on_clearZ(self, cpu):
        frame = self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, 'I')[0]
        self.events.append({'op': 'ClearZ', 'rendev': self.ref(cpu.reg_read(UC_X86_REG_ECX)), 'frame': self.ref(frame)})
        self.ret(cpu, 0, 4)

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        this = cpu.reg_read(UC_X86_REG_ECX)
        if address == _TYPED.PROCESS_SCRIPT:
            name_id, params, third = self.read(stack + 4, '3I')
            if self.event_ids.get(name_id) == 'CalcView':
                origin, watch = self.read(params, '2I')
                loc, rot = list(self.read(params + 8, '3I')), list(self.read(params + 0x14, '3i'))
                self.events.append({'op': 'ProcessScript', 'window': self.ref(this), 'name': 'CalcView',
                                    'params': [self.ref(origin), self.ref(watch), loc, rot], 'third': third})
                change = self.case.get('calcView')
                if change:
                    self.write(params + 8, '3I', *change['location'])
                    self.write(params + 0x14, '3i', *change['rotation'])
                self.ret(cpu, 0, 12)
                return
        if address == self.compute_render_size:
            self.events.append({'op': 'ComputeRenderSize', **self.frame_state(this)})
            self.ret(cpu, 0, 0)
            return
        name = LEAVES.get(address)
        if name:
            args = {'XWindow::Init': 1, 'XWindow::CleanUp': 0, 'XWindow::Draw': 1, 'XWindow::PostDraw': 1, 'PushGC': 0,
                    'SetStyle': 1, 'SetTileColor': 1, 'DrawPattern': 7, 'PopGC': 0}[name]
            words = list(self.read(stack + 4, '%dI' % args)) if args else []
            if name in ('XWindow::Init', 'XWindow::Draw', 'XWindow::PostDraw'):
                words = [self.ref(words[0])]
            elif name == 'SetStyle':
                words = [words[0] & 0xff]
            elif name == 'DrawPattern':
                words = words[:6] + [self.ref(words[6])]
            self.events.append({'op': name, 'object': self.ref(this), 'args': words})
            self.ret(cpu, 1 if name == 'PushGC' else 0, 4 * args)
            return
        super().on_instruction(cpu, address, size, data)

    # ---- world -------------------------------------------------------------
    def object(self, ident, size):
        address = self.alloc(size)
        self.cpu.mem_write(address, bytes(size))
        self.ids[address] = ident
        return address

    def klass(self, kind):
        """A fake UClass whose SuperField (+0x28) is APawn's or APlayerPawn's
        static class; __init__ links APlayerPawn's SuperField to APawn."""
        target = {'pawn': self.pawn_class, 'playerpawn': self.player_pawn_class}.get(kind, 0)
        address = self.alloc(0x40)
        self.cpu.mem_write(address, bytes(0x40))
        self.write(address + 0x28, 'I', target)
        return address

    def build(self, case):
        super().build(case)
        self.viewport_id = next((s['id'] for s in case['windows'] if s.get('family') == 'viewport'), None)
        self.actors = {}
        for spec in case.get('actors', []):
            actor = self.object(spec['id'], 0xa00)
            self.actors[spec['id']] = actor
        for spec in case.get('actors', []):
            actor = self.actors[spec['id']]
            self.write(actor + 0x24, 'I', self.klass(spec.get('kind', 'actor')))
            self.write(actor + 0x28, 'I', spec.get('flags', 0))
            self.write(actor + 0x114, '3I', *spec.get('location', [0, 0, 0]))
            self.write(actor + 0x120, '3i', *spec.get('rotation', [0, 0, 0]))
            self.write(actor + 0x3f8, 'I', spec.get('eyeHeight', 0))
            self.write(actor + 0x3dc, '3i', *spec.get('viewRotation', [0, 0, 0]))
            self.write(actor + 0x318, 'I', spec.get('pawnFlags', 0))
            self.write(actor + 0x410, 'I', spec.get('fov', 0))
        self.player = self.actors.get(case.get('player'))
        if self.player:
            table = self.object('playerVtable', 0x200)
            self.write(table + 0xac, 'I', self.add_view)
            self.write(table + 0xb0, 'I', self.remove_view)
            self.write(self.player, 'I', table)
            for i, ident in enumerate(case.get('additionalViews', [])):
                self.write(self.player + 0x6a8 + 4 * i, 'I', self.actors.get(ident, 0))
            refs = case.get('actorRefs', [])
            for i, (ident, count) in enumerate(refs):
                self.write(self.player + 0x898 + 8 * i, '2i', self.actors[ident], count)
            self.write(self.player + 0x998, 'i', len(refs))
            if case.get('renderer', True):
                level, engine, render, vtable = (self.object(n, 0x100) for n in ('level', 'engine', 'render', 'renderVtable'))
                for name, slot in [('createMasterFrame', 0x64), ('finishMasterFrame', 0x6c), ('drawWorld', 0x70)]:
                    self.write(vtable + slot, 'I', self.render_stubs[name])
                self.write(render, 'I', vtable)
                self.write(engine + 0x48, 'I', render)
                self.write(level + 0x40, 'I', engine)
                self.write(self.player + 0xac, 'I', level)
        for spec in case['windows']:
            win = self.windows[spec['id']]
            if spec.get('family') == 'root':
                self.write(win + 0x588, 'I', self.player or 0)
                self.write(win + 0x730, '2i', *spec.get('multipliers', [1, 1]))
            if spec.get('family') == 'viewport':
                for key, offset, fmt in [('vflags', 0x14c, 'I'), ('fov', 0x150, 'I'), ('defaultColor', 0x158, 'I'),
                                         ('privateFlags', 0x194, 'I')]:
                    if key in spec:
                        self.write(win + offset, fmt, spec[key])
                for key, offset in [('location', 0x164), ('relLocation', 0x170), ('lastLocation', 0x198)]:
                    if key in spec:
                        self.write(win + offset, '3I', *spec[key])
                for key, offset in [('rotation', 0x17c), ('relRotation', 0x188), ('lastRotation', 0x1a4)]:
                    if key in spec:
                        self.write(win + offset, '3i', *spec[key])
                for key, offset in [('origin', 0x15c), ('watch', 0x160)]:
                    if key in spec:
                        self.write(win + offset, 'I', self.actors[spec[key]])
                if 'defaultTexture' in spec:
                    self.write(win + 0x154, 'I', spec['defaultTexture'])
        # GC, canvas, viewport and its render device.
        self.gc = self.object('gc', 0x100)
        self.canvas = self.object('canvas', 0x100)
        viewport, rendev, rendev_vtable = self.object('viewport', 0x100), self.object('rendev', 0x40), self.object('rendevVtable', 0x100)
        self.write(rendev_vtable + 0x90, 'I', self.render_stubs['clearZ'])
        self.write(rendev, 'I', rendev_vtable)
        self.write(viewport + 0x64, 'I', rendev)
        self.write(self.gc + 0x28, 'I', self.canvas)
        canvas = case.get('canvas', {})
        if canvas.get('viewport', True):
            self.write(self.canvas + 0x78, 'I', viewport)
        self.write(self.canvas + 0x60, '2i', *canvas.get('size', [640, 480]))
        self.write(self.canvas + 0x3c, '2I', U(canvas.get('size', [640, 480])[0]), U(canvas.get('size', [640, 480])[1]))
        if 'frame' in canvas:
            cframe = self.object('canvasFrame', 0x100)
            self.write(cframe + 0xb0, '2i', *canvas['frame'])
            self.write(self.canvas + 0x7c, 'I', cframe)

    def snapshot(self):
        state = {}
        for key, win in self.windows.items():
            if self.families[key] != 'viewport':
                continue
            state[key] = {'flags': self.read(win + 0x14c, 'I')[0], 'fov': self.read(win + 0x150, 'I')[0],
                          'defaultTexture': self.read(win + 0x154, 'I')[0], 'defaultColor': self.read(win + 0x158, 'I')[0],
                          'origin': self.ref(self.read(win + 0x15c, 'I')[0]), 'watch': self.ref(self.read(win + 0x160, 'I')[0]),
                          'location': list(self.read(win + 0x164, '3I')), 'relLocation': list(self.read(win + 0x170, '3I')),
                          'rotation': list(self.read(win + 0x17c, '3i')), 'relRotation': list(self.read(win + 0x188, '3i')),
                          'privateFlags': self.read(win + 0x194, 'I')[0], 'lastLocation': list(self.read(win + 0x198, '3I')),
                          'lastRotation': list(self.read(win + 0x1a4, '3i')), 'frame': self.ref(self.read(win + 0x1b0, 'I')[0]),
                          'windowFlags38': self.read(win + 0x38, 'I')[0]}
        for ident, actor in self.actors.items():
            state['actor:' + ident] = {'flags': self.read(actor + 0x28, 'I')[0], 'pawnFlags': self.read(actor + 0x318, 'I')[0],
                                       'fov': self.read(actor + 0x410, 'I')[0]}
        if self.player:
            count = self.read(self.player + 0x998, 'i')[0]
            state['refs'] = [[self.ref(a), r] for a, r in (self.read(self.player + 0x898 + 8 * i, '2i') for i in range(max(0, min(count, 32))))]
            state['additionalViews'] = [self.ref(v) for v in self.read(self.player + 0x6a8, '3I')]
        state['canvas'] = [*self.read(self.canvas + 0x60, '2i'), *self.read(self.canvas + 0x3c, '2I'), self.ref(self.read(self.canvas + 0x7c, 'I')[0])]
        return state

    def step(self, step):
        op, W = step['op'], self.windows
        win = W.get(step.get('win', self.viewport_id))
        actor = lambda key: self.actors.get(step.get(key), 0) if step.get(key) else 0
        if op == 'init':
            return self.call(BODY['init'], win, struct.pack('<I', W[step['parent']]))
        if op in ('cleanUp', 'draw', 'postDraw'):
            return self.call(BODY[op], win, b'' if op == 'cleanUp' else struct.pack('<I', self.gc))
        if op == 'setViewportActor':
            return self.call(BODY[op], win, struct.pack('<III', actor('actor'), step.get('eyeLevel', 1), step.get('enable', 1)))
        if op == 'setViewportLocation':
            return self.call(BODY[op], win, struct.pack('<IIII', *step['location'], step.get('enable', 1)))
        if op == 'setWatchActor':
            return self.call(BODY[op], win, struct.pack('<II', actor('actor'), step.get('eyeLevel', 1)))
        if op in ('setRotation', 'setRelativeRotation'):
            return self.call(BODY[op], win, struct.pack('<3i', *step['rotation']))
        if op == 'setRelativeLocation':
            return self.call(BODY[op], win, struct.pack('<3I', *step['location']))
        if op in ('enableViewport', 'showViewportActor', 'showWeapons', 'clearZBuffer'):
            return self.call(BODY[op], win, struct.pack('<I', step['value']))
        if op == 'setFOVAngle':
            return self.call(BODY[op], win, struct.pack('<I', step['bits']))
        if op == 'setDefaultTexture':
            return self.call(BODY[op], win, struct.pack('<II', step.get('texture', 0), step['color']))
        if op == 'convert':
            frame = self.object('convertFrame', 0x100)
            words = step['frame']
            for offset, value in words.items():
                self.write(frame + int(offset), 'I', value)
            self.write(win + 0x1b0, 'I', frame)
            out = self.alloc(8)
            self.write(out, '2I', 0, 0)
            result = self.call(BODY['convertVectorToCoordinates'], win, struct.pack('<3III', *step['vector'], out, out + 4))
            return [result, *self.read(out, '2I')]
        if op == 'moveActor':
            self.write(self.actors[step['actor']] + 0x114, '3I', *step['location'])
            return None
        if op == 'actorFlags':
            self.write(self.actors[step['actor']] + 0x28, 'I', step['flags'])
            return None
        return super().step(step)

    def run(self, case):
        self.player = None
        self.viewport_id = None
        return super().run(case)


def main():
    request = json.load(sys.stdin)
    oracle = ViewportOracle(sys.argv[1])
    print(json.dumps({'results': [oracle.run(case) for case in request['cases']]}))


if __name__ == '__main__':
    main()
