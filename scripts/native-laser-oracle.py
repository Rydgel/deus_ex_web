"""Execute DeusEx.dll's ULaserIterator::CurrentItem (0x1001a1a0) on
fabricated iterators.

DeusEx.dll, Core.dll and Engine.dll are hash-pinned and mapped together
(native-collision-oracle.py); Core's own FGlobalMath constructor fills GMath
(the sine table and UnitCoords that FCoords /= FRotator reads). appFrand
(DeusEx IAT 0x100271d8) returns the case's doubles on the x87 stack. The
proxy's XLevel is a recording stand-in for vtable +0x8c FarMoveActor and +0x88
MoveActor (each returns 1); every other instruction is original, including
FVector::UnsafeNormal and FVector::Rotation (whose FPATAN Unicorn evaluates in
double precision, see docs/lasers.md).

Iterator layout (DeusEx.u LaserIterator, instance size 0x190): Outer +0x18,
MaxItems +0x28, Index +0x2c, Beams[8] at +0x34 (0x24 each: bActive, Location,
Rotation, Length, numSegments), prevLoc +0x154, prevRand +0x160, savedLoc
+0x16c, savedRot +0x178, nextItem +0x184, proxy +0x188, bRandomBeam +0x18c.

  native-laser-oracle.py GAME_ROOT < cases.json
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)
DEUSEX_HASH = 'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04'
GMATH, GMATH_CTOR = 0x101b3218, 0x10102978
FRAND_IAT, CURRENT_ITEM = 0x100271d8, 0x1001a1a0
STUBS = 0x700f0000


class LaserOracle(collision.NativeCollision):
    def __init__(self, root):
        self.frand_stub, self.frand_slot = STUBS, STUBS + 0x40
        self.far_stub, self.move_stub = STUBS + 0x80, STUBS + 0xc0
        super().__init__(root, {'DeusEx.dll': DEUSEX_HASH})
        self.call(GMATH_CTOR, GMATH, b'')
        # fld qword [slot]; ret
        self.cpu.mem_write(self.frand_stub, bytes.fromhex('dd05') + struct.pack('<I', self.frand_slot) + bytes.fromhex('c3'))
        # mov eax, 1; ret 0x18 (FarMoveActor: actor, FVector, test, noCheck)
        self.cpu.mem_write(self.far_stub, bytes.fromhex('b801000000c21800'))
        # mov eax, 1; ret 0x30 (MoveActor: actor, Delta, Rotation, Hit, 4 flags)
        self.cpu.mem_write(self.move_stub, bytes.fromhex('b801000000c23000'))
        self.write(FRAND_IAT, 'I', self.frand_stub)
        self.queue, self.calls = [], []
        self.level, self.vtable = self.alloc(0x40), self.alloc(0x100)
        self.write(self.level, 'I', self.vtable)
        self.write(self.vtable + 0x88, 'II', self.move_stub, self.far_stub)
        self.this, self.owner, self.proxy = self.alloc(0x200), self.alloc(0x400), self.alloc(0x400)

    def on_instruction(self, cpu, address, size, data):
        if address == self.frand_stub:
            if not self.queue:
                raise RuntimeError('appFrand queue exhausted')
            self.write(self.frand_slot, 'd', self.queue.pop(0))
            return
        if address == self.far_stub:
            esp = cpu.reg_read(UC_X86_REG_ESP)
            actor, *rest = self.read(esp + 4, 'I3III')
            self.calls.append({'far': [actor == self.proxy, *[self.bits(v) for v in self.read(esp + 8, '3f')], rest[3], rest[4]]})
            return
        if address == self.move_stub:
            esp = cpu.reg_read(UC_X86_REG_ESP)
            actor = self.read(esp + 4, 'I')[0]
            delta = [self.bits(v) for v in self.read(esp + 8, '3f')]
            rotation = list(self.read(esp + 0x14, '3i'))
            flags = list(self.read(esp + 0x24, '4I'))
            self.calls.append({'move': [actor == self.proxy, delta, rotation, flags]})
            return
        return super().on_instruction(cpu, address, size, data)

    @staticmethod
    def bits(value):
        return struct.unpack('<I', struct.pack('<f', value))[0]

    def run(self, case):
        this, owner, proxy = self.this, self.owner, self.proxy
        self.cpu.mem_write(this, bytes(0x200))
        self.cpu.mem_write(owner, bytes(0x400))
        self.cpu.mem_write(proxy, bytes(0x400))
        self.write(proxy + 0xac, 'I', self.level)
        self.write(owner + 0x114, '3I', *case['ownerLocation'])
        self.write(this + 0x18, 'I', owner)
        self.write(this + 0x28, 'i', case['maxItems'])
        for i, beam in enumerate(case['beams']):
            self.write(this + 0x34 + 0x24 * i, 'I3I3ifi', beam['active'], *beam['location'], *beam['rotation'],
                       struct.unpack('<f', struct.pack('<I', beam['length']))[0], beam['numSegments'])
        self.write(this + 0x154, '3I3I3I3i', *case['prevLoc'], *case['prevRand'], *case['savedLoc'], *case['savedRot'])
        self.write(this + 0x184, 'iII', case['nextItem'], proxy if case['hasProxy'] else 0, case['randomBeam'])
        self.queue[:] = list(case['frand'])
        items = []
        for index in case['indices']:
            self.write(this + 0x2c, 'i', index)
            self.calls = []
            # CurrentItem runs inside SetupDynamics (render pass): ORACLE_CW.
            self.control_word = collision.render_control_word()
            result = self.call(CURRENT_ITEM, this, b'')
            self.control_word = 0x037f
            items.append({'returned': 'proxy' if result == proxy else 'owner' if result == owner else hex(result),
                          'calls': self.calls,
                          'prevLoc': list(self.read(this + 0x154, '3I')), 'prevRand': list(self.read(this + 0x160, '3I')),
                          'savedLoc': list(self.read(this + 0x16c, '3I')), 'savedRot': list(self.read(this + 0x178, '3i')),
                          'nextItem': self.read(this + 0x184, 'i')[0], 'frandLeft': len(self.queue)})
        return items


if __name__ == '__main__':
    oracle = LaserOracle(Path(sys.argv[1]))
    print(json.dumps({'deusExSha256': DEUSEX_HASH, 'results': [oracle.run(case) for case in json.load(sys.stdin)]}))
