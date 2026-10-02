"""Execute DeusEx.dll's UParticleIterator::execUpdateParticles (native 3017,
0x1001ac50) after its float parameter on fabricated iterators.

DeusEx.dll (hash-pinned) is mapped alone: the iterator's 64 particles
(+0x34, 0x34 bytes each), nextFreeParticle (+0xd34), proxy (+0xd38) and the
owner fields (+0xd3c flags, +0xd40 ZoneGravity, +0xd44 RiseRate, +0xd48
LifeSpan, +0xd4c DrawScale) come from the case; appFrand returns the case's
doubles on the x87 stack; DeleteParticle runs natively. Cases on stdin.

  native-particles-oracle.py GAME_ROOT < cases.json
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_ESP, UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_EIP, UC_X86_REG_FPCW

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
DEUSEX_HASH = 'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04'
TRAP, HEAP = 0x0e000000, 0x20000000
EXITS = (0x1001ae3a, 0x1001ae49)


def main():
    image = native.Image(Path(sys.argv[1]) / 'System' / 'DeusEx.dll', DEUSEX_HASH)
    cpu = Uc(UC_ARCH_X86, UC_MODE_32)
    cpu.mem_map(image.base, (image.size + 4095) & ~4095)
    for _, _, virtual, raw_size, raw in image.sections:
        if raw_size:
            cpu.mem_write(image.base + virtual, image.data[raw:raw + raw_size])
    cpu.mem_map(TRAP, 0x10000)
    cpu.mem_map(HEAP, 0x100000)
    slots = {}
    for library, symbol, slot in image.imports():
        address = TRAP + 0x10 * len(slots)
        slots[address] = symbol
        cpu.mem_write(slot, struct.pack('<I', address))
    frand_slot, queue = HEAP + 0x80000, []
    for address, symbol in slots.items():
        if symbol == '?appFrand@@YAMXZ':
            # fld qword [frand_slot]; ret
            cpu.mem_write(address, bytes.fromhex('dd05') + struct.pack('<I', frand_slot) + bytes.fromhex('c3'))

    def on_trap(uc, address, size, data):
        symbol = slots.get(address)
        if symbol is None:
            return
        if symbol != '?appFrand@@YAMXZ':
            raise RuntimeError(f'Unexpected import {symbol}')
        uc.mem_write(frand_slot, struct.pack('<d', queue.pop(0)))
    cpu.hook_add(UC_HOOK_CODE, on_trap, begin=TRAP, end=TRAP + 0x10000)

    def on_exit(uc, address, size, data):
        if address in EXITS:
            uc.emu_stop()
    cpu.hook_add(UC_HOOK_CODE, on_exit, begin=EXITS[0], end=EXITS[1])

    out = []
    for case in json.load(sys.stdin):
        this, proxy, frame = HEAP + 0x1000, HEAP + 0x3000, HEAP + 0x4000
        cpu.mem_write(this, bytes(0xe00))
        cpu.mem_write(proxy, bytes(0x100))
        self_write = lambda address, fmt, *values: cpu.mem_write(address, struct.pack('<' + fmt, *values))
        for i, p in enumerate(case['particles']):
            self_write(this + 0x34 + 0x34 * i, 'I12f', p['active'], *p['initVel'], *p['velocity'], *p['location'],
                       p['drawScale'], p['scaleGlow'], p['lifeSpan'])
        self_write(this + 0xd34, 'iI', case['nextFreeParticle'], proxy)
        self_write(this + 0xd3c, 'I4f', case['flags'], case['zoneGravity'], case['riseRate'], case['ownerLifeSpan'], case['ownerDrawScale'])
        self_write(proxy + 0x28, 'I', case.get('proxyFlags', 0))
        queue[:] = list(case['frand'])
        steps = []
        for dt in case['times']:
            esp = HEAP + 0x60000
            # The frame after `sub esp,0x10; push ebx; push ebp; push esi;
            # push edi`: the parameter at [esp+0x10], return slot at +0x24.
            self_write(esp + 0x10, 'f', dt)
            self_write(frame + 0xc, 'I', HEAP + 0x5000)
            cpu.reg_write(UC_X86_REG_ESP, esp)
            cpu.reg_write(UC_X86_REG_ESI, frame)
            cpu.reg_write(UC_X86_REG_EDI, this)
            cpu.reg_write(UC_X86_REG_FPCW, 0x037f)
            cpu.emu_start(0x1001ac81, 0, count=1_000_000)
            particles = []
            for i in range(64):
                values = struct.unpack('<I12f', bytes(cpu.mem_read(this + 0x34 + 0x34 * i, 0x34)))
                particles.append([values[0]] + [struct.unpack('<I', struct.pack('<f', v))[0] for v in values[1:]])
            steps.append({'particles': particles, 'nextFreeParticle': struct.unpack('<i', bytes(cpu.mem_read(this + 0xd34, 4)))[0],
                          'proxyFlags': struct.unpack('<I', bytes(cpu.mem_read(proxy + 0x28, 4)))[0]})
        out.append({'steps': steps, 'frandLeft': len(queue)})
    json.dump({'deusExSha256': DEUSEX_HASH, 'results': out}, sys.stdout)


if __name__ == '__main__':
    main()
