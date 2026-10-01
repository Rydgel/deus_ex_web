"""Execute Engine's original UTexture::Get (0x103212e0) -> Update (0x103ecb70)
-> Tick (0x103ed0d0) -> ConstantTimeTick (0x103ed330) on fabricated textures.

Each texture is a 0x100-byte object whose vtable slots +0x68 (Tick), +0x6c
(ConstantTimeTick) and +0x78 (Update) are the plain UTexture's own
(`??_7UTexture@@6B@`). AnimNext chains, PrimeCount, the frame rates and the
transient state (AnimCur, PrimeCurrent, Accumulator, LastUpdateTime) are plain
memory. Each case runs a sequence of Get(Time) calls and records, after each,
the returned frame and every state word.

  native-texture-animation-oracle.py GAME_ROOT CASES_JSON
"""
import importlib.util
import json
import struct
import sys
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)

GET = 0x103212E0
VTABLE = 0x1042672C  # ??_7UTexture@@6B@


class Probe(_NATIVE.NativeCollision):
    def chain(self, c):
        frames = [self.alloc(0x100) for _ in range(c['frames'])]
        for index, frame in enumerate(frames):
            self.write(frame, 'I', VTABLE)
            # AnimNext (+0x8c): the case's links, by frame index or None.
            link = c['links'][index]
            self.write(frame + 0x8c, 'I', frames[link] if link is not None else 0)
        head = frames[0]
        self.write(head + 0x34, '2i', 64, 64)  # USize/VSize (Update's statistics)
        self.write(head + 0x84, 'I', c.get('flags', 0))
        self.write(head + 0x90, 'I', frames[c['animCur']] if c.get('animCur') is not None else 0)
        self.write(head + 0x94, '2B', c['primeCount'], c.get('primeCurrent', 0))
        self.write(head + 0x98, '2I', c['minFrameRate'], c['maxFrameRate'])
        self.write(head + 0xa0, 'I', c.get('accumulator', 0))
        self.write(head + 0x4c, 'd', float(c.get('lastUpdateTime', 0.0)))
        return frames

    def run(self, c):
        frames = self.chain(c)
        head, index = frames[0], {address: i for i, address in enumerate(frames)}
        steps = []
        for time in c['times']:
            self.call(GET, head, struct.pack('<d', float(time)))
            result = self.cpu.reg_read(_NATIVE.UC_X86_REG_EAX)
            anim_cur = self.read(head + 0x90, 'I')[0]
            steps.append({'result': index.get(result), 'animCur': index.get(anim_cur) if anim_cur else None,
                          'primeCurrent': self.read(head + 0x95, 'B')[0], 'accumulator': self.read(head + 0xa0, 'I')[0],
                          'lastUpdateTime': '%016x' % self.read(head + 0x4c, 'Q')[0], 'flags': self.read(head + 0x84, 'I')[0]})
        return {'steps': steps}


def main():
    root, cases_path = Path(sys.argv[1]), Path(sys.argv[2])
    probe = Probe(root)
    results = [probe.run(c) for c in json.loads(cases_path.read_text())]
    print(json.dumps({'hashes': _NATIVE.HASHES, 'results': results}))


if __name__ == '__main__':
    main()
