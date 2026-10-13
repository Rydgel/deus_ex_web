#!/usr/bin/env python3
"""Execute the original AScriptedPawn::Tick (DeusEx.dll 0x100195a0) and its two helpers on a fabricated pawn.

Optional research tool, never imported by the browser. The real DeusEx.dll, Engine.dll, Core.dll and MSVCRT.dll bytes run
under Unicorn (hash-checked, as native-pawn-latent-probe.py); the controlled leaves are what the function calls out to:

  * AActor::Tick (Engine export, the Super tick at the end): records (this, delta, tickType), returns the scene's value;
  * AActor::InStasis (Engine export): the scene's value;
  * ULevel vtable +0x94 (DestroyActor(actor, flag)): recorded;
  * FName::FName(const TCHAR*, EFindName), UObject::FindFunctionChecked and the pawn vtable's ProcessEvent (+0x10): the
    event names (EnableCloak, ExtinguishFire, SpurtBlood) and their bool parameter are recorded in call order.

appSqrt (Core) and the x87 arithmetic are the original instructions. Input: a JSON list of scenes on stdin or in argv[1];
output: a JSON list of results (every field the function can write, as float32/dword bits, and the recorded calls).
A scene: {"fields": {name: value}, "delta": f32, "tickType": int, "time": double (Level.TimeSeconds),
"inStasis": 0|1, "superResult": 0|1}; field names are FIELDS below (floats as numbers, bit-fields as booleans).
"""
import importlib.util
import json
import struct
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('latent', Path(__file__).with_name('native-pawn-latent-probe.py'))
latent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(latent)
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP, UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG

DEUSEX_HASH = 'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04'
latent.HASHES['DeusEx.dll'] = DEUSEX_HASH

ENTRY = 0x100195a0
LEVEL_DESTROY_SLOT = 0x94
EVENT_NAMES = {'EnableCloak': 0x1f000010, 'ExtinguishFire': 0x1f000011, 'SpurtBlood': 0x1f000012}
NAME_OF = {v: k for k, v in EVENT_NAMES.items()}

# name: (offset, struct format, bit mask or None). Bit-fields are one dword; scenes give a boolean.
FIELDS = {
    'Physics': (0x30, 'B', None), 'Role': (0x31, 'B', None), 'RemoteRole': (0x32, 'B', None),
    'LastRenderTime': (0x34, 'f', None), 'DistanceFromPlayer': (0x38, 'f', None),
    'Velocity': (0x144, '3f', None), 'Acceleration': (0x150, '3f', None), 'PrePivot': (0x180, '3f', None),
    'bSimulatedPawn': (0x30c, 'I', 0x40), 'bAdvancedTactics': (0x318, 'I', 0x80000000),
    'MoveTimer': (0x348, 'f', None), 'Weapon': (0x3d0, 'I', None), 'Health': (0x428, 'i', None),
    'bOnFire': (0x5a4, 'I', 1), 'burnTimer': (0x5a8, 'f', None),
    'CarcassCheckTimer': (0x640, 'f', None), 'PotentialEnemyAlliance': (0x644, 'I', None),
    'PotentialEnemyTimer': (0x648, 'f', None), 'BeamCheckTimer': (0x64c, 'f', None),
    'bAlliancesChanged': (0x650, 'I', 0x08), 'ReloadTimer': (0x668, 'f', None),
    'DesiredPrePivot': (0x69c, '3f', None), 'PrePivotTime': (0x6a8, 'f', None),
    'bCanBleed': (0x6b8, 'I', 1), 'BleedRate': (0x6bc, 'f', None), 'DropCounter': (0x6c0, 'f', None),
    'ClotPeriod': (0x6c4, 'f', None),
    'AgitationDecayRate': (0x720, 'f', None), 'AgitationTimer': (0x724, 'f', None),
    'AgitationCheckTimer': (0x728, 'f', None), 'PlayerAgitationTimer': (0x72c, 'f', None),
    'FearSustainTime': (0x730, 'f', None), 'FearDecayRate': (0x734, 'f', None),
    'FearTimer': (0x738, 'f', None), 'FearLevel': (0x73c, 'f', None),
    'AlarmTimer': (0x768, 'f', None), 'WeaponTimer': (0x76c, 'f', None), 'FireTimer': (0x770, 'f', None),
    'SpecialTimer': (0x774, 'f', None), 'bDisappear': (0x788, 'I', 1),
    'bTickVisibleOnly': (0x910, 'I', 0x400),
    'bClearedObstacle': (0x974, 'I', 0x08), 'TurnDirection': (0x978, 'B', None), 'NextDirection': (0x979, 'B', None),
    'ActorAvoiding': (0x97c, 'I', None), 'AvoidWallTimer': (0x980, 'f', None), 'AvoidBumpTimer': (0x984, 'f', None),
    'ObstacleTimer': (0x988, 'f', None), 'TakeHitTimer': (0x9b0, 'f', None), 'BurnPeriod': (0x9bc, 'f', None),
    'FutzTimer': (0x9c0, 'f', None), 'DistressTimer': (0x9c4, 'f', None),
    'bHasCloak': (0x9d8, 'I', 0x08), 'CloakThreshold': (0x9dc, 'i', None), 'CloakEMPTimer': (0x9e0, 'f', None),
    'DropCounterBits': (0x6c0, 'I', None),
}
# the bit-field dwords the function rewrites whole: report them raw too
RAW_DWORDS = {'raw30c': 0x30c, 'raw318': 0x318, 'raw5a4': 0x5a4, 'raw650': 0x650, 'raw6b8': 0x6b8, 'raw788': 0x788,
              'raw910': 0x910, 'raw974': 0x974, 'raw9d8': 0x9d8}
