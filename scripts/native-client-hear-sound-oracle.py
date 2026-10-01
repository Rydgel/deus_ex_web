"""Execute Engine's original APawn::execClientHearSound (0x103dfc40),
AActor::execStopSound (0x103e27d0) and AActor::ProcessRemoteFunction
(0x103e5d90) on fabricated objects.

Replacements: one GNatives evaluator writes each P_GET's queued bytes, and the
audio subsystem's vtable +0x74 (PlaySound) and +0x78 (StopSoundId) are
recording stubs. Class chains, the PlayerPawn Player viewport, XLevel->Engine
->Audio, the Actor's bDeleteMe byte and ProcessRemoteFunction's
Role/DemoRecDriver/NetMode fields are plain memory.

  native-client-hear-sound-oracle.py GAME_ROOT CASES_JSON
"""
import importlib.util
import json
import struct
import sys
from pathlib import Path

from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP

_SPEC = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)

EVALUATOR_TABLE = 0x101F41B8  # Core GNatives
TOKEN = 0x1D                  # any token: its evaluator is replaced
END_FUNCTION_PARMS = 0x16
CLIENT_HEAR_SOUND = 0x103DFC40
STOP_SOUND = 0x103E27D0
PROCESS_REMOTE_FUNCTION = 0x103E5D90
PLAYER_PAWN_CLASS = 0x1058C160
VIEWPORT_CLASS = 0x10581068


