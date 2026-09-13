"""Execute original Core.dll UStrProperty/UArrayProperty/UMapProperty/UBoolProperty
SerializeItem in the isolated x86 emulator against a constructed measure archive
(vtable 0x10177640).

Optional research tool, never imported by the browser. Only the hash-verified
GOTY Core.dll is supported. Mirrors scripts/native-collision-oracle.py setup.
"""
import importlib.util
import json
import struct
import sys

from pathlib import Path

_script_dir = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('native_collision', _script_dir / 'native-collision-oracle.py')
_native_collision = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_native_collision)
NativeCollision = _native_collision.NativeCollision

MEASURE_VTABLE = 0x10177640
INT_VTABLE = 0x10175bc4
ARRAY_VTABLE = 0x101761c4
CORE_GMALLOC_PTR = 0x101a7c44


class SerializeItemProbe(NativeCollision):
    REALLOC_STUB = bytes.fromhex('8b 44 24 04 c2 0c 00')
    FREE_STUB = bytes.fromhex('c2 04 00')
    RAW_STUB = bytes.fromhex('c2 08 00')

    def __init__(self, game_root):
        super().__init__(game_root)
        self.raw_inputs = {}
        self.raw_cursors = {}
        self.raw_events = {}
        self.realloc_events = []
        # FArray::Realloc remains the original Core body.  Its sole external
        # edge is GMalloc::Realloc, which this probe supplies as a
        # non-reclaiming allocator so native pointer/count mutations remain
        # observable without inventing a heap implementation.
        allocator = self.alloc(0x20)
        allocator_vtable = self.alloc(0x20)
        self.realloc_stub = self.alloc(0x10)
        self.free_stub = self.alloc(0x10)
        self.cpu.mem_write(self.realloc_stub, self.REALLOC_STUB)
        self.cpu.mem_write(self.free_stub, self.FREE_STUB)
        self.write(allocator_vtable + 0x04, 'I', self.realloc_stub)
        self.write(allocator_vtable + 0x08, 'I', self.free_stub)
        self.write(allocator, 'I', allocator_vtable)
        self.write(CORE_GMALLOC_PTR, 'I', allocator)

        self.archive_vtable = self.alloc(0x20)
        self.raw_stub = self.alloc(0x10)
        self.count_stub = self.alloc(0x10)
        self.cpu.mem_write(self.raw_stub, self.RAW_STUB)
        self.cpu.mem_write(self.count_stub, bytes.fromhex('c2 08 00'))
        self.write(self.archive_vtable + 0x04, 'I', self.raw_stub)
        self.write(self.archive_vtable + 0x14, 'I', self.count_stub)

    def on_instruction(self, cpu, address, size, data):
        if address == self.raw_stub:
            archive = cpu.reg_read(_native_collision.UC_X86_REG_ECX)
            sp = cpu.reg_read(_native_collision.UC_X86_REG_ESP)
            pointer = self.read(sp + 0x04, 'I')[0]
            width = self.read(sp + 0x08, 'I')[0]
            if archive in self.raw_inputs:
                cursor = self.raw_cursors.get(archive, 0)
                stream = self.raw_inputs[archive]
                if cursor + width > len(stream):
                    raise RuntimeError(f'raw input exhausted: archive={archive:#x}, width={width}')
                payload = bytes(stream[cursor:cursor + width])
                self.raw_cursors[archive] = cursor + width
                self.cpu.mem_write(pointer, payload)
            else:
                payload = bytes(self.cpu.mem_read(pointer, width))
            self.raw_events.setdefault(archive, []).append({
                'width': width, 'bytes': list(payload), 'pointer': pointer,
            })
        elif address == self.realloc_stub:
            sp = cpu.reg_read(_native_collision.UC_X86_REG_ESP)
            self.realloc_events.append({
                'pointer': self.read(sp + 0x04, 'I')[0],
                'bytes': self.read(sp + 0x08, 'I')[0],
                'tag': self.read(sp + 0x0c, 'I')[0],
            })
        return super().on_instruction(cpu, address, size, data)
    def measure_archive(self):
        # FArchive constructor words: +04=0x44 +08=0x44c +0c=0 +10=0 +14=0
        # +18=0 +1c=1 +20=1 +24=1 +28=0 +2c=0, vtable = measure vtable.
        record = self.alloc(0x30)
        self.write(record, '12I', MEASURE_VTABLE, 0x44, 0x44c, 0, 0, 0, 0, 1, 1, 1, 0, 0)
        return record

    def archive(self, *, loading=False, saving=False, input_bytes=()):
        record = self.alloc(0x30)
        self.cpu.mem_write(record, bytes(0x30))
        self.write(record, 'I', self.archive_vtable)
        self.write(record + 0x0c, 'I', 1 if loading else 0)
        self.write(record + 0x10, 'I', 1 if saving else 0)
        if loading:
            self.raw_inputs[record] = list(input_bytes)
            self.raw_cursors[record] = 0
        self.raw_events[record] = []
        return record

    def raw_events_for(self, archive):
        return [{key: event[key] for key in ('width', 'bytes')}
                for event in self.raw_events.get(archive, [])]

    def string_words(self, record, count=None):
        data, array_num, array_max = self.read(record, '3I')
        length = array_max if count is None else count
        return {
            'data': [self.read(data + i * 2, 'H')[0] for i in range(length)],
            'arrayNum': array_num,
            'arrayMax': array_max,
        }

    def string_load_save(self):
        result = {}
        # Loading a signed marker exercises the Unicode unit path and the
        # native Num/Max -> Realloc order.  The stream is CompactIndex(-3),
        # then 'h', 0x0100, and a terminator as UTF-16 units.
        load = self.archive(loading=True, input_bytes=[0x83, 0x68, 0x00, 0x00, 0x01, 0x00, 0x00])
        loaded = self.fstring_with_capacity('old', 8, array_num=4)
        self.str_serialize_item(load, loaded)
        result['load'] = {
            'archive': {'ar0c': self.read(load + 0x0c, 'I')[0], 'ar10': self.read(load + 0x10, 'I')[0]},
            'value': self.string_words(loaded, 3),
            'raw': self.raw_events_for(load),
            'realloc': list(self.realloc_events),
        }

        self.realloc_events = []
        save = self.archive(saving=True)
        saved = self.fstring_with_capacity('h\u0100', 8)
        self.str_serialize_item(save, saved)
        result['save'] = {
            'archive': {'ar0c': self.read(save + 0x0c, 'I')[0], 'ar10': self.read(save + 0x10, 'I')[0]},
            'value': self.string_words(saved, 3),
            'raw': self.raw_events_for(save),
            'realloc': list(self.realloc_events),
        }
        return result

    def array_load_save(self):
        result = {}
        arr_prop = self.array_property(self.int_property())
        load = self.archive(loading=True, input_bytes=[2, 7, 0, 0, 0, 9, 0, 0, 0])
        old_data = self.alloc(4 * 40)
        self.write(old_data, '40I', *([0] * 40))
        value = self.alloc(0x0c)
        self.write(value, '3I', old_data, 1, 1)
        self.array_serialize_item(load, value, arr_prop)
        data, array_num, array_max = self.read(value, '3I')
        result['load'] = {
            'arrayNum': array_num,
            'arrayMax': array_max,
            'data': list(self.read(data, f'{array_num}I')),
            'raw': self.raw_events_for(load),
            'realloc': list(self.realloc_events),
        }

        self.realloc_events = []
        save = self.archive(saving=True)
        save_data = self.alloc(8)
        self.write(save_data, '2I', 7, 9)
        save_value = self.alloc(0x0c)
        self.write(save_value, '3I', save_data, 2, 2)
        self.array_serialize_item(save, save_value, arr_prop)
        result['save'] = {
            'arrayNum': self.read(save_value + 0x04, 'I')[0],
            'arrayMax': self.read(save_value + 0x08, 'I')[0],
            'raw': self.raw_events_for(save),
            'realloc': list(self.realloc_events),
        }
        return result

    def counter(self, archive):
        return self.read(archive + 0x2c, 'I')[0]

    def fstring(self, text):
        # FString(const TCHAR*) sets both counts to strlen+1 for nonempty
        # text, but leaves an empty string as the raw Num=Max=0 value.
        array_num = len(text) + 1 if text else 0
        data = self.alloc(max(array_num, 1) * 2)
        self.write(data, f'{max(array_num, 1)}H', *([ord(c) for c in text] + [0]))
        record = self.alloc(0xc)
        self.write(record, 'I2I', data, array_num, array_num)
        return record

    def fstring_record(self, data_ptr, array_num, array_max):
        record = self.alloc(0xc)
        if array_num < 0 or array_max < array_num:
            raise ValueError('FString ArrayMax must be at least ArrayNum')
        self.write(record, 'I2I', data_ptr, array_num, array_max)
        return record

    def fstring_with_capacity(self, text, array_max, array_num=None):
        # An explicit array_num=1 represents an allocated empty FString;
        # omitting it follows FString(const TCHAR*) and leaves empty raw.
        if array_num is None:
            array_num = len(text) + 1 if text else 0
        if array_max < array_num:
            raise ValueError('FString ArrayMax must be at least ArrayNum')
        data = self.alloc(max(array_max, 1) * 2)
        units = [ord(c) for c in text] + [0]
        units.extend([0] * max(0, array_max - len(units)))
        self.write(data, f'{max(array_max, 1)}H', *units[:max(array_max, 1)])
        return self.fstring_record(data, array_num, array_max)

    def int_property(self):
        record = self.alloc(0x80)
        self.write(record, '4I', INT_VTABLE, 0, 0, 0)
        self.write(record + 0x38, 'I', 4)
        return record

    def array_property(self, inner):
        record = self.alloc(0x80)
        self.write(record, 'I', ARRAY_VTABLE)
        self.write(record + 0x5c, 'I', inner)
        return record

    def tarray(self, items):
        data = self.alloc(4 * len(items))
        self.write(data, f'{len(items)}I', *items)
        record = self.alloc(0xc)
        self.write(record, '3I', data, len(items), len(items))
        return record

    def str_serialize_item(self, ar, string):
        self.call(0x10167750, 0, struct.pack('<II', ar, string))

    def array_serialize_item(self, ar, value, property_record):
        self.call(0x10168520, property_record, struct.pack('<II', ar, value))

    def map_serialize_item(self, ar, value):
        self.call(0x10168d90, 0, struct.pack('<II', ar, value))

    def bool_serialize_item(self, ar, value_word):
        record = self.alloc(0x80)
        self.write(record, 'I', 0x10175c84)
        self.write(record + 0x5c, 'I', 4)  # BitMask = 4 (bit 2)
        value = self.alloc(4)
        self.write(value, 'I', value_word)
        self.call(0x10166550, record, struct.pack('<II', ar, value))

    def code_stub(self, code):
        """Install a tiny native callback in the emulator's private heap."""
        address = self.alloc(len(code))
        self.cpu.mem_write(address, code)
        return address

    @staticmethod
    def abs_word(opcode, address):
        return opcode + struct.pack('<I', address)

    def fixed_serialize_item(self):
        """Run the original fixed-array loop against a logging Inner body."""
        # State words: preload object/count, SerializeBin Ar/Data/count, then
        # fixed Inner count and the recorded Data pointers.
        state = self.alloc(0x40)
        self.cpu.mem_write(state, bytes(0x40))
        # Inner SerializeItem(Ar, Data): log Data at state+0x18 + i*4.
        inner_stub = b''.join([
            b'\x8b\x44\x24\x08',                 # mov eax,[esp+8] (Data)
            self.abs_word(b'\x8b\x15', state + 0x14),  # mov edx,[fixed count]
            self.abs_word(b'\x89\x04\x95', state + 0x18),  # [log + edx*4] = eax
            self.abs_word(b'\xff\x05', state + 0x14),  # ++fixed count
            b'\xc2\x08\x00',                      # ret 8
        ])
        inner_stub = self.code_stub(inner_stub)
        inner_vtable = self.alloc(0x80)
        self.cpu.mem_write(inner_vtable, bytes(0x80))
        self.write(inner_vtable + 0x78, 'I', inner_stub)
        inner = self.alloc(0x80)
        self.cpu.mem_write(inner, bytes(0x80))
        self.write(inner, 'I', inner_vtable)
        self.write(inner + 0x38, 'I', 4)  # Inner ElementSize / stride.
        prop = self.alloc(0x80)
        self.cpu.mem_write(prop, bytes(0x80))
        self.write(prop + 0x5c, 'I', inner)
        self.write(prop + 0x60, 'I', 3)  # Count.
        archive = self.alloc(0x20)
        data = self.alloc(0x40)
        self.call(0x10167da0, prop, struct.pack('<II', archive, data))
        count = self.read(state + 0x14, 'I')[0]
        pointers = [self.read(state + 0x18 + i * 4, 'I')[0] for i in range(count)]
        expected = [data + i * 4 for i in range(3)]
        if count != 3 or pointers != expected:
            raise AssertionError(f'fixed SerializeItem mismatch: count={count}, pointers={pointers}, expected={expected}')
        return {
            'count': count,
            'innerElementSize': 4,
            'dataBase': data,
            'innerDataPointers': pointers,
            'innerDataOffsets': [pointer - data for pointer in pointers],
        }

    def struct_serialize_item(self):
        """Run the original StructProperty wrapper with logging virtuals."""
        # State words: Preload argument/count, SerializeBin Ar/Data/count.
        state = self.alloc(0x30)
        self.cpu.mem_write(state, bytes(0x30))
        preload_stub = b''.join([
            b'\x8b\x44\x24\x04',                 # mov eax,[esp+4] (Struct)
            self.abs_word(b'\xa3', state + 0x00),
            self.abs_word(b'\xff\x05', state + 0x04),
            b'\xc2\x04\x00',                      # ret 4
        ])
        preload_stub = self.code_stub(preload_stub)
        bin_stub = b''.join([
            b'\x8b\x44\x24\x04',                 # mov eax,[esp+4] (Ar)
            self.abs_word(b'\xa3', state + 0x08),
            b'\x8b\x44\x24\x08',                 # mov eax,[esp+8] (Data)
            self.abs_word(b'\xa3', state + 0x0c),
            self.abs_word(b'\xff\x05', state + 0x10),
            b'\xc2\x08\x00',                      # ret 8
        ])
        bin_stub = self.code_stub(bin_stub)
        archive_vtable = self.alloc(0x40)
        self.cpu.mem_write(archive_vtable, bytes(0x40))
        self.write(archive_vtable + 0x10, 'I', preload_stub)
        archive = self.alloc(0x30)
        self.cpu.mem_write(archive, bytes(0x30))
        self.write(archive, 'I', archive_vtable)
        struct_vtable = self.alloc(0x80)
        self.cpu.mem_write(struct_vtable, bytes(0x80))
        self.write(struct_vtable + 0x70, 'I', bin_stub)
        structure = self.alloc(0x80)
        self.cpu.mem_write(structure, bytes(0x80))
        self.write(structure, 'I', struct_vtable)
        prop = self.alloc(0x80)
        self.cpu.mem_write(prop, bytes(0x80))
        self.write(prop + 0x5c, 'I', structure)
        data = self.alloc(0x40)
        self.call(0x101691b0, prop, struct.pack('<II', archive, data))
        preload_object, preload_count = self.read(state + 0x00, '2I')
        bin_archive, bin_data, bin_count = self.read(state + 0x08, '3I')
        if (preload_object, preload_count) != (structure, 1):
            raise AssertionError(f'StructProperty Preload mismatch: {(preload_object, preload_count)}')
        if (bin_archive, bin_data, bin_count) != (archive, data, 1):
            raise AssertionError(f'StructProperty SerializeBin mismatch: {(bin_archive, bin_data, bin_count)}')
        return {
            'preloadObject': preload_object,
            'preloadCount': preload_count,
            'serializeBinArchive': bin_archive,
            'serializeBinData': bin_data,
            'serializeBinCount': bin_count,
            'preloadIsStruct': preload_object == structure,
            'serializeBinArgsMatch': bin_archive == archive and bin_data == data,
        }


