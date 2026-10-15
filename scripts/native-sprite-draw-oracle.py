"""Original sprite tile reference (docs/frame-projection.md "Sprites").

Optional research tool, never imported by the browser. For each requested
camera it builds the frame with the unchanged URender::CreateMasterFrame,
ComputeRenderSize and OccludeBsp (scripts/native-occlusion-oracle.py: the
unchanged FDynamicSprite constructor and Setup build each sprite actor's
record, so ScreenX, ScreenY, Persp and Z are the original's), with
`children` every mirror and sky frame too, and for every sprite in a frame's
Frame->Sprite runs, under control word 0x007f (the render pass precision):

  URender::DrawActorSprite (Render.dll 0x10b25080, DrawFrame's call 0x10b1b446)
    -> UCanvas::DrawIcon (Engine 0x10376640, through the canvas vtable +0x60)
    -> UCanvas::DrawTile (Engine 0x10376160, vtable +0x5c): the clip to
       [0, FX] x [0, FY], the texture lock and the U/V scale
    -> UD3DRenderDevice::DrawTile (D3DDrv 0x10005ba0, RenDev vtable +0x7c):
       the four vertices of one D3DPT_TRIANGLEFAN.

A case with `coronas` also runs, on the root frame after its sprites, the
light-corona draw loop of DrawFrame (Render.dll 0x10b1b745-0x10b1bafc, docs/
coronas.md) over a prepared 32-entry cache of lights: the unchanged loop
transforms each light's Location by the frame's Coords, projects it and calls
the same canvas DrawIcon with Z 1.0, so the chain below it (DrawTile, D3DDrv's
DrawTile and its vertices) is the sprites' own. Reported per corona like a sprite.

Reported per sprite: the arguments each of the three calls received (words),
the vertex buffer D3DDrv filled (4 x 8 words), the render and texture-stage
state calls, and the frame fields and depth constants the vertices depend on.

Everything executed is original code. Bridges (no behavior invented), as the
decal oracle (scripts/native-decal-render-oracle.py, whose D3D device
fixture, texture fixtures and SetTexture bookkeeping are reused): fake COM
objects for the IDirect3DDevice7 and vertex buffer (record, return D3D_OK),
UTexture's Update/Lock/Unlock (record; Lock fills the FTextureInfo fields as
UTexture::Lock 0x103ecc90 does at LOD 0: UScale = VScale = f32((USize /
USize) * Scale), the LOD-1 case reduces to 0 without a client table), D3DDrv
SetTexture (thunk 0x100010a5) replaced by a recorder that applies only its
stage bookkeeping with the scale values the original instructions produced
(0x10008e15..0x10008e97). The canvas is an object with Engine's own UCanvas
vtable, Viewport at +0x78 and Frame at +0x7c. Fixtures supply only fields
the instructions read; unmapped access and null objects trap. Input JSON on
stdin, output JSON on stdout. Original DLLs, inputs and results stay local.
"""
import importlib.util
import json
import struct
import sys
from pathlib import Path

from unicorn import UC_HOOK_CODE
from unicorn.x86_const import (UC_X86_REG_EBP, UC_X86_REG_ESI, UC_X86_REG_ESP, UC_X86_REG_FPCW, UC_X86_REG_FPSW,
                               UC_X86_REG_FPTAG)

spec = importlib.util.spec_from_file_location('decal_render', Path(__file__).with_name('native-decal-render-oracle.py'))
decal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decal)
native, occlusion = decal.native, decal.occlusion

DRAW_ACTOR_SPRITE = 0x10b25080   # URender::DrawActorSprite (thunk 0x10b011c2), thiscall (Frame, Sprite), ret 8
CANVAS_VTABLE = 0x10428eec       # ??_7UCanvas@@6B@
CANVAS_DRAW_ICON = 0x10376640    # UCanvas::DrawIcon (export thunk 0x10303f35), vtable +0x60
CANVAS_DRAW_TILE = 0x10376160    # UCanvas::DrawTile (export thunk 0x103019fb), vtable +0x5c
D3D_DRAW_TILE = 0x10005ba0       # UD3DRenderDevice::DrawTile, vtable +0x7c
CORONA_LOOP, CORONA_LOOP_END = 0x10b1b745, 0x10b1bafc   # DrawFrame's draw loop over the 32-entry corona cache
CORONA_SLOTS = {0x10b5d528: '??0FPlane@@QAE@MMMM@Z', 0x10b5d530: '??0FPlane@@QAE@ABV0@@Z', 0x10b5d5c4: '??0FPlane@@QAE@ABVFVector@@@Z'}
CORONA_IS_VALID = 0x10b5d5c8     # the import slot of UObject::IsValid (the cache entries' assertion)
CW_RENDER = decal.CW_RENDER


