"""Execute the recovered APawn perception natives in an isolated x86 emulator.

Six natives ride on the recovered bodies:

  LineOfSightTo(514)  0x103bce10  -> worker 0x103beb50(Other, 0, bIgnoreDistance)
  CanSee(533)         0x103ba5d0  -> worker 0x103beb50(Other, 1, 0)
  PlayerCanSeeMe(532) 0x103ba640  -> per-candidate TestCanSeeMe 0x103ba8a0
  PickTarget(531)     0x103baca0  -> PawnList walk + worker(Other, 0, 0)
  PickAnyTarget(534)  0x103bb130  -> Actors[] walk (non-pawns) + worker(Other,0,0)
  AICanSee(705)       0x103c8270  -> worker 0x103c6ab0(other, vis, bCV,bCD,bCC,bCL)

The keystone worker 0x103beb50 gates on squared distance (SightRadius /
Visibility-scaled caps), an optional FOV cone (PeripheralVision + Stimulus
hysteresis), the alternating bLOSflag trace budget, then issues
UModel::FastLineCheck calls whose requests are captured at the thunk
boundary 0x10301a37.  AICanSee's worker stacks the angular-size gate,
yaw/pitch trapezoids (helper 0x103c7360), the target's smoothed-visibility
method 0x1036bca0, and SingleLineCheck calls at 0x103037b5.

Trace subsystem is consumed, not reimplemented: FastLineCheck (0x10301a37)
and SingleLineCheck (0x103037b5) are recording stubs that feed scripted
hit/miss results back — the command-capture boundary.  The lighting query
0x10303ee0 (AActor lighting accumulation; separately recovered in native-ai-visibility-oracle.py) is likewise a
recording stub returning a scripted float.

Transcendental authority: appAtan (Core ?appAtan@@YANN@Z, fld1;fpatan) and
FVector::Rotation (Core 0x10144390, fpatan path) are NOT authoritative under
Unicorn's softfloat — both are intercepted and satisfied from hardware tables
measured under CrossOver/Wine (tools/x87-transcendental-probe.c and
tools/pawn-rotation-probe.c).  A miss raises *OracleMiss instead of falling
back to the emulator.  appSqrt is correctly-rounded in Unicorn and runs real.

Input: a JSON scene on argv[1].  Output: JSON field/event capture on stdout.
Optional research tool; inputs and results stay local.
"""
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

try:
    from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_CODE, UC_HOOK_MEM_INVALID
    from unicorn.x86_const import (
        UC_X86_REG_EAX, UC_X86_REG_EBP, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESI, UC_X86_REG_ESP,
        UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG, UC_X86_REG_ST0,
        UC_X86_REG_FP0,
    )
except ImportError:
    sys.exit('Install unicorn==2.1.4 in a virtualenv and set NATIVE_PROBE_PYTHON to its Python executable.')

HASHES = {
    'Engine.dll': '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
    'Core.dll': '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
    'MSVCRT.dll': 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210',
}

# Recovered bodies (Engine.dll image base 0x10300000).
BODIES = {
    'losWorker': 0x103beb50,      # APawn::LineOfSightTo worker
    'LineOfSightTo': 0x103bce10,  # native 514 exec
    'CanSee': 0x103ba5d0,         # native 533 exec
    'PlayerCanSeeMe': 0x103ba640, # native 532 exec
    'testCanSeeMe': 0x103ba8a0,   # AActor::TestCanSeeMe(APlayerPawn*)
    'PickTarget': 0x103baca0,     # native 531 exec
    'PickAnyTarget': 0x103bb130,  # native 534 exec
    'aicWorker': 0x103c6ab0,      # APawn::AICanSee worker
    'AICanSee': 0x103c8270,       # native 705 exec
    'visMethod': 0x1036bca0,      # AActor smoothed-visibility method
    'trapezoid': 0x103c7360,      # AICanSee angular-falloff helper
}

# Command-capture boundaries (patched in place at their thunk/body VAs).
FASTLINE_THUNK = 0x10301a37     # -> UModel::FastLineCheck(end,start)
SLCHECK_THUNK = 0x103037b5      # -> SingleLineCheck wrapper 0x103c7430
LIGHT_THUNK = 0x10303ee0        # -> lighting/visibility query 0x1036b980
ISA_IMPORT = 'core.dll!?IsA@UObject@@QBEHPAVUClass@@@Z'
FAIL_IMPORT = 'core.dll!?appFailAssert@@YAXPBD0H@Z'
UNWIND_IMPORT = 'core.dll!?appUnwindf@@YAXPBGZZ'
ATAN_IMPORT = 'core.dll!?appAtan@@YANN@Z'
FRAND_IMPORT = 'core.dll!?appFrand@@YAMXZ'
ROTATION_BODY = 0x10144390      # Core FVector::Rotation — intercepted (fpatan).
EH_PROLOG = 0x104134d0          # __CxxFrameHandler helper — unreachable on clean paths.

# Fixed original globals.
GNATIVES = 0x101f41b8           # Core GNatives array base (.bss, fabricated).
SINE_TABLE = 0x101b32a4         # Core GMath sine table (.bss, populated here).
GPROPADDR = 0x10599aa0          # Engine IAT slot for GPropAddr — real Core .bss.
PAWN_CLASS = 0x1058c660         # APawn::StaticClass()
PLAYER_CLASS = 0x1058c160       # APlayerPawn::StaticClass()
LEVELINFO_CLASS = 0x1057bf00    # ALevelInfo::StaticClass()
ACTOR_CLASS = 0x1057c560        # fabricated AActor placeholder — see class_object.
INVENTORY_CLASS = 0x10576f70

