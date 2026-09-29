"""Execute the recovered APawn navigation/reachability natives in an isolated
x86 emulator.

Recovered bodies (Engine.dll image base 0x10300000):

  pointReachable(521)   exec 0x103bc710 -> worker 0x103c0d30(pawn; point, target)
  actorReachable(520)   exec 0x103bc1a0 -> worker 0x103c0630(pawn; actor, flag)
                        + close-navpoint scan worker 0x103dad20(pawn; nav, target)
  FindRandomDest(525)   exec 0x103bcb90 -> 0x103da050 + 0x103dc700
  FindPathToward(517)   exec 0x103bc9c0 -> 0x103db3f0
  FindPathTo(518)       exec 0x103bc800 -> 0x103dc1d0
  PickWallAdjust(526)   exec 0x103bb7e0 -> 0x103c4150
  FindStairRotation(524) exec 0x103bb880 (inline fp)
  AIDirectionReachable(708) exec 0x103c8560 -> band search 0x103c78a0

The reachability core is a stepped-walk graph primitive: the point/actor
workers run zone gates, an optional eye trace, a test FarMoveActor, then
dispatch on the destination zone / pawn Physics into three stepped-move
helpers (walkReach 0x103c1b70, waterReach 0x103c15a0, flyReach 0x103c1190)
that iterate up to 100 move-check probes (checkMove 0x103c3290,
waterMove 0x103c3ca0, flyMove 0x103c3900, FindBestJump 0x103c2f50 with
SuggestJumpVelocity 0x103c2c80 and jumpLanding 0x103c2530).

Collision/movement subsystem is consumed, not reimplemented: every
MoveActor (XLevel vtable +0x88), FarMoveActor (+0x8c) and SingleLineCheck
(+0xc0) call lands on a RECORDING STUB in a fabricated level vtable that
feeds scripted results back.  UModel PointRegion (thunk 0x1030391d) and
FastLineCheck (thunk 0x10301a37) are patched in place the same way — the
command-capture boundary.

Transcendental authority: none of the reachability bodies use
fsin/fcos/fpatan/fptan/fyl2x/f2xm1 (verified by opcode scan); Unicorn is
fully authoritative for their integer/vector/fsqrt math.  appSqrt and
FVector::SafeNormal run as real imported bodies.

Optional controlled-world scene keys (the swimming slice, docs/script-pawn-nav.md):
  waterPlane {z, wet, dry}  PointRegion answers the wet zone strictly below z and
                            the dry zone otherwise; after every MoveActor and
                            FarMoveActor stub commit, Region.Zone follows the
                            same rule (a SetActorZone stand-in).
  moveNearlyZero            MoveActor's early return for a nearly-zero Delta with
                            an unchanged Rotation (no move, Hit untouched).
  coverage [[lo, hi], ...]  report executed instruction addresses in the ranges.
  vecbufInit [x, y, z]      float32 contents of the 'vecbuf' scratch before the
                            call (SuggestJumpVelocity's in/out FVector& Vel).
Every GLog->Logf call (Core FOutputDevice::Logf, cdecl) is intercepted and
recorded with its format string and the 9 raw argument dwords that follow it
(FindBestJump's "FAILING FBJ" line); it is part of the ordered call log.
  disasm {name: [lo, hi]}   return the instruction addresses instead of running.
  resultInit dword          sentinel in the exec's RESULT_DECL slot before the call.
  gPropAddr ref|0           stale Core GPropAddr before the call (P_GET_*_REF resets it).
Exec scenes also report codeConsumed, the script bytes the exec stepped over.

Input: a JSON scene on argv[1].  Output: JSON command/result capture.
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
        UC_X86_REG_EAX, UC_X86_REG_EBP, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_EIP, UC_X86_REG_ESI, UC_X86_REG_ESP,
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
    'pointReachable': 0x103bc710,      # native 521 exec
    'pointWorker': 0x103c0d30,         # point-reach worker (pawn; vec, target)
    'actorReachable': 0x103bc1a0,      # native 520 exec
    'actorWorker': 0x103c0630,         # actor-reach worker (pawn; actor, flag)
    'directReach': 0x103dad20,         # nav-point ReachSpec scan (pawn; nav, target)
    'reachMask': 0x10326d10,           # pawn capability-mask gather (thiscall)
    'dispatch': 0x103c1000,            # physics reach dispatcher
    'waterReach': 0x103c15a0,
    'walkReach': 0x103c1b70,
    'flyReach': 0x103c1190,
    'checkMove': 0x103c3290,
    'jumpArc': 0x103c2f50,             # APawn::FindBestJump (thunk 0x10303422)
    'findBestJump': 0x103c2f50,
    'jumpLanding': 0x103c2530,         # APawn::jumpLanding (thunk 0x103016ae)
    'suggestJumpVelocity': 0x103c2c80, # APawn::SuggestJumpVelocity (thunk 0x103035a8)
    'flyMove': 0x103c3900,
    'waterMove': 0x103c3ca0,
    'FindRandomDest': 0x103bcb90,      # native 525 exec
    'randomDestWorker': 0x103dc700,
    'clearPaths': 0x103da050,
    'FindPathTo': 0x103bc800,          # native 518 exec
    'pathToWorker': 0x103dc1d0,
    'FindPathToward': 0x103bc9c0,      # native 517 exec
    'findPathToward': 0x103bc9c0,
    'pathTowardWorker': 0x103db3f0,
    'PickWallAdjust': 0x103bb7e0,      # native 526 exec
    'wallAdjustWorker': 0x103c4150,
    'FindStairRotation': 0x103bb880,   # native 524 exec
    # AIPickRandomDestination (709) chain: exec -> worker -> direction helper +
    # band-search helper (UnPawnExt.cpp, assert "!GIsEditor" at +0x2a8).
    'aiPickExec': 0x103c86f0,          # native 709 exec
    'aiPickWorker': 0x103c7fc0,        # thiscall(pawn; 9 args) -> bool
    'aiPickSearch': 0x103c78a0,        # stepped-move band search
    'aiDirection': 0x1036d030,         # biased random rotator helper
    # AIDirectionReachable (708): exec -> the band search above, which is
    # APawn::AIDirectionReachable (thunk 0x103011d6), with a literal 15.0f.
    'aiDirectionReachableExec': 0x103c8560,  # native 708 exec (thunk 0x103022cf)
}

# Engine IAT slot for Core's appFrand — patched to a scripted queue for the
# AI-pick bodies so the random-direction inputs are observable/deterministic.
APPFRAND_IAT = 0x10599cb8

# Command-capture boundaries patched in place at their thunk VAs.
POINTREGION_THUNK = 0x1030391d   # -> UModel::PointRegion 0x103f5db0
FASTLINE_THUNK = 0x10301a37      # -> UModel::FastLineCheck(end,start)
SPECIALCOST_THUNK = 0x10302af9   # -> SpecialCost event dispatch 0x1033bb50
EH_PROLOG = 0x104134d0           # __CxxFrameHandler helper — unreachable on clean paths.

# Fixed original globals.
GNATIVES = 0x101f41b8            # Core GNatives array base (.bss, fabricated).
SINE_TABLE = 0x101b32a4          # Core GMath sine table (.bss, populated here).
GPROPADDR = 0x10599aa0           # Engine IAT slot for GPropAddr — real Core .bss.
GISEDITOR = 0x10599c94           # Engine data: pointer to editor-mode flag.
GTIMING = 0x10599dac             # Engine data: stat-timing flag pointer.
PAWN_CLASS = 0x1058c660          # APawn::StaticClass()
PLAYER_CLASS = 0x1058c160        # APlayerPawn::StaticClass()
LEVELINFO_CLASS = 0x1057bf00     # ALevelInfo::StaticClass()
NAVPOINT_CLASS = 0x1057a128      # ANavigationPoint::StaticClass()
WARPMARKER_CLASS = 0x10575198    # AWarpZoneMarker::StaticClass()
INVENTORY_CLASS = 0x10576f70     # AInventory::StaticClass()
MOVER_CLASS = 0x1058bb58         # AMover::StaticClass()
TRIGGER_CLASS = 0x10576088       # ATrigger::StaticClass()
ACTOR_CLASS = 0x1057c560         # AActor::StaticClass()

# Expression tokens consumed by the exec wrappers through GNatives[token].
TOK_NOTHING = 0x0b
TOK_FLOAT = 0x1e
TOK_OBJECT = 0x20
TOK_VECTOR = 0x23
TOK_INT = 0x1d
TOK_OUT = 0x01
TOK_END = 0x16

# Mailboxes — each capture block: +0 record count, +4 result-queue index,
# +8 result-queue base pointer.  The captured-argument records themselves are
# written to a separate heap buffer (recs), so the header stays small.
MAIL_MV = 0x1ff00000   # MoveActor      header
MAIL_FM = 0x1ff00100   # FarMoveActor   header
MAIL_SL = 0x1ff00180   # SingleLineCheck header
MAIL_PR = 0x1ff00280   # PointRegion    header
MAIL_FL = 0x1ff00300   # FastLineCheck  header
MAIL_FR = 0x1ff00380   # appFrand       header (scripted float queue)
MAIL_SC = 0x1ff00400   # SpecialCost    header (scripted int queue)

# Deep enough that a ~100-step reach loop can't exhaust a scripted boundary
# (each list is padded by repeating its last entry to this depth).
RESULT_DEPTH = 8192


def u32(v):
    return v & 0xffffffff


def f32bits(v):
    return struct.unpack('<I', struct.pack('<f', v))[0]


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
    (a storage address) to *out AND to GPropAddr[0], advances Code by 4."""
    return hx(
        '56',
        '8b442408',
        '8b500c',
        '8b4c240c',
        '8b32',
        '8931',
        '8b0d', struct.pack('<I', GPROPADDR).hex(),
        '8931',
        '83400c04',
        '5e',
        'c20800')


