"""Unicorn oracle for Extension XRootWindow's render viewport.

Executes the hash-checked Extension.dll (rebased to 0x12000000 by the
list-window probe) unchanged over PreRender's frame edit, 0x1003a7dd up to
the ComputeRenderSize call at 0x1003a8cb: esi is the root window, ebx the
scene node, ebp a locals frame. MSVCRT _ftol is the harness's truncating
bridge. Reads JSON cases on stdin:

  {"flags": u32, "render": [4 u32 float bits], "multipliers": [i32, i32],
   "frame": [X, Y, XB, YB]}

Prints {"results": [[X, Y, XB, YB], ...]} (the node's +0xa8/+0xac/+0xb0/+0xb4).
"""
import importlib.util
import os
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import (UC_X86_REG_EBP, UC_X86_REG_EBX, UC_X86_REG_ESI, UC_X86_REG_ESP,
                               UC_X86_REG_EIP, UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG)

_SPEC = importlib.util.spec_from_file_location(
    'listwindow_probe', Path(__file__).with_name('native-listwindow-probe.py'))
_PROBE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PROBE)

EXT = _PROBE.EXTENSION_BASE
START, END = EXT + 0x3a7dd, EXT + 0x3a8cb


def main():
    probe = _PROBE.ListWindowProbe(Path(sys.argv[1]))
    root, node, locals_ = probe.alloc(0x800), probe.alloc(0x100), probe.alloc(0x100)
    results = []
    for case in json.load(sys.stdin):
        probe.cpu.mem_write(root, b'\0' * 0x800)
        probe.cpu.mem_write(node, b'\0' * 0x100)
        probe.cpu.mem_write(locals_, b'\0' * 0x100)
        probe.write(root + 0x5d8, 'I', case['flags'])
        probe.write(root + 0x5dc, '4I', *case['render'])
        probe.write(root + 0x730, '2i', *case['multipliers'])
        probe.write(node + 0xa8, '4i', *case['frame'])
        cpu = probe.cpu
        cpu.reg_write(UC_X86_REG_ESI, root)
        cpu.reg_write(UC_X86_REG_EBX, node)
        cpu.reg_write(UC_X86_REG_EBP, locals_ + 0x80)
        cpu.reg_write(UC_X86_REG_ESP, probe.stack)
        # The same x87 state as the harness's call(): control word 0x037f
        # (64-bit precision, round to nearest), empty stack. XRootWindow's
        # PreRender runs from the PreRender event inside the render pass:
        # ORACLE_CW (the precision audit) overrides the word.
        cpu.reg_write(UC_X86_REG_FPCW, int(os.environ.get('ORACLE_CW', '0x037f'), 0))
        cpu.reg_write(UC_X86_REG_FPSW, 0)
        cpu.reg_write(UC_X86_REG_FPTAG, 0xffff)
        cpu.emu_start(START, END, count=100000)
        if cpu.reg_read(UC_X86_REG_EIP) != END:
            raise RuntimeError('render viewport range did not reach ComputeRenderSize')
        results.append(list(probe.read(node + 0xa8, '4i')))
    print(json.dumps({'results': results}))


if __name__ == '__main__':
    main()
