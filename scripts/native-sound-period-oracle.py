"""Run the original Engine Sound period helpers in the x86 emulator.

The cases file contains an array of objects with ``name``, ``bytesBase64`` and
an optional signed ``lazyPosition``.  The validator supplies the two original
Switch4Click WAV payloads and the two small branch fixtures.  No host parser
or guessed archive service is used: nonpositive lazy positions intentionally
exercise the native generic-loader no-op path.
"""

import base64
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class PeriodProbe(native.NativeCollision):
    """Bind only the return-float capture needed by GetPeriod."""

    def __init__(self, root):
        super().__init__(root)
        self.period_out = self.alloc(4)
        # GetPeriod has already rounded its local result to float32 at
        # 0x1036f89e and reloads it at 0x1036f8a1.  Store that returned ST0
        # immediately after the normal register/FS cleanup, preserving the
        # rest of the original epilogue and native call order.
        self.cpu.mem_write(
            0x1036f8b1,
            b'\x8b\xe5\xd9\x1d' + struct.pack('<I', self.period_out)
            + b'\x5d\xc3',
        )

    def run_case(self, case):
        payload = base64.b64decode(case['bytesBase64'], validate=True)
        if not payload:
            raise ValueError(f"{case.get('name', '<unnamed>')} has no bytes")
        array_num = case.get('arrayNum', len(payload))
        if not isinstance(array_num, int) or array_num < 0 or array_num > len(payload):
            raise ValueError(f"invalid arrayNum for {case.get('name', '<unnamed>')}")
        lazy_position = case.get('lazyPosition', -1)
        if not isinstance(lazy_position, int) or not -0x80000000 <= lazy_position <= 0x7fffffff:
            raise ValueError(f"invalid lazyPosition for {case.get('name', '<unnamed>')}")

        data = self.alloc(len(payload))
        self.cpu.mem_write(data, payload)
        array = self.alloc(0x0c)
        self.write(array, '3I', data, array_num, array_num)

        info = self.alloc(0x40)
        read_result = self.call(
            0x1036fd10, info, struct.pack('<I', array))
        words = self.read(info, '15I')

        sound_data = self.alloc(0x20)
        self.write(sound_data + 0x08, 'i', lazy_position)
        self.write(sound_data + 0x0c, '3I', data, array_num, array_num)
        self.call(0x1036f7a0, sound_data, b'')
        period = self.read(self.period_out, 'f')[0]

        return {
            'name': case.get('name', ''),
            'arrayNum': array_num,
            'lazyPosition': lazy_position,
            'inputLength': len(payload),
            'readWaveInfo': bool(read_result),
            'period': period,
            'info': self.info_result(words, data),
        }

    @staticmethod
    def info_result(words, data):
        def relative(value):
            return None if value == 0 else value - data

        return {
            'arrayEndOffset': relative(words[11]),
            'waveHeaderPointerOffset': relative(words[7]),
            'format': {
                'sampleRatePointerOffset': relative(words[0]),
                'averageBytesPerSecondPointerOffset': relative(words[1]),
                'blockAlignPointerOffset': relative(words[2]),
                'bitsPerSamplePointerOffset': relative(words[3]),
                'channelsPointerOffset': relative(words[4]),
                'bitsPerSample': words[5],
            },
            'data': {
                'sizePointerOffset': relative(words[6]),
                'bytesPointerOffset': relative(words[8]),
                'endOffset': relative(words[9]),
                'size': words[10],
                'sizeCopy': words[14],
            },
            'smpl': {
                'loopCount': words[12],
                'firstLoopOffset': relative(words[13]),
            },
        }


def main():
    if len(sys.argv) != 3:
        raise SystemExit('Usage: native-sound-period-oracle.py GAME_ROOT CASES_JSON')
    root = Path(sys.argv[1])
    cases = json.loads(Path(sys.argv[2]).read_text())
    if not isinstance(cases, list):
        raise SystemExit('Cases JSON must be an array')
    probe = PeriodProbe(root)
    results = [probe.run_case(case) for case in cases]
    print(json.dumps({
        'hashes': native.HASHES,
        'addresses': {
            'getPeriod': {'thunk': 0x10303bc5, 'body': 0x1036f7a0},
            'readWaveInfo': {'thunk': 0x10301c67, 'body': 0x1036fd10},
            'genericLazyLoad': {'thunk': 0x10301168, 'body': 0x1030cbb0},
            'periodConstant': {'address': 0x1042b148, 'value': 8.0},
        },
        'results': results,
    }))


if __name__ == '__main__':
    main()