def move_stub(mail, recs):
    """MoveActor record stub (vtable +0x88).  thiscall ecx=level;
    stack: [ret][actor][delta12][rot12][hit*][f1][f2][f3][f4] -> ret 0x30.
    Record {level,actor,delta,rot,hitptr,flags4} (64B); copy the scripted 44B
    FCheckResult (results+idx*48+4) into *hitptr; eax = results[idx*48]."""
    mc, mi, mb = mail, mail + 4, mail + 8
    return hx(
        '53', '56', '57',
        '8b1d', struct.pack('<I', mc).hex(),        # ebx = count
        'c1e306',                                   # ebx *= 64
        '81c3', struct.pack('<I', recs).hex(),      # ebx = record
        '890b',                                     # level (ecx)
        '8b442410', '894304',                       # actor   (orig+4, +0xc pushes)
        '8b442414', '894308', '8b442418', '89430c', '8b44241c', '894310',   # delta
        '8b442420', '894314', '8b442424', '894318', '8b442428', '89431c',   # rot
        '8b44242c', '894320',                       # hitptr
        '8b442430', '894324', '8b442434', '894328',
        '8b442438', '89432c', '8b44243c', '894330', # flags4
        'ff05', struct.pack('<I', mc).hex(),        # ++count
        '8b1d', struct.pack('<I', mi).hex(),        # ebx = result idx
        '8d045b',                                   # eax = idx*3
        'c1e004',                                   # eax = idx*48
        '8b35', struct.pack('<I', mb).hex(),        # esi = results base
        '03f0',                                     # esi += idx*48
        '8b06',                                     # eax = scripted return
        '83c604',                                   # esi = &hit44
        # Commit the move like ULevel::MoveActor: actor.loc += delta*hit.time.
        '8b7c2410',                                 # edi = actor (orig+4,+0xc)
        'd94624',                                   # fld [esi+0x24]      (time)
        'd84c2414',                                 # fmul [esp+0x14]     (*delta.x)
        'd88714010000',                             # fadd [edi+0x114]
        'd99f14010000',                             # fstp [edi+0x114]
        'd94624',                                   # fld [esi+0x24]
        'd84c2418',                                 # fmul [esp+0x18]     (*delta.y)
        'd88718010000',                             # fadd [edi+0x118]
        'd99f18010000',                             # fstp [edi+0x118]
        'd94624',                                   # fld [esi+0x24]
        'd84c241c',                                 # fmul [esp+0x1c]     (*delta.z)
        'd8871c010000',                             # fadd [edi+0x11c]
        'd99f1c010000',                             # fstp [edi+0x11c]
        '8b7c242c',                                 # edi = hitptr
        'b90b000000',                               # ecx = 11 dwords
        'f3a5',                                     # rep movsd
        'ff05', struct.pack('<I', mi).hex(),        # ++idx
        '5f', '5e', '5b',
        'c23000')                                   # ret 0x30


def farmove_stub(mail, recs):
    """FarMoveActor record stub (vtable +0x8c).  thiscall ecx=level;
    stack: [ret][actor][vec12][test][noCheck] -> ret 0x18.
    Record {level,actor,vec,test,noCheck} (32B); on scripted nonzero result
    write vec -> actor+0x114 (FarMove teleports even on a test move);
    eax = scripted dword; ret 0x18."""
    mc, mi, mb = mail, mail + 4, mail + 8
    return hx(
        '53', '56',
        '8b1d', struct.pack('<I', mc).hex(),
        'c1e305',                                   # ebx *= 32
        '81c3', struct.pack('<I', recs).hex(),
        '890b',                                     # level
        '8b44240c', '894304',                       # actor (orig+4, +8 pushes)
        '8b442410', '894308', '8b442414', '89430c', '8b442418', '894310',   # vec
        '8b44241c', '894314',                       # test
        '8b442420', '894318',                       # noCheck
        'ff05', struct.pack('<I', mc).hex(),
        '8b1d', struct.pack('<I', mi).hex(),        # ebx = idx
        '8b35', struct.pack('<I', mb).hex(),        # esi = results
        '8b049e',                                   # eax = [esi+ebx*4]
        'ff05', struct.pack('<I', mi).hex(),
        '85c0',                                     # test eax,eax
        '7422',                                     # jz done (skip 34B vec-write)
        '8b54240c',                                 # edx = actor
        '8b4c2410', '898a14010000',                 # vec.x -> actor+0x114
        '8b4c2414', '898a18010000',                 # vec.y -> actor+0x118
        '8b4c2418', '898a1c010000',                 # vec.z -> actor+0x11c
        '5e', '5b',
        'c21800')


def slcheck_stub(mail, recs):
    """SingleLineCheck record stub (vtable +0xc0).  thiscall ecx=level;
    stack: [ret][hit*][source][end*][start*][flags][extent12] -> ret 0x20.
    Record {level,hitptr,source,end,start,flags,extent} (64B); copy the
    scripted 44B FCheckResult into *hitptr; eax = scripted; ret 0x20."""
    mc, mi, mb = mail, mail + 4, mail + 8
    return hx(
        '53', '56', '57',
        '8b1d', struct.pack('<I', mc).hex(),
        'c1e306',
        '81c3', struct.pack('<I', recs).hex(),
        '890b',                                     # level
        '8b442410', '894304',                       # hitptr
        '8b442414', '894308',                       # source
        '8b7c2418', '8b07', '89430c',               # end.x
        '8b4704', '894310',                         # end.y
        '8b4708', '894314',                         # end.z
        '8b7c241c', '8b07', '894318',               # start.x
        '8b4704', '89431c',                         # start.y
        '8b4708', '894320',                         # start.z
        '8b442420', '894324',                       # flags
        '8b442424', '894328', '8b442428', '89432c', '8b44242c', '894330',   # extent
        'ff05', struct.pack('<I', mc).hex(),
        '8b1d', struct.pack('<I', mi).hex(),
        '8d045b',                                   # eax = idx*3
        'c1e004',                                   # eax = idx*48
        '8b35', struct.pack('<I', mb).hex(),
        '03f0',
        '8b06',                                     # eax = scripted ret
        '83c604',
        '8b7c2410',                                 # edi = hitptr
        'b90b000000',
        'f3a5',
        'ff05', struct.pack('<I', mi).hex(),
        '5f', '5e', '5b',
        # SingleLineCheck pops 9 stack dwords: hit, source, end*, start*,
        # flags, extent vec3, extra — real body at 0x1039aed0 ends `ret 0x24`.
        'c22400')


