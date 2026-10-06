"""Execute original UModel collision functions in an isolated x86 emulator.

Optional research tool, never imported by the browser. Inputs, DLLs, and results
stay local. Only the two hash-verified GOTY DLLs below are supported. Unknown
imports and invalid memory access fail instead of supplying guessed behavior.
Install unicorn==2.1.4 in a virtualenv; see docs/movement.md for the driver.
"""
from collections import deque
import hashlib
import json
from pathlib import Path
import struct
import sys

try:
    from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_CODE, UC_HOOK_MEM_INVALID
    from unicorn.x86_const import (
        UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP,
        UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG,
    )
except ImportError:
    sys.exit('Install unicorn==2.1.4 in a virtualenv and set NATIVE_PROBE_PYTHON to its Python executable.')

def render_control_word(default=0x037f):
    """The x87 control word for an oracle's render-pass segments.

    URender::PreRender sets precision control 24 (0x007f) until PostRender
    (docs/render-pass-precision.md). An oracle passes its own default; the
    ORACLE_CW environment variable (the precision audit, set by validators
    through scripts/precision-audit.mjs) overrides it."""
    import os
    value = os.environ.get('ORACLE_CW')
    return int(value, 0) if value else default


HASHES = {
    'Engine.dll': '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
    'Core.dll': '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
}


class Image:
    def __init__(self, path, expected_hash=None, rebase=None):
        self.data = data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != (expected_hash or HASHES[path.name]):
            raise ValueError(f'Unsupported original binary hash: {path.name}')
        pe = struct.unpack_from('<I', data, 60)[0]
        opt = pe + 24
        self.base = struct.unpack_from('<I', data, opt + 28)[0]
        self.size = struct.unpack_from('<I', data, opt + 56)[0]
        self.directories = [struct.unpack_from('<II', data, opt + 96 + i * 8) for i in range(16)]
        section = opt + struct.unpack_from('<H', data, pe + 20)[0]
        count = struct.unpack_from('<H', data, pe + 6)[0]
        self.sections = [struct.unpack_from('<8sIIII', data, section + i * 40) for i in range(count)]
        if rebase is not None and rebase != self.base:
            self.rebase(rebase)

    def rebase(self, new_base):
        """Apply the PE .reloc fixups and change this image's preferred base."""
        delta = (new_base - self.base) & 0xffffffff
        rva, size = self.directories[5]
        if not rva or size < 8:
            raise ValueError('Image has no relocation table and cannot be rebased')
        buf = bytearray(self.data)
        end = rva + size
        page = rva
        while page < end:
            block_rva, block_size = struct.unpack_from('<II', buf, self.offset(page))
            if block_size < 8:
                break
            for entry_rva in range(page + 8, page + block_size, 2):
                entry = struct.unpack_from('<H', buf, self.offset(entry_rva))[0]
                if entry >> 12 == 3:  # IMAGE_REL_BASED_HIGHLOW
                    target = block_rva + (entry & 0xfff)
                    offset = self.offset(target)
                    value = struct.unpack_from('<I', buf, offset)[0]
                    struct.pack_into('<I', buf, offset, (value + delta) & 0xffffffff)
            page += block_size
        self.data = bytes(buf)
        self.base = new_base

    def offset(self, rva):
        for _, virtual_size, virtual, raw_size, raw in self.sections:
            if virtual <= rva < virtual + max(virtual_size, raw_size):
                return raw + rva - virtual
        return rva

    def read(self, rva, fmt):
        return struct.unpack_from('<' + fmt, self.data, self.offset(rva))

    def string(self, rva):
        offset = self.offset(rva)
        return self.data[offset:self.data.index(0, offset)].decode('ascii')

    def exports(self):
        table = self.directories[0][0]
        count, functions, names, ordinals = self.read(table + 24, 'IIII')
        return {
            self.string(self.read(names + i * 4, 'I')[0]):
            self.base + self.read(functions + self.read(ordinals + i * 2, 'H')[0] * 4, 'I')[0]
            for i in range(count)
        }

    def imports(self):
        descriptor = self.directories[1][0]
        while True:
            original, _, _, name, iat = self.read(descriptor, 'IIIII')
            if not name:
                return
            index = 0
            while True:
                entry = self.read((original or iat) + index * 4, 'I')[0]
                if not entry:
                    break
                symbol = entry & 0xffff if entry & 0x80000000 else self.string(entry + 2)
                yield self.string(name).lower(), symbol, self.base + iat + index * 4
                index += 1
            descriptor += 20


