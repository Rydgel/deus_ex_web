"""Focused original Render.dll environment-coordinate and normal probes.

Loaded vertex positions/normals and frame coordinates are explicit inputs. The
original instruction slices execute; only external CRT sqrt/pow/isnan are ABI
leaves. No clipping, adaptive tessellation or lighting result is asserted.
"""
import importlib.util, json, math, struct, sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_EBP, UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_ESP, UC_X86_REG_EAX
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'))
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
RENDER='607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1'
class Probe(native.NativeCollision):
    def __init__(self,root):
        super().__init__(root,{'Render.dll':RENDER})
        self.leaves={}; self.result=self.alloc(8)
        for ptr,(_,name) in list(self.thunks.items()):
            if name=='sqrt':
                self.cpu.mem_write(ptr,bytes.fromhex('dd442404d9fac3'));del self.thunks[ptr]
            elif name in ('pow','_CIpow','_isnan'):
                self.leaves[ptr]=name;del self.thunks[ptr]
                self.cpu.mem_write(ptr,((b'\xdd\xd8\xdd\xd8' if name=='_CIpow' else b'')+b'\xdd\x05'+struct.pack('<I',self.result) if name in ('pow','_CIpow') else b'')+b'\xc3')
        self.call(0x10b024b0,0,struct.pack('<IIf',0x10b33650,0x10b3d384,-.5))
    def on_instruction(self,cpu,address,size,data):
        name=self.leaves.get(address)
        if name:
            sp=cpu.reg_read(UC_X86_REG_ESP)
            a=self.read(sp+4,'d')[0]
            if name in ('pow','_CIpow'):
                b=self.read(sp+12,'d')[0]
                v=float('inf') if a==0 and b<0 else math.pow(a,b)
                self.write(self.result,'d',v)
            else:cpu.reg_write(UC_X86_REG_EAX,int(math.isnan(a)))
            return
        super().on_instruction(cpu,address,size,data)
    def run(self,s):
        if s.get('kind')=='faceNormal':
            verts=self.alloc(3*88);frame=self.alloc(0x800)+0x400
            for i,p in enumerate(s['points']):self.write(verts+88*i,'3f',*p)
            self.cpu.reg_write(UC_X86_REG_EBP,frame)
            self.cpu.reg_write(UC_X86_REG_ESI,verts)
            self.cpu.reg_write(UC_X86_REG_EDI,verts+88)
            self.cpu.reg_write(UC_X86_REG_EDX,22)
            self.done=0x10b10314
            self.call(0x10b101d3,verts,b'')
            return [self.read(verts+88*i+0x20,'3f') for i in range(3)]
        frame=self.alloc(0x100);ptrs=self.alloc(12);verts=[]
        self.write(frame+0x64,'12f',0,0,0,*s.get('axes',[1,0,0,0,1,0,0,0,1]))
        for i,(p,n) in enumerate(zip(s['points'],s['normals'])):
            v=self.alloc(88);verts.append(v);self.write(ptrs+4*i,'I',v)
            self.write(v,'3f',*p);self.write(v+0x20,'3f',*n)
        self.write(0x10b4eac8,'f',s.get('uScale',1));self.write(0x10b4eaec,'f',s.get('vScale',1))
        self.done=0x10b0bbbc
        self.call(0x10b0bab0,0,struct.pack('<6I',frame,0,0,ptrs,16,3))
        return [self.read(v+0x50,'2f') for v in verts]
if __name__=='__main__':
    request=json.load(sys.stdin);probe=Probe(Path(request['gameRoot']))
    print(json.dumps([probe.run(s) for s in request['samples']]))