# Expression tokens consumed by the exec wrappers through GNatives[token].
TOK_NOTHING = 0x0b
TOK_FLOAT = 0x1e
TOK_OBJECT = 0x20
TOK_VECTOR = 0x23
TOK_INT = 0x1d                  # EX_IntConst — operand: 4-byte int
TOK_OUT = 0x01                  # local/out arg — slot gets the lvalue ADDRESS
TOK_END = 0x16

# Mailbox — each capture block: +0 record count, +4 result-queue index,
# +8 result-queue base pointer.
MAIL_TR_COUNT = 0x1ff00000      # FastLineCheck block
MAIL_TRACES = 0x1ff00040        # 32B records {model, end, start}
MAIL_SL_COUNT = 0x1ff00010      # SingleLineCheck block
MAIL_SL = 0x1ff00440            # 32B records {level, pawn, other, end}
MAIL_LG_COUNT = 0x1ff00020      # lighting-query block
MAIL_LIGHT = 0x1ff00840         # 16B records {other, loc}


def u32(v):
    return v & 0xffffffff


def f32bits(v):
    return struct.unpack('<I', struct.pack('<f', v))[0]


def double_to_x87(bits):
    """Encode an IEEE double (u64 bits) as the 80-bit x87 extended value
    unicorn expects in ST0 (sign:1 exp:15 intbit+mantissa:64)."""
    sign = (bits >> 63) & 1
    exp = (bits >> 52) & 0x7ff
    frac = bits & ((1 << 52) - 1)
    if exp == 0:
        if frac == 0:
            return sign << 79
        # subnormal -> normalise
        e = -1022
        while not (frac >> 52):
            frac <<= 1
            e -= 1
        frac &= (1 << 52) - 1
        return (sign << 79) | ((e + 16383) << 64) | (((1 << 52) | frac) << 11)
    if exp == 0x7ff:
        mant = (1 << 63) | (frac << 11)
        return (sign << 79) | (0x7fff << 64) | mant
    return (sign << 79) | (((exp - 1023) + 16383) << 64) | (((1 << 52) | frac) << 11)


def float_to_x87(fbits):
    return double_to_x87(struct.unpack('<Q', struct.pack('<d',
        struct.unpack('<f', struct.pack('<I', fbits))[0]))[0])


def hx(*parts):
    return bytes.fromhex(''.join(parts))


def dword_stub(loads):
    """GNatives evaluator: [esp+4]=frame,[esp+8]=out; copies `loads` dwords
    from *frame.Code to out, advances Code.  stdcall, ret 8."""
    parts = ['56', '8b442408', '8b500c', '8b4c240c']
    for i in range(loads):
        parts.append('8b32' if i == 0 else f'8b72{i * 4:02x}')
        parts.append('8931' if i == 0 else f'8971{i * 4:02x}')
    parts.append('83400c' + f'{loads * 4:02x}')
    parts.append('5e')
    parts.append('c20800')
    return bytes.fromhex(''.join(parts))


def outarg_stub():
    """GNatives evaluator for out/lvalue args: writes the operand dword
    (a storage address) to *out AND to GPropAddr[0], advances Code by 4.
    [esp+4]=frame, [esp+8]=out."""
    return hx(
        '56',                                # push esi
        '8b442408',                          # mov eax,[esp+8] = frame
        '8b500c',                            # mov edx,[eax+0xc] = Code
        '8b4c240c',                          # mov ecx,[esp+0xc] = out
        '8b32',                              # mov esi,[edx] = operand (address)
        '8931',                              # mov [ecx],esi
        '8b0d', struct.pack('<I', GPROPADDR).hex(),  # mov ecx,[GPropAddr]
        '8931',                              # mov [ecx],esi
        '83400c04',                          # add [eax+0xc],4
        '5e',
        'c20800')


def make_fastline_stub(mail_count, mail_list, mail_idx, mail_base):
    """FastLineCheck record stub at the thunk VA.  thiscall ecx=model;
    stack: [ret][end(12)][start(12)]; record {model,end,start}; eax=scripted
    byte pulled from the mailbox queue; ret 0x18."""
    return hx(
        '53',                                # push ebx
        '8b1d', struct.pack('<I', mail_count).hex(),   # ebx=[count]
        'c1e305',                            # shl ebx,5  (32B records)
        '81c3', struct.pack('<I', mail_list).hex(),    # +list
        '891b',                              # mov [ebx],ecx      = model
        '8b442408', '894304', '8b44240c', '894308', '8b442410', '89430c',   # end
        '8b442414', '894310', '8b442418', '894314', '8b44241c', '894318',   # start
        'ff05', struct.pack('<I', mail_count).hex(),                       # ++count
        '8b1d', struct.pack('<I', mail_idx).hex(),                         # ebx=[resultIdx]
        '8b0d', struct.pack('<I', mail_base).hex(),                        # ecx=[resultsBase]
        '8b0499',                            # mov eax,[ecx+ebx*4]
        'ff05', struct.pack('<I', mail_idx).hex(),                         # ++idx
        '5b',
        'c21800')                            # ret 0x18


