"""Execute original ULodMesh::Serialize from the GOTY Engine.dll in an isolated
x86 emulator against real serialized mesh exports.

Optional research tool, never imported by the browser. Establishes the GOTY
LodMesh serialized layout from the original native code; see
docs/lodmesh-serialization.md. The fake loading FArchive (version 68) is
implemented in Python: raw Serialize transfers, Tell/Seek, AttachLazyLoader,
FName/UObject compact reads and FMalloc::Realloc are supplied by this driver,
so every byte the original code consumes is recorded as
(archive offset -> mesh field offset, length, bytes).
"""
import base64
import json
import struct
import subprocess
import sys
from collections import deque
from pathlib import Path

import importlib.util as _ilu
import os


def _load(name, path):
    spec = _ilu.spec_from_file_location(name, path)
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_native = _load('native_collision_oracle', str(Path(__file__).parent / 'native-collision-oracle.py'))
NativeCollision = _native.NativeCollision

from unicorn import UC_HOOK_MEM_WRITE  # noqa: E402
from unicorn.x86_const import *  # noqa: E402,F403

REPO = Path(__file__).resolve().parents[1]
GAME_ROOT = Path(__file__).resolve().parents[1] / 'Deus Ex GOTY Edition'

MESH_BASE = 0x73000000
MESH_OFFSET = 0x100
AR_OBJ = 0x72000200
STUB_BASE = 0x71000000
FAKE_VT_BASE = 0x71500000

# Engine IAT slots and Core addresses used by the mesh serializers.
IAT_UBOBJECT_SERIALIZE = 0x10599b10  # Core UObject::Serialize (Engine IAT)
CORE_GMALLOC_PTR = 0x101a7c44        # Core ?GMalloc@@3PAVFMalloc@@A
CORE_GLAZYLOAD = 0x10599cc0          # Engine IAT -> Core ?GLazyLoad@@3HA
ARRAY_OFFSETS = (0x54, 0x6c, 0x84, 0x90, 0xa8, 0xb4, 0xc0, 0xd8)


