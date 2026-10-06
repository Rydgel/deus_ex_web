"""Original Render.dll BSP surface auto-pan (0x10b1a59a-0x10b1a72a).

Runs only that straight-line range of the surface pass on a fabricated
FBspSurf (PolyFlags +4, PanU +0x20, PanV +0x22), draw list (zone actor +0x34),
zone (TexUPanSpeed +0x39c, TexVPanSpeed +0x3a0) and frame whose Level's
Actors(0) is a LevelInfo (class from the ALevelInfo import slot, TimeSeconds
+0x478). Render's _ftol thunk (0x10b278a4) jumps through its msvcrt import,
which is the truncating x87 sequence of native-mesh-light-oracle.py
(fistp qword with RC=truncate; edx:eax). The range ends where the
wavy-surface test begins; the float PanU/PanV it leaves are read back.

  native-surface-pan-oracle.py GAME_ROOT CASES_JSON
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import Uc, UC_ARCH_X86, UC_MODE_32
from unicorn.x86_const import UC_X86_REG_EBX, UC_X86_REG_EBP, UC_X86_REG_ESP, UC_X86_REG_FPCW

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
RENDER_HASH = '607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1'
LEVELINFO_IMPORT = 0x10b5d6a4
FTOL_IMPORT = 0x10b5d774
FTOL = bytes.fromhex('83ec0c' 'd93c24' '668b0424' '660d000c' '6689442402' 'd96c2402'
                     'df7c2404' 'd92c24' '8b442404' '8b542408' '83c40c' 'c3')
START, END = 0x10b1a59a, 0x10b1a72a


def main():
    image = native.Image(Path(sys.argv[1]) / 'System' / 'Render.dll', RENDER_HASH)
    cpu = Uc(UC_ARCH_X86, UC_MODE_32)
    cpu.mem_map(image.base, (image.size + 4095) & ~4095)
    for _, _, virtual, raw_size, raw in image.sections:
        if raw_size:
            cpu.mem_write(image.base + virtual, image.data[raw:raw + raw_size])
    base = 0x20000000
    cpu.mem_map(base, 0x10000)
    surf, frame, level, actors, info, zone, drawlist, cls, stack = [base + o for o in
        (0, 0x100, 0x200, 0x300, 0x400, 0x1000, 0x2000, 0x2100, 0x8000)]
    def write(address, fmt, *values):
        cpu.mem_write(address, struct.pack('<' + fmt, *values))
    write(LEVELINFO_IMPORT, 'I', cls)
    ftol = base + 0x3000
    cpu.mem_write(ftol, FTOL)
    write(FTOL_IMPORT, 'I', ftol)
    write(frame + 4, 'I', level)
    write(level + 0x2c, 'I', actors)
    write(actors, 'I', info)
    write(info + 0x24, 'I', cls)
    write(drawlist + 0x34, 'I', zone)
    results = []
    for c in json.loads(Path(sys.argv[2]).read_text()):
        write(surf + 4, 'I', c['flags'])
        write(surf + 0x20, '2h', c['panU'], c['panV'])
        write(zone + 0x39c, '2I', c['speedU'], c['speedV'])
        write(info + 0x478, 'I', c['time'])
        ebp = stack + 0x1000
        write(ebp + 8, 'I', frame)
        write(ebp - 0x24, 'I', drawlist)
        cpu.reg_write(UC_X86_REG_EBP, ebp)
        cpu.reg_write(UC_X86_REG_ESP, stack + 0x400)
        cpu.reg_write(UC_X86_REG_EBX, surf)
        # DrawFrame runs in the render pass: precision control 24 (0x007f)
        # unless ORACLE_CW says otherwise.
        cpu.reg_write(UC_X86_REG_FPCW, native.render_control_word(0x007f))
        cpu.emu_start(START, END, count=400)
        results.append({'u': struct.unpack('<I', cpu.mem_read(ebp - 0x4c, 4))[0],
                        'v': struct.unpack('<I', cpu.mem_read(ebp - 0x18, 4))[0]})
    print(json.dumps({'renderSha256': RENDER_HASH, 'results': results}))


if __name__ == '__main__':
    main()
