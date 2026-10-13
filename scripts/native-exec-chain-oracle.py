"""Trace the fall-through order of original console-command Exec bodies.

Optional research tool, never imported by the browser. Each hash-pinned body
runs unchanged in an isolated x86 emulator. Every call it makes is stubbed at
the call edge and returns 0, so the body takes the path of a command nothing
claims. Memory it reads through `this`, imported globals or loaded pointers is
symbolic: each dword it loads is a fresh object pointer with a recorded path.
The printed steps are the body's real order of keyword tests, subsystem calls
and object dispatches. A call site's name comes from the DLL's import/export
tables; a virtual call's target is its symbolic load path.

Usage: python scripts/native-exec-chain-oracle.py GAME_DIR [body ...] > trace.json
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys

try:
    from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_CODE, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE, UC_HOOK_MEM_INVALID
    from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP
except ImportError:
    sys.exit('Install unicorn==2.1.4 in a virtualenv and set NATIVE_PROBE_PYTHON to its Python executable.')

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('native_collision', HERE / 'native-collision-oracle.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

HASHES = {
    'Core.dll': '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
    'Engine.dll': '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
    'WinDrv.dll': '9cf2861ca66dabf21db97e44e328aa0a42d85289a35dbad090271c0611f94e1f',
    'DeusEx.dll': 'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04',
    'Extension.dll': '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
    'Render.dll': '607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1',
    'Galaxy.dll': '606e71d13bbd3c4db2460aabcf60d87b1c79bb49d77725cf9e087513c7d06353',
    'GlideDrv.dll': '50b9f142700ca928ea688e7cce34d3064d39ccbe0b5056c826b413bd842cfe4c',
    'D3DDrv.dll': '9e0f8a4293de6edb4f88b1ba9972fe98b4e80a1115f9667e57f8ef3d51d8ac9f',
    'DeusEx.exe': '3e6fdb89b880a60ee984b885a48f262070019572f1531ed70d96108781bae00e',
}

# name: (image, body entry or export, arguments). Thunks are followed to the
# body; 'Cmd' is an unclaimed command and 'Ar' a symbolic output device.
CMD = ['Cmd', 'Ar']
BODIES = {
    'UInput::Exec': ('Engine.dll', 0x1030178f, CMD),
    'URenderDevice::Exec': ('Engine.dll', 0x10303819, CMD),
    'UGlideRenderDevice::Exec': ('GlideDrv.dll', 0x107010cd, CMD),
    'UD3DRenderDevice::Exec': ('D3DDrv.dll', 0x100061b0, CMD),
    'UViewport::Exec': ('Engine.dll', 0x1030204a, CMD),
    'UWindowsViewport::Exec': ('WinDrv.dll', 0x1110119a, CMD),
    'UPlayer::Exec': ('Engine.dll', 0x10302cb6, CMD),
    'ULevel::Exec': ('Engine.dll', 0x1030311b, CMD),
    'DDeusExGameEngine::Exec': ('DeusEx.dll', 0x1000ed70, CMD),
    'UGameEngine::Exec': ('Engine.dll', 0x1030196a, CMD),
    'UEngine::Exec': ('Engine.dll', 0x10302270, CMD),
    'USystem::Exec': ('Core.dll', 0x101031e3, CMD),
    'UObject::StaticExec': ('Core.dll', 0x101011a9, CMD),
    'FMemCache::Exec': ('Core.dll', 0x10101aaf, CMD),
    'FExecHook::Exec': ('DeusEx.exe', 0x109010ff, CMD),
    'UWindowsClient::Exec': ('WinDrv.dll', 0x11101140, CMD),
    'UClient::Exec': ('Engine.dll', 0x10303c92, CMD),
    'URender::Exec': ('Render.dll', 0x10b0109b, CMD),
    'UGalaxyAudioSubsystem::Exec': ('Galaxy.dll', 0x1060110e, CMD),
    # Its tail call 0x10601145(Cmd, Ar, 1): a cdecl keyword helper.
    'Galaxy 0x106019b0': ('Galaxy.dll', 0x10601145, CMD + [1]),
    'UEngine::Flush': ('Engine.dll', '?Flush@UEngine@@UAEXH@Z', [1]),
}

# Core flags with a known value in a local single-player client: the launcher
# runs a listen-capable client (GIsClient, GIsServer), never the editor/UCC.
GLOBALS = {'?GIsClient@@3HA': 1, '?GIsServer@@3HA': 1, '?GIsEditor@@3HA': 0, '?GIsUCC@@3HA': 0,
           '?GIsRunning@@3HA': 1, '?GIsScriptable@@3HA': 1}

SYM, SLOT, SLOTS = 0x40000000, 0x2000, 0x3000   # symbolic objects
STACK, STACK_SIZE = 0x3f000000, 0x100000
DONE = 0x3f200000
MAX_DEPTH = 6
COMMAND = 0x3f300000   # the unclaimed command text, "?"


class Tracer:
    def __init__(self, root, image_name):
        self.image = image = native.Image(root / 'System' / image_name, HASHES[image_name])
        self.cpu = cpu = Uc(UC_ARCH_X86, UC_MODE_32)
        cpu.mem_map(image.base, (image.size + 4095) & ~4095)
        cpu.mem_write(image.base, image.data[:1024])
        for _, _, virtual, size, raw in image.sections:
            if size:
                cpu.mem_write(image.base + virtual, image.data[raw:raw + size])
        cpu.mem_map(0, 0x10000)
        cpu.mem_map(STACK, STACK_SIZE)
        cpu.mem_map(DONE, 0x1000)
        cpu.mem_map(COMMAND, 0x1000)
        cpu.mem_write(COMMAND, '?'.encode('utf-16-le') + b'\0\0')
        cpu.mem_map(SYM, SLOT * SLOTS)
        self.paths = ['this']
        self.depth = [0]
        self.known = set()
        self.md = None
        self.exports = {address: name for name, address in image.exports().items()}
        self.imports = {}
        for dll, symbol, iat in image.imports():
            obj = self.new(f'{dll}!{symbol}', 0)
            self.imports[obj] = f'{dll}!{symbol}'
            cpu.mem_write(iat, struct.pack('<I', obj))
            if symbol in GLOBALS:
                cpu.mem_write(obj, struct.pack('<I', GLOBALS[symbol]))
                self.known.add(obj)
        cpu.hook_add(UC_HOOK_MEM_READ, self.on_read, begin=SYM, end=SYM + SLOT * SLOTS - 1)
        cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write, begin=SYM, end=SYM + SLOT * SLOTS - 1)
        cpu.hook_add(UC_HOOK_CODE, self.on_code)
        cpu.hook_add(UC_HOOK_MEM_INVALID, self.on_invalid)

    def new(self, path, depth):
        index = len(self.paths)
        if index >= SLOTS:
            raise MemoryError('Symbolic object limit exceeded')
        self.paths.append(path)
        self.depth.append(depth)
        return SYM + index * SLOT

    def path(self, value):
        if SYM <= value < SYM + SLOT * SLOTS:
            index, offset = divmod(value - SYM, SLOT)
            return self.paths[index] + (f'&{offset:#x}' if offset else '')
        if value == COMMAND:
            return 'Cmd'
        text = self.wide(value)
        if text is not None:
            return repr(text)
        if value in self.exports:
            return self.exports[value]
        return f'{value:#x}'

    def wide(self, value):
        image = self.image
        if not image.base <= value < image.base + image.size:
            return None
        try:
            offset, text = image.offset(value - image.base), ''
            while True:
                char = image.data[offset] | image.data[offset + 1] << 8
                if not char:
                    return text or None
                if not 32 <= char < 127 or len(text) > 96:
                    return None
                text += chr(char)
                offset += 2
        except IndexError:
            return None

    def on_read(self, cpu, access, address, size, value, data):
        base = address & ~3
        if base in self.known:
            return
        self.known.add(base)
        index, offset = divmod(base - SYM, SLOT)
        if self.depth[index] >= MAX_DEPTH:
            return
        child = self.new(f'{self.paths[index]}/{offset:#x}', self.depth[index] + 1)
        cpu.mem_write(base, struct.pack('<I', child))

    def on_write(self, cpu, access, address, size, value, data):
        for base in range(address & ~3, address + size, 4):
            self.known.add(base)

    def on_invalid(self, cpu, access, address, size, value, data):
        raise RuntimeError(f'Invalid memory {address:#x} at {cpu.reg_read(UC_X86_REG_EIP):#x}')

    def on_code(self, cpu, address, size, data):
        if address == DONE:
            cpu.emu_stop()
            return
        if self.pending is not None:
            ret, site = self.pending
            self.pending = None
            if address != ret:
                self.stub(address, site)
                return
        self.last = max(self.last, address)
        opcode = bytes(cpu.mem_read(address, 2))
        if opcode[0] == 0xe8 or (opcode[0] == 0xff and (opcode[1] >> 3) & 7 == 2):
            self.pending = (address + size, address)
        self.count += 1
        if self.count > 200000:
            raise RuntimeError('Instruction budget exceeded')

    def stub(self, target, site):
        cpu = self.cpu
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret, *args = struct.unpack('<5I', cpu.mem_read(esp, 20))
        if SYM <= target < SYM + SLOT * SLOTS and target in self.imports:
            name = self.imports[target]
        else:
            name = self.path(target)
        step = {'site': f'{site:#x}', 'call': name, 'this': self.path(cpu.reg_read(UC_X86_REG_ECX)),
                'args': [self.path(arg) for arg in args]}
        self.steps.append(step)
        cpu.reg_write(UC_X86_REG_EAX, 0)
        cpu.reg_write(UC_X86_REG_ESP, esp + 4)
        cpu.reg_write(UC_X86_REG_EIP, ret)

    def follow(self, address):
        # An exported thunk is a single jmp rel32 to the body.
        first = self.image.data[self.image.offset(address - self.image.base)]
        if first == 0xe9:
            rel = struct.unpack_from('<i', self.image.data, self.image.offset(address - self.image.base) + 1)[0]
            return address + 5 + rel
        return address

    def run(self, entry, args):
        if isinstance(entry, str):
            entry = self.image.exports()[entry]
        body = self.follow(entry)
        self.steps, self.pending, self.count, self.last = [], None, 0, body
        esp = STACK + STACK_SIZE - 0x1000
        frame = [DONE] + [COMMAND if arg == 'Cmd' else self.new(arg, 0) if isinstance(arg, str) else arg for arg in args]
        self.cpu.mem_write(esp, struct.pack(f'<{len(frame)}I', *frame))
        self.cpu.reg_write(UC_X86_REG_ESP, esp)
        self.cpu.reg_write(UC_X86_REG_ECX, SYM)
        self.cpu.emu_start(body, DONE + 1)
        return {'body': f'{body:#x}', 'result': self.cpu.reg_read(UC_X86_REG_EAX), 'steps': self.steps,
                'literals': self.literals(body)}

    def literals(self, body):
        # Every UTF-16 literal the body pushes up to the last instruction it
        # executed (not every image pads functions with int3), so keywords the
        # fall-through path does not test can be reviewed.
        from capstone import Cs, CS_ARCH_X86, CS_MODE_32
        image, out = self.image, []
        start = image.offset(body - image.base)
        end = image.offset(self.last - image.base) + 16
        for insn in Cs(CS_ARCH_X86, CS_MODE_32).disasm(image.data[start:end], body):
            if insn.mnemonic == 'push' and insn.op_str.startswith('0x'):
                text = self.wide(int(insn.op_str, 16))
                if text is not None:
                    out.append(text)
        return out


def main():
    root = Path(sys.argv[1])
    out = {}
    for name in sys.argv[2:] or BODIES:
        image, entry, args = BODIES[name]
        out[name] = Tracer(root, image).run(entry, args)
    json.dump(out, sys.stdout, indent=1)


if __name__ == '__main__':
    main()