class LodMeshProbe(NativeCollision):
    """Runs ULodMesh::Serialize(ULodMesh*, FArchive&) with faked archive."""

    GMALLOC = 0x71600000
    GMALLOC_VT = 0x71600100

    def __init__(self, game_root=GAME_ROOT):
        super().__init__(game_root)
        self.cpu.mem_map(0x71000000, 0x5000000)
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)
        self.slot_hits = []
        self.lazy_marks = []
        self._trace = []
        self.trace = deque(maxlen=200)
        self.transfers = []
        self.buffer = b''
        self.serial_offset = 0
        self.pos = 0
        for slot in range(64):
            self.write(FAKE_VT_BASE + slot * 4, 'I', STUB_BASE + slot * 16)
            self.cpu.mem_write(STUB_BASE + slot * 16, b'\xcc')
        self.cpu.mem_write(STUB_BASE + 0xf00, b'\xcc')  # UObject::Serialize stub

    def init_gmalloc(self):
        self.cpu.mem_write(self.GMALLOC, b'\x00' * 0x400)
        for i in range(8):
            self.write(self.GMALLOC_VT + i * 4, 'I', STUB_BASE + (0x300 + i) * 16)
            self.cpu.mem_write(STUB_BASE + (0x300 + i) * 16, b'\xcc')
        self.write(self.GMALLOC, 'I', self.GMALLOC_VT)
        self.write(CORE_GMALLOC_PTR, 'I', self.GMALLOC)

    def run(self, payload, version=68, serial_offset=0):
        """Serialize `payload` (the full export bytes, tagged prefix included)."""
        self.init_gmalloc()
        self.buffer = bytearray(payload)
        self.serial_offset = serial_offset
        self.pos = serial_offset
        self.slot_hits = []
        self.transfers = []
        self._trace = []
        # Fake FArchive: vtable + fields (Ver, flags, loader).
        self.write(AR_OBJ + 0, 'I', FAKE_VT_BASE)
        self.write(AR_OBJ + 4, 'I', version)
        self.write(AR_OBJ + 8, 'I', 0)
        self.write(AR_OBJ + 0xc, 'I', 1)   # bulk loading path
        self.write(AR_OBJ + 0x10, 'I', 0)  # no lazy loader attached
        self.write(AR_OBJ + 0x14, 'I', 0)
        # Zeroed mesh object with stub vtables; every array field gets one too.
        self.cpu.mem_write(MESH_BASE + MESH_OFFSET, b'\x00' * 0x400)
        self.write(MESH_BASE + MESH_OFFSET, 'I', MESH_BASE)
        self.cpu.mem_write(STUB_BASE + 0x1000, b'\xcc' * 256)
        self.cpu.mem_write(STUB_BASE + 0x2000, b''.join(
            struct.pack('<I', STUB_BASE + (0x100 + i) * 16) for i in range(16)))
        for off in ARRAY_OFFSETS:
            self.write(MESH_BASE + MESH_OFFSET + off, 'I', STUB_BASE + 0x2000)
        # Stub UObject::Serialize: consume the tagged prefix with the
        # repo-verified tagged-property format.
        self.cpu.mem_write(IAT_UBOBJECT_SERIALIZE, struct.pack('<I', STUB_BASE + 0xf00))
        self.cpu.mem_write(STUB_BASE + 0xf00, b'\xcc')
        self.write(CORE_GLAZYLOAD, 'I', self.alloc(8))
        self.cpu.mem_write(CORE_GLAZYLOAD, b'\x00\x00\x00\x00')
        try:
            return self.call(0x10354ab0, MESH_BASE + MESH_OFFSET, struct.pack('<I', AR_OBJ))
        except Exception:
            raise

    def _read_compact(self):
        # UE1 FCompactIndex: sign + continuation + 6 payload bits in byte 0,
        # then 7+7+7+5 payload bits. This is the exact representation consumed
        # by the original linker's FName/FCompactIndex archive operators.
        local = self.pos - self.serial_offset
        first = self.buffer[local]
        self.pos += 1
        negative = bool(first & 0x80)
        value = first & 0x3f
        more = bool(first & 0x40)
        index = 1
        while more:
            local = self.pos - self.serial_offset
            byte = self.buffer[local]
            self.pos += 1
            if index == 4 and byte > 0x1f:
                raise RuntimeError('FCompactIndex overflow')
            mask = 0x1f if index == 4 else 0x7f
            value += (byte & mask) << (6 + (index - 1) * 7)
            more = index < 4 and bool(byte & 0x80)
            index += 1
        if value > (0x80000000 if negative else 0x7fffffff):
            raise RuntimeError('FCompactIndex exceeds signed 32-bit range')
        return -value if negative and value else value

    def on_write(self, cpu, access, address, size, value, data):
        if os.environ.get('DEUS_EX_LODMESH_TRACE') and 0x73000150 <= address < 0x730001a0:
            print(f'WRITE {address:#x} size={size} val={value:#x} '
                  f'eip={cpu.reg_read(UC_X86_REG_EIP):#x}', file=sys.stderr)

    def on_bad_memory(self, cpu, access, address, size, value, data):
        print(f'BAD {address:#x} eip={cpu.reg_read(UC_X86_REG_EIP):#x}', file=sys.stderr)
        raise RuntimeError(f'Invalid memory {address:x}')

    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if STUB_BASE <= address < STUB_BASE + 64 * 16:
            self.handle_stub(cpu, (address - STUB_BASE) // 16)
            return
        if STUB_BASE + 0x3000 <= address < STUB_BASE + 0x3400:
            self.handle_gmalloc(cpu, (address - STUB_BASE - 0x3000) // 16)
            return
        if STUB_BASE + 0x1000 <= address < STUB_BASE + 0x2400:
            self.handle_array_virtual(cpu)
            return
        if address == STUB_BASE + 0xf00:
            self.handle_uobject_serialize(cpu)
            return
        if address in self.thunks:
            raise RuntimeError(f'Unresolved import {self.thunks[address]}; trace {list(self.trace)}')
        self.trace.append(hex(address))

    def _return(self, cpu, stack_bytes, value=None):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = struct.unpack('<I', cpu.mem_read(esp, 4))[0]
        if value is not None:
            cpu.reg_write(UC_X86_REG_EAX, value)
        cpu.reg_write(UC_X86_REG_EIP, ret)
        cpu.reg_write(UC_X86_REG_ESP, esp + stack_bytes)

    def handle_stub(self, cpu, slot):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = struct.unpack('<I', cpu.mem_read(esp, 4))[0]
        args = struct.unpack('<8I', cpu.mem_read(esp + 4, 32))
        self.slot_hits.append((slot, hex(ret), args[:2]))
        if slot == 1:
            data_addr, length = args[0], args[1]
            if length < 0 or length > 0x10000:
                raise RuntimeError(f'Bogus serialize length {length}')
            local = self.pos - self.serial_offset
            chunk = bytes(self.buffer[local:local + length])
            if len(chunk) < length:
                raise RuntimeError(f'Ran out of payload at {local} wanting {length}')
            cpu.mem_write(data_addr, chunk)
            self.transfers.append((local, data_addr - (MESH_BASE + MESH_OFFSET), length, chunk.hex()))
            self.pos += length
            self._return(cpu, 12, 0)
            return
        if slot == 5:
            # FArchive::CountBytes(INT, INT): diagnostic, no stream effect.
            self._return(cpu, 12, 0)
            return
        if slot == 6:
            index = self._read_compact()
            self.slot_hits.append(('objref', index))
            cpu.mem_write(args[0], struct.pack('<I', index))
            self._return(cpu, 8, cpu.reg_read(UC_X86_REG_ECX))
            return
        if slot == 7:
            index = self._read_compact()
            self.slot_hits.append(('fname', index))
            cpu.mem_write(args[0], struct.pack('<I', index))
            self._return(cpu, 8, cpu.reg_read(UC_X86_REG_ECX))
            return
        if slot == 10:
            self._return(cpu, 4, self.pos)
            return
        if slot == 13:
            target = args[0] & 0xffffffff
            self.slot_hits.append(('seek', self.pos - self.serial_offset, target - self.serial_offset))
            self.pos = target
            self._return(cpu, 8)
            return
        if slot == 14:
            # AttachLazyLoader(FLazyLoader*): base impl is a no-op.
            self.slot_hits.append(('attach', self.pos - self.serial_offset, args[0]))
            self._return(cpu, 8)
            return
        raise RuntimeError(f'FArchive slot {slot} called from {hex(ret)}; implement me')

    def handle_gmalloc(self, cpu, slot):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = struct.unpack('<I', cpu.mem_read(esp, 4))[0]
        args = struct.unpack('<4I', cpu.mem_read(esp + 4, 16))
        if slot == 1:
            size = args[1]
            ptr = self.alloc(max(size, 16))
            self.cpu.mem_write(ptr, b'\x00' * max(size, 16))
            self.slot_hits.append(('gmalloc-realloc', hex(args[0]), size, hex(ptr)))
            cpu.reg_write(UC_X86_REG_EAX, ptr)
        else:
            cpu.reg_write(UC_X86_REG_EAX, 0)
        cpu.reg_write(UC_X86_REG_EIP, ret)
        cpu.reg_write(UC_X86_REG_ESP, esp + 16)

    def handle_array_virtual(self, cpu):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = struct.unpack('<I', cpu.mem_read(esp, 4))[0]
        self.slot_hits.append(('arrayvt', hex(cpu.reg_read(UC_X86_REG_ECX))))
        cpu.reg_write(UC_X86_REG_EIP, ret)
        cpu.reg_write(UC_X86_REG_ESP, esp + 4)

    def handle_uobject_serialize(self, cpu):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = struct.unpack('<I', cpu.mem_read(esp, 4))[0]
        # Tagged property stream: compact name index; 0 == None terminates.
        # Non-empty entries: info byte, optional struct name, size, data.
        while True:
            index = self._read_compact()
            if index == 0:
                break
            info = self.buffer[self.pos - self.serial_offset]
            self.pos += 1
            type_code = info & 15
            size_code = (info >> 4) & 7
            if type_code == 10:
                self._read_compact()
            if size_code_of(info) < 5:
                size = [1, 2, 4, 12, 16][size_code_of(info)]
            elif size_code_of(info) == 5:
                size = self.buffer[self.pos - self.serial_offset]
                self.pos += 1
            elif size_code_of(info) == 6:
                size = struct.unpack('<H', self.buffer[self.pos - 2 - self.serial_offset:self.pos - self.serial_offset])[0]
                self.pos += 2
            else:
                size = struct.unpack('<I', self.buffer[self.pos - 4 - self.serial_offset:self.pos - self.serial_offset])[0]
                self.pos += 4
            if type_code == 3:
                size = 0
            self.pos += size
        cpu.reg_write(UC_X86_REG_EIP, ret)
        cpu.reg_write(UC_X86_REG_ESP, esp + 8)


def size_code_of(info):
    return (info >> 4) & 7


def load_export(index, package='DeusExDeco'):
    out = subprocess.run(['node', '-e', f'''
      import('./src/unreal/package.mjs').then(async ({{parsePackage}}) => {{
        const fs = await import('node:fs/promises');
        const buf = await fs.readFile('Deus Ex GOTY Edition/System/{package}.u');
        const pkg = parsePackage(buf);
        const e = pkg.exports[{index}];
        console.log(JSON.stringify({{name: e.name, serialSize: e.serialSize, serialOffset: e.serialOffset, bytes: Buffer.from(buf.subarray(e.serialOffset, e.serialOffset + e.serialSize)).toString('base64')}}));
      }});
    '''], capture_output=True, text=True, cwd=REPO)
    return json.loads(out.stdout)


def report(probe, label):
    print(f'{label}: returned, consumed local {probe.pos - probe.serial_offset} of {len(probe.buffer)}')
    base = MESH_BASE + MESH_OFFSET
    data_ptr, count, _ = probe.read(base + 0x84, '3I')
    if count and count <= 64:
        for i in range(count):
            e = data_ptr + i * 0x20
            name, group, start, frames, rate = probe.read(e, '5I')
            print(f'  seq{i}: name {name} group {group} start {start} '
                  f'frames {frames} rate {rate:#x}')


def main():
    selections = sys.argv[1:] or [f'DeusExDeco:{index}' for index in (605, 398, 399, 453, 498, 400)]
    for selection in selections:
        if ':' in selection:
            package, raw_index = selection.split(':', 1)
        else:
            package, raw_index = 'DeusExDeco', selection
        index0 = int(raw_index)
        info = load_export(index0, package)
        payload = base64.b64decode(info['bytes'])
        probe = LodMeshProbe()
        try:
            probe.run(payload, serial_offset=info['serialOffset'])
            report(probe, info['name'])
        except Exception as error:
            print(f"{info['name']}: FAILED {type(error).__name__}: {error}")


if __name__ == '__main__':
    main()