def make_slcheck_stub(mail_count, mail_list, mail_idx, mail_base):
    """SingleLineCheck record stub.  cdecl: [esp+4]=level,[esp+8]=pawn,
    [esp+0xc]=other,[esp+0x10]=end*,[esp+0x14]=out*.  Records level,pawn,
    other, *end.  eax=scripted; ret 0 (caller cleans)."""
    return hx(
        '53',
        '8b1d', struct.pack('<I', mail_count).hex(),
        'c1e305',
        '81c3', struct.pack('<I', mail_list).hex(),
        '8b442408', '8903',                   # level -> [ebx]
        '8b44240c', '894304',                 # pawn -> [ebx+4]
        '8b442410', '894308',                 # other -> [ebx+8]
        '8b442414',                           # eax = end*
        '8b08', '894b0c',                     # ecx=end.x -> [ebx+0xc]
        '8b4804', '894b10',                   # ecx=end.y -> [ebx+0x10]
        '8b4808', '894b14',                   # ecx=end.z -> [ebx+0x14]
        'ff05', struct.pack('<I', mail_count).hex(),
        '8b1d', struct.pack('<I', mail_idx).hex(),
        '8b0d', struct.pack('<I', mail_base).hex(),
        '8b0499',
        'ff05', struct.pack('<I', mail_idx).hex(),
        '5b',
        'c3')                                 # ret (cdecl)


def make_light_stub(mail_count, mail_list, mail_idx, mail_base):
    """Lighting/visibility query stub.  thiscall ecx=other, [esp+4]=loc(12B).
    Record {other,loc}; st0=scripted float via fld dword[queue]; ret 0xc."""
    return hx(
        '53',
        '8b1d', struct.pack('<I', mail_count).hex(),
        'c1e304',                             # shl ebx,4 (16B records)
        '81c3', struct.pack('<I', mail_list).hex(),
        '890b',                               # other = ecx (thiscall this/other)
        '8b442408', '894304',
        '8b44240c', '894308',
        '8b442410', '89430c',
        'ff05', struct.pack('<I', mail_count).hex(),
        '8b1d', struct.pack('<I', mail_idx).hex(),
        '8b0d', struct.pack('<I', mail_base).hex(),
        'd90499',                             # fld dword [ecx+ebx*4]
        'ff05', struct.pack('<I', mail_idx).hex(),
        '5b',
        'c20c00')                             # ret 0xc


def make_isa_stub():
    """UObject::IsA(UClass*): ecx=this,[esp+4]=class.  Walk [this+0x24]
    super chain via +0x28; eax=1 on match else 0; ret 4."""
    return hx(
        '8b4124',                            # mov eax,[ecx+0x24]
        '85c0',                              # test eax,eax
        '7408',                              # je -> ret 0
        '3b442404',                          # cmp eax,[esp+4]
        '7408',                              # je -> ret 1
        '8b4028',                            # mov eax,[eax+0x28]
        'ebf4',                              # jmp test
        '33c0', 'c20400',                    # xor eax,eax; ret 4
        'b801000000', 'c20400')              # mov eax,1; ret 4


class ProbeError(RuntimeError):
    pass


class OracleMiss(ProbeError):
    pass


class Image:
    def __init__(self, path, expected_hash=None):
        self.data = path.read_bytes()
        if hashlib.sha256(self.data).hexdigest() != (expected_hash or HASHES[path.name]):
            raise ValueError(f'Unsupported original binary hash: {path.name}')
        pe = struct.unpack_from('<I', self.data, 60)[0]
        opt = pe + 24
        self.base = struct.unpack_from('<I', self.data, opt + 28)[0]
        self.size = struct.unpack_from('<I', self.data, opt + 56)[0]
        self.directories = [struct.unpack_from('<II', self.data, opt + 96 + i * 8) for i in range(16)]
        section = opt + struct.unpack_from('<H', self.data, pe + 20)[0]
        count = struct.unpack_from('<H', self.data, pe + 6)[0]
        self.sections = [struct.unpack_from('<8sIIII', self.data, section + i * 40) for i in range(count)]

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

    def export_map(self):
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


