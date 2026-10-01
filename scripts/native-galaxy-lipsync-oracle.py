"""Unicorn oracle for Galaxy.dll's lip-sync analysis (docs/lip-sync.md).

Runs the hash-checked Galaxy.dll unchanged over UGalaxyAudioSubsystem::Update's
lip-sync block, 0x1060a0da up to 0x1060a268: bytes per sample from the voice
format word, the streamed-record window bounds, the mean-amplitude cache, the
window fill 0x10609180, the FFT 0x10609310, the inline |real| pass, the
classifier 0x10608d70, the FString copy into APawn.nextPhoneme (+0x588) and
`next += 0.1`. Fabricated: the channel (ebx), the voice ([ebx]), the sample
record (esi), the pawn and the locals frame (ebp).

Two boundaries are replaced. Core FArray::Realloc (the FString growth) is a
Python allocation. After each of the FFT's four fsin/fcos per stage executes,
ST(0) is overwritten with the hardware result measured by
tools/galaxy-fft-twiddle-probe.c (.cache/galaxy-fft-twiddles.csv): Unicorn
computes them through a host double.

Reads JSON cases on stdin:
  {"ring": hex bytes (<= 0x10000), "pos": ring sample position, "voiceFlags": u16,
   "recordFlags": u16, "time": f32 bits, "next": f32 bits, "mean": f32 bits,
   "phoneme": initial nextPhoneme text}
Prints {"results": [{"phoneme", "next", "mean", "real", "imag", "window"}]} with
the float arrays as hex (1024 little-endian f32 each).
"""
import csv
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn import x86_const
from unicorn.x86_const import (UC_X86_REG_EBP, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EDI,
                               UC_X86_REG_EIP, UC_X86_REG_ESI, UC_X86_REG_ESP,
                               UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG)
FP = [getattr(x86_const, f'UC_X86_REG_FP{i}') for i in range(8)]

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

GALAXY = '606e71d13bbd3c4db2460aabcf60d87b1c79bb49d77725cf9e087513c7d06353'
START, END = 0x1060a0da, 0x1060a268
FSIN_2, FSIN_1, FCOS_2, FCOS_1 = 0x10609384, 0x10609394, 0x1060939a, 0x106093a0
WINDOW, REAL, IMAG, PHONEME = 0x1067588c, 0x10676890, 0x10674858, 0x10674854
REALLOC_IAT = 0x10699854


def ext_value(text):
    """'sseeSSSSSSSSSSSSSSSS' (sign/exponent then significand) -> (significand, sign/exponent)."""
    return int(text[4:], 16), int(text[:4], 16)


def f32_ext(bits):
    """A normal float32 as the 80-bit value FLD dword would load."""
    if bits & 0x7fffffff == 0:
        return 0, (bits >> 31) << 15
    sign, exp, man = bits >> 31, (bits >> 23) & 0xff, bits & 0x7fffff
    return (0x800000 | man) << 40, (sign << 15) | (exp - 127 + 16383)


