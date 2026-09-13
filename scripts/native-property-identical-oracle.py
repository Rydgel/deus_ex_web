"""Execute original Core.dll UStrProperty::Identical / UMapProperty::Identical
in the isolated x86 emulator.

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


class IdenticalProbe(NativeCollision):
    # _wcsicmp(a at [esp+4], b at [esp+8]) ASCII case-insensitive compare.
    # loop: ca=towupper(*a); cb=towupper(*b); if ca!=cb return ca-cb;
    #       if ca==0 return 0; a+=2; b+=2.
    # Layout (offsets for the relative jumps):
    #   00 mov esi,[esp+4]  04 mov edi,[esp+8]  08 movzx eax,[esi]
    #   0b movzx ebx,[edi]  0e cmp eax,'a'  11 jb -> 1b  13 cmp eax,'z'
    #   16 ja -> 1b  18 sub eax,0x20  1b cmp ebx,'a'  1e jb -> 2b
    #   20 cmp ebx,'z'  23 ja -> 2b  25 sub ebx,0x20  2b cmp eax,ebx
    #   2d jne -> 3e  2f test eax,eax  31 jz -> 3b  33 add esi,2
    #   36 add edi,2  39 jmp -> 08  3b xor eax,eax; ret  3e sub eax,ebx; ret
    WCSICMP_STUB = bytes.fromhex(
        '8b 74 24 04 8b 7c 24 08'      # mov esi,[esp+4]; mov edi,[esp+8]
        '0f b7 06 0f b7 1f'            # movzx eax,word[esi]; movzx ebx,word[edi]
        '83 f8 61 72 08'               # cmp eax,'a'; jb +8 -> 1b
        '83 f8 7a 77 03'               # cmp eax,'z'; ja +3 -> 1b
        '83 e8 20'                     # sub eax,0x20
        '83 fb 61 72 0b'               # cmp ebx,'a'; jb +11 -> 2b
        '83 fb 7a 77 06'               # cmp ebx,'z'; ja +6 -> 2b
        '81 eb 20 00 00 00'            # sub ebx,0x20
        '3b c3 75 0f'                  # cmp eax,ebx; jne +15 -> 3e
        '85 c0 74 08'                  # test eax,eax; jz +8 -> 3b
        '83 c6 02 83 c7 02'            # add esi,2; add edi,2
        'eb cd'                        # jmp -51 -> 08
        '33 c0 c3'                     # equal_zero: xor eax,eax; ret
        '2b c3 c3'                     # not_equal: sub eax,ebx; ret
    )

    def __init__(self, game_root):
        super().__init__(game_root)
        # The auto-allocated thunk (16 bytes) is too small for the loop body and
        # would overlap the next import's thunk.  Allocate a private copy and
        # repoint the _wcsicmp IAT slot at it.
        image = _native_collision.Image(game_root / 'System' / 'Core.dll')
        for dll, symbol, iat in image.imports():
            if dll == 'msvcrt.dll' and symbol == '_wcsicmp':
                self.thunks = {a: t for a, t in self.thunks.items() if t != ('msvcrt.dll', '_wcsicmp')}
                code = self.alloc(len(self.WCSICMP_STUB))
                self.cpu.mem_write(code, self.WCSICMP_STUB)
                self.write(iat, 'I', code)
                self.wcsicmp = code

    def fstring(self, text):
        data = self.alloc((len(text) + 1) * 2)
        self.write(data, f'{len(text) + 1}H', *[ord(c) for c in text], 0)
        record = self.alloc(0xc)
        self.write(record, 'I2I', data, len(text) + 1, len(text))
        return record

    def empty_fstring(self):
        record = self.alloc(0xc)
        self.write(record, '3I', 0, 0, 0)
        return record

    def str_identical(self, a, b):
        # Identical(const void* A, const void* B); A at stack+4, B at stack+8.
        return self.call(0x101676f0, 0, struct.pack('<II', a, b))

    def map_identical(self):
        return self.call(0x10168d80, 0, struct.pack('<II', 0, 0))


def main():
    if len(sys.argv) != 2:
        sys.exit('Usage: native-property-identical-oracle.py GAME_ROOT')
    root = Path(sys.argv[1])
    native = IdenticalProbe(root)

    # The two string-literal addresses in UStrProperty::Identical.
    for address, label in [(0x101ef654, 'empty'), (0x102a7fe8, 'none')]:
        words = native.read(address, '16H')
        print(f'{label} literal @ {address:#x}: utf16={words!r}')

    hello = native.fstring('hello')
    empty = native.fstring('')
    world = native.fstring('world')
    # Direct _wcsicmp checks on the stubbed import.
    hello_data = native.read(hello, 'I')[0]
    world_data = native.read(world, 'I')[0]
    wc = native.wcsicmp
    wcs = lambda a, b: native.call(wc, 0, struct.pack('<II', a, b))
    print('wcsicmp', json.dumps({
        'hello_hello': wcs(hello_data, hello_data),
        'hello_world': wcs(hello_data, world_data),
    }))
    results = {
        'hello_hello': native.str_identical(hello, hello),
        'hello_HELLO': native.str_identical(hello, native.fstring('HELLO')),
        'hello_world': native.str_identical(hello, world),
        'empty_empty': native.str_identical(empty, empty),
        'empty_arrayMax0': native.str_identical(empty, native.empty_fstring()),
        'hello_null': native.str_identical(hello, 0),
        'empty_null': native.str_identical(empty, 0),
        'world_hello': native.str_identical(world, hello),
        'map_identical': native.map_identical(),
    }
    print(json.dumps({'results': results}))


if __name__ == '__main__':
    main()