def main():
    if len(sys.argv) != 2:
        sys.exit('Usage: native-property-serialize-item-oracle.py GAME_ROOT')
    root = Path(sys.argv[1])
    native = SerializeItemProbe(root)
    results = {}

    # --- UStrProperty::SerializeItem: Ar << *(FString*)Data ---
    for text, label in [('', 'str_empty'), ('a', 'str_1'), ('abc', 'str_3'),
                        ('hello', 'str_5'), ('\u00e9', 'str_ascii_233'),
                        ('\u0100', 'str_unicode_0x100'), ('\u4e2d', 'str_unicode_0x4e2d'),
                        ('h\u0100llo', 'str_unicode_mixed')]:
        ar = native.measure_archive()
        native.str_serialize_item(ar, native.fstring(text))
        results[label] = native.counter(ar)

    # ArrayNum includes the terminating code unit and controls the serialized
    # byte count; ArrayMax is capacity only.
    ar = native.measure_archive()
    native.str_serialize_item(ar, native.fstring_with_capacity('abc', 20))
    results['str_cap20_num4'] = native.counter(ar)

    # Keep raw empty (Num=0) distinct from an allocated one-code-unit empty
    # FString (Num=1), which serializes its terminator.
    ar = native.measure_archive()
    native.str_serialize_item(ar, native.fstring_with_capacity('', 1, array_num=1))
    results['str_allocated_empty'] = native.counter(ar)

    # --- UArrayProperty::SerializeItem: count + inner items ---
    arr_prop = native.array_property(native.int_property())
    for items, label in [([7, 9], 'array_2_ints'), ([], 'array_empty')]:
        ar = native.measure_archive()
        native.array_serialize_item(ar, native.tarray(items), arr_prop)
        results[label] = native.counter(ar)

    # --- UMapProperty::SerializeItem: immediate ret, no counter change ---
    ar = native.measure_archive()
    native.map_serialize_item(ar, 0)
    results['map_any'] = native.counter(ar)

    # --- UBoolProperty::SerializeItem: 1 byte raw write for the bit ---
    for word, label in [(0, 'bool_clear'), (4, 'bool_set'), (0xffffffff, 'bool_all')]:
        ar = native.measure_archive()
        native.bool_serialize_item(ar, word)
        results[label] = native.counter(ar)

    # --- UFixedArrayProperty/UStructProperty::SerializeItem -----------------
    # These bodies do not use the collector measure vtable directly.  Tiny
    # private native callbacks let the oracle observe the original virtual
    # call order and pointer arithmetic without substituting a host behavior.
    results['fixed_array'] = native.fixed_serialize_item()
    results['struct'] = native.struct_serialize_item()
    # Variable-width CompactIndex plus native FString/TArray loading and
    # saving.  The archive raw slot and GMalloc Realloc are the only host
    # callbacks; all property and CompactIndex instructions are original.
    results['str_load_save'] = native.string_load_save()
    results['array_load_save'] = native.array_load_save()

    print(json.dumps({'hashes': _native_collision.HASHES, 'results': results}))


if __name__ == '__main__':
    main()
