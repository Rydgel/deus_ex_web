"""Original StaticLoadObject: simple name + filename -> an existing package/linker.

Reuse the loaded export fixture. File search and existing CreatePackage are
explicit leaves; filename parsing and the second loader scan run unchanged.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec=importlib.util.spec_from_file_location('loaded',Path(__file__).with_name('native-static-load-object-oracle.py'))
loaded=importlib.util.module_from_spec(spec)
spec.loader.exec_module(loaded)


class Probe(loaded.StaticLoadProbe):
    def __init__(self,root):
        super().__init__(root)
        self._patch_service(0x10102e87,'appFindPackageFile',b'\xc3')
        self._patch_service(0x10101b9f,'appStrchr',b'\xc3')
        self._patch_service(0x10101ccb,'CreatePackage',b'\xc3')
        self.filename_text='..\\System\\DeusExConText.u'
        self.filename=self._write_utf16(self.filename_text)
        self.labels[self.filename]=self.filename_text

    def _service(self,cpu,address):
        service=self.services[address]
        stack=cpu.reg_read(loaded.UC_X86_REG_ESP)
        if service=='ResolveName':
            outer,name,create,throw=self.read(stack+4,'4I')
            if self.read(outer,'I')[0] or self._utf16(self.read(name,'I')[0])!='Mission00':
                raise RuntimeError('Unexpected filename ResolveName input')
            self.events.append({'op':'ResolveName','outer':None,'name':'Mission00','create':create,'throw':throw})
            cpu.reg_write(loaded.UC_X86_REG_EAX,1)
        elif service=='appFindPackageFile':
            source,guid,dest=self.read(stack+4,'3I')
            text=self._utf16(source)
            if text!=self.filename_text or guid:
                raise RuntimeError('Unexpected file search input')
            self.cpu.mem_write(dest,text.encode('utf-16-le')+b'\0\0')
            self.events.append({'op':service,'filename':text,'guid':None,'found':True})
            cpu.reg_write(loaded.UC_X86_REG_EAX,1)
        elif service=='appStrchr':
            source,char=self.read(stack+4,'2I')
            text=self._utf16(source)
            index=text.find(chr(char))
            self.events.append({'op':service,'text':text,'char':chr(char),'index':index})
            cpu.reg_write(loaded.UC_X86_REG_EAX,0 if index<0 else source+2*index)
        elif service=='CreatePackage':
            outer,name=self.read(stack+4,'2I')
            text=self._utf16(name)
            if outer or text!='DeusExConText':
                raise RuntimeError('Unexpected package stem')
            self.events.append({'op':service,'outer':None,'name':text})
            cpu.reg_write(loaded.UC_X86_REG_EAX,self.package)
        else:
            return super()._service(cpu,address)

    def run_filename(self):
        result=self.call(loaded.STATIC_LOAD_OBJECT,0,struct.pack('<6I',
          self.conversation_list_class,0,self.name_pointer,self.filename,2,0))
        if result!=self.loaded_object:
            raise RuntimeError('Wrong filename loaded object')
        return {'result':self._label(result),'events':self.events,'nest':self.read(loaded.G_LOAD_NEST,'I')[0]}


probe=Probe(Path(sys.argv[1]))
print(json.dumps(probe.run_filename()))