ALLIANCES = 0x7ec          # FAllianceInfoEx[16]: AllianceName @0, AllianceLevel @4, AgitationLevel @8, bPermanent @0xc
ALLIANCE_STRIDE = 16
PAWN_SIZE = 0xa40


class TickProbe(latent.PawnLatentProbe):
    def __init__(self, game_root):
        super().__init__(game_root)
        exports = {name.lower(): image.export_map() for name, image in self.images.items()}
        self.hooks = {}
        self.superTick = exports['engine.dll']['?Tick@AActor@@UAEHMW4ELevelTick@@@Z']
        self.inStasis = exports['engine.dll']['?InStasis@AActor@@QAEHXZ']
        self.nameCtor = exports['core.dll']['??0FName@@QAE@PBGW4EFindName@@@Z']
        self.findFunction = exports['core.dll']['?FindFunctionChecked@UObject@@QAEPAVUFunction@@VFName@@H@Z']
        self.hooks[self.superTick] = self.on_super
        self.hooks[self.inStasis] = self.on_stasis
        self.hooks[self.nameCtor] = self.on_name
        self.hooks[self.findFunction] = self.on_find
        self.destroy_stub = self.deploy(b'\xc2\x08\x00')           # ret 8 (hooked: the original is the ULevel vtable slot)
        self.hooks[self.destroy_stub] = self.on_destroy
        self.scene = {}
        self.calls = []

    def on_instruction(self, cpu, address, size, data):
        hook = self.hooks.get(address)
        if hook:
            hook(cpu)
            return
        super().on_instruction(cpu, address, size, data)

    def arg(self, cpu, n):
        return self.read(cpu.reg_read(UC_X86_REG_ESP) + 4 + 4 * n, 'I')[0]

    def ret(self, cpu, value, pops):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        cpu.reg_write(UC_X86_REG_EAX, value & 0xffffffff)
        cpu.reg_write(UC_X86_REG_EIP, self.read(esp, 'I')[0])
        cpu.reg_write(UC_X86_REG_ESP, esp + 4 + pops)

    def on_super(self, cpu):
        self.calls.append({'call': 'super', 'this': cpu.reg_read(UC_X86_REG_ECX), 'delta': '%08x' % self.arg(cpu, 0), 'tickType': self.arg(cpu, 1)})
        self.ret(cpu, self.scene.get('superResult', 1), 8)

    def on_stasis(self, cpu):
        self.calls.append({'call': 'inStasis', 'this': cpu.reg_read(UC_X86_REG_ECX)})
        self.ret(cpu, self.scene.get('inStasis', 0), 0)

    def on_name(self, cpu):
        text = self.mem_wstring(self.arg(cpu, 0))
        this = cpu.reg_read(UC_X86_REG_ECX)
        if text not in EVENT_NAMES:
            raise latent.ProbeError(f'FName({text!r}) is not one of the events the oracle names')
        self.write(this, 'I', EVENT_NAMES[text])
        self.ret(cpu, this, 8)

    def on_find(self, cpu):
        name = self.arg(cpu, 0)
        self.calls.append({'call': 'find', 'name': NAME_OF.get(name, hex(name)), 'flag': self.arg(cpu, 1)})
        self.ret(cpu, name | 0x60000000, 8)

    def on_destroy(self, cpu):
        self.calls.append({'call': 'destroy', 'actor': self.arg(cpu, 0), 'flag': self.arg(cpu, 1)})
        self.ret(cpu, 1, 8)

    def mem_wstring(self, address):
        out = bytearray()
        while True:
            pair = bytes(self.cpu.mem_read(address + len(out), 2))
            if pair == b'\0\0':
                return out.decode('utf-16le')
            out += pair

    def build(self, scene):
        pawn = self.alloc(PAWN_SIZE)
        self.cpu.mem_write(pawn, bytes(PAWN_SIZE))
        level = self.alloc(0x200)
        level_vtable = self.alloc(0x200)
        self.write(level, 'I', level_vtable)
        self.write(level_vtable + LEVEL_DESTROY_SLOT, 'I', self.destroy_stub)
        self.write(level + 0xdc, 'd', scene.get('time', 100.0))
        # pawn: vtable (ProcessEvent at +0x10), Class (a class with no super), XLevel
        self.write(pawn, 'I', self.vtable())
        self.write(pawn + 0x24, 'I', self.class_object(0))
        self.write(pawn + 0xac, 'I', level)
        for name, value in scene.get('fields', {}).items():
            if name == 'AlliancesEx':
                for i, entry in enumerate(value):
                    base = pawn + ALLIANCES + ALLIANCE_STRIDE * i
                    self.write(base, 'I', entry.get('name', 0))
                    self.write(base + 4, 'f', entry.get('level', 0.0))
                    self.write(base + 8, 'f', entry.get('agitation', 0.0))
                    self.write(base + 12, 'I', 1 if entry.get('permanent') else 0)
                continue
            offset, fmt, mask = FIELDS[name]
            if mask is not None:
                word = self.read(pawn + offset, 'I')[0]
                word = (word | mask) if value else (word & ~mask & 0xffffffff)
                self.write(pawn + offset, 'I', word)
            elif fmt.endswith('f') and len(fmt) == 2:
                self.write(pawn + offset, fmt, *value)
            elif isinstance(value, (list, tuple)):
                self.write(pawn + offset, fmt, *value)
            else:
                self.write(pawn + offset, fmt, value)
        return pawn

    def result(self, pawn, eax):
        out = {'returned': eax, 'calls': self.calls, 'events': [], 'fields': {}, 'raw': {}}
        for i in range(self.read(latent.MAIL_EVT_COUNT, 'I')[0]):
            this, fn, parms, extra, arg0 = self.read(latent.MAIL_EVT_LIST + i * 20, '5I')
            out['events'].append({'this': this, 'name': NAME_OF.get(fn & 0x1fffffff, hex(fn)), 'parms': parms != 0, 'arg0': arg0})
        for name, (offset, fmt, mask) in FIELDS.items():
            if name == 'DropCounterBits' or mask is not None:
                continue
            count = 3 if fmt == '3f' else 1
            raw = [('%08x' % w) if fmt != 'B' else w for w in (self.read(pawn + offset, '3I' if count == 3 else ('I' if fmt != 'B' else 'B')))]
            out['fields'][name] = raw
        for name, offset in RAW_DWORDS.items():
            out['raw'][name] = '%08x' % self.read(pawn + offset, 'I')[0]
        entries = []
        for i in range(16):
            base = pawn + ALLIANCES + ALLIANCE_STRIDE * i
            entries.append(['%08x' % w for w in self.read(base, '4I')])
        out['alliances'] = entries
        return out

    def run_scene(self, scene):
        self.scene = scene
        self.calls = []
        self.write(latent.MAIL_EVT_COUNT, 'I', 0)
        self.write(latent.MAIL_FFC_COUNT, 'I', 0)
        pawn = self.build(scene)
        for reg, value in [(UC_X86_REG_ESP, self.stack), (UC_X86_REG_FPCW, 0x037f), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        self.cpu.reg_write(UC_X86_REG_ECX, pawn)
        self.write(self.stack, 'I', self.done)
        self.write(self.stack + 4, 'f', scene.get('delta', 1 / 60))
        self.write(self.stack + 8, 'I', scene.get('tickType', 2))
        self.cpu.emu_start(ENTRY, self.done + 1, count=4000000)
        if self.cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise latent.ProbeError('Native instruction budget exceeded')
        out = self.result(pawn, self.cpu.reg_read(UC_X86_REG_EAX))
        out['pawn'] = pawn
        return out


def main():
    root = Path(__file__).resolve().parent.parent
    game = root / 'Deus Ex GOTY Edition'
    if not game.exists():
        import os
        game = Path(os.environ.get('DEUS_EX_GAME_DIR', game))
    payload = json.loads(Path(sys.argv[1]).read_text() if len(sys.argv) > 1 else sys.stdin.read())
    probe = TickProbe(game)
    out = []
    for scene in payload:
        try:
            out.append({'ok': True, 'result': probe.run_scene(scene)})
        except latent.ProbeError as error:
            out.append({'ok': False, 'error': str(error)})
    print(json.dumps(latent.sanitize(out)))


if __name__ == '__main__':
    main()
