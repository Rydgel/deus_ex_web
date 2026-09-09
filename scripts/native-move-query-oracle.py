"""Original MoveActor query/filter/math/return; controlled MultiLine results.
Scene mutation callbacks are bypassed explicitly; their rejection is not tested.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_EBP, UC_X86_REG_EIP
s=importlib.util.spec_from_file_location('c',Path(__file__).with_name('native-collision-oracle.py'))
c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
class NativeMove(c.NativeCollision):
    def __init__(self,root):
        super().__init__(root)
        self.source,self.level,self.world,self.hit=self.alloc(0x1000),self.alloc(0x1200),self.alloc(0x1000),self.alloc(48)
        vtable,actors=self.alloc(0x100),self.alloc(16)
        self.write(self.level,'I',vtable);self.write(self.level+0x2c,'III',actors,1,1);self.write(actors,'I',self.world)
        self.write(self.world+0x24,'I',0x1057bf00)
        self.write(self.source+0x24,'I',0x1058c160);self.write(self.source+0x5d4,'I',1)
        self.write(self.source+0x28,'I',0x80000);self.write(self.source+0xa8,'I',self.world)
        self.thunk=0x700fd000;self.cpu.mem_write(self.thunk,bytes.fromhex('c2 34 00'));self.write(vtable+0xc8,'I',self.thunk)
        self.active=False
    def on_instruction(self,cpu,address,size,data):
        if self.active and address==self.thunk:
            stack=cpu.reg_read(c.UC_X86_REG_ESP)
            mem,*values=self.read(stack+4,'I9f3I')
            self.query={'end':values[:3],'start':values[3:6],'extent':values[6:9],
                        'checkActors':bool(values[9]),'world':bool(values[10]),'extra':values[11]}
            cpu.reg_write(c.UC_X86_REG_EAX,self.head);return
        if self.active and address==0x103998a0:
            frame=cpu.reg_read(UC_X86_REG_EBP)
            self.displacement=list(self.read(frame-0x24,'3f'))
            # Jump over all scene mutation callbacks to original Location stores.
            cpu.reg_write(UC_X86_REG_EIP,0x10399cb6);return
        if self.active and address==0x10399cef:
            cpu.reg_write(UC_X86_REG_EIP,0x10399f48);return
        super().on_instruction(cpu,address,size,data)
    def capture(self,case):
        self.query=None;self.displacement=[0,0,0]
        self.write(self.source+0x28,'I',(1 if case.get('static') else 0)|(0 if case.get('movable') is False else 0x80000))
        self.write(self.source+0x114,'3f',*case['start']);self.write(self.source+0x120,'3i',0,0,0)
        self.write(self.source+0x1d4,'2f',*case.get('extent',[17,42]));self.write(self.source+0x1dc,'I',case.get('sourceFlags',15))
        self.write(self.hit,'44s',bytes(44));self.write(self.hit+36,'f',1)
        actors={'world':self.world,'self':self.source};self.head=0;tail=None
        for index,h in enumerate(case['hits']):
            kind=h.get('kind','actor')
            actor=actors.get(kind)
            if actor is None:
                actor=self.alloc(0x1000)
                cls={'actor':0,'player':0x1058c160,'projectile':0x10578850,'mover':0x10582a28}.get(kind,0)
                self.write(actor+0x24,'I',cls)
                self.write(actor+0x5d4,'I',1 if kind=='player' else 0)
                self.write(actor+0x178,'I',1 if kind=='mover' else 0)
                self.write(actor+0x1dc,'I',h.get('flags',15))
                self.write(actor+0xc4,'I',self.source if h.get('basedOnSource') else 0)
            hit=self.alloc(44);self.write(hit,'II6fIfi',0,actor,*h.get('location',[10,20,30]),*h.get('normal',[-1,0,0]),0,h['time'],index)
            if tail:self.write(tail,'I',hit)
            else:self.head=hit
            tail=hit
        self.active=True
        success=self.call(0x103990e0,self.level,struct.pack('<I3f3iI4I',self.source,*case['delta'],0,0,0,self.hit,0,0,0,0))
        self.active=False
        return {'success':bool(success),'query':self.query,'delta':self.displacement,'position':list(self.read(self.source+0x114,'3f')),
                'time':self.read(self.hit+36,'f')[0], 'selected':self.read(self.hit+40,'i')[0] if self.read(self.hit+4,'I')[0] else None}
if __name__=='__main__':
    n=NativeMove(Path(sys.argv[1]));cases=json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes':c.HASHES,'results':[n.capture(x) for x in cases]}))
