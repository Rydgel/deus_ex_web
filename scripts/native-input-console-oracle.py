"""Execute the original Engine.dll input arithmetic and byte-write instructions.

The harness runs the unchanged instruction ranges recovered in docs/script-console-command.md.
Only object pointers and scalar inputs are fixtures; no game boot or substitute engine is used.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class NativeInput(module.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.engine = module.Image(root / 'System' / 'Engine.dll')
        self.verify(0x10393eba, bytes.fromhex('c60001'))
        self.verify(0x10393ed4, bytes.fromhex('c60000'))
        self.verify(0x10393fc0, bytes.fromhex('803080'))
        self.verify(0x103947c7, bytes.fromhex('d94508dc3de0e44210'))
        self.verify(0x1039480e, bytes.fromhex('d9c0'))
        self.verify(0x1039481b, bytes.fromhex('d808d918'))
        self.verify(0x10394060, bytes.fromhex('d986840e0000d84d0cdc0d58984210d807d91f'))
        self.verify(0x1039407a, bytes.fromhex('d986840e0000d84d0cd807d91f'))

    def verify(self, va, expected):
        image = self.engine
        if image.data[image.offset(va-image.base):image.offset(va-image.base)+len(expected)] != expected:
            raise AssertionError(f'Engine.dll instruction bytes changed at {va:08x}')

    def execute(self, begin, end, registers, preserve_fpu=False):
        from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_EBP, UC_X86_REG_EBX,
            UC_X86_REG_ECX, UC_X86_REG_EDI, UC_X86_REG_ESI, UC_X86_REG_ESP,
            UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG)
        for reg,value in [(UC_X86_REG_EAX,0),(UC_X86_REG_EBX,0),(UC_X86_REG_ECX,0),
                          (UC_X86_REG_EDI,0),(UC_X86_REG_ESI,0),(UC_X86_REG_EBP,0),
                          (UC_X86_REG_ESP,self.stack)]:
            self.cpu.reg_write(reg,value)
        if not preserve_fpu:
            for reg,value in [(UC_X86_REG_FPCW,0x037f),(UC_X86_REG_FPSW,0),(UC_X86_REG_FPTAG,0xffff)]:
                self.cpu.reg_write(reg,value)
        for reg,value in registers.items(): self.cpu.reg_write(reg,value)
        self.cpu.emu_start(begin,end,count=1000)
        from unicorn.x86_const import UC_X86_REG_EIP
        if self.cpu.reg_read(UC_X86_REG_EIP) != end:
            raise RuntimeError(f'Original input slice failed to stop at {end:08x}')

    def scale(self, delta, prior):
        from unicorn.x86_const import UC_X86_REG_EBP, UC_X86_REG_EAX
        params=self.alloc(32); field=self.alloc(4)
        self.write(params+8,'f',delta);self.write(field,'f',prior)
        self.execute(0x103947b7,0x103947d8,{UC_X86_REG_EBP:params})
        self.execute(0x1039480e,0x10394810,{},preserve_fpu=True)
        self.execute(0x1039481b,0x1039481f,{UC_X86_REG_EAX:field},preserve_fpu=True)
        result=self.read(field,'f')[0]
        return result

    def axis(self, action, delta, speed, prior):
        from unicorn.x86_const import UC_X86_REG_EBP, UC_X86_REG_EDI, UC_X86_REG_ESI
        inp=self.alloc(0xeb0);field=self.alloc(4);frame=self.alloc(32)
        self.write(inp+0xe84,'f',delta);self.write(field,'f',prior);self.write(frame+0xc,'f',speed)
        if action==4: begin,end=0x10394060,0x103940d0
        elif action==2: begin,end=0x1039407a,0x103940d0
        else: raise ValueError('Only native AXIS action 2 and 4 branches are captured')
        self.execute(begin,end,{UC_X86_REG_EBP:frame,UC_X86_REG_EDI:field,UC_X86_REG_ESI:inp})
        return self.read(field,'f')[0]

    def byteop(self, address, prior):
        from unicorn.x86_const import UC_X86_REG_EAX
        field=self.alloc(4);self.write(field,'B',prior)
        self.execute(address,address+3,{UC_X86_REG_EAX:field})
        return self.read(field,'B')[0]

if __name__=='__main__':
    n=NativeInput(Path(sys.argv[1]))
    result={
      'hashes':module.HASHES,
      'buttons':{'press':n.byteop(0x10393eba,0),'release':n.byteop(0x10393ed4,0x80),
                 'toggleOff':n.byteop(0x10393fc0,0),'toggleOn':n.byteop(0x10393fc0,0x80)},
      'sampling':{'dt005_value3':n.scale(.05,3),'sentinelMinus1_value3':n.scale(-1,3),
                  'zeroDt_value3':('Infinity' if n.scale(0,3)>0 else n.scale(0,3))},
      'axis':{'hold2_dt005_speed300_prior0':n.axis(2,.05,300,0),
              'axis4_dt005_speed1_prior0':n.axis(4,.05,1,0),
              'axis4_dt005_speed6_prior0':n.axis(4,.05,6,0)},
    }
    print(json.dumps(result))
