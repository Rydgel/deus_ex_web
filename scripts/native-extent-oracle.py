"""Original world/owner nonzero-extent LineCheck; optional native diagnostics."""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_ESP, UC_X86_REG_ECX, UC_X86_REG_ESI, UC_X86_REG_EBP
spec=importlib.util.spec_from_file_location('brush',Path(__file__).with_name('native-brush-oracle.py'))
brush=importlib.util.module_from_spec(spec);spec.loader.exec_module(brush)

class NativeExtent(brush.NativeBrush):
    def __init__(self,root):
        self.diagnostics=False
        self.events=[]
        self.node=-1
        self.hit_node=-1
        self.model_nodes=0
        super().__init__(root)
    def on_instruction(self,cpu,address,size,data):
        if address==0x103f4602:
            self.node=(cpu.reg_read(UC_X86_REG_EBP)-self.model_nodes)//64
        elif address==0x103f564a:
            self.hit_node=self.node
        if self.diagnostics:
            p=cpu.reg_read(UC_X86_REG_ESI)
            if address==0x103f4804:
                count=self.read(p+0x4c,'I')[0]
                self.events.append({'leaf':self.node,'planes':[self.read(p+0x80+i*16,'4f') for i in range(count)]})
            elif address==0x103f5b80:
                sp=cpu.reg_read(UC_X86_REG_ESP);plane=self.read(sp+4,'I')[0]
                self.events.append({'bevel':self.read(plane,'4f')})
        return super().on_instruction(cpu,address,size,data)
    def extent(self,model,case):
        self.model_nodes=self.read(model+0x58,'I')[0]
        self.events=[];self.hit_node=-1
        self.diagnostics=case.get('diagnostics',False)
        owner=case.get('owner');coords=self.owner(owner) if owner is not None else None
        hit=self.alloc(48);self.write(hit+36,'f',1);self.write(hit+40,'i',-1)
        end=case.get('end') or [a+b for a,b in zip(case['start'],case['delta'])]
        clear=self.call(0x103f3c20,model,struct.pack('<II9fI',hit,self.actor if owner is not None else 0,*end,*case['start'],*case['extent'],case.get('extraNodeFlags',0)))
        return {'coords':coords,'line':self.result(clear,hit),'node':self.hit_node,'events':self.events}

if __name__=='__main__':
    if len(sys.argv)!=4:sys.exit('Usage: native-extent-oracle.py GAME_ROOT MODEL_JSON CASES_JSON')
    n=NativeExtent(Path(sys.argv[1]));model=n.model(json.loads(Path(sys.argv[2]).read_text()))
    cases=json.loads(Path(sys.argv[3]).read_text())
    print(json.dumps({'hashes':brush.collision.HASHES,'results':[n.extent(model,c) for c in cases]}))