class Probe(native.NativeCollision):
    def __init__(self, game_root, twiddles):
        super().__init__(game_root, {'Galaxy.dll': GALAXY})
        self.realloc = self.read(REALLOC_IAT, 'I')[0]
        self.ring, self.voice, self.record = self.alloc(0x10000), self.alloc(0x100), self.alloc(0x100)
        self.channel, self.pawn, self.frame = self.alloc(0x40), self.alloc(0x600), self.alloc(0x200)
        self.text = self.alloc(64)
        self.twiddles = {}
        for row in twiddles:
            m = int(row['m'])
            # Keyed by the instruction after each transcendental.
            self.twiddles[(FSIN_2 + 2, m)] = f32_ext(int(row['sm2Bits'], 16))
            self.twiddles[(FSIN_1 + 2, m)] = f32_ext(int(row['sm1Bits'], 16))
            self.twiddles[(FCOS_2 + 2, m)] = ext_value(row['cm2Ext'])
            self.twiddles[(FCOS_1 + 2, m)] = ext_value(row['cm1Ext'])
        self.after = {FSIN_2 + 2, FSIN_1 + 2, FCOS_2 + 2, FCOS_1 + 2}
        # Core appStrlen's MSVCRT wcslen (the FString copy's length).
        self.wcslen = next(address for address, (dll, symbol) in self.thunks.items() if symbol == 'wcslen')
        self.thunks.pop(self.wcslen)

    def on_instruction(self, cpu, address, size, data):
        if address in self.after:
            m = self.read(cpu.reg_read(UC_X86_REG_ESP) + 0x1c, 'I')[0]
            top = (cpu.reg_read(UC_X86_REG_FPSW) >> 11) & 7
            cpu.reg_write(FP[top], self.twiddles[(address, m)])
        if address == self.wcslen:
            esp = cpu.reg_read(UC_X86_REG_ESP)
            ret, text = self.read(esp, '2I')
            n = 0
            while self.read(text + 2 * n, 'H')[0]:
                n += 1
            cpu.reg_write(x86_const.UC_X86_REG_EAX, n)
            cpu.reg_write(UC_X86_REG_ESP, esp + 4)
            cpu.reg_write(UC_X86_REG_EIP, ret)
            return
        if address == self.realloc:
            this = cpu.reg_read(UC_X86_REG_ECX)
            esp = cpu.reg_read(UC_X86_REG_ESP)
            ret, element = self.read(esp, '2I')
            data_ptr, num, maximum = self.read(this, '3I')
            size_bytes = maximum * element
            new = self.alloc(max(size_bytes, 16)) if size_bytes else 0
            if new and data_ptr:
                cpu.mem_write(new, bytes(cpu.mem_read(data_ptr, size_bytes)))
            self.write(this, 'I', new)
            cpu.reg_write(UC_X86_REG_ESP, esp + 8)
            cpu.reg_write(UC_X86_REG_EIP, ret)
            return
        super().on_instruction(cpu, address, size, data)

    def classify(self, case):
        """0x10608d70 alone over crafted bins at the real array."""
        self.cpu.mem_write(REAL, bytes.fromhex(case['real']))
        self.write(PHONEME, 'I', 0x00510051)
        self.call(0x10608d70, 0, struct.pack('<I', case['rate'] & 0xffffffff))
        return {'phoneme': chr(self.read(PHONEME, 'H')[0])}

    def run(self, case):
        if case.get('kind') == 'classify':
            return self.classify(case)
        ring, voice, record, channel, pawn, frame = (self.ring, self.voice, self.record, self.channel,
                                                     self.pawn, self.frame)
        data = bytes.fromhex(case['ring'])
        self.cpu.mem_write(ring, data + b'\0' * (0x10000 - len(data)))
        for block, size in ((voice, 0x100), (record, 0x100), (channel, 0x40), (pawn, 0x600), (frame, 0x200)):
            self.cpu.mem_write(block, b'\0' * size)
        start = ring // 2
        self.write(voice + 0x4c, 'H', case['voiceFlags'])
        self.write(voice + 0x52, '2I', start, start + 0x7fff)
        self.write(voice + 0x46, 'I', start + case['pos'])
        self.write(record + 0x2c, 'H', case['recordFlags'])
        self.write(record + 0x3c, 'I', 44100)
        self.write(channel, 'I', voice)
        self.write(channel + 0x30, '3I', case['time'], case['next'], case['mean'])
        text = case.get('phoneme', '')
        if text:
            buf = self.text
            self.cpu.mem_write(buf, text.encode('utf-16le') + b'\0\0')
            self.write(pawn + 0x588, '3I', buf, len(text) + 1, len(text) + 1)
        ebp = frame + 0x180
        self.write(ebp - 0x18, 'I', record)
        self.write(ebp - 0x50, 'I', pawn)
        self.write(ebp - 0x58, 'I', channel)
        cpu = self.cpu
        for reg, value in ((UC_X86_REG_EBX, channel), (UC_X86_REG_ESI, record), (UC_X86_REG_EDI, pawn),
                           (UC_X86_REG_EBP, ebp), (UC_X86_REG_ESP, self.stack),
                           (UC_X86_REG_FPCW, 0x037f), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)):
            cpu.reg_write(reg, value)
        cpu.emu_start(START, END, count=20000000)
        if cpu.reg_read(UC_X86_REG_EIP) != END:
            raise RuntimeError(f'lip-sync block stopped at {cpu.reg_read(UC_X86_REG_EIP):x}; trace {list(self.trace)[-12:]}')
        ptr, num, _ = self.read(pawn + 0x588, '3I')
        phoneme = bytes(cpu.mem_read(ptr, 2 * num)).decode('utf-16le').rstrip('\0') if ptr and num else ''
        def hexf(address):
            return bytes(cpu.mem_read(address, 4096)).hex()
        return {'phoneme': phoneme, 'next': self.read(channel + 0x34, 'I')[0], 'mean': self.read(channel + 0x38, 'I')[0],
                'window': hexf(WINDOW), 'real': hexf(REAL), 'imag': hexf(IMAG)}


def main():
    with open(ROOT / '.cache' / 'galaxy-fft-twiddles.csv') as source:
        twiddles = list(csv.DictReader(source))
    probe = Probe(Path(sys.argv[1]), twiddles)
    print(json.dumps({'results': [probe.run(case) for case in json.load(sys.stdin)]}))


if __name__ == '__main__':
    main()