class NativeCollision:
    def __init__(self, game_root, additional_hashes=None):
        self.cpu = cpu = Uc(UC_ARCH_X86, UC_MODE_32)
        self.thunks = {}
        self.trace = deque(maxlen=20)
        extra = additional_hashes or {}
        if extra.keys() & HASHES.keys():
            raise ValueError('Additional images must not override the original Engine/Core hashes')
        images = {}
        for name, spec in (HASHES | extra).items():
            rebase = None
            if isinstance(spec, dict):
                rebase = spec.get('base')
                spec = spec['hash']
            images[name.lower()] = Image(game_root / 'System' / name, spec, rebase=rebase)
        for image in images.values():
            cpu.mem_map(image.base, (image.size + 4095) & ~4095)
            cpu.mem_write(image.base, image.data[:1024])
            for _, _, virtual, size, raw in image.sections:
                if size:
                    cpu.mem_write(image.base + virtual, image.data[raw:raw + size])
        cpu.mem_map(0, 0x10000)  # FS exception chain used by original function prologues.
        cpu.mem_map(0x70000000, 0x100000)
        cpu.mem_map(0x20000000, 0x4000000)
        self.free = 0x20000000
        self.stack = 0x23ff0000
        self.done = 0x700ff000
        exports = {name: image.exports() for name, image in images.items()}
        thunk = 0x70000000
        for image in images.values():
            for dll, symbol, iat in image.imports():
                address = exports.get(dll, {}).get(symbol)
                if address is None:
                    address = thunk
                    thunk += 16
                    self.thunks[address] = (dll, symbol)
                self.write(iat, 'I', address)
                if dll == 'msvcrt.dll' and symbol == '_ftol' and address in self.thunks:
                    # The sole external bridge: MSVC's x87 truncation to int64
                    # in EDX:EAX. All collision/math code executes from the DLLs.
                    cpu.mem_write(address, bytes.fromhex('83 ec 08 dd 0c 24 58 5a c3'))
                    self.thunks.pop(address)
        self.code_hook = cpu.hook_add(UC_HOOK_CODE, self.on_instruction)
        cpu.hook_add(UC_HOOK_MEM_INVALID, self.on_bad_memory)
        # UnitCoords, normally initialized by Core's process startup constructor.
        gmath = exports['core.dll']['?GMath@@3VFGlobalMath@@A']
        self.write(gmath + 24, '12f', 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)

    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address in self.thunks:
            raise RuntimeError(f'Unresolved import {self.thunks[address]}; trace {list(self.trace)}')
        self.trace.append(hex(address))

    def on_bad_memory(self, cpu, access, address, size, value, data):
        raise RuntimeError(f'Invalid memory {address:x}; trace {list(self.trace)}')

    def alloc(self, size):
        address = self.free
        self.free += (size + 15) & ~15
        if self.free >= 0x23000000:
            raise MemoryError('Native probe allocation limit exceeded')
        return address

    def write(self, address, fmt, *values):
        self.cpu.mem_write(address, struct.pack('<' + fmt, *values))

    def read(self, address, fmt):
        return struct.unpack('<' + fmt, self.cpu.mem_read(address, struct.calcsize('<' + fmt)))

    # The x87 control word of each call. 0x037f (64-bit precision) is the
    # established word of the game-thread translations; render-pass oracles
    # set 0x007f, URender::PreRender's precision control 24
    # (docs/render-pass-precision.md).
    control_word = 0x037f

    def call(self, address, this, args):
        for reg, value in [(UC_X86_REG_ESP, self.stack), (UC_X86_REG_ECX, this),
                           (UC_X86_REG_FPCW, self.control_word), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        self.write(self.stack, 'I', self.done)
        self.cpu.mem_write(self.stack + 4, args)
        self.cpu.emu_start(address, self.done + 1, count=4000000)
        if self.cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise RuntimeError('Native instruction budget exceeded')
        return self.cpu.reg_read(UC_X86_REG_EAX)

    def model(self, model):
        address = self.alloc(0x100)
        nodes = self.alloc(64 * len(model['nodes']))
        hulls = self.alloc(4 * len(model['leafHulls']))
        for i, node in enumerate(model['nodes']):
            p = nodes + 64 * i
            if 'planeBits' in node:
                self.write(p, '4I', *node['planeBits'])
            else:
                self.write(p, '4f', *node['plane'])
            self.write(p + 16, 'II', *node['zoneMask'])
            self.write(p + 24, '7i', node['vertexPool'], node['surface'], node['back'], node['front'],
                       node['coplanar'], node['collisionBound'], node['renderBound'])
            self.write(p + 52, '4B', *node['zones'], node['vertexCount'], node['flags'])
            self.write(p + 56, '2i', *node['leaves'])
        self.write(address + 0x58, 'III', nodes, len(model['nodes']), len(model['nodes']))
        self.write(hulls, str(len(model['leafHulls'])) + 'i', *model['leafHulls'])
        self.write(address + 0xcc, 'III', hulls, len(model['leafHulls']), len(model['leafHulls']))
        self.write(address + 0xf0, 'I', model['rootOutside'])
        return address

    def result(self, clear, hit):
        return {'outside': bool(clear), 'location': self.read(hit + 8, '3f'),
                'normal': self.read(hit + 20, '3f'), 'time': self.read(hit + 36, 'f')[0]}

    def point(self, model, position, extent):
        hit = self.alloc(48)
        clear = self.call(0x103f1570, model, struct.pack('<II6fI', hit, 0, *position, *extent, 0))
        return self.result(clear, hit)

    def line(self, model, start, end, extent, extra_node_flags=0):
        hit = self.alloc(48)
        self.write(hit + 36, 'f', 1)
        clear = self.call(0x103f3c20, model, struct.pack('<II9fI', hit, 0, *end, *start, *extent, extra_node_flags))
        return self.result(clear, hit)


def main():
    if len(sys.argv) != 4:
        sys.exit('Usage: native-collision-oracle.py GAME_ROOT MODEL_JSON CASES_JSON')
    native = NativeCollision(Path(sys.argv[1]))
    model = native.model(json.loads(Path(sys.argv[2]).read_text()))
    results = []
    for case in json.loads(Path(sys.argv[3]).read_text()):
        end = [a + b for a, b in zip(case['start'], case['delta'])]
        results.append({'line': native.line(model, case['start'], end, case['extent'], case.get('extraNodeFlags', 0)),
                        'point': native.point(model, case['start'], case['extent'])})
    print(json.dumps({'hashes': HASHES, 'results': results}))


if __name__ == '__main__':
    main()
