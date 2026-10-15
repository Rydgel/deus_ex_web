"""Execute the original Render.dll third-person weapon attachment (docs/weapon-attachment.md).

Optional research tool, never imported by the browser. Runs the hash-pinned
Render.dll and Core.dll bodies, unchanged:

  hand       DrawLodMesh 0x10b0f1c9..0x10b0f44f: the special face's three camera-space
             vertices, their outcode test, FVector::SafeNormal, the two cross products,
             the midpoint of the first and third vertex, FCoords::operator*= (Core), and
             the copy of the result into the hand coordinates 0x10b4ea08 (flag 0x10b4eb10).
  weapon     DrawActorSprite 0x10b256e8..0x10b257a2: the weapon's DrawScale/ThirdPersonScale
             swap, its Rotation zeroed, Frame.Mirror forced to 1, the hand coordinates
             copied, FCoords::operator/= (FRotator) (Core) and the weapon's Location added
             to the origin: the Coords handed to DrawMesh.
  flash      the same for the muzzle flash, 0x10b25911..0x10b259ae (AnimFrame set from
             appFrand, which the case scripts).

Core's FVector::SafeNormal, FCoords::operator*= and FCoords::operator/= (FRotator)
run unchanged at the render pass's precision control (24). appSqrt is Python-serviced
as the fld/fsqrt body the other oracles use. Every other import traps. Cases arrive as
JSON on stdin; floats travel as their uint32 words.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EDI, UC_X86_REG_EDX, UC_X86_REG_ESI

spec = importlib.util.spec_from_file_location('dyn', Path(__file__).with_name('native-dynamic-light-oracle.py'))
dyn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dyn)
native = dyn.native

HAND = (0x10b0f1c9, 0x10b0f44f)
WEAPON = (0x10b256e8, 0x10b257a2)
FLASH = (0x10b25911, 0x10b259ae)
HAND_COORDS, HAND_FLAG = 0x10b4ea08, 0x10b4eb10
SAFE_NORMAL = '?SafeNormal@FVector@@QBE?AV1@XZ'
COORDS_MUL = '??XFCoords@@QAEAAV0@ABV0@@Z'
COORDS_DIV_ROTATOR = '??_0FCoords@@QAEAAV0@ABVFRotator@@@Z'


class AttachOracle(dyn.Oracle):
    def __init__(self, root, control_word, sines):
        super().__init__(root, control_word)
        core_exports = self.core.exports()
        for library, symbol, slot in self.render.imports():
            if library == 'core.dll' and symbol in (SAFE_NORMAL, COORDS_MUL, COORDS_DIV_ROTATOR):
                self.write(slot, 'I', core_exports[symbol])
        self.gmath(sines)

    def hand(self, case):
        """case: vertices (three records of three words and an outcode byte), indices (three
        u16 into them), outputs the produced hand coordinates and flag."""
        base = self.alloc(0x58 * max(case['indices']) + 0x58 + 0x10)
        for index, vertex in enumerate(case['vertices']):
            self.write(base + 0x58 * index, '3I', *vertex['words'])
            self.write(base + 0x58 * index + 0xc, 'B', vertex['outcode'])
        faces = self.alloc(16)
        self.write(faces, '3H', *case['indices'])
        mesh = self.alloc(0x200)
        self.write(mesh + 0x174, 'I', faces)
        ebp = self.frame()
        self.write(ebp - 0x58, 'I', base)
        self.write(HAND_FLAG, 'I', 0)
        self.write(HAND_COORDS, '12I', *([0xdeadbeef] * 12))
        self.cpu.reg_write(UC_X86_REG_EBX, mesh)
        self.run(*HAND)
        return {'flag': self.read(HAND_FLAG, 'I')[0], 'coords': list(self.read(HAND_COORDS, '12I'))}

    def drawing(self, case, span):
        """The Coords DrawMesh receives for the weapon (or its flash) from the hand coordinates
        the case supplies: (coords words, the weapon's fields afterwards, Frame.Mirror before and
        after)."""
        weapon, frame = self.alloc(0x800), self.alloc(0x100)
        self.write(weapon + 0x114, '3I', *case['location'])
        self.write(weapon + 0x120, '3I', *case['rotation'])
        self.write(weapon + 0x17c, 'I', case['drawScale'])
        self.write(weapon + 0x370, 'I', case.get('thirdPersonScale', 0x3f800000))
        self.write(weapon + 0x3a8, 'I', case.get('muzzleScale', 0x3f800000))
        self.write(weapon + 0x174, 'I', 0x1000)
        self.write(weapon + 0x36c, 'I', 0x2000)
        self.write(weapon + 0x3a4, 'I', 0x3000)
        self.write(weapon + 0x39c, 'I', case.get('flags39c', 0))
        self.write(weapon + 0x194, 'I', case.get('bits194', 0))
        self.write(frame + 0x20, 'I', case['mirror'])
        self.write(HAND_COORDS, '12I', *case['hand'])
        self.frand_values = list(case.get('frand', []))
        ebp = self.frame()
        self.write(ebp + 8, 'I', frame)
        self.cpu.reg_write(UC_X86_REG_EBX, weapon)
        # The flash block's registers: edx = the animation frame bits it stores later is read from
        # the stack by the original (the appFrand result), esi = the weapon's [+0x194] bits.
        self.cpu.reg_write(UC_X86_REG_ESI, case.get('bits194', 0))
        self.run(*span)
        return {'coords': list(self.read(ebp - 0xe8, '12I')), 'mirror': self.read(frame + 0x20, 'I')[0],
                'rotation': list(self.read(weapon + 0x120, '3I')), 'drawScale': self.read(weapon + 0x17c, 'I')[0],
                'thirdPersonScale': self.read(weapon + 0x370, 'I')[0], 'savedMirror': self.read(ebp - 0x38, 'I')[0],
                'animFrame': self.read(weapon + 0x58, 'I')[0], 'bits194': self.read(weapon + 0x194, 'I')[0]}


def main():
    root = sys.argv[1]
    control_word = int(sys.argv[2], 0) if len(sys.argv) > 2 else native.render_control_word(0x007f)
    cases = json.load(sys.stdin)
    sines = cases['sines']
    out = {'controlWord': control_word}
    # A fresh emulator per case: the hand coordinates are a global.
    out['hand'] = [AttachOracle(root, control_word, sines).hand(case) for case in cases.get('hand', [])]
    out['weapon'] = [AttachOracle(root, control_word, sines).drawing(case, WEAPON) for case in cases.get('weapon', [])]
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