def pointregion_stub(mail, recs):
    """PointRegion record stub (thunk 0x1030391d).  thiscall ecx=model;
    stack: [ret][outRegion*][worldActor][point12] -> ret 0x14.
    Record {model,outptr,world,point} (32B); write scripted {zone,leaf,num}
    to *outRegion; eax = outRegion*."""
    mc, mi, mb = mail, mail + 4, mail + 8
    return hx(
        '53', '56',
        '8b1d', struct.pack('<I', mc).hex(),
        'c1e305',                                   # ebx *= 32
        '81c3', struct.pack('<I', recs).hex(),
        '890b',                                     # model (ecx)
        '8b44240c', '894304',                       # outptr
        '8b442410', '894308',                       # world
        '8b442414', '89430c', '8b442418', '894310', '8b44241c', '894314',   # point
        'ff05', struct.pack('<I', mc).hex(),
        '8b1d', struct.pack('<I', mi).hex(),        # ebx = idx
        '8d045b',                                   # eax = idx*3
        'c1e002',                                   # eax = idx*12
        '8b35', struct.pack('<I', mb).hex(),        # esi = results
        '03f0',                                     # esi = slot
        '8b7c240c',                                 # edi = outptr
        '8b06', '8907',                             # zone
        '8b4604', '894704',                         # leaf
        '8b4608', '894708',                         # zoneNumber
        'ff05', struct.pack('<I', mi).hex(),
        '8b44240c',                                 # eax = outptr
        '5e', '5b',
        'c21400')


def fastline_stub(mail, recs):
    """FastLineCheck record stub (thunk 0x10301a37).  thiscall ecx=model;
    stack: [ret][v1(12)][v2(12)] -> ret 0x18.  eax = scripted dword."""
    mc, mi, mb = mail, mail + 4, mail + 8
    return hx(
        '53',
        '8b1d', struct.pack('<I', mc).hex(),
        'c1e305',
        '81c3', struct.pack('<I', recs).hex(),
        '890b',                                     # model
        '8b442408', '894304', '8b44240c', '894308', '8b442410', '89430c',   # v1
        '8b442414', '894310', '8b442418', '894314', '8b44241c', '894318',   # v2
        'ff05', struct.pack('<I', mc).hex(),
        '8b1d', struct.pack('<I', mi).hex(),
        '8b0d', struct.pack('<I', mb).hex(),
        '8b0499',                                   # eax = [ecx+ebx*4]
        'ff05', struct.pack('<I', mi).hex(),
        '5b',
        'c21800')


def isa_stub():
    """UObject::IsA(UClass*): ecx=this,[esp+4]=class.  Walk [this+0x24]
    super chain via +0x28; eax=1 on match else 0; ret 4."""
    return hx(
        '8b4124',
        '85c0',
        '7408',
        '3b442404',
        '7408',
        '8b4028',
        'ebf4',
        '33c0', 'c20400',
        'b801000000', 'c20400')


def specialcost_stub(mail, recs):
    """NavigationPoint.SpecialCost dispatch stub (thunk 0x10302af9 ->
    0x1033bb50 FindFunction+ProcessEvent).  thiscall ecx=nav; stack:
    [ret][pawn] -> ret 4.  eax = scripted int, args recorded like the other
    boundary stubs."""
    mc, mi, mb = mail, mail + 4, mail + 8
    return hx(
        '53',
        '8b1d', struct.pack('<I', mc).hex(),
        'c1e305',
        '81c3', struct.pack('<I', recs).hex(),
        '890b',                                     # nav (ecx)
        '8b442408', '894304',                       # pawn arg
        'ff05', struct.pack('<I', mc).hex(),
        '8b1d', struct.pack('<I', mi).hex(),
        '8b0d', struct.pack('<I', mb).hex(),
        '8b0499',                                   # eax = [ecx+ebx*4]
        'ff05', struct.pack('<I', mi).hex(),
        '5b',
        'c20400')


def frand_stub():
    """appFrand record stub (patched over the Core IAT slot).  st0 = the next
    scripted f64 from the queue; the mailbox keeps count/index/base like the
    other boundary stubs so consumption order stays observable.  cdecl ret.
    The queue stores doubles because appFrand's real result is the exact
    80-bit product rand*(1/32767f) — at most 39 significant bits, so an f64
    load reproduces the extended value bit-for-bit where an f32 would not."""
    mc, mi, mb = MAIL_FR, MAIL_FR + 4, MAIL_FR + 8
    return hx(
        '8b0d', struct.pack('<I', mi).hex(),        # ecx = result idx
        '8b15', struct.pack('<I', mb).hex(),        # edx = results base
        'dd04ca',                                 # fld qword [edx+ecx*8]
        'ff05', struct.pack('<I', mi).hex(),        # ++idx
        'ff05', struct.pack('<I', mc).hex(),        # ++count
        'c3')


class ProbeError(RuntimeError):
    pass


class OracleMiss(ProbeError):
    pass


class Image:
    def __init__(self, path, expected_hash=None):
        self.data = Path(path).read_bytes()
        if expected_hash:
            digest = hashlib.sha256(self.data).hexdigest()
            if digest != expected_hash:
                raise ProbeError(f'{Path(path).name} sha256 {digest} != {expected_hash}')
        pe = struct.unpack_from('<I', self.data, 60)[0]
        opt = pe + 24
        self.base = struct.unpack_from('<I', self.data, opt + 28)[0]
        nsec = struct.unpack_from('<H', self.data, pe + 6)[0]
        optsize = struct.unpack_from('<H', self.data, pe + 20)[0]
        sec = opt + optsize
        self.sections = []
        self.size = 0
        for i in range(nsec):
            o = sec + i * 40
            vsize, va, rsize, raw = struct.unpack_from('<IIII', self.data, o + 8)
            self.sections.append((va, vsize, raw, rsize))
            self.size = max(self.size, va + vsize)

    def offset(self, rva):
        for va, vs, raw, rs in self.sections:
            if va <= rva < va + max(vs, rs):
                return raw + rva - va
        return None

    def read(self, rva, fmt):
        o = self.offset(rva)
        return struct.unpack_from('<' + fmt, self.data, o)

    def string(self, rva):
        o = self.offset(rva)
        end = self.data.index(b'\0', o)
        return self.data[o:end].decode('ascii', 'replace')

    def export_map(self):
        pe = struct.unpack_from('<I', self.data, 60)[0]
        opt = pe + 24
        edir_rva, _ = struct.unpack_from('<II', self.data, opt + 96)
        if not edir_rva:
            return {}
        o = self.offset(edir_rva)
        base = self.base
        addr_funcs = struct.unpack_from('<I', self.data, o + 28)[0]
        addr_names = struct.unpack_from('<I', self.data, o + 32)[0]
        addr_ord = struct.unpack_from('<I', self.data, o + 36)[0]
        nnames = struct.unpack_from('<I', self.data, o + 24)[0]
        out = {}
        for i in range(nnames):
            name_rva = struct.unpack_from('<I', self.data, self.offset(addr_names) + i * 4)[0]
            name = self.string(name_rva)
            ord_i = struct.unpack_from('<H', self.data, self.offset(addr_ord) + i * 2)[0]
            func_rva = struct.unpack_from('<I', self.data, self.offset(addr_funcs) + ord_i * 4)[0]
            out[name] = self.base + func_rva
        return out

    def imports(self):
        pe = struct.unpack_from('<I', self.data, 60)[0]
        opt = pe + 24
        idir_rva, _ = struct.unpack_from('<II', self.data, opt + 104)
        if not idir_rva:
            return
        o = self.offset(idir_rva)
        while True:
            ilt, ts, fwd, name_rva, iat = struct.unpack_from('<IIIII', self.data, o)
            if not ilt and not iat:
                break
            dll = self.string(name_rva).lower()
            lookup = self.offset(ilt) if ilt else self.offset(iat)
            j = 0
            while True:
                entry = struct.unpack_from('<I', self.data, lookup + j * 4)[0]
                if not entry:
                    break
                sym = f'#{entry & 0xffff}' if entry & 0x80000000 else self.string(entry + 2)
                yield dll, sym, self.base + iat + j * 4
                j += 1
            o += 20


