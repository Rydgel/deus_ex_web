"""Original Render.dll brightness multiplication and color-cache decision.

Runs only the recovered straight-line normalization/multiply and cache-test
instructions. Color-generation virtual output is an explicit fixture input;
native table allocation and the surrounding renderer are not simulated.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_EBP

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
RENDER_HASH = '607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1'


def run(image, before, after, flags=0, color=(1.0, 0.5, 0.25)):
    cpu = Uc(UC_ARCH_X86, UC_MODE_32)
    cpu.mem_map(image.base, (image.size + 4095) & ~4095)
    for _, _, virtual, raw_size, raw in image.sections:
        if raw_size:
            cpu.mem_write(image.base + virtual, image.data[raw:raw + raw_size])
    cpu.mem_map(0x20000000, 0x4000)
    info, actor, level, cache, frame = [0x20000000 + offset for offset in [0, 0x200, 0xa00, 0x1400, 0x1800]]
    def write(address, fmt, *values):
        cpu.mem_write(address, struct.pack('<' + fmt, *values))
    write(info, 'I', actor)
    write(actor + 0xa8, 'I', level)
    write(actor + 0x28, 'I', flags)
    write(level + 0x500, 'f', 1.0)
    write(frame + 8, 'I', 1)
    cpu.reg_write(UC_X86_REG_EBP, frame)
    cpu.reg_write(UC_X86_REG_EBX, info)

    def live_color(brightness):
        write(actor + 0x1e2, 'B', brightness)
        write(info + 0x6c, 'fff', *color)
        cpu.reg_write(UC_X86_REG_EAX, actor)
        cpu.reg_write(UC_X86_REG_EDI, info + 0x20)
        cpu.emu_start(0x10b060b1, 0x10b060d0, count=64)
        cpu.reg_write(UC_X86_REG_ESI, info + 0x6c)
        cpu.emu_start(0x10b06122, 0x10b0614b, count=64)
        return bytes(cpu.mem_read(info + 0x6c, 12))

    previous = live_color(before)
    cpu.mem_write(cache, previous)
    current = live_color(after)
    cpu.reg_write(UC_X86_REG_ESI, cache)
    result = []
    def stop_at_branch(uc, address, size, data):
        if address in [0x10b064ff, 0x10b065e2]:
            result.append('rebuild' if address == 0x10b064ff else 'reuse')
            uc.emu_stop()
    cpu.hook_add(UC_HOOK_CODE, stop_at_branch)
    cpu.emu_start(0x10b06427, 0x10b06600, count=128)
    if len(result) != 1:
        raise RuntimeError('Original cache decision did not reach a recovered branch')
    return {'before': before, 'after': after, 'flags': flags, 'sourceColor': color,
            'previousColor': struct.unpack('<fff', previous),
            'currentColor': struct.unpack('<fff', current), 'branch': result[0]}


if __name__ == '__main__':
    image = native.Image(Path(sys.argv[1]) / 'System' / 'Render.dll', RENDER_HASH)
    cases = [run(image, 50, 50), run(image, 50, 25), run(image, 25, 0),
             run(image, 0, 50), run(image, 50, 50, 0x400),
             run(image, 0, 50, color=(0.0, 0.0, 0.0))]
    expected = ['reuse', 'rebuild', 'rebuild', 'rebuild', 'rebuild', 'reuse']
    assert [case['branch'] for case in cases] == expected
    print(json.dumps({'cases': cases}))
