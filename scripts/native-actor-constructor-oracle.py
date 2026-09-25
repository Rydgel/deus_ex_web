"""Execute every original native Actor-class InternalConstructor.

UClass::Bind copies the nearest native ancestor's ClassConstructor (+0x4e0)
down to a script-only class, so SpawnActor's construction of any class runs
one of these bodies (docs/script-spawn.md, docs/script-construction.md).
StaticAllocateObject has already copied the class template into the object
before the constructor runs; a constructor is therefore observable only
through the bytes it writes.

For each requested class this probe fills an instance-sized buffer with a
pattern, calls the registered InternalConstructor with the buffer as its
stack argument (the window-construction oracle's convention), and records
every write inside the buffer plus every exported function the body enters.
It reports the final vtable at +0 and that vtable's +0x2c slot (the native
IsPendingKill predicate). Core.dll, Engine.dll, DeusEx.dll, Extension.dll,
ConSys.dll and MSVCRT.dll are hash-checked GOTY images; Extension and ConSys
are rebased so the images fit one address space. Unknown imports fail.
The player cases additionally use a documented post-name-init fixture, a
log sink and a symbolic FlagBase allocation boundary (docs/script-spawn.md).

Input (stdin): JSON [{"key", "dll", "internalCtor", "instanceSize"}] with
unrebased addresses. Output (stdout): JSON results in the same order.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_MEM_WRITE
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_EAX, UC_X86_REG_EIP, UC_X86_REG_ESP

_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)

IMAGES = {
    'DeusEx.dll': {'hash': 'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04', 'base': 0x10000000},
    'Extension.dll': {'hash': '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c', 'base': 0x12000000},
    'ConSys.dll': {'hash': 'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa', 'base': 0x13000000},
    'MSVCRT.dll': {'hash': 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210', 'base': 0x78000000},
}
PREFERRED = {'core.dll': 0x10100000, 'engine.dll': 0x10300000, 'deusex.dll': 0x10000000,
             'extension.dll': 0x10000000, 'consys.dll': 0x10000000}
PATTERN = 0xa5


class ActorConstructorProbe(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), IMAGES)
        self.object = None
        self.size = 0
        self.writes = []
        self.entered = []
        self.allocations = []
        self.logs = []
        self.symbols = {}
        for name, spec in {**_NATIVE.HASHES, **IMAGES}.items():
            image = _NATIVE.Image(Path(root) / 'System' / name,
                                  spec if isinstance(spec, str) else spec['hash'],
                                  rebase=None if isinstance(spec, str) else spec['base'])
            for symbol, address in image.exports().items():
                self.symbols[address] = f'{name}!{symbol}'
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)
        # Explicit post-Extension-name-initialization fixture. 0x10022a80
        # only interns global event names, then clears this guard at
        # 0x10022eb4. It never writes an actor. The raw DLL starts before
        # FName::StaticInit, so running it there produces a diagnostic rather
        # than a constructor result. Names are not consumed by these bodies.
        self.write(0x12097cb0, 'I', 0)
        # FOutputDevice::Logf and MSVCRT formatting execute unchanged; only
        # the external log sink is supplied. Its Serialize virtual is void.
        log = self.alloc(32)
        self.log_sink = log + 8
        self.write(log, 'II', log + 4, self.log_sink)
        self.cpu.mem_write(self.log_sink, b'\xc2\x08\x00')
        self.write(0x101a7c34, 'I', log)

    def wstring(self, address):
        result = bytearray()
        for i in range(4096):
            char = bytes(self.cpu.mem_read(address + i * 2, 2))
            if char == b'\0\0':
                return result.decode('utf-16le')
            result.extend(char)
        raise RuntimeError('Unterminated oracle string')

    def on_write(self, cpu, access, address, size, value, data):
        if self.object is not None and self.object <= address < self.object + self.size:
            self.writes.append((address - self.object, size, value & 0xffffffff))

    def on_instruction(self, cpu, address, size, data):
        if address == self.log_sink:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            text, event = self.read(stack + 4, 'II')
            self.logs.append({'text': self.wstring(text), 'event': event})
        if address == 0x10102ec3 and self.object is not None:
            # Isolate StaticAllocateObject: assert the exact original call
            # tuple, provide a zeroed template buffer, then let the original
            # XFlagBase constructor run. This is a call-boundary oracle,
            # not a replacement model of UObject allocation/registration.
            stack = cpu.reg_read(UC_X86_REG_ESP)
            args = self.read(stack + 4, '7I')
            if args != (0x1209dbe8, self.object, 0, 0, 0, self.read(0x101a7c38, 'I')[0], 0):
                raise RuntimeError(f'Unexpected constructor allocation {args}')
            flagbase = self.alloc(0x12c)
            self.cpu.mem_write(flagbase, bytes(0x12c))
            self.allocations.append({'address': flagbase, 'class': 'Extension.FlagBase',
                                     'outerOffset': 0, 'size': 0x12c})
            cpu.reg_write(UC_X86_REG_EAX, flagbase)
            cpu.reg_write(UC_X86_REG_EIP, self.read(stack, 'I')[0])
            cpu.reg_write(UC_X86_REG_ESP, stack + 4)
            return
        symbol = self.symbols.get(address)
        if symbol is not None and self.object is not None:
            this = cpu.reg_read(UC_X86_REG_ECX)
            self.entered.append({'symbol': symbol,
                                 'this': this - self.object if self.object <= this < self.object + self.size else None})
        return super().on_instruction(cpu, address, size, data)

    def follow(self, address):
        """Follow incremental-link `jmp rel32` and import `jmp [IAT]` thunks to the body."""
        for _ in range(8):
            code = bytes(self.cpu.mem_read(address, 6))
            if code[0] == 0xe9:
                address = (address + 5 + struct.unpack('<i', code[1:5])[0]) & 0xffffffff
            elif code[:2] == b'\xff\x25':
                address = self.read(struct.unpack('<I', code[2:6])[0], 'I')[0]
            else:
                return address
        raise RuntimeError(f'Thunk chain too long at {address:x}')

    def construct(self, dll, internal, size, null_flagbase=False):
        delta = IMAGES.get(dll, {}).get('base', PREFERRED[dll.lower()]) - PREFERRED[dll.lower()]
        self.object = self.alloc(size)
        self.size = size
        self.cpu.mem_write(self.object, bytes([PATTERN]) * size)
        if null_flagbase:
            self.write(self.object + 0x890, 'I', 0)
        self.writes = []
        self.entered = []
        self.allocations = []
        self.logs = []
        self.call(internal + delta, 0, struct.pack('<I', self.object))
        vtable = self.read(self.object, 'I')[0]
        members = {}
        for offset, width, value in self.writes:
            if offset == 0 and width == 4:
                continue
            for byte in range(offset, offset + width):
                members[byte] = self.read(self.object + byte, 'B')[0]
        vtable_stores = [value for offset, width, value in self.writes if offset == 0 and width == 4]
        slot = self.read(vtable + 0x2c, 'I')[0]
        return {
            'vtable': vtable,
            'vtableStores': vtable_stores,
            'pendingKillSlot': slot,
            'pendingKillBody': self.follow(slot),
            'memberBytes': [[offset, value] for offset, value in sorted(members.items())],
            'entered': self.entered,
            'logs': self.logs,
            'allocations': [{**allocation, 'vtable': self.read(allocation['address'], 'I')[0],
                             'tail': self.read(allocation['address'] + 0x128, 'I')[0]}
                            for allocation in self.allocations],
        }


def main():
    root = sys.argv[1]
    requests = json.load(sys.stdin)
    probe = ActorConstructorProbe(root)
    results = []
    for request in requests:
        try:
            result = probe.construct(request['dll'], request['internalCtor'], request['instanceSize'])
            if request['key'] in ('deusex.deusexplayer', 'extension.playerpawnext'):
                null_result = probe.construct(request['dll'], request['internalCtor'], request['instanceSize'], True)
                result['nullFlagBaseCase'] = null_result
        except Exception as error:  # a body that needs an unresolved import stays reported, not guessed
            result = {'error': str(error)[:400]}
        results.append({'key': request['key'], **result})
    json.dump(results, sys.stdout)


if __name__ == '__main__':
    main()
