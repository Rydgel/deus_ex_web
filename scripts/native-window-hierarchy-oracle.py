"""Unchanged Extension GetRootWindow pointer traversal, with read tracing."""
import importlib.util
import json
from pathlib import Path
import sys
import struct
from unicorn import UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE, UC_MEM_READ

spec=importlib.util.spec_from_file_location('child',Path(__file__).with_name('native-window-child-oracle.py'))
child=importlib.util.module_from_spec(spec)
spec.loader.exec_module(child)

class Probe(child._NATIVE.NativeCollision):
    def __init__(self,root):
        super().__init__(Path(root),child.EXTENSION)
        self.objects=[self.alloc(0x200) for _ in range(3)]
        for index,obj in enumerate(self.objects):
            self.write(obj+0x138,'I',self.objects[index+1] if index<2 else 0)
            self.write(obj+0x28,'B',0)
        self.reads=[]
        self.cpu.hook_add(UC_HOOK_MEM_READ,self.on_read)
    def on_read(self,cpu,access,address,size,value,data):
        for index,obj in enumerate(self.objects):
            if address in (obj+0x138,obj+0x28):
                self.reads.append({'object':index,'offset':address-obj,'size':size})
    def case(self,start,type_byte):
        self.write(self.objects[-1]+0x28,'B',type_byte)
        self.reads=[]
        result=self.call(child.EXTENSION_BASE+0x4c5a0,self.objects[start],b'')
        return {'result':self.objects.index(result) if result else None,'reads':self.reads}

class LinkProbe(child._NATIVE.NativeCollision):
    def __init__(self,root):
        super().__init__(Path(root),child.EXTENSION)
        self.objects=[self.alloc(0x200) for _ in range(6)]
        self.events=[]
        self.cpu.hook_add(UC_HOOK_MEM_READ|UC_HOOK_MEM_WRITE,self.on_access)
    def identity(self,pointer):
        return self.objects.index(pointer) if pointer else None
    def on_access(self,cpu,access,address,size,value,data):
        for index,obj in enumerate(self.objects):
            if obj+0x138<=address<=obj+0x148:
                value=self.read(address,'I')[0] if access==UC_MEM_READ else value
                self.events.append({'op':'read' if access==UC_MEM_READ else 'write',
                                    'object':index,'offset':address-obj,'value':self.identity(value)})
    def case(self,name):
        for obj in self.objects:
            self.cpu.mem_write(obj+0x138,b'\0'*20)
        def link(index,offset,value):
            self.write(self.objects[index]+offset,'I',self.objects[value] if value is not None else 0)
        if name=='emptyFront':
            parent,selected,front=0,2,1
        elif name=='occupiedBack':
            parent,selected,front=0,2,0
            link(0,0x13c,1);link(0,0x140,1);link(1,0x138,0)
        else:
            parent,selected,front=4,2,1
            link(0,0x13c,1);link(0,0x140,3)
            for index in (1,2,3):link(index,0x138,0)
            link(1,0x148,2);link(2,0x144,1);link(2,0x148,3);link(3,0x144,2)
            link(4,0x13c,5);link(4,0x140,5);link(5,0x138,4)
        before=[[self.identity(self.read(obj+offset,'I')[0]) for offset in range(0x138,0x14c,4)] for obj in self.objects]
        self.events=[]
        self.call(child.EXTENSION_BASE+0x50a80,self.objects[parent],struct.pack('<2I',self.objects[selected],front))
        after=[[self.identity(self.read(obj+offset,'I')[0]) for offset in range(0x138,0x14c,4)] for obj in self.objects]
        return {'parent':parent,'child':selected,'front':front,'before':before,'after':after,'events':self.events}

if __name__=='__main__':
    probe=Probe(sys.argv[1])
    links=LinkProbe(sys.argv[1])
    print(json.dumps({'cases':{'childRoot':probe.case(0,3),'rootSelf':probe.case(2,3),
                              'nonRoot':probe.case(0,2),'highByte':probe.case(0,255)},
                      'links':{name:links.case(name) for name in ('emptyFront','occupiedBack','reparentFront')}}))