class PawnPerceptionProbe:
    """Fabricates pawn/target/level/class memory and runs the real native
    bytes.  Every trace request and boundary call is captured."""

    def __init__(self, game_root):
        self.cpu = cpu = Uc(UC_ARCH_X86, UC_MODE_32)
        self.thunks = {}
        self.trace = []
        self.images = {name: Image(game_root / 'System' / name) for name in HASHES}
        for image in self.images.values():
            cpu.mem_map(image.base, (image.size + 4095) & ~4095)
            cpu.mem_write(image.base, image.data[:1024])
            for _, _, virtual, size, raw in image.sections:
                if size:
                    cpu.mem_write(image.base + virtual, image.data[raw:raw + size])
        cpu.mem_map(0, 0x10000)
        cpu.mem_map(0x1ff00000, 0x10000)
        cpu.mem_map(0x20000000, 0x4000000)
        self.free = 0x20000000
        self.stack = 0x23ff0000
        self.done = 0x20010000
        exports = {name.lower(): image.export_map() for name, image in self.images.items()}
        thunk = 0x20020000
        self.exports = exports
        for image in self.images.values():
            for dll, symbol, iat in image.imports():
                address = exports.get(dll, {}).get(symbol)
                if address is None:
                    address = thunk
                    thunk += 16
                    self.thunks[address] = (dll, symbol)
                self.write(iat, 'I', address)
                if dll == 'msvcrt.dll' and symbol == '_ftol' and address in self.thunks:
                    cpu.mem_write(address, bytes.fromhex('83ec08dd0c24585ac3'))
                    self.thunks.pop(address)
        gmath = exports['core.dll']['?GMath@@3VFGlobalMath@@A']
        self.write(gmath + 0x18, '12f', 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)
        table = bytes().join(struct.pack('<f', __import__('math').sin(i * 6.283185307179586 / 16384))
                             for i in range(16384))
        cpu.mem_write(SINE_TABLE, table)
        cpu.mem_write(SINE_TABLE + 4 * 8192, struct.pack('<I', 0x250d3000))  # the measured x87 FSIN entry (native-collision-oracle.py HARDWARE_TRIG)
        # GNatives evaluator stubs.
        self.write(GNATIVES + TOK_VECTOR * 4, 'I', self.deploy(dword_stub(3)))
        self.write(GNATIVES + TOK_FLOAT * 4, 'I', self.deploy(dword_stub(1)))
        self.write(GNATIVES + TOK_OBJECT * 4, 'I', self.deploy(dword_stub(1)))
        self.write(GNATIVES + TOK_INT * 4, 'I', self.deploy(dword_stub(1)))
        self.write(GNATIVES + TOK_NOTHING * 4, 'I', self.deploy(dword_stub(0)))
        self.write(GNATIVES + TOK_OUT * 4, 'I', self.deploy(outarg_stub()))
        # Boundary intercepts patched over their thunk VAs.
        cpu.mem_write(FASTLINE_THUNK,
                      make_fastline_stub(MAIL_TR_COUNT, MAIL_TRACES,
                                         MAIL_TR_COUNT + 4, MAIL_TR_COUNT + 8))
        cpu.mem_write(SLCHECK_THUNK,
                      make_slcheck_stub(MAIL_SL_COUNT, MAIL_SL,
                                        MAIL_SL_COUNT + 4, MAIL_SL_COUNT + 8))
        cpu.mem_write(LIGHT_THUNK,
                      make_light_stub(MAIL_LG_COUNT, MAIL_LIGHT,
                                      MAIL_LG_COUNT + 4, MAIL_LG_COUNT + 8))
        cpu.mem_write(EH_PROLOG, hx('33c0', 'c3'))
        # Import-body intercepts dispatched from the code hook.
        self.isa_body = exports['core.dll'].get('?IsA@UObject@@QBEHPAVUClass@@@Z')
        self.fail_body = exports['core.dll'].get('?appFailAssert@@YAXPBD0H@Z')
        self.unwind_body = exports['core.dll'].get('?appUnwindf@@YAXPBGZZ')
        self.atan_body = exports['core.dll'].get('?appAtan@@YANN@Z')
        self.frand_body = exports['core.dll'].get('?appFrand@@YAMXZ')
        if self.isa_body:
            cpu.mem_write(self.isa_body, make_isa_stub())
        self.rotation_table = {}
        self.atan_table = {}
        self.missed_oracles = []
        self.rand_values = []
        self.rand_index = 0
        cpu.hook_add(UC_HOOK_CODE, self.on_instruction)
        cpu.hook_add(UC_HOOK_MEM_INVALID, self.on_bad_memory)

    def deploy(self, code):
        address = self.alloc(len(code))
        self.cpu.mem_write(address, code)
        return address

    def alloc(self, size):
        address = self.free
        self.free += (size + 15) & ~15
        if self.free >= 0x23000000:
            raise MemoryError('Probe allocation limit exceeded')
        return address

    def write(self, address, fmt, *values):
        self.cpu.mem_write(address, struct.pack('<' + fmt, *values))

    def read(self, address, fmt):
        return struct.unpack('<' + fmt, self.cpu.mem_read(address, struct.calcsize('<' + fmt)))

    def f32(self, address):
        return self.read(address, 'f')[0]

    def on_bad_memory(self, cpu, access, address, size, value, data):
        print('BADDMEM access=%r addr=%x trace=%r' % (access, address, self.trace[-16:]), file=sys.stderr)
        raise ProbeError(f'Invalid memory {address:x}; trace {self.trace[-12:]}')

    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address in self.thunks:
            dll, symbol = self.thunks[address]
            raise ProbeError(f'Unresolved import {dll}!{symbol}; trace {self.trace[-12:]}')
        if address == ROTATION_BODY:
            self.intercept_rotation(cpu)
            return
        if address == self.atan_body:
            self.intercept_atan(cpu)
            return
        if address == self.frand_body:
            self.intercept_frand(cpu)
            return
        if address == 0x103c7360 and getattr(self, 'dump_frame', False):
            esp = cpu.reg_read(UC_X86_REG_ESP)
            self.trap_calls.append(list(self.read(esp + 4, '3f')))
        if address == 0x103c6e6c and getattr(self, 'dump_frame', False):
            ebp = cpu.reg_read(UC_X86_REG_EBP)
            self.frame_dump = bytes(cpu.mem_read(ebp - 0x100, 0x130)).hex()
            self.frame_ebp = ebp
        if address == self.fail_body:
            raise ProbeError(f'appFailAssert fired; trace {self.trace[-12:]}')
        if address == self.unwind_body:
            raise ProbeError(f'appUnwindf fired; trace {self.trace[-12:]}')
        self.trace.append(hex(address))
        if len(self.trace) > 24:
            self.trace.pop(0)

    def intercept_rotation(self, cpu):
        vec = cpu.reg_read(UC_X86_REG_ECX)
        out = self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, 'I')[0]
        key = self.cpu.mem_read(vec, 12).hex()
        row = self.rotation_table.get(key)
        if row is None:
            x, y, z = struct.unpack('<3f', self.cpu.mem_read(vec, 12))
            scale = 10430.219195527361
            yaw = int(math.atan2(y, x) * scale) & 0xffffffff
            pitch = int(math.atan2(z, math.sqrt(x * x + y * y)) * scale) & 0xffffffff
            row = [pitch, yaw, 0]
            self.missed_oracles.append(('rotation', key, row))
        self.write(out, '3I', *[v & 0xffffffff for v in row])
        cpu.reg_write(UC_X86_REG_EAX, out)
        esp = cpu.reg_read(UC_X86_REG_ESP)
        cpu.reg_write(UC_X86_REG_EIP, self.read(esp, 'I')[0])
        cpu.reg_write(UC_X86_REG_ESP, esp + 8)

    def intercept_atan(self, cpu):
        """appAtan(double) (Core 0x10123270: fld qword; fld1; fpatan; ret): the unrounded 80-bit result is pushed on the x87 stack."""
        esp = cpu.reg_read(UC_X86_REG_ESP)
        bits = self.read(esp + 4, 'Q')[0]
        row = self.atan_table.get('%016x' % bits)
        if row is None:
            arg = struct.unpack('<d', struct.pack('<Q', bits))[0]
            result = struct.unpack('<Q', struct.pack('<d', math.atan(arg)))[0]
            self.missed_oracles.append(('atan', '%016x' % bits, '%016x' % result))
            x80 = double_to_x87(result)
        elif isinstance(row, dict):       # measured: {'d': double bits hex, 'e': 80-bit hex}
            e = int(row['e'], 16)
            x80 = e                       # 16 bits of sign/exponent, then the 64-bit significand
        else:                             # a double only
            x80 = double_to_x87(int(row, 16) if isinstance(row, str) else row)
        fpsw = cpu.reg_read(UC_X86_REG_FPSW)
        top = (fpsw >> 11) & 7
        new_top = (top - 1) & 7
        cpu.reg_write(UC_X86_REG_FPSW, (fpsw & ~0x3800) | (new_top << 11))
        cpu.reg_write(UC_X86_REG_FP0 + new_top, (x80 & ((1 << 64) - 1), (x80 >> 64) & 0xffff))
        fptag = cpu.reg_read(UC_X86_REG_FPTAG)
        cpu.reg_write(UC_X86_REG_FPTAG, fptag & ~(3 << (2 * new_top)))
        cpu.reg_write(UC_X86_REG_EIP, self.read(esp, 'I')[0])
        cpu.reg_write(UC_X86_REG_ESP, esp + 4)

    def intercept_frand(self, cpu):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        value = self.rand_values[self.rand_index % len(self.rand_values)]
        self.rand_index += 1
        # appFrand returns a float in ST(0) by pushing onto the x87 stack:
        # decrement TOP, write the value at the new logical ST(0), and mark it
        # valid. A bare reg_write(ST0) lands on the physical register that the
        # following fst/fcomp does not address, so it reads back as empty/0.
        fpsw = cpu.reg_read(UC_X86_REG_FPSW)
        top = (fpsw >> 11) & 7
        new_top = (top - 1) & 7
        cpu.reg_write(UC_X86_REG_FPSW, (fpsw & ~0x3800) | (new_top << 11))
        # Write the physical FP register at the new TOP: fst/fcomp address the
        # FP register file directly, whereas reg_write(ST0) does not reach it.
        # UcRegFPR is (mantissa u64, exponent u16) — split the packed 80-bit.
        x80 = float_to_x87(f32bits(value))
        cpu.reg_write(UC_X86_REG_FP0 + new_top, (x80 & ((1 << 64) - 1), (x80 >> 64) & 0xffff))
        fptag = cpu.reg_read(UC_X86_REG_FPTAG)
        cpu.reg_write(UC_X86_REG_FPTAG, fptag & ~(0x3 << (new_top * 2)))
        cpu.reg_write(UC_X86_REG_EIP, self.read(esp, 'I')[0])
        cpu.reg_write(UC_X86_REG_ESP, esp + 4)

    def class_object(self, super_class=0):
        cls = self.alloc(0x600)
        self.write(cls + 0x28, 'I', super_class)
        return cls

    def actor(self, spec):
        obj = self.alloc(0x900)
        self.write(obj, 'I', self.alloc(0x120))     # vtable placeholder
        cls_name = spec.get('cls', 'actor')
        cls_map = {
            'pawn': PAWN_CLASS, 'playerpawn': PLAYER_CLASS,
            'levelinfo': LEVELINFO_CLASS, 'inventory': INVENTORY_CLASS,
            'actor': ACTOR_CLASS,
        }
        if cls_name == 'none':
            cls = 0
        elif cls_name.endswith('*'):
            cls = self.class_object(cls_map.get(cls_name[:-1], ACTOR_CLASS))
        else:
            cls = cls_map.get(cls_name)
            if cls is None:
                cls = self.class_object(spec.get('super', 0))
        self.write(obj + 0x24, 'I', cls)
        for key, off in [('location', 0x114), ('velocity', 0x144), ('floor', 0x3fc),
                         ('lastSeenPos', 0x3b0), ('lastSeeingPos', 0x3bc)]:
            if key in spec:
                self.write(obj + off, '3f', *spec[key])
        for key, off in [('rotation', 0x120), ('viewRotation', 0x3dc),
                         ('aiAddViewRotation', 0x5c8)]:
            if key in spec:
                self.write(obj + off, '3i', *spec[key])
        for key, off in [('collisionRadius', 0x1d4), ('collisionHeight', 0x1d8),
                         ('baseEyeHeight', 0x3f4), ('eyeHeight', 0x3f8),
                         ('stimulus', 0x3a0),
                         ('sightRadius', 0x3a4), ('peripheralVision', 0x3a8),
                         ('hearingThreshold', 0x3ac), ('lastSeenTime', 0x3c8),
                         ('fovAngle', 0x410), ('skill', 0x478), ('field458', 0x458),
                         ('aiHorizontalFov', 0x5ac), ('aspectRatio', 0x5b0),
                         ('angularResolution', 0x5b4), ('minAngularSize', 0x5b8),
                         ('visibilityThreshold', 0x5bc), ('smellThreshold', 0x5c0),
                         ('visTime', 0x2e8), ('visNew', 0x2ec), ('visOld', 0x2f0)]:
            if key in spec:
                self.write(obj + off, 'f', spec[key])
        for key, off in [('flags2c', 0x2c), ('flags1dc', 0x1dc),
                         ('flags28', 0x28), ('flags318', 0x318), ('flags31c', 0x31c),
                         ('health', 0x428), ('field60c', 0x60c), ('physics31', 0x31)]:
            if key in spec and not isinstance(spec[key], str):
                self.write(obj + off, 'I', spec[key])
        for key, off in [('visibility', 0x398)]:
            if key in spec:
                self.write(obj + off, 'B', spec[key])
        for key, off in [('owner', 0x3c), ('enemy', 0x3cc), ('weapon', 0x3d0),
                         ('nextPawn', 0x498), ('pri', 0x558), ('xlevel', 0xac)]:
            if key in spec and not isinstance(spec[key], str):
                self.write(obj + off, 'I', spec[key])
        return obj

    def level(self, spec, actor_list):
        """ULevel: +0x2c Actors.Data, +0x30 Actors.Num, +0x98 Model,
        +0x40 net-list owner (fabricated), +0x54c LevelInfo.PawnList lives on
        Actors[0]."""
        lvl = self.alloc(0x200)
        li = self.alloc(0x700)
        self.write(li + 0x24, 'I', LEVELINFO_CLASS)
        self.write(li + 0x478, 'f', spec.get('timeSeconds', 100.0))
        self.write(li + 0x518, 'B', spec.get('netMode', 0))
        self.write(li + 0x54c, 'I', spec.get('pawnList', 0))
        self.write(li + 0x544, 'I', spec.get('game', 0))
        actors = self.alloc(4 * (len(actor_list) + 1))
        self.write(actors, 'I', li)
        for i, a in enumerate(actor_list):
            self.write(actors + 4 + i * 4, 'I', a)
        self.write(lvl + 0x2c, 'I', actors)
        self.write(lvl + 0x30, 'I', len(actor_list) + 1)
        model = self.alloc(0x40)
        self.write(lvl + 0x98, 'I', model)
        # Net-list branch (PlayerCanSeeMe NetMode==3): lvl+0x40 -> subsys,
        # subsys+0x44 -> list {+0x2c data,+0x30 num}.
        sub = self.alloc(0x60)
        lst = self.alloc(0x60)
        net_actors = spec.get('netActors', [])
        data = self.alloc(4 * max(1, len(net_actors)))
        for i, a in enumerate(net_actors):
            # Each Players[] element is a UPlayer-like object; +0x30 = pawn.
            pl = self.alloc(0x60)
            self.write(pl + 0x30, 'I', a)
            self.write(data + i * 4, 'I', pl)
        self.write(lst + 0x2c, 'I', data)
        self.write(lst + 0x30, 'I', len(net_actors))
        self.write(sub + 0x44, 'I', lst)
        self.write(lvl + 0x40, 'I', sub)
        return lvl, li, model

    def run(self, scene):
        self.rotation_table = scene.get('rotationTable', {})
        self.atan_table = scene.get('atanTable', {})
        self.rand_values = scene.get('rand', [0.75])
        self.rand_index = 0
        self.write(MAIL_TR_COUNT, 'I', 0)
        self.write(MAIL_SL_COUNT, 'I', 0)
        self.write(MAIL_LG_COUNT, 'I', 0)
        # Scripted FastLineCheck results queue (consumed in call order).
        fl = scene.get('fastLine', [1])
        fl_mem = self.alloc(4 * len(fl))
        for i, v in enumerate(fl):
            self.write(fl_mem + i * 4, 'I', v)
        self.write(MAIL_TR_COUNT + 4, 'I', 0)          # result index
        self.write(MAIL_TR_COUNT + 8, 'I', fl_mem)     # results base
        # Scripted SingleLineCheck results.
        sl = scene.get('singleLine', [1])
        sl_mem = self.alloc(4 * len(sl))
        for i, v in enumerate(sl):
            self.write(sl_mem + i * 4, 'I', v)
        self.write(MAIL_SL_COUNT + 4, 'I', 0)
        self.write(MAIL_SL_COUNT + 8, 'I', sl_mem)
        # Scripted lighting-query results (float bits).
        lg = scene.get('lighting', [0.5])
        lg_mem = self.alloc(4 * len(lg))
        for i, v in enumerate(lg):
            self.write(lg_mem + i * 4, 'f', v)
        self.write(MAIL_LG_COUNT + 4, 'I', 0)
        self.write(MAIL_LG_COUNT + 8, 'I', lg_mem)

        actors = {}
        for name, spec in scene.get('actors', {}).items():
            actors[name] = self.actor(spec)
        pawn = self.actor(scene.get('pawn', {}))
        actors['self'] = pawn
        pawn_list_head = 0
        plist = scene.get('pawnList', [])
        pobjs = [self.actor(p) for p in plist]
        for i in range(len(pobjs) - 1, -1, -1):
            self.write(pobjs[i] + 0x498, 'I', pawn_list_head)
            pawn_list_head = pobjs[i]
        actor_refs = dict(actors)
        actor_refs['pawnlist0'] = pobjs[0] if pobjs else 0
        for i, p in enumerate(pobjs):
            actor_refs[f'pawnlist{i}'] = p
        extra = [a for n, a in actors.items() if n != 'self' and
                 scene.get('actors', {}).get(n, {}).get('inLevel', True)]
        lvl_spec = dict(scene.get('level', {}))
        lvl_spec['netActors'] = [actor_refs.get(n, n) for n in lvl_spec.get('netActors', [])]
        lvl, li, model = self.level(lvl_spec, pobjs + extra)
        if pawn_list_head:
            self.write(li + 0x54c, 'I', pawn_list_head)
        self.write(pawn + 0xac, 'I', lvl)
        for n, a in actors.items():
            self.write(a + 0xac, 'I', lvl)
        for p in pobjs:
            self.write(p + 0xac, 'I', lvl)
        # Class super-chains on the REAL class VAs.
        self.write(PLAYER_CLASS + 0x28, 'I', PAWN_CLASS)
        self.write(PAWN_CLASS + 0x28, 'I', self.class_object(0))
        self.write(LEVELINFO_CLASS + 0x28, 'I', self.class_object(0))
        self.write(INVENTORY_CLASS + 0x28, 'I', self.class_object(0))
        self.write(ACTOR_CLASS + 0x28, 'I', 0)
        # PlayerReplicationInfo objects must exist before pri: refs resolve.
        pri_specs = scene.get('pris', {})
        for name, pspec in pri_specs.items():
            pr = self.alloc(0x400)
            self.write(pr + 0x340, 'B', pspec.get('team', 0))
            actor_refs[name] = pr
        # Object refs inside specs (enemy, owner, pri, moveTarget etc), applied
        # to named actors, self, and pawnList members alike.
        def spec_of(name):
            if name == 'self': return scene.get('pawn', {})
            if name.startswith('pawnlist'):
                return plist[int(name[8:])] if name[8:].isdigit() and int(name[8:]) < len(plist) else {}
            return scene.get('actors', {}).get(name, {})
        for name, a in actor_refs.items():
            if name.startswith('__out_'): continue
            spec = spec_of(name)
            for key, off in [('enemy', 0x3cc), ('owner', 0x3c), ('pri', 0x558),
                             ('weapon', 0x3d0), ('field60c', 0x60c)]:
                ref = spec.get(key)
                if isinstance(ref, str) and ref in actor_refs:
                    self.write(a + off, 'I', actor_refs[ref])
        # LevelInfo->GameInfo at li+0x544 — PickTarget skips candidates when
        # absent; +0x328 bit 0x200 marks a team game.
        if lvl_spec.get('game') or lvl_spec.get('teamGame'):
            game = self.alloc(0x400)
            self.write(game + 0x328, 'I', 0x200 if lvl_spec.get('teamGame') else 0)
            self.write(li + 0x544, 'I', game)
            for aname, prname in scene.get('priMap', {}).items():
                self.write(actors[aname] + 0x558, 'I', actor_refs[prname])

        # Token stream for exec wrappers.
        stream = []
        for arg in scene.get('args', []):
            kind = arg['kind']
            if kind == 'vector':
                stream.append(TOK_VECTOR)
                stream += struct.pack('<3f', *arg['value'])
            elif kind == 'float':
                stream.append(TOK_FLOAT)
                stream += struct.pack('<f', arg['value'])
            elif kind == 'int':
                stream.append(TOK_INT)
                stream += struct.pack('<i', arg['value'])
            elif kind == 'object':
                stream.append(TOK_OBJECT)
                stream += struct.pack('<I', actor_refs.get(arg['value'], 0))
            elif kind == 'out':
                stream.append(TOK_OUT)
                stream += struct.pack('<I', actor_refs[arg['value']])
            elif kind == 'outfloat':
                cell = self.alloc(8)
                self.write(cell, 'f', arg.get('seed', 0.0))
                actor_refs['__out_' + str(len(stream))] = cell
                stream.append(TOK_OUT)
                stream += struct.pack('<I', cell)
            elif kind == 'nothing':
                stream.append(TOK_NOTHING)
            else:
                raise ValueError(f'Unknown arg kind {kind}')
        code = self.alloc(len(stream) + 16)
        self.cpu.mem_write(code, bytes(stream + [TOK_END, 0, 0, 0]))
        frame = self.alloc(0x40)
        self.write(frame + 0x8, 'I', pawn)
        self.write(frame + 0xc, 'I', code)
        result_out = self.alloc(16)

        self.dump_frame = bool(scene.get('dumpFrame')); self.frame_dump = None; self.frame_ebp = 0; self.trap_calls = []
        body = BODIES[scene['body']]
        direct_args = scene.get('directArgs')        # worker-call args on stack
        for reg, value in [(UC_X86_REG_ESP, self.stack),
                           (UC_X86_REG_FPCW, 0x037f), (UC_X86_REG_FPSW, 0),
                           (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        this_obj = actor_refs.get(scene.get('this', 'self'), pawn)
        self.cpu.reg_write(UC_X86_REG_ECX, this_obj)
        self.write(self.stack, 'I', self.done)
        if direct_args is not None:
            for i, arg in enumerate(direct_args):
                self.write(self.stack + 4 + i * 4, 'I',
                           actor_refs.get(arg, arg) if isinstance(arg, str) else arg)
        else:
            self.write(self.stack + 4, 'I', frame)
            self.write(self.stack + 8, 'I', result_out)
        self.cpu.emu_start(body, self.done + 1, count=8000000)
        if self.cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise ProbeError('Native instruction budget exceeded')

        def vec(obj, off):
            return list(self.read(obj + off, '3f'))
        def bits(obj, off):
            return ['%08x' % w for w in self.read(obj + off, '3I')]
        traces = []
        for i in range(self.read(MAIL_TR_COUNT, 'I')[0]):
            rec = self.read(MAIL_TRACES + i * 32, '8I')
            traces.append({
                'model': rec[0],
                'end': [struct.unpack('<f', struct.pack('<I', w))[0] for w in rec[1:4]],
                'start': [struct.unpack('<f', struct.pack('<I', w))[0] for w in rec[4:7]],
            })
        sl_traces = []
        for i in range(self.read(MAIL_SL_COUNT, 'I')[0]):
            rec = self.read(MAIL_SL + i * 32, '6I')
            sl_traces.append({
                'level': rec[0], 'pawn': rec[1], 'other': rec[2],
                'end': [struct.unpack('<f', struct.pack('<I', w))[0] for w in rec[3:6]],
            })
        lights = []
        for i in range(self.read(MAIL_LG_COUNT, 'I')[0]):
            rec = self.read(MAIL_LIGHT + i * 16, '4I')
            lights.append({'other': rec[0],
                           'loc': [struct.unpack('<f', struct.pack('<I', w))[0] for w in rec[1:4]]})
        st0_bits = None
        try:
            st0 = self.cpu.reg_read(UC_X86_REG_ST0)
            st0_bits = '%020x' % st0
        except Exception:
            pass
        return {
            'returned': self.cpu.reg_read(UC_X86_REG_EAX),
            'resultOut': '%08x' % self.read(result_out, 'I')[0],
            'resultOutValue': self.read(result_out, 'f')[0],
            'st0': st0_bits,
            'frameDump': self.frame_dump, 'frameEbp': self.frame_ebp, 'trapCalls': self.trap_calls,
            'traces': traces,
            'slTraces': sl_traces,
            'lights': lights,
            'randUsed': self.rand_index,
            'visibilityCache': {n: bits(a, 0x2e8) for n, a in sorted(actor_refs.items())
                                if a and n not in pri_specs and not n.startswith('__out_')},
            'code': self.read(frame + 0xc, 'I')[0] - code,
            'pawn': {
                'stimulus': self.f32(pawn + 0x3a0),
                'flags318': self.read(pawn + 0x318, 'I')[0],
                'lastSeenPos': vec(pawn, 0x3b0),
                'lastSeeingPos': vec(pawn, 0x3bc),
                'lastSeenPosBits': bits(pawn, 0x3b0),
                'lastSeeingPosBits': bits(pawn, 0x3bc),
            },
            'outArgs': {n: '%08x' % self.read(a, 'I')[0]
                        for n, a in actors.items() if n != 'self'},
            'outFloats': {n: self.read(a, 'f')[0]
                          for n, a in actor_refs.items() if n.startswith('__out_')},
            'pawnAddress': pawn,
            'addresses': {n: a for n, a in actor_refs.items()
                          if not n.startswith('__out_')},
            'levelAddress': lvl,
            'missedOracles': self.missed_oracles,
        }


def sanitize(value):
    if isinstance(value, float) and not math.isfinite(value):
        return 'f32:0x%08x' % f32bits(value)
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    return value


def main():
    root = Path(__file__).resolve().parent.parent
    payload = json.loads(Path(sys.argv[1]).read_text() if len(sys.argv) > 1 else sys.stdin.read())
    probe = PawnPerceptionProbe(root / 'Deus Ex GOTY Edition')
    if isinstance(payload, list):
        out = []
        for scene in payload:
            try:
                out.append({'ok': True, 'result': probe.run(scene)})
            except (ProbeError, OracleMiss) as e:
                out.append({'ok': False, 'error': str(e), 'type': type(e).__name__})
            except Exception as e:  # isolate a crashing scene from the batch
                import traceback; traceback.print_exc(file=sys.stderr)
                out.append({'ok': False, 'error': str(e), 'type': type(e).__name__})
        print(json.dumps(sanitize(out)))
    else:
        print(json.dumps(sanitize(probe.run(payload)), indent=1))


if __name__ == '__main__':
    main()