class NavProbe:
    """Fabricates pawn/zone/level/nav-graph memory and runs the real native
    bytes.  Every MoveActor/FarMoveActor/SingleLineCheck call through the
    fabricated level vtable, plus PointRegion/FastLineCheck thunk calls, is
    captured as a command; scripted results feed back per call."""

    def __init__(self, game_root):
        self.cpu = cpu = Uc(UC_ARCH_X86, UC_MODE_32)
        self.thunks = {}
        self.trace = []
        self.images = {name: Image(game_root / 'System' / name) for name in HASHES}
        for image in self.images.values():
            cpu.mem_map(image.base, (image.size + 4095) & ~4095)
            cpu.mem_write(image.base, image.data[:1024])
            for virtual, _vsize, raw, size in image.sections:
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
        table = bytes().join(struct.pack('<f', math.sin(i * 6.283185307179586 / 16384))
                             for i in range(16384))
        cpu.mem_write(SINE_TABLE, table)
        # The AI-pick bodies are the only corpus callers of appFrand; replace the
        # Core import with the scripted queue so random draws are deterministic
        # and observable (the real MSVCRT rand would need thread-local state).
        self.frand_body = self.deploy(frand_stub())
        self.write(APPFRAND_IAT, 'I', self.frand_body)
        self.stub_frand = self.frand_body
        # GNatives evaluator stubs.
        self.write(GNATIVES + TOK_VECTOR * 4, 'I', self.deploy(dword_stub(3)))
        self.write(GNATIVES + TOK_FLOAT * 4, 'I', self.deploy(dword_stub(1)))
        self.write(GNATIVES + TOK_OBJECT * 4, 'I', self.deploy(dword_stub(1)))
        self.write(GNATIVES + TOK_INT * 4, 'I', self.deploy(dword_stub(1)))
        self.write(GNATIVES + TOK_NOTHING * 4, 'I', self.deploy(dword_stub(0)))
        self.write(GNATIVES + TOK_OUT * 4, 'I', self.deploy(outarg_stub()))
        # Fabricated level vtable: MoveActor +0x88, FarMoveActor +0x8c,
        # SingleLineCheck +0xc0 -> recording stubs; every other slot -> trap.
        self.vtable = self.alloc(0x100)
        trap = self.deploy(hx('0f0b', 'c3'))          # ud2 guard
        for i in range(0x100 // 4):
            self.write(self.vtable + i * 4, 'I', trap)
        # Captured-argument record buffers live in heap space (one record per
        # boundary call); the mailbox headers only keep count/index/base.
        self.rec_mv = self.alloc(64 * RESULT_DEPTH)
        self.rec_fm = self.alloc(32 * RESULT_DEPTH)
        self.rec_sl = self.alloc(64 * RESULT_DEPTH)
        self.rec_pr = self.alloc(32 * RESULT_DEPTH)
        self.rec_fl = self.alloc(32 * RESULT_DEPTH)
        self.rec_sc = self.alloc(32 * RESULT_DEPTH)
        # Boundary stub addresses -> op name, so the code hook can log which
        # call site (the return address at [esp] on stub entry) invoked each.
        self.stub_entry = {}
        # Final `ret` of the MoveActor/FarMoveActor stubs: the location commit
        # is done there, which is where the optional SetActorZone stand-in
        # (scene 'waterPlane') refreshes Region.Zone.
        self.stub_ret = {}
        for op, slot, builder in [
                ('moveActor', self.vtable + 0x88, move_stub(MAIL_MV, self.rec_mv)),
                ('farMoveActor', self.vtable + 0x8c, farmove_stub(MAIL_FM, self.rec_fm)),
                ('singleLineCheck', self.vtable + 0xc0, slcheck_stub(MAIL_SL, self.rec_sl))]:
            addr = self.deploy(builder)
            self.write(slot, 'I', addr)
            self.stub_entry[addr] = op
            if op != 'singleLineCheck':
                self.stub_ret[addr + len(builder) - 3] = op
        # Per-scene controlled-world options (reset in run()).
        self.water_plane = None
        self.move_nearly_zero = False
        self.coverage_ranges = []
        self.covered = set()
        for op, thunk, builder in [
                ('pointRegion', POINTREGION_THUNK, pointregion_stub(MAIL_PR, self.rec_pr)),
                ('fastLineCheck', FASTLINE_THUNK, fastline_stub(MAIL_FL, self.rec_fl)),
                ('specialCost', SPECIALCOST_THUNK, specialcost_stub(MAIL_SC, self.rec_sc))]:
            cpu.mem_write(thunk, builder)
            self.stub_entry[thunk] = op
        self.callsite_log = []
        cpu.mem_write(EH_PROLOG, hx('33c0', 'c3'))
        # Import-body intercepts dispatched from the code hook.
        self.isa_body = exports['core.dll'].get('?IsA@UObject@@QBEHPAVUClass@@@Z')
        self.fail_body = exports['core.dll'].get('?appFailAssert@@YAXPBD0H@Z')
        self.unwind_body = exports['core.dll'].get('?appUnwindf@@YAXPBGZZ')
        self.warnf_body = exports['core.dll'].get('?appWarnf@@YAXPBGZZ')
        self.probing_body = exports['core.dll'].get('?IsProbing@UObject@@QAEHVFName@@@Z')
        self.logf_body = exports['core.dll'].get('?Logf@FOutputDevice@@QAAXPBGZZ')
        self.logf_log = []
        if self.isa_body:
            cpu.mem_write(self.isa_body, isa_stub())
        self.missed_oracles = []
        self.probing_results = []
        self.probing_index = 0
        self.last_image_ip = 0
        self.watch_ips = set()
        # Heap watermark: every allocation above this point is per-scene and is
        # reclaimed at the top of run(), so a batch of scenes does not grow the
        # fabricated heap without bound.
        self.heap_mark = self.free
        cpu.hook_add(UC_HOOK_CODE, self.on_instruction)
        cpu.hook_add(UC_HOOK_MEM_INVALID, self.on_bad_memory)

    def deploy(self, code):
        address = self.alloc(len(code))
        self.cpu.mem_write(address, code)
        return address

    def alloc(self, size):
        address = self.free
        span = (size + 15) & ~15
        self.free += span
        if self.free >= 0x23000000:
            raise MemoryError('Probe allocation limit exceeded')
        # The heap watermark rewinds self.free per scene; without re-zeroing,
        # fields a later scene leaves unset would retain stale data.  mem_map
        # gave zeros on first use, so reproduce that here.
        self.cpu.mem_write(address, b'\x00' * span)
        return address

    def write(self, address, fmt, *values):
        self.cpu.mem_write(address, struct.pack('<' + fmt, *values))

    def read(self, address, fmt):
        return struct.unpack('<' + fmt, self.cpu.mem_read(address, struct.calcsize('<' + fmt)))

    def f32(self, address):
        return self.read(address, 'f')[0]

    def on_bad_memory(self, cpu, access, address, size, value, data):
        print('BADMEM access=%r addr=%x trace=%r' % (access, address, self.trace[-16:]), file=sys.stderr)
        raise ProbeError(f'Invalid memory {address:x}; trace {self.trace[-12:]}')

    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address in self.thunks:
            dll, symbol = self.thunks[address]
            raise ProbeError(f'Unresolved import {dll}!{symbol}; trace {self.trace[-12:]}')
        if address == self.fail_body:
            raise ProbeError(f'appFailAssert fired; trace {self.trace[-12:]}')
        if address == self.unwind_body:
            raise ProbeError(f'appUnwindf fired; trace {self.trace[-12:]}')
        if address == self.logf_body:
            # FOutputDevice::Logf(this, fmt, ...) is cdecl: record the format
            # string and the 9 dwords after it, then return to the caller.
            esp = cpu.reg_read(UC_X86_REG_ESP)
            site = self.read(esp, 'I')[0]
            fmt = self.read(esp + 8, 'I')[0]
            text, o = [], fmt
            while len(text) < 256:
                c = self.read(o, 'H')[0]
                if not c:
                    break
                text.append(chr(c))
                o += 2
            self.logf_log.append({'site': '%x' % site, 'format': ''.join(text),
                                  'args': ['%08x' % w for w in self.read(esp + 12, '9I')]})
            self.callsite_log.append(('logf', site))
            cpu.reg_write(UC_X86_REG_EIP, site)
            cpu.reg_write(UC_X86_REG_ESP, esp + 4)
            return
        if address == self.warnf_body or address == self.probing_body:
            # Variadic warn / IsProbing(FName): consume one stack arg, eax=scripted.
            esp = cpu.reg_read(UC_X86_REG_ESP)
            if address == self.probing_body:
                value = self.probing_results[self.probing_index % len(self.probing_results)] \
                    if self.probing_results else 0
                self.probing_index += 1
            else:
                value = 0
            cpu.reg_write(UC_X86_REG_EAX, value)
            cpu.reg_write(UC_X86_REG_EIP, self.read(esp, 'I')[0])
            cpu.reg_write(UC_X86_REG_ESP, esp + 4)
            return
        self.trace.append(hex(address))
        if len(self.trace) > 200:
            self.trace.pop(0)
        for lo, hi in self.coverage_ranges:
            if lo <= address < hi:
                self.covered.add(address)
        if address in self.stub_ret and self.water_plane:
            # SetActorZone stand-in: after the committed move, Region.Zone
            # (+0xc8) follows the scene's water plane (FootRegion/HeadRegion
            # and the +0xd0 ZoneNumber byte are left as fabricated).
            esp = cpu.reg_read(UC_X86_REG_ESP)
            actor = self.read(esp + 4, 'I')[0]
            self.write(actor + 0xc8, 'I', self.plane_zone(self.read(actor + 0x11c, 'f')[0]))
        if address in self.stub_entry:
            esp = cpu.reg_read(UC_X86_REG_ESP)
            site = self.read(esp, 'I')[0]
            self.callsite_log.append((self.stub_entry[address], site))
            op = self.stub_entry[address]
            if op == 'moveActor' and self.move_nearly_zero and self.nearly_zero_move(cpu, esp):
                return
            if op == 'pointRegion' and self.water_plane:
                self.plane_point_region(cpu, esp)
                return
            if self.dump_stubs and self.stub_entry[address] == 'moveActor':
                idx = self.read(MAIL_MV + 4, 'I')[0]
                base = self.read(MAIL_MV + 8, 'I')[0]
                act = self.read(esp + 4, 'I')[0]
                dx = self.read(esp + 8, 'f')[0]
                lx = self.read(act + 0x114, 'f')[0] if act else -9
                print('STUB mv @%x idx=%d act=%x dx=%.2f act.lx=%.2f' % (
                    site, idx, act, dx, lx), file=sys.stderr)
        if address < 0x20000000:
            self.last_image_ip = address
        if address in self.watch_ips:
            r = cpu.reg_read(UC_X86_REG_EAX)
            ebx = cpu.reg_read(UC_X86_REG_EBX)
            ht, nz = 0.0, 0.0
            esp = cpu.reg_read(UC_X86_REG_ESP)
            ebp = cpu.reg_read(UC_X86_REG_EBP)
            sp1c, bp14 = 0, 0
            try:
                ht = self.read(ebx + 0x24, 'f')[0]
                nz = self.read(ebx + 0x1c, 'f')[0]
                sp1c = self.read(esp + 0x1c, 'I')[0]
                bp14 = self.read(ebp + 0x14, 'I')[0]
                raw = ' '.join('%02x:%x' % (o, self.read(ebx + o, 'I')[0])
                               for o in range(0, 44, 4))
            except Exception:
                raw = '?'
            try:
                lx = self.read(esi + 0x114, 'f')[0]
                ly = self.read(esi + 0x118, 'f')[0]
                lz = self.read(esi + 0x11c, 'f')[0]
            except Exception:
                lx = ly = lz = 0.0
            extra = ''
            try:
                extra = ' [ebp+c]=%s arg8=%x' % (
                    '%.3f' % self.read(ebp + 0xc, 'f')[0],
                    self.read(ebp + 8, 'I')[0])
            except Exception:
                extra = ' ?'
            print('WATCH @%x ebx=%x loc=(%.1f,%.1f,%.1f) [ebp-5c]=%s hit.t=%.3f hit.nz=%.3f%s | %s' % (
                address, ebx, lx, ly, lz,
                ('%.3f' % self.read(ebp - 0x5c, 'f')[0]) if ebp else '?', ht, nz, extra, raw),
                file=sys.stderr)

    # --- controlled world (scene options) -------------------------------------
    def plane_zone(self, z):
        """Scene 'waterPlane' {z, wet, dry}: the water zone strictly below the
        plane, the dry zone at or above it (NaN compares false: dry)."""
        return self.water_plane['wet'] if z < self.water_plane['z'] else self.water_plane['dry']

    def nearly_zero_move(self, cpu, esp):
        """ULevel::MoveActor's early return (0x1039915a..0x103991c6, see
        docs/swimming.md): every |Delta| component below the double 1e-4
        (unordered counts as below) with NewRotation equal to the actor's
        Rotation returns 1 before `Hit = FCheckResult(1)` -- no move, no zone
        update, the caller's Hit untouched and no scripted result consumed.
        The call is still recorded like the stub records it."""
        actor = self.read(esp + 4, 'I')[0]
        delta = self.read(esp + 8, '3f')
        if not all(not (abs(c) >= 1e-4) for c in delta):
            return False
        if self.read(esp + 0x14, '3i') != self.read(actor + 0x120, '3i'):
            return False
        count = self.read(MAIL_MV, 'I')[0]
        rec = self.rec_mv + count * 64
        self.write(rec, 'I', cpu.reg_read(UC_X86_REG_ECX))
        self.cpu.mem_write(rec + 4, bytes(self.cpu.mem_read(esp + 4, 0x30)))
        self.write(MAIL_MV, 'I', count + 1)
        cpu.reg_write(UC_X86_REG_EAX, 1)
        cpu.reg_write(UC_X86_REG_EIP, self.read(esp, 'I')[0])
        cpu.reg_write(UC_X86_REG_ESP, esp + 4 + 0x30)
        return True

    def plane_point_region(self, cpu, esp):
        """UModel::PointRegion (thunk 0x1030391d) under the scene water plane:
        records {model,out,world,point} like pointregion_stub, writes
        {zone, 0, 0} to *out and returns out (ret 0x14)."""
        out, world = self.read(esp + 4, '2I')
        point = self.read(esp + 0xc, '3f')
        count = self.read(MAIL_PR, 'I')[0]
        rec = self.rec_pr + count * 32
        self.write(rec, 'III', cpu.reg_read(UC_X86_REG_ECX), out, world)
        self.cpu.mem_write(rec + 12, bytes(self.cpu.mem_read(esp + 0xc, 12)))
        self.write(MAIL_PR, 'I', count + 1)
        self.write(out, '3I', self.plane_zone(point[2]), 0, 0)
        cpu.reg_write(UC_X86_REG_EAX, out)
        cpu.reg_write(UC_X86_REG_EIP, self.read(esp, 'I')[0])
        cpu.reg_write(UC_X86_REG_ESP, esp + 4 + 0x14)

    def instructions(self, ranges):
        """Instruction addresses of each named [lo, hi) body range (capstone),
        for instruction-coverage reports."""
        from capstone import Cs, CS_ARCH_X86, CS_MODE_32
        md = Cs(CS_ARCH_X86, CS_MODE_32)
        return {name: ['%x' % i.address for i in md.disasm(bytes(self.cpu.mem_read(lo, hi - lo)), lo)]
                for name, (lo, hi) in ranges.items()}

    # --- fabrication -------------------------------------------------------
    def class_object(self, super_class=0):
        cls = self.alloc(0x600)
        self.write(cls + 0x28, 'I', super_class)
        return cls

    CLASS_MAP = {
        'pawn': PAWN_CLASS, 'playerpawn': PLAYER_CLASS, 'levelinfo': LEVELINFO_CLASS,
        'navpoint': NAVPOINT_CLASS, 'navigationpoint': NAVPOINT_CLASS,
        'warpzonemarker': WARPMARKER_CLASS, 'inventory': INVENTORY_CLASS,
        'mover': MOVER_CLASS, 'trigger': TRIGGER_CLASS, 'actor': ACTOR_CLASS,
    }

    def zone(self, spec):
        """Fabricated ZoneInfo: +0x31c ZoneGravity (gravityZ at +0x324),
        +0x328 ZoneVelocity, +0x338 ZoneFluidFriction, +0x350 damageType
        dword, +0x388 flags byte (bit0 water, bit0x20 pain)."""
        z = self.alloc(0x480)
        self.write(z + 0x388, 'B', spec.get('flags388', 0)
                 | (1 if spec.get('water') else 0)
                 | (0x20 if spec.get('pain') else 0))
        self.write(z + 0x350, 'I', spec.get('damageType', 0))
        self.write(z + 0x324, 'f', spec.get('gravityZ', -950.0))
        if 'gravity' in spec:
            self.write(z + 0x31c, '3f', *spec['gravity'])
        if 'zoneVelocity' in spec:
            self.write(z + 0x328, '3f', *spec['zoneVelocity'])
        if 'fluidFriction' in spec:
            self.write(z + 0x338, 'f', spec['fluidFriction'])
        return z

    def region(self, zone_addr, leaf=0, num=0):
        return (zone_addr, leaf, num)

    def actor(self, spec, refs):
        obj = self.alloc(0x900)
        self.write(obj, 'I', self.alloc(0x120))
        cls_name = spec.get('cls', 'actor')
        cls_map = self.CLASS_MAP
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
                         ('destination', 0x354), ('focus', 0x360)]:
            if key in spec:
                self.write(obj + off, '3f', *spec[key])
        if 'rotation' in spec:
            self.write(obj + 0x120, '3i', *spec['rotation'])
        for key, off in [('collisionRadius', 0x1d4), ('collisionHeight', 0x1d8),
                         ('baseEyeHeight', 0x3f4), ('maxStepHeight', 0x38c),
                         ('desiredSpeed', 0x36c), ('maxDesiredSpeed', 0x370),
                         ('meleeRange', 0x374), ('groundSpeed', 0x378),
                         ('waterSpeed', 0x37c), ('airSpeed', 0x380),
                         ('accelRate', 0x384), ('jumpZ', 0x388)]:
            if key in spec:
                self.write(obj + off, 'f', spec[key])
        for key, off in [('flags1dc', 0x1dc), ('flags318', 0x318), ('flags31c', 0x31c),
                         ('flags28', 0x28), ('field444', 0x444), ('field4ec', 0x4ec),
                         ('physics', 0x30),
                         # NavigationPoint path-search state: +0x448 packs
                         # bPlayerOnly(1)/bEndPoint(2)/bEndPointOnly(4)/
                         # bSpecialCost(8)/bOneWayPath(0x10).
                         ('visitedWeight', 0x420), ('bestPathWeight', 0x428),
                         ('cost', 0x440), ('extraCost', 0x444), ('flags448', 0x448)]:
            if key in spec:
                self.write(obj + off, 'I', spec[key])
        for key, off in [('specialPause', 0x460)]:
            if key in spec:
                self.write(obj + off, 'f', spec[key])
        # Byte-sized fields (walkReach reads the +0xd0 collide flag as a byte).
        for key, off in [('collideFlag', 0xd0)]:
            if key in spec:
                self.write(obj + off, 'B', spec[key])
        for key, off in [('enemy', 0x3cc), ('moveTarget', 0x34c), ('faceTarget', 0x350),
                         ('owner', 0x3c), ('nextPawn', 0x498), ('nextNav', 0x42c),
                         ('weapon', 0x3d0), ('field398', 0x398),
                         ('markedWarpZone', 0x44c),
                         # NavigationPoint path-search links + Pawn special nav.
                         ('nextOrdered', 0x430), ('prevOrdered', 0x434),
                         ('startPath', 0x438), ('previousPath', 0x43c),
                         ('specialGoal', 0x45c)]:
            ref = spec.get(key)
            # String refs resolve only when the target already exists; the
            # second pass (run() below) fills in forward references.
            if isinstance(ref, str):
                if ref in refs:
                    self.write(obj + off, 'I', refs[ref])
            elif ref is not None:
                self.write(obj + off, 'I', ref)
        return obj

    def level(self, spec, actor_list, reach_specs):
        """ULevel: +0 vtable, +0x2c Actors.Data, +0x30 Actors.Num, +0x8c
        ReachSpec TArray data, +0x90 ReachSpec TArray Num, +0x98 Model.
        The nav-list head lives on LevelInfo (+0x548), not here."""
        lvl = self.alloc(0x600)
        self.write(lvl, 'I', self.vtable)
        actors = self.alloc(4 * max(1, len(actor_list)))
        for i, a in enumerate(actor_list):
            self.write(actors + i * 4, 'I', a)
        self.write(lvl + 0x2c, 'I', actors)
        self.write(lvl + 0x30, 'I', len(actor_list))
        # ReachSpec TArray: contiguous 28-byte records
        # {+0:distance,+4:start,+8:end,+0xc:radius,+0x10:height,+0x14:flags,+0x18:pruned}
        if reach_specs:
            mem = self.alloc(28 * len(reach_specs))
            for i, s in enumerate(reach_specs):
                o = mem + i * 28
                self.write(o + 0x00, 'I', s.get('distance', 0))
                self.write(o + 0x04, 'I', s.get('start', 0))
                self.write(o + 0x08, 'I', s.get('end', 0))
                self.write(o + 0x0c, 'I', s.get('radius', 0))
                self.write(o + 0x10, 'I', s.get('height', 0))
                self.write(o + 0x14, 'I', s.get('flags', 0))
                self.write(o + 0x18, 'I', s.get('pruned', 0))
            self.write(lvl + 0x8c, 'I', mem)
        self.write(lvl + 0x90, 'I', len(reach_specs))   # ReachSpecs.Num
        self.write(lvl + 0x94, 'I', len(reach_specs))   # ReachSpecs.Max
        model = self.alloc(0x40)
        self.write(lvl + 0x98, 'I', model)
        return lvl, model

    # --- run ---------------------------------------------------------------
    def run(self, scene):
        # Reclaim the prior scene's heap: restore the allocation pointer to the
        # watermark captured at the end of __init__ (below the persistent
        # vtable/stub/record-buffer allocations) so batches stay bounded.
        self.free = self.heap_mark
        self.callsite_log = []
        self.logf_log = []
        self.water_plane = None
        self.move_nearly_zero = bool(scene.get('moveNearlyZero'))
        self.coverage_ranges = [(int(lo, 16), int(hi, 16)) for lo, hi in scene.get('coverage', [])]
        self.covered = set()
        if 'disasm' in scene:
            return {'instructions': self.instructions(
                {name: (int(lo, 16), int(hi, 16)) for name, (lo, hi) in scene['disasm'].items()})}
        for mail in (MAIL_MV, MAIL_FM, MAIL_SL, MAIL_PR, MAIL_FL, MAIL_FR, MAIL_SC):
            self.write(mail, 'I', 0)
            self.write(mail + 4, 'I', 0)
        self.probing_results = scene.get('probing', [])
        self.watch_ips = {int(a, 0) for a in scene.get('watch', [])}
        self.dump_stubs = bool(scene.get('dumpStubs', 0))
        self.probing_index = 0
        self.write(GISEDITOR, 'I', self.alloc(8))
        self.write(self.read(GISEDITOR, 'I')[0], 'I', scene.get('gIsEditor', 0))
        self.write(GTIMING, 'I', self.alloc(8))
        self.write(self.read(GTIMING, 'I')[0], 'I', scene.get('gTiming', 0))

        # Scripted boundary results.  The reach helpers loop ~100 steps and
        # may call a boundary many times; pad each scripted list by repeating
        # its last entry so the recording index never runs past the buffer.
        def pad(lst, default):
            lst = list(lst) if lst else [default]
            while len(lst) < RESULT_DEPTH:
                lst.append(lst[-1])
            return lst
        # Buffers are allocated now (base -> mailbox); the per-call hit records
        # are written later once actor refs exist (see the post-fab fill below).
        mv = pad(scene.get('moveActor', []), {'ret': 0})
        mv_mem = self.alloc(48 * len(mv))
        self.write(MAIL_MV + 8, 'I', mv_mem)
        fm = pad(scene.get('farMove', []), 1)
        fm_mem = self.alloc(4 * len(fm))
        for i, v in enumerate(fm):
            self.write(fm_mem + i * 4, 'I', v)
        self.write(MAIL_FM + 8, 'I', fm_mem)
        sl = pad(scene.get('singleLine', []), {'ret': 0})
        sl_mem = self.alloc(48 * len(sl))
        self.write(MAIL_SL + 8, 'I', sl_mem)
        fl = pad(scene.get('fastLine', []), 1)
        fl_mem = self.alloc(4 * len(fl))
        for i, v in enumerate(fl):
            self.write(fl_mem + i * 4, 'I', v)
        self.write(MAIL_FL + 8, 'I', fl_mem)
        # Scripted appFrand draws (f64 each) for the AI-pick direction helper.
        fr = pad(scene.get('frand', []), 0.5)
        fr_mem = self.alloc(8 * len(fr))
        for i, v in enumerate(fr):
            self.write(fr_mem + i * 8, 'd', v)
        self.write(MAIL_FR + 8, 'I', fr_mem)
        # Scripted NavigationPoint.SpecialCost returns (int each) for
        # bSpecialCost nodes reset inside scoutA.
        sc = pad(scene.get('specialCost', []), 0)
        sc_mem = self.alloc(4 * len(sc))
        for i, v in enumerate(sc):
            self.write(sc_mem + i * 4, 'i', v)
        self.write(MAIL_SC + 8, 'I', sc_mem)

        # Zones (built before actors so region fields can reference them).
        zones = {name: self.zone(spec) for name, spec in scene.get('zones', {}).items()}
        refs = dict(zones)
        if scene.get('waterPlane'):
            plane = scene['waterPlane']
            self.water_plane = {'z': plane['z'], 'wet': zones[plane['wet']], 'dry': zones[plane['dry']]}

        # PointRegion results carry zone pointers — resolve after zones exist.
        pr = pad(scene.get('pointRegion', []), {'zone': 0})
        pr_mem = self.alloc(12 * len(pr))
        for i, r in enumerate(pr):
            zref = r.get('zone', 0)
            if isinstance(zref, str):
                zref = refs.get(zref.removeprefix('USE:'), 0)
            self.write(pr_mem + i * 12, '3I', zref, r.get('leaf', 0), r.get('zoneNumber', 0))
        self.write(MAIL_PR + 8, 'I', pr_mem)
        actors = {}
        # Navigation points get their spec index arrays: upstreamPaths
        # +0x320 (inbound, spec.end==node), Paths +0x360 and PrunedPaths
        # +0x3a0 (outbound, spec.start==node), VisNoReachPaths +0x3e0.
        # Each is 16 dwords, -1 terminated.
        for name, spec in scene.get('navPoints', {}).items():
            obj = self.actor(spec, refs)
            # navPoints default to ANavigationPoint; a spec cls (e.g.
            # 'navpoint*' for a fabricated NavigationPoint subclass such as
            # PatrolPoint) keeps the class actor() resolved.
            if 'cls' not in spec:
                self.write(obj + 0x24, 'I', NAVPOINT_CLASS)
            for key, off in [('upstreamPaths', 0x320), ('paths', 0x360),
                             ('prunedPaths', 0x3a0), ('visNoReachPaths', 0x3e0)]:
                arr = spec.get(key, [])
                for i, idx in enumerate(arr):
                    self.write(obj + off + i * 4, 'i', idx)
                if len(arr) < 16:
                    self.write(obj + off + len(arr) * 4, 'i', -1)
            for key, off in [('regionZone', 0xc8), ('footZone', 0x330), ('headZone', 0x33c)]:
                ref = spec.get(key)
                if ref in zones:
                    self.write(obj + off, 'I', zones[ref])
            actors[name] = obj
            refs[name] = obj
        for name, spec in scene.get('actors', {}).items():
            obj = self.actor(spec, refs)
            for key, off in [('regionZone', 0xc8), ('footZone', 0x330), ('headZone', 0x33c)]:
                ref = spec.get(key)
                if ref in zones:
                    self.write(obj + off, 'I', zones[ref])
            actors[name] = obj
            refs[name] = obj
        pawn = self.actor(scene.get('pawn', {}), refs)
        pz = scene.get('pawn', {})
        for key, off in [('regionZone', 0xc8), ('footZone', 0x330), ('headZone', 0x33c)]:
            ref = pz.get(key)
            if ref in zones:
                self.write(pawn + off, 'I', zones[ref])
        actors['self'] = pawn
        refs['self'] = pawn
        # Second pass: resolve actor->actor refs that needed all objects first.
        ref_fields = [('enemy', 0x3cc), ('moveTarget', 0x34c), ('faceTarget', 0x350),
                      ('owner', 0x3c), ('nextPawn', 0x498), ('nextNav', 0x42c),
                      ('nextOrdered', 0x430), ('prevOrdered', 0x434),
                      ('startPath', 0x438), ('previousPath', 0x43c),
                      ('specialGoal', 0x45c)]
        for name, spec in list(scene.get('navPoints', {}).items()) + list(scene.get('actors', {}).items()):
            obj = actors[name]
            for key, off in ref_fields:
                ref = spec.get(key)
                if isinstance(ref, str) and ref in refs:
                    self.write(obj + off, 'I', refs[ref])
        for key, off in ref_fields:
            ref = pz.get(key)
            if isinstance(ref, str) and ref in refs:
                self.write(pawn + off, 'I', refs[ref])

        # ReachSpec graph: resolve named start/end refs.
        reach_specs = []
        for s in scene.get('reachSpecs', []):
            s = dict(s)
            s['start'] = refs.get(s.get('start'), s.get('start', 0))
            s['end'] = refs.get(s.get('end'), s.get('end', 0))
            reach_specs.append(s)
        nav_head = refs.get(scene.get('navList', ''), 0)
        # LevelInfo is Actors[0] — carries the +0x548 nav-point list.
        levelinfo = refs.get(scene.get('levelInfo', ''), 0) or self.actor(
            {'cls': 'levelinfo'}, refs)
        li_spec = scene.get('levelInfoSpec', {})
        self.write(levelinfo + 0x548, 'I', refs.get(li_spec.get('navList', scene.get('navList', '')), nav_head))
        actor_list = [levelinfo] + [a for n, a in actors.items()
                                    if n != 'self' and a != levelinfo]
        lvl, model = self.level(scene.get('level', {}), actor_list, reach_specs)
        self.write(pawn + 0xac, 'I', lvl)
        self.write(pawn + 0xa8, 'I', levelinfo)
        for n, a in actors.items():
            self.write(a + 0xac, 'I', lvl)
        refs['__level'] = lvl
        refs['__levelinfo'] = levelinfo
        refs['__model'] = model
        # Named scratch buffers for by-reference out params (FCheckResult,
        # FVector outs).  Referenced from directArgs as e.g. 'hitbuf'.
        for name, size in [('hitbuf', 64), ('vecbuf', 64), ('scratch', 256), ('foundbuf', 16)]:
            refs[name] = self.alloc(size)
        if 'vecbufInit' in scene:
            self.write(refs['vecbuf'], '3f', *scene['vecbufInit'])

        # Deferred hit records — 'actor' resolves named refs now that every
        # object exists.  Resolve a name once so the padded tail shares it.
        def resolve(v):
            return refs.get(v, v) if isinstance(v, str) else v
        for i, r in enumerate(mv):
            self.write(mv_mem + i * 48, 'I', r.get('ret', 1))
            hit = r.get('hit', {})
            self.write(mv_mem + i * 48 + 4, 'II3f3fIfi',
                       hit.get('f0', 0), resolve(hit.get('actor', 0)),
                       *hit.get('location', [0, 0, 0]), *hit.get('normal', [0, 0, 0]),
                       hit.get('f20', 0), hit.get('time', 1.0), hit.get('item', -1))
        for i, r in enumerate(sl):
            if isinstance(r, int):
                r = {'ret': r}
            self.write(sl_mem + i * 48, 'I', r.get('ret', 1))
            hit = r.get('hit', {})
            self.write(sl_mem + i * 48 + 4, 'II3f3fIfi',
                       hit.get('f0', 0), resolve(hit.get('actor', 0)),
                       *hit.get('location', [0, 0, 0]), *hit.get('normal', [0, 0, 0]),
                       hit.get('f20', 0), hit.get('time', 1.0), hit.get('item', -1))
        # Class super-chains on the REAL class VAs.
        self.write(PLAYER_CLASS + 0x28, 'I', PAWN_CLASS)
        self.write(PAWN_CLASS + 0x28, 'I', self.class_object(0))
        self.write(NAVPOINT_CLASS + 0x28, 'I', ACTOR_CLASS)
        self.write(WARPMARKER_CLASS + 0x28, 'I', NAVPOINT_CLASS)
        self.write(INVENTORY_CLASS + 0x28, 'I', self.class_object(0))
        self.write(MOVER_CLASS + 0x28, 'I', self.class_object(0))
        self.write(TRIGGER_CLASS + 0x28, 'I', ACTOR_CLASS)
        self.write(ACTOR_CLASS + 0x28, 'I', 0)
        self.write(LEVELINFO_CLASS + 0x28, 'I', self.class_object(0))

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
                stream += struct.pack('<I', refs.get(arg['value'], 0))
            elif kind == 'out':
                stream.append(TOK_OUT)
                stream += struct.pack('<I', refs[arg['value']])
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
        # Optional exec-frame state: a sentinel in the result slot (so an
        # unwritten result is visible) and a stale Core GPropAddr value left by
        # an earlier lvalue evaluation (a named ref, or 0).
        if 'resultInit' in scene:
            self.write(result_out, 'I', scene['resultInit'] & 0xffffffff)
        if 'gPropAddr' in scene:
            stale = scene['gPropAddr']
            self.write(self.read(GPROPADDR, 'I')[0], 'I',
                       refs.get(stale, 0) if isinstance(stale, str) else stale)

        body = BODIES[scene['body']]
        direct_args = scene.get('directArgs')
        for reg, value in [(UC_X86_REG_ESP, self.stack),
                           (UC_X86_REG_FPCW, 0x037f), (UC_X86_REG_FPSW, 0),
                           (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        this_obj = refs.get(scene.get('this', 'self'), pawn)
        self.cpu.reg_write(UC_X86_REG_ECX, this_obj)
        self.write(self.stack, 'I', self.done)
        if direct_args is not None:
            for i, arg in enumerate(direct_args):
                # Explicit typed args keep JSON ints distinct from floats:
                # {'f': x} -> float32, {'i': x} -> dword, {'ref': name} -> pointer.
                if isinstance(arg, dict):
                    if 'f' in arg:
                        self.write(self.stack + 4 + i * 4, 'f', arg['f'])
                        continue
                    if 'i' in arg:
                        self.write(self.stack + 4 + i * 4, 'I', arg['i'] & 0xffffffff)
                        continue
                    if 'ref' in arg:
                        self.write(self.stack + 4 + i * 4, 'I', refs.get(arg['ref'], 0))
                        continue
                if isinstance(arg, float):
                    self.write(self.stack + 4 + i * 4, 'f', arg)
                else:
                    self.write(self.stack + 4 + i * 4, 'I',
                               refs.get(arg, arg) if isinstance(arg, str) else arg)
        else:
            self.write(self.stack + 4, 'I', frame)
            self.write(self.stack + 8, 'I', result_out)
        try:
            self.cpu.emu_start(body, self.done + 1, count=8000000)
        except Exception as e:
            ec, ea = self.cpu.reg_read(UC_X86_REG_ECX), self.cpu.reg_read(UC_X86_REG_EAX)
            def d(a):
                try:
                    return '%x' % self.read(a, 'I')[0]
                except Exception:
                    return '?'
            raise ProbeError(
                f'{e}; eip={self.cpu.reg_read(UC_X86_REG_EIP):#x} '
                f'last_image={self.last_image_ip:#x} ecx={ec:#x} eax={ea:#x} '
                f'lvl={lvl:#x} [lvl]={d(lvl)} vt={self.vtable:#x} vt88={d(self.vtable+0x88)} '
                f'vt8c={d(self.vtable+0x8c)} vtc0={d(self.vtable+0xc0)} '
                f'trace {self.trace[-16:]}')
        if self.cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise ProbeError('Native instruction budget exceeded')

        def vec3(rec):
            return [struct.unpack('<f', struct.pack('<I', w))[0] for w in rec]
        commands = []
        for i in range(self.read(MAIL_MV, 'I')[0]):
            rec = self.read(self.rec_mv + i * 64, '14I')
            commands.append({'op': 'moveActor', 'level': rec[0], 'actor': rec[1],
                             'delta': vec3(rec[2:5]), 'rot': vec3(rec[5:8]),
                             'deltaBits': ['%08x' % w for w in rec[2:5]],
                             'rotationBits': ['%08x' % w for w in rec[5:8]],
                             'hit': rec[8], 'flags': list(rec[9:13])})
        for i in range(self.read(MAIL_FM, 'I')[0]):
            rec = self.read(self.rec_fm + i * 32, '8I')
            commands.append({'op': 'farMoveActor', 'level': rec[0], 'actor': rec[1],
                             'dest': vec3(rec[2:5]),
                             'destBits': ['%08x' % w for w in rec[2:5]],
                             'test': rec[5], 'noCheck': rec[6]})
        for i in range(self.read(MAIL_SL, 'I')[0]):
            rec = self.read(self.rec_sl + i * 64, '14I')
            commands.append({'op': 'singleLineCheck', 'level': rec[0], 'hit': rec[1],
                             'source': rec[2], 'end': vec3(rec[3:6]),
                             'start': vec3(rec[6:9]), 'flags': rec[9],
                             'extent': vec3(rec[10:13])})
        for i in range(self.read(MAIL_PR, 'I')[0]):
            rec = self.read(self.rec_pr + i * 32, '8I')
            commands.append({'op': 'pointRegion', 'model': rec[0], 'out': rec[1],
                             'world': rec[2], 'point': vec3(rec[3:6])})
        for i in range(self.read(MAIL_FL, 'I')[0]):
            rec = self.read(self.rec_fl + i * 32, '8I')
            commands.append({'op': 'fastLineCheck', 'model': rec[0],
                             'end': vec3(rec[1:4]), 'start': vec3(rec[4:7])})
        for i in range(self.read(MAIL_SC, 'I')[0]):
            rec = self.read(self.rec_sc + i * 32, '8I')
            commands.append({'op': 'specialCost', 'nav': rec[0], 'pawn': rec[1]})
        # `commands` is grouped by operation; `callsites` preserves global
        # order so consumers can interleave each operation's captured records.
        def vec(obj, off):
            return list(self.read(obj + off, '3f'))
        def bits(obj, off):
            return ['%08x' % w for w in self.read(obj + off, '3I')]
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
            # Script bytes the exec consumed (its P_GETs plus P_FINISH).
            'codeConsumed': self.read(frame + 0xc, 'I')[0] - code,
            'st0': st0_bits,
            'commands': commands,
            'counts': {op: self.read(mail, 'I')[0]
                       for op, mail in [('moveActor', MAIL_MV), ('farMoveActor', MAIL_FM),
                                        ('singleLineCheck', MAIL_SL), ('pointRegion', MAIL_PR),
                                        ('fastLineCheck', MAIL_FL), ('frand', MAIL_FR),
                                        ('specialCost', MAIL_SC)]},
            'callsites': [[op, '%x' % site] for op, site in self.callsite_log],
            'mvres': [[self.read(mv_mem + i * 48, 'I')[0],
                       round(self.read(mv_mem + i * 48 + 0x28, 'f')[0], 4)]
                      for i in range(4)],
            'hit44src': ['%08x' % self.read(mv_mem + 48 + 4 + o, 'I')[0] for o in range(0, 44, 4)],
            'pawn': {
                'location': vec(pawn, 0x114), 'locationBits': bits(pawn, 0x114),
                'velocity': vec(pawn, 0x144), 'velocityBits': bits(pawn, 0x144),
                'destination': vec(pawn, 0x354), 'focus': vec(pawn, 0x360),
                'flags318': self.read(pawn + 0x318, 'I')[0],
                'physics': self.read(pawn + 0x30, 'B')[0],
                'moveTarget': self.read(pawn + 0x34c, 'I')[0],
                'regionZone': self.read(pawn + 0xc8, 'I')[0],
            },
            'probingUsed': self.probing_index,
            'found': '%08x' % self.read(refs['foundbuf'], 'I')[0],
            # NavigationPoint post-run search state (+0x420 visitedWeight,
            # +0x428 bestPathWeight, +0x430/+0x434 ordered links, +0x438
            # startPath, +0x43c previousPath, +0x440 cost, +0x444 ExtraCost,
            # +0x448 flags) plus the pawn special-nav fields.
            'navState': {
                name: {
                    'visitedWeight': self.read(obj + 0x420, 'i')[0],
                    'bestPathWeight': self.read(obj + 0x428, 'i')[0],
                    'nextOrdered': '%08x' % self.read(obj + 0x430, 'I')[0],
                    'prevOrdered': '%08x' % self.read(obj + 0x434, 'I')[0],
                    'startPath': '%08x' % self.read(obj + 0x438, 'I')[0],
                    'previousPath': '%08x' % self.read(obj + 0x43c, 'I')[0],
                    'cost': self.read(obj + 0x440, 'i')[0],
                    'extraCost': self.read(obj + 0x444, 'i')[0],
                    'flags448': '%08x' % self.read(obj + 0x448, 'I')[0],
                } for name, obj in actors.items() if name != 'self'
            },
            'pawnSpecial': {
                'specialGoal': '%08x' % self.read(pawn + 0x45c, 'I')[0],
                'specialPause': self.read(pawn + 0x460, 'f')[0],
            },
            'hitbuf': ['%08x' % w for w in self.read(refs['hitbuf'], '12I')],
            'vecbuf': ['%08x' % w for w in self.read(refs['vecbuf'], '4I')],
            'pawnAddress': pawn,
            'addresses': {n: a for n, a in refs.items() if not n.startswith('__out_')},
            'levelAddress': lvl,
            'missedOracles': self.missed_oracles,
            'logf': self.logf_log,
            'coverage': ['%x' % a for a in sorted(self.covered)],
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
    probe = NavProbe(root / 'Deus Ex GOTY Edition')
    if isinstance(payload, list):
        out = []
        for scene in payload:
            try:
                out.append({'ok': True, 'result': probe.run(scene)})
            except (ProbeError, OracleMiss) as e:
                out.append({'ok': False, 'error': str(e), 'type': type(e).__name__})
            except Exception as e:
                import traceback
                traceback.print_exc(file=sys.stderr)
                out.append({'ok': False, 'error': str(e), 'type': type(e).__name__})
        print(json.dumps(sanitize(out)))
    else:
        print(json.dumps(sanitize(probe.run(payload)), indent=1))


if __name__ == '__main__':
    main()