class Probe(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.evaluator = self.alloc(16)
        self.cpu.mem_write(self.evaluator, bytes.fromhex('c2 08 00'))
        self.write(EVALUATOR_TABLE + TOKEN * 4, 'I', self.evaluator)
        # PlaySound(Actor, Id, Sound, FVector, Volume, Radius, Pitch): 9 dwords.
        self.play = self.alloc(16)
        self.cpu.mem_write(self.play, bytes.fromhex('c2 24 00'))
        self.stop = self.alloc(16)
        self.cpu.mem_write(self.stop, bytes.fromhex('c2 04 00'))
        self.vtable = self.alloc(0x100)
        self.write(self.vtable + 0x74, 'I', self.play)
        self.write(self.vtable + 0x78, 'I', self.stop)
        self.queue = []
        self.calls = []
        self.names = {}

    def on_instruction(self, cpu, address, size, data):
        if address == self.evaluator:
            out = self.read(cpu.reg_read(UC_X86_REG_ESP) + 8, 'I')[0]
            self.cpu.mem_write(out, self.queue.pop(0))
        elif address == self.play:
            esp = cpu.reg_read(UC_X86_REG_ESP)
            actor, ident, sound, *rest = self.read(esp + 4, '3I6I')
            self.calls.append({'op': 'play', 'this': self.names.get(cpu.reg_read(UC_X86_REG_ECX)),
                               'actor': self.names.get(actor, actor), 'id': ident - (1 << 32) if ident & 0x80000000 else ident,
                               'sound': self.names.get(sound, sound), 'location': rest[0:3], 'volume': rest[3],
                               'radius': rest[4], 'pitch': rest[5]})
        elif address == self.stop:
            esp = cpu.reg_read(UC_X86_REG_ESP)
            self.calls.append({'op': 'stop', 'this': self.names.get(cpu.reg_read(UC_X86_REG_ECX)),
                               'id': self.read(esp + 4, 'i')[0]})
        return super().on_instruction(cpu, address, size, data)

    def obj(self, name, size=0x800):
        address = self.alloc(size)
        self.names[address] = name
        return address

    def cls(self, kind, base):
        """`base` itself, a one-level subclass of it, or an unrelated root."""
        if kind == 'exact':
            return base
        fake = self.alloc(0x40)
        self.write(fake + 0x28, 'I', base if kind == 'sub' else 0)
        return fake

    def level(self, audio, demo=None, net_mode=0):
        xlevel, engine, info = self.obj('XLevel'), self.obj('Engine', 0x100), self.obj('LevelInfo')
        self.write(xlevel + 0x40, 'I', engine)
        self.write(xlevel + 0x88, 'I', demo or 0)
        self.write(info + 0x518, 'B', net_mode)
        if audio:
            subsystem = self.obj('Audio', 0x100)
            self.write(subsystem, 'I', self.vtable)
            self.write(engine + 0x4c, 'I', subsystem)
        return xlevel, info

    def frame(self, values):
        self.queue = values
        code = self.alloc(len(values) + 1)
        self.cpu.mem_write(code, bytes([TOKEN] * len(values) + [END_FUNCTION_PARMS]))
        frame = self.alloc(0x20)
        self.write(frame + 8, '2I', 0, code)
        return frame, code

    def hear(self, c):
        self.calls = []
        pawn = self.obj('Pawn')
        self.write(pawn + 0x24, 'I', self.cls(c['pawnClass'], PLAYER_PAWN_CLASS))
        if c['player'] != 'none':
            player = self.obj('Player', 0x100)
            self.write(player + 0x24, 'I', self.cls(c['player'], VIEWPORT_CLASS))
            self.write(pawn + 0x5d4, 'I', player)
        xlevel, _ = self.level(c['audio'])
        self.write(pawn + 0xac, 'I', xlevel)
        actor = 0
        if c['actor'] != 'none':
            actor = self.obj('Actor')
            self.write(actor + 0x28, 'B', c.get('actorFlags', 0))
        sound = self.obj('Sound', 0x40)
        frame, code = self.frame([struct.pack('<I', actor), struct.pack('<i', c['id']), struct.pack('<I', sound),
                                  struct.pack('<3I', *c['location']), struct.pack('<3I', *c['parameters'])])
        self.call(CLIENT_HEAR_SOUND, pawn, struct.pack('<2I', frame, 0))
        return {'calls': self.calls, 'codeAdvance': self.read(frame + 12, 'I')[0] - code}

    def stop_sound(self, c):
        self.calls = []
        actor = self.obj('Actor')
        xlevel, _ = self.level(c['audio'])
        self.write(actor + 0xac, 'I', xlevel)
        frame, code = self.frame([struct.pack('<i', c['id'])])
        self.call(STOP_SOUND, actor, struct.pack('<2I', frame, 0))
        return {'calls': self.calls, 'codeAdvance': self.read(frame + 12, 'I')[0] - code}

    def remote(self, c):
        actor = self.obj('Actor')
        demo = 0
        if c.get('demo'):
            demo = self.obj('DemoRecDriver', 0x100)
            self.write(demo + 0x38, 'I', self.obj('ServerConnection', 0x40) if c['demo'] == 'server' else 0)
        xlevel, info = self.level(False, demo, c.get('netMode', 0))
        self.write(actor + 0x28, 'B', c.get('actorFlags', 0))
        self.write(actor + 0x31, 'B', c['role'])
        self.write(actor + 0xac, 'I', xlevel)
        self.write(actor + 0xa8, 'I', info)
        function = self.alloc(0x100)
        self.write(function + 0x6c, 'I', c['functionFlags'])
        self.call(PROCESS_REMOTE_FUNCTION, actor, struct.pack('<3I', function, self.alloc(0x40), 0))
        return {'result': self.cpu.reg_read(_NATIVE.UC_X86_REG_EAX)}


def main():
    root, cases_path = Path(sys.argv[1]), Path(sys.argv[2])
    cases = json.loads(cases_path.read_text())
    results = []
    # One emulator for every case: each case fabricates its own objects.
    probe = Probe(root)
    for c in cases:
        results.append({'hear': probe.hear, 'stop': probe.stop_sound, 'remote': probe.remote}[c['kind']](c))
    print(json.dumps({'hashes': _NATIVE.HASHES, 'results': results}))


if __name__ == '__main__':
    main()