class SpriteDraw(decal.DecalRender):
    def __init__(self, root, tangents):
        super().__init__(root, tangents)
        cpu = self.cpu
        for address, name, words in ((CANVAS_DRAW_ICON, 'DrawIcon', 16), (CANVAS_DRAW_TILE, 'CanvasDrawTile', 20),
                                     (D3D_DRAW_TILE, 'DeviceDrawTile', 21)):
            cpu.hook_add(UC_HOOK_CODE, lambda uc, a, size, data, name=name, words=words: self.on_tile_entry(name, words),
                         begin=address, end=address)
        # DrawTile reads GTimestamp through its import pointer: a zeroed variable (no rdtsc).
        image = native.Image(self.root / 'System' / 'D3DDrv.dll', decal.D3D_HASH)
        for _, symbol, iat in image.imports():
            if symbol == 'GTimestamp':
                self.write(iat, 'I', self.alloc(16))
        self.draw_enabled = False
        self.d3d_config = {}

    # -- fixtures ------------------------------------------------------------------
    def load(self, request):
        # The level, model, viewer and renderer of the occlusion oracle only (the decal fixtures are not needed).
        occlusion.Occlusion.load(self, request)
        self.client = self.alloc(0x100)                      # Viewport->Client (style flags read +0x48)
        self.write(self.viewport + 0x18, 'I', self.client)
        self.write(self.actor + 0xa8, 'I', self.level_info)
        # The canvas: Engine's UCanvas vtable (DrawIcon +0x60, DrawTile +0x5c), Viewport +0x78, Frame +0x7c.
        self.canvas = self.alloc(0x100)
        vtable = self.alloc(0x200)
        self.cpu.mem_write(vtable, bytes(self.cpu.mem_read(CANVAS_VTABLE, 0x200)))
        self.write(self.canvas, 'I', vtable)
        self.write(self.canvas + 0x78, 'I', self.viewport)
        self.write(self.viewport + 0x5c, 'I', self.canvas)
        # UTexture fixtures (Update/Lock/Unlock stubs, AnimCur) double as the sprite actors' Textures: Setup reads
        # USize/VSize (+0x34, +0x38), DrawActorSprite the PolyFlags (+0x80).
        textures = request['textures']
        self.uv = self.make_textures(textures)
        for t, texture in zip(self.textures, textures):
            self.write(t + 0x34, 'ii', texture['usize'], texture['vsize'])
            self.write(t + 0x80, 'I', texture.get('polyFlags', 0))
        self.sprite_textures = self.textures
        # The corona loop's imports (Core's FPlane constructors) and UObject::IsValid, which answers 1
        # for the light fixtures (`mov eax, 1; ret`), as native-coronas-oracle.py does.
        core = native.Image(self.root / 'System' / 'Core.dll', native.HASHES['Core.dll']).exports()
        for slot, symbol in CORONA_SLOTS.items():
            self.write(slot, 'I', core[symbol])
        self.write(CORONA_IS_VALID, 'I', self.code(bytes.fromhex('b801000000c3')))

    def actor_fixture(self, actor):
        """The AActor fields Setup, DrawActorSprite and its style flags (0x10b26230) read."""
        address = super().actor_fixture(actor)
        self.write(address + 0x165, 'B', actor.get('style', 1))
        self.write(address + 0x194, 'I', actor.get('flags194', 0) | (4 if actor.get('particles') else 0))
        self.write(address + 0x15c, 'B', actor.get('flags15c', 0))
        return address

    # -- recorders -----------------------------------------------------------------
    def on_tile_entry(self, name, words):
        if self.events is None:
            return
        esp = self.cpu.reg_read(UC_X86_REG_ESP)
        self.log(name, list(self.read(esp + 4, f'{words}I')))

    # -- the draw ------------------------------------------------------------------
    def run_case(self, case):
        self.draw_enabled = bool(case.get('draw', True))
        self.coronas, self.corona_draws = case.get('coronas'), None
        self.write(self.viewport + 0xb0, 'II', *case.get('currentTimeWords', [0, 0x40240000]))
        result = super().run_case(case)
        if self.corona_draws is not None:
            result['coronas'] = self.corona_draws
        return result

    def occlude_frame(self, frame, specs, root):
        drawn, setups = super().occlude_frame(frame, specs, root)
        if self.draw_enabled:
            tiles = self.draw_sprites(frame)
            assert len(tiles) == len(drawn), 'Frame->Sprite changed between the walk and the draw'
            for entry, tile in zip(drawn, tiles):
                entry['draw'] = tile
            if root and self.coronas:
                self.corona_draws = self.draw_coronas(frame, self.coronas)
        return drawn, setups

    def begin_draw(self, frame):
        """The render device and canvas as DrawFrame leaves them for this frame's draws: the D3D fixture as the
        RenDev, the canvas on the frame, the device state SetRes and the first stage set. Returns the header
        the vertices depend on (the frame's size fields and the depth constants)."""
        self.saved_device = self.read(self.viewport + 0x64, 'I')[0]
        self.write(self.viewport + 0x64, 'I', self.dev)
        self.write(self.canvas + 0x7c, 'I', frame)
        self.setup_d3d(dict(self.d3d_config))
        self.write(self.dev + 0xaa4, '3f', 1.0, 1.0, 1.0)      # Stages[0].MaxColor
        return {'sizeAndProj': list(self.read(frame + 0xa8, '21I')),
                'depth': {'zBias': self.read(self.dev + 0xa30, 'I')[0], 'zScale': self.read(self.dev + 0xa40, 'I')[0]}}

    def draw_coronas(self, frame, lights):
        """DrawFrame's corona draw loop (0x10b1b745..0x10b1bafc) over a cache of `lights`, one entry each in
        the 32 slots (slot k holds light k at Level.Actors index k + 1; `brightnessBits`, `locationBits`,
        `drawScaleBits`, `hue`, `saturation`, `texture`): the unchanged loop checks each entry, transforms the
        light by the frame's Coords, projects it with Proj.Z, FX2, FY2 and X and calls the canvas' DrawIcon.
        Returns one record per light that reached DrawIcon, with the events of its chain."""
        header = self.begin_draw(frame)
        actors = [self.level_info]
        for light in lights:
            actor = self.alloc(0x400)
            self.write(actor + 0x114, '3I', *light['locationBits'])
            self.write(actor + 0x17c, 'I', light['drawScaleBits'])
            self.write(actor + 0x170, 'I', self.sprite_textures[light['texture']])
            self.write(actor + 0x1e3, '2B', light['hue'], light['saturation'])
            actors.append(actor)
        array, cache = self.alloc(4 * len(actors) + 4), self.alloc(32 * 12)
        self.write(array, f'{len(actors)}I', *actors)
        saved_actors = self.read(self.level + 0x2c, '3I')
        self.write(self.level + 0x2c, '3I', array, len(actors), len(actors))    # Level.Actors: [LevelInfo, lights...]
        for k, light in enumerate(lights):
            self.write(cache + 12 * k, 'IiI', actors[k + 1], k + 1, light['brightnessBits'])
        # DrawFrame's frame: the master frame at [ebp + 8], the viewport at [ebp - 0x1c], the cache at [ebp - 0x54], no
        # PlayerPawn Sprite override ([ebp - 0xb0] = 0), the loop counter at [ebp - 0x5c].
        ebp = self.stack - 0x4000
        self.write(ebp + 8, 'I', frame)
        self.write(ebp - 0x1c, 'I', self.viewport)
        self.write(ebp - 0x54, 'I', cache)
        self.write(ebp - 0xb0, 'I', 0)
        for reg, value in ((UC_X86_REG_ESP, ebp - 0x1000), (UC_X86_REG_EBP, ebp), (UC_X86_REG_ESI, cache), (UC_X86_REG_FPCW, CW_RENDER),
                           (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)):
            self.cpu.reg_write(reg, value)
        self.events = []
        try:
            self.cpu.emu_start(CORONA_LOOP, CORONA_LOOP_END)
        finally:
            events, self.events = self.events, None
            self.write(self.level + 0x2c, '3I', *saved_actors)
            self.write(self.viewport + 0x64, 'I', self.saved_device)
        out = []
        for event in events:
            if event[0] == 'DrawIcon':
                out.append({'events': [], **header})
            if out:
                out[-1]['events'].append(event)
        return out

    def draw_sprites(self, frame):
        """DrawFrame's sprite loop (0x10b1b3f6..0x10b1b44b) for one frame: DrawActorSprite on each Frame->Sprite
        in RenderNext order, with the canvas on this frame and the render device the D3D fixture."""
        header = self.begin_draw(frame)
        saved_device = self.saved_device
        out = []
        link = self.read(frame + 0xa4, 'I')[0]
        while link:
            actor = self.read(link + 0x94, 'I')[0]
            self.write(self.dev + 0xc0, 'II', 0, 0)
            self.events = []
            self.call_native(DRAW_ACTOR_SPRITE, self.render, struct.pack('<2I', frame, link), CW_RENDER)
            events, self.events = self.events, None
            out.append({'events': events, 'lastRenderTimeBits': self.read(actor + 0x34, 'I')[0], **header})
            link = self.read(link + 0x10, 'I')[0]
        self.write(self.viewport + 0x64, 'I', saved_device)
        return out


def main():
    request = json.load(sys.stdin)
    oracle = SpriteDraw(request['gameRoot'], request['tangents'])
    oracle.decal_index = oracle.poly_index = oracle.span_index = {}
    oracle.load(request)
    oracle.d3d_config = request.get('d3d', {})
    results = [oracle.run(case) for case in request['cases']]
    json.dump({'uvScale': oracle.uv, 'textures': request['textures'], 'results': results}, sys.stdout, separators=(',', ':'))
    print()


if __name__ == '__main__':
    main()
