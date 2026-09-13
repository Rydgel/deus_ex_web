"""Probe original Core string natives and related string operations.

FFrame expression evaluation, wcslen/wcsstr and output allocation are explicit
services. The original instructions are loaded from hash-verified Core.dll.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_EBP, UC_X86_REG_ESI, UC_X86_REG_EBX

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class StringProbe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root, {'Extension.dll': '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'})
        self.stop = None
        self.value_kind = 'name'
        self.error_stub = self.alloc(16)
        self.intern_stub = self.alloc(16)
        self.cpu.mem_write(self.error_stub, b'\xc3')
        self.cpu.mem_write(self.intern_stub, bytes.fromhex('c2 08 00'))
        self.write(0x100590b0, 'I', self.error_stub)
        self.write(0x100590dc, 'I', self.intern_stub)
        self.evaluator = self.alloc(16)
        self.cpu.mem_write(self.evaluator, bytes.fromhex('c2 08 00'))
        self.cpu.mem_write(0x10145440, bytes.fromhex('c2 04 00')) # bounded FString allocator hook
        self.length_import = next(address for address, (_, symbol) in self.thunks.items() if symbol == 'wcslen')
        self.cpu.mem_write(self.length_import, b'\xc3')
        del self.thunks[self.length_import]
        self.copy_import = next(address for address, (_, symbol) in self.thunks.items() if symbol == 'wcsncpy')
        self.cpu.mem_write(self.copy_import, b'\xc3')
        del self.thunks[self.copy_import]

        # The three string natives use the normal FFrame expression table.
        # Keep separate typed stubs so the probe verifies both evaluation order
        # and the fact that the optional Mid count is not evaluated when its
        # EndFunctionParms token is present.
        self.string_evaluator = self.alloc(16)
        self.int_evaluator = self.alloc(16)
        self.end_parameters = self.alloc(16)
        for address in (self.string_evaluator, self.int_evaluator, self.end_parameters):
            self.cpu.mem_write(address, bytes.fromhex('c2 08 00'))
        self.write(0x101f41b8 + 0x1f * 4, 'I', self.string_evaluator)
        self.write(0x101f41b8 + 0x1d * 4, 'I', self.int_evaluator)
        self.write(0x101f41b8 + 0x16 * 4, 'I', self.end_parameters)

        # FString::InStr(…,0) reaches appStrstr, whose only unresolved edge is
        # the CRT wcsstr import.  The pointer result is the original ABI: a
        # null pointer means INDEX_NONE and a found pointer is converted to a
        # UTF-16 code-unit offset by the installed FString body.
        self.substring_import = next(address for address, (_, symbol) in self.thunks.items() if symbol == 'wcsstr')
        self.cpu.mem_write(self.substring_import, b'\xc3')
        del self.thunks[self.substring_import]
        self.expression_values = []
        self.expression_events = []

    def on_instruction(self, cpu, address, size, data):
        if address == self.stop:
            cpu.emu_stop()
            return
        if address in (self.string_evaluator, self.int_evaluator):
            if not self.expression_values:
                raise RuntimeError('String native evaluated an unexpected expression')
            kind, value = self.expression_values.pop(0)
            expected = 'int' if address == self.int_evaluator else 'string'
            if kind != expected:
                raise RuntimeError(f'String native evaluated {kind} where {expected} was expected')
            stack = cpu.reg_read(native.UC_X86_REG_ESP)
            output = self.read(stack + 8, 'I')[0]
            self.expression_events.append({'kind': kind, 'value': value})
            if kind == 'int':
                self.write(output, 'I', value & 0xffffffff)
            else:
                pointer, count = self._make_string(value)
                self.write(output, '3I', pointer, count, count)
        if address == self.substring_import:
            stack = cpu.reg_read(native.UC_X86_REG_ESP)
            left, right = self.read(stack + 4, '2I')
            left_text, right_text = self.text_at(left), self.text_at(right)
            index = left_text.find(right_text)
            cpu.reg_write(native.UC_X86_REG_EAX, left + index * 2 if index >= 0 else 0)
            self.expression_events.append({'kind': 'wcsstr', 'left': left_text,
                                            'right': right_text, 'index': index})
        if address == self.evaluator:
            sp = cpu.reg_read(native.UC_X86_REG_ESP)
            output = self.read(sp + 8, 'I')[0]
            if self.value_kind == 'name':
                self.write(output, 'I', self.name_index)
            else:
                self.cpu.mem_write(output, bytes(self.cpu.mem_read(self.string_argument, 12)))
        if address == 0x10145440:
            array = cpu.reg_read(native.UC_X86_REG_ECX)
            pointer, count, capacity = self.read(array, '3I')
            if capacity and not pointer:
                pointer = self.alloc(capacity * self.read(cpu.reg_read(native.UC_X86_REG_ESP) + 4, 'I')[0])
                self.write(array, 'I', pointer)
        if address == self.error_stub:
            sp = cpu.reg_read(native.UC_X86_REG_ESP)
            self.extension_events.append({'op': 'error', 'unit': self.read(sp + 12, 'I')[0],
                                          'text': self.text_at(self.read(sp + 16, 'I')[0])})
        if address == self.intern_stub:
            sp = cpu.reg_read(native.UC_X86_REG_ESP)
            self.extension_events.append({'op': 'intern', 'text': self.text_at(self.read(sp + 4, 'I')[0]),
                                          'mode': self.read(sp + 8, 'I')[0]})
            output = cpu.reg_read(native.UC_X86_REG_ECX)
            self.write(output, 'I', 84)
            cpu.reg_write(native.UC_X86_REG_EAX, output)
        if address == self.length_import:
            sp = cpu.reg_read(native.UC_X86_REG_ESP)
            pointer = self.read(sp + 4, 'I')[0]
            length = 0
            while self.read(pointer + length * 2, 'H')[0]:
                length += 1
            cpu.reg_write(native.UC_X86_REG_EAX, length)
        if address == self.copy_import:
            sp = cpu.reg_read(native.UC_X86_REG_ESP)
            destination, source, count = self.read(sp + 4, '3I')
            ended = False
            for index in range(count):
                unit = 0 if ended else self.read(source + index * 2, 'H')[0]
                if unit == 0:
                    ended = True
                self.write(destination + index * 2, 'H', unit)
            cpu.reg_write(native.UC_X86_REG_EAX, destination)
        return super().on_instruction(cpu, address, size, data)

    def _make_string(self, text):
        raw = text.encode('utf-16-le', errors='surrogatepass') + b'\0\0'
        if not text:
            return 0, 0
        pointer = self.alloc(len(raw))
        self.cpu.mem_write(pointer, raw)
        return pointer, len(raw) // 2

    def _run_expression(self, body, values, tokens, result_size, stop):
        if len(values) != len(tokens):
            raise ValueError('String native probe expression/token mismatch')
        self.expression_values = list(zip(
            ['string' if token == 0x1f else 'int' for token in tokens], values))
        self.expression_events = []
        code = self.alloc(len(tokens) + 1)
        self.cpu.mem_write(code, bytes(tokens) + b'\x16')
        frame = self.alloc(0x20)
        self.write(frame + 8, '2I', 0, code)
        result = self.alloc(result_size)
        self.cpu.mem_write(result, b'\0' * result_size)
        self.write(self.stack, 'I', self.done)
        self.cpu.mem_write(self.stack + 4, struct.pack('<II', frame, result))
        for register, value in [
            (native.UC_X86_REG_ESP, self.stack),
            (native.UC_X86_REG_ECX, 0),
            (native.UC_X86_REG_FPCW, 0x037f),
            (native.UC_X86_REG_FPSW, 0),
            (native.UC_X86_REG_FPTAG, 0xffff),
        ]:
            self.cpu.reg_write(register, value)
        self.stop = stop
        try:
            self.cpu.emu_start(body, stop + 1, count=4000000)
            if self.cpu.reg_read(native.UC_X86_REG_EIP) != stop:
                raise RuntimeError(f'String native did not reach result boundary {stop:x}')
        finally:
            self.stop = None
        if self.expression_values:
            raise RuntimeError('String native left an expression unevaluated')
        return code, frame, result

    def _result_string(self, result):
        pointer, count, capacity = self.read(result, '3I')
        raw = bytes(self.cpu.mem_read(pointer, count * 2)) if pointer and count else b''
        decoded = raw.decode('utf-16-le', errors='surrogatepass')
        return {'output': decoded.split('\0', 1)[0],
                'raw': raw.decode('utf-16-le', errors='surrogatepass'),
                'count': count, 'capacity': capacity}

    def length(self, text):
        code, frame, result = self._run_expression(
            0x1013bad0, [text], [0x1f], 4, 0x1013bb35)
        return {'input': text, 'value': self.read(result, 'i')[0],
                'codeAdvance': self.read(frame + 12, 'I')[0] - code,
                'events': self.expression_events}

    def instr(self, text, needle):
        code, frame, result = self._run_expression(
            0x1013bc40, [text, needle], [0x1f, 0x1f], 4, 0x1013bce5)
        return {'input': text, 'needle': needle, 'value': self.read(result, 'i')[0],
                'codeAdvance': self.read(frame + 12, 'I')[0] - code,
                'events': self.expression_events}

    def mid(self, text, start, count=None):
        values, tokens = [text, start], [0x1f, 0x1d]
        if count is not None:
            values.append(count)
            tokens.append(0x1d)
        code, frame, result = self._run_expression(
            0x1013bdf0, values, tokens, 12, 0x1013bef5)
        return {'input': text, 'start': start, 'countArg': count,
                **self._result_string(result),
                'codeAdvance': self.read(frame + 12, 'I')[0] - code,
                'events': self.expression_events}

    def text_at(self, pointer):
        raw = bytearray()
        while self.read(pointer, 'H')[0]:
            raw.extend(self.cpu.mem_read(pointer, 2))
            pointer += 2
        return bytes(raw).decode('utf-16-le', errors='surrogatepass')

    def caps(self, text):
        raw = text.encode('utf-16-le', errors='surrogatepass') + b'\0\0'
        units = len(raw) // 2
        copied = self.alloc(len(raw))
        self.cpu.mem_write(copied, raw)
        source = self.alloc(12)
        self.write(source, '3I', copied, units, units)
        frame = self.alloc(0x100) + 0x80
        self.write(frame - 0x2c, '3I', copied, units, units)
        self.cpu.reg_write(UC_X86_REG_EBP, frame)
        self.cpu.reg_write(UC_X86_REG_ESI, source)
        self.cpu.reg_write(UC_X86_REG_EBX, 0)
        self.stop = 0x10108d1b
        self.cpu.emu_start(0x10108cda, self.stop + 1, count=10000)
        if self.cpu.reg_read(native.UC_X86_REG_EIP) != self.stop:
            raise RuntimeError('Caps did not reach its output-copy boundary')
        self.stop = None
        return bytes(self.cpu.mem_read(copied, len(raw) - 2)).decode('utf-16-le', errors='surrogatepass')

    def left(self, text, count):
        raw = text.encode('utf-16-le', errors='surrogatepass') + b'\0\0'
        if text:
            data = self.alloc(len(raw))
            self.cpu.mem_write(data, raw)
            units = len(raw) // 2
        else:
            data, units = 0, 0
        source = self.alloc(12)
        self.write(source, '3I', data, units, units)
        result = self.alloc(12)
        self.write(result, '3I', 0, 0, 0)
        self.call(0x10108430, source, struct.pack('<Ii', result, count))
        output, used, capacity = self.read(result, '3I')
        copied = bytes(self.cpu.mem_read(output, max(0, used - 1) * 2)) if output else b''
        return {'output': copied.decode('utf-16-le', errors='surrogatepass'),
                'count': used, 'capacity': capacity}

    def right(self, text, count):
        raw = text.encode('utf-16-le', errors='surrogatepass') + b'\0\0'
        if text:
            data = self.alloc(len(raw))
            self.cpu.mem_write(data, raw)
            units = len(raw) // 2
        else:
            data, units = 0, 0
        source = self.alloc(12)
        self.write(source, '3I', data, units, units)
        result = self.alloc(12)
        self.write(result, '3I', 0, 0, 0)
        self.call(0x101085f0, source, struct.pack('<Ii', result, count))
        output, used, capacity = self.read(result, '3I')
        copied = bytes(self.cpu.mem_read(output, max(0, used - 1) * 2)) if output else b''
        return {'output': copied.decode('utf-16-le', errors='surrogatepass'),
                'count': used, 'capacity': capacity}

    def name(self, spelling, index):
        self.value_kind = 'name'
        self.name_index = index
        raw = spelling.encode('utf-16-le') + b'\0\0'
        entry = self.alloc(12 + len(raw))
        self.write(entry, '3I', index, 0, 0)
        self.cpu.mem_write(entry + 12, raw)
        names = self.alloc((index + 1) * 4)
        self.write(names + index * 4, 'I', entry)
        self.write(0x102961f0, 'I', names)
        self.write(0x101f41b8 + 0x21 * 4, 'I', self.evaluator)
        code = self.alloc(16)
        self.cpu.mem_write(code, b'\x21')
        frame = self.alloc(0x20)
        self.write(frame + 8, '2I', 0, code)
        result = self.alloc(12)
        output = self.alloc(len(raw))
        self.write(result, '3I', output, 0, 0)
        self.call(0x101320b0, 0, struct.pack('<II', frame, result))
        count = self.read(result + 4, 'I')[0]
        return {'spelling': bytes(self.cpu.mem_read(output, max(0, count - 1) * 2)).decode('utf-16-le'),
                'count': count, 'capacity': self.read(result + 8, 'I')[0],
                'codeAdvance': self.read(frame + 12, 'I')[0] - code}

    def extension(self, text):
        self.value_kind = 'string'
        self.extension_events = []
        raw = text.encode('utf-16-le') + b'\0\0'
        data = self.alloc(len(raw))
        self.cpu.mem_write(data, raw)
        count = len(raw) // 2 if text else 0
        self.string_argument = self.alloc(12)
        self.write(self.string_argument, '3I', data, count, count)
        self.write(0x101f41b8 + 0x1f * 4, 'I', self.evaluator)
        code = self.alloc(16)
        self.cpu.mem_write(code, b'\x1f\x16')
        frame = self.alloc(0x20)
        self.write(frame + 8, '2I', 0, code)
        result = self.alloc(4)
        self.write(self.stack, '3I', self.done, frame, result)
        self.cpu.reg_write(native.UC_X86_REG_ESP, self.stack)
        self.cpu.reg_write(native.UC_X86_REG_ECX, 0)
        self.stop = 0x10037a2d # result written, before temporary cleanup
        self.cpu.emu_start(0x10037940, self.stop + 1, count=10000)
        if self.cpu.reg_read(native.UC_X86_REG_EIP) != self.stop:
            raise RuntimeError('StringToName did not reach its result boundary')
        self.stop = None
        return {'events': self.extension_events, 'index': self.read(result, 'I')[0],
                'codeAdvance': self.read(frame + 12, 'I')[0] - code}


if __name__ == '__main__':
    probe = StringProbe(Path(sys.argv[1]))
    long_text = 'a' * (0xffff + 0x1000)
    mid_limits = []
    for start, count in [(0, None), (0, 0xffff), (0, -1), (0xffff, None)]:
        case = probe.mid(long_text, start, count)
        mid_limits.append({'inputLength': len(long_text), 'start': start,
                           'countArg': count, 'outputLength': len(case['output']),
                           'count': case['count'], 'capacity': case['capacity'],
                           'codeAdvance': case['codeAdvance'],
                           'eventKinds': [event['kind'] for event in case['events']]})
    print(json.dumps({'left': [{'input': text, 'take': count, **probe.left(text, count)}
        for text, count in [('', -1), ('', 4), ('abc', -2), ('abc', 0), ('abc', 2),
                            ('abc', 3), ('abc', 9), ('abcdefghijklmnopq', 16), ('A\U0001f603Z', 2)]],
        'right': [{'input': text, 'take': count, **probe.right(text, count)}
        for text, count in [('', -1), ('', 4), ('abc', -2), ('abc', 0), ('abc', 1),
                            ('abc', 3), ('abc', 9), ('A\U0001f603Z', 2)]],
        'length': [probe.length(text) for text in ['', 'abc', 'A\U0001f603Z', 'a\0b']],
        'instr': [probe.instr(text, needle) for text, needle in [
            ('', ''), ('', 'a'), ('abc', ''), ('abc', 'b'), ('abc', 'bc'),
            ('abc', 'x'), ('A\U0001f603Z', '\U0001f603'), ('a\0b', 'b')]],
        'mid': [probe.mid(text, start, count) for text, start, count in [
            ('', 0, 0), ('abc', 0, 1), ('abc', 1, 1), ('abc', 1, 2),
            ('abc', 2, 99), ('abc', 3, 1), ('abc', -1, 1), ('abc', 0, -1),
            ('abc', 1, -3), ('A\U0001f603Z', 1, 1), ('a\0b', 0, 99)]] +
            [probe.mid('abc', 0)],
        'midLimits': mid_limits,
        'caps': [{'input': text, 'output': probe.caps(text)}
        for text in ['', 'dl_start', 'aAzZ09_`{', 'éßıσ\U0001f603']],
        'names': [{'index': index, 'input': text, **probe.name(text, index)}
        for index, text in [(0, 'None'), (3, 'dl_start'), (7, 'MiXeD_Name')]],
        'extension': [{'input': text, **probe.extension(text)}
            for text in ['', 'DL_Start_Played', 'a-Z_09', 'bad name!', 'ébad', 'ok\0unused']]}))
