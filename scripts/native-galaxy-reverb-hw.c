/* Run Galaxy.dll's effects-reverb setup (0x106109f0) and SSE reverb kernel
 * (0x10622d33) natively on the host CPU's x87 and SSE units, as the original
 * runs them (docs/galaxy-music/reverb.md, scripts/validate-galaxy-reverb.mjs).
 * The setup's FCOS is a transcendental Unicorn computes in double, so the
 * host's real x87 is the reference for it.
 *
 * Optional research tool. On x86 Linux build it with
 *   gcc -m32 -O1 -o galaxy-reverb-hw scripts/native-galaxy-reverb-hw.c
 * and it runs on the host's x87 and SSE units. Elsewhere (the Mac) build the
 * Windows executable with
 *   i686-w64-mingw32-gcc -O1 -o galaxy-reverb-hw.exe scripts/native-galaxy-reverb-hw.c
 * and run it under CrossOver/Wine (CX_BOTTLE=DeusEx): on Apple silicon that is
 * Rosetta 2's translation of the x87 and SSE instructions, not an x87 unit.
 * It embeds no original data: it reads the hash-pinned Galaxy.dll given on
 * the command line and maps its sections at the preferred base 0x10600000
 * (no relocation needed). The only import the two functions reach is
 * MSVCRT _ftol (through the thunk 0x106300f4), whose IAT slot is pointed at
 * a bridge with the same instructions (truncating FISTP under a saved and
 * restored control word). Globals set as the library leaves them after the
 * output open: the rate [0x10697d18] = 44100, the output type [0x1069817a]
 * = 0 (no EAX/A3D: the setup returns after the six delay taps).
 *
 * Usage: galaxy-reverb-hw GALAXY_DLL SCRIPT OUT
 * SCRIPT is a sequence of ops (little-endian u32 fields):
 *   1 setup  cw [0x6c-byte glxReverb]  FLDCW cw, then 0x106109f0(ctx, &copy);
 *            record 'S' = u32 result, ctx[0..0xc8], the glxReverb after the call
 *   2 kernel count [count*8 send bytes] [count*8 dry bytes]
 *            MXCSR 0x1f80, 0x10622d33(ctx, dry, send, count, 0) on the current
 *            ctx; record 'K' = dry after, ctx[0..0xc8]
 *   3 dump   record 'D' = the whole ctx (0x60188 bytes)
 *   4 sweep  cw first last [0x6c-byte glxReverb]  for each cutoff in
 *            [first, last]: x = f32(cutoff) * f32 [0x1063ed04] / (int)rate
 *            and FCOS(x) exactly as 0x10610a9c..0x10610ac1 compute them (FLD
 *            m32, FMUL m32, FIDIV m32, FCOS), then the setup with HFDamp =
 *            cutoff; record 'X' = x (10 bytes), FCOS(x) (10 bytes), FPU status
 *            word after FCOS (u16), then ctx+0x68 (k) and ctx+0x80 (1 - k)
 *   5 ctx    [0x60188 bytes]  replace the ctx
 * OUT receives the records as tag(1) u32 length payload. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#include <malloc.h>
#else
#include <sys/mman.h>
#endif

#define BASE 0x10600000u
#define SETUP 0x106109f0u
#define KERNEL 0x10622d33u
#define FTOL_THUNK 0x106300f4u
#define RATE 0x10697d18u
#define OUTPUT_TYPE 0x1069817au
#define HFDAMP_SCALE 0x1063ed04u
#define CTX_SIZE 0x60188u
#define REVERB_SIZE 0x6c

typedef int (*setup_fn)(void *ctx, void *reverb);
typedef void (*kernel_fn)(void *ctx, void *dry, void *send, uint32_t count, uint32_t flags);

static uint8_t *slurp(const char *path, size_t *size) {
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); exit(2); }
    fseek(f, 0, SEEK_END);
    *size = (size_t)ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *b = malloc(*size ? *size : 1);
    if (fread(b, 1, *size, f) != *size) { perror(path); exit(2); }
    fclose(f);
    return b;
}

static uint32_t rd32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static uint16_t rd16(const uint8_t *p) { uint16_t v; memcpy(&v, p, 2); return v; }

/* MSVCRT _ftol: truncate ST(0) to int64 (pop), EDX:EAX. */
__attribute__((naked)) static void ftol_bridge(void) {
    __asm__ volatile(
        "push %ebp\n mov %esp, %ebp\n sub $12, %esp\n"
        "fnstcw -2(%ebp)\n mov -2(%ebp), %ax\n or $0x0c, %ah\n mov %ax, -4(%ebp)\n"
        "fldcw -4(%ebp)\n fistpll -12(%ebp)\n fldcw -2(%ebp)\n"
        "mov -12(%ebp), %eax\n mov -8(%ebp), %edx\n leave\n ret\n");
}

static void map_image(const uint8_t *dll, size_t size) {
    uint32_t pe = rd32(dll + 0x3c);
    if (pe + 0xf8 > size || rd32(dll + pe) != 0x4550) { fprintf(stderr, "not a PE image\n"); exit(2); }
    uint16_t sections = rd16(dll + pe + 6), optional = rd16(dll + pe + 0x14);
    uint32_t base = rd32(dll + pe + 0x34), image = rd32(dll + pe + 0x50);
    if (base != BASE) { fprintf(stderr, "unexpected image base %#x\n", base); exit(2); }
#ifdef _WIN32
    void *p = VirtualAlloc((void *)(uintptr_t)BASE, image, MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE);
#else
    void *p = mmap((void *)(uintptr_t)BASE, image, PROT_READ | PROT_WRITE | PROT_EXEC,
                   MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
#endif
    if (p != (void *)(uintptr_t)BASE) { fprintf(stderr, "cannot map %#x\n", BASE); exit(2); }
    memcpy(p, dll, 0x400);
    const uint8_t *table = dll + pe + 0x18 + optional;
    for (int i = 0; i < sections; i++) {
        const uint8_t *s = table + 40 * i;
        uint32_t vsize = rd32(s + 8), va = rd32(s + 12), raw = rd32(s + 16), ptr = rd32(s + 20);
        uint32_t n = raw < vsize || !vsize ? raw : vsize;
        if (ptr + n > size || va + n > image) { fprintf(stderr, "bad section\n"); exit(2); }
        memcpy((uint8_t *)p + va, dll + ptr, n);
    }
    /* The _ftol thunk is `jmp dword ptr [slot]` (ff 25 slot). */
    const uint8_t *thunk = (const uint8_t *)(uintptr_t)FTOL_THUNK;
    if (thunk[0] != 0xff || thunk[1] != 0x25) { fprintf(stderr, "unexpected _ftol thunk\n"); exit(2); }
    *(uint32_t *)(uintptr_t)rd32(thunk + 2) = (uint32_t)(uintptr_t)&ftol_bridge;
    *(uint32_t *)(uintptr_t)RATE = 44100;
    *(uint8_t *)(uintptr_t)OUTPUT_TYPE = 0;
}

static void emit(FILE *out, char tag, const void *payload, uint32_t size) {
    fputc(tag, out);
    fwrite(&size, 4, 1, out);
    fwrite(payload, 1, size, out);
}

static uint16_t control_word(void) { uint16_t cw; __asm__ volatile("fnstcw %0" : "=m"(cw)); return cw; }
static void set_control_word(uint16_t cw) { __asm__ volatile("fninit\n fldcw %0" : : "m"(cw)); }

int main(int argc, char **argv) {
    if (argc != 4 || sizeof(void *) != 4) {
        fprintf(stderr, "usage: galaxy-reverb-hw GALAXY_DLL SCRIPT OUT (a 32-bit build)\n");
        return 2;
    }
    size_t dll_size, script_size;
    uint8_t *dll = slurp(argv[1], &dll_size);
    uint8_t *script = slurp(argv[2], &script_size);
    map_image(dll, dll_size);
    setup_fn setup = (setup_fn)(uintptr_t)SETUP;
    kernel_fn kernel = (kernel_fn)(uintptr_t)KERNEL;
#ifdef _WIN32
    uint8_t *ctx = _aligned_malloc((CTX_SIZE + 63) & ~63u, 64);
#else
    uint8_t *ctx = aligned_alloc(64, (CTX_SIZE + 63) & ~63u);
#endif
    memset(ctx, 0, CTX_SIZE);
    uint8_t reverb[REVERB_SIZE];
    uint32_t mxcsr = 0x1f80;
    __asm__ volatile("ldmxcsr %0" : : "m"(mxcsr));
    uint16_t initial = control_word();
    FILE *out = fopen(argv[3], "wb");
    if (!out) { perror(argv[3]); return 2; }
    size_t at = 0;
#define U32() (at += 4, rd32(script + at - 4))
    while (at < script_size) {
        uint32_t op = U32();
        if (op == 1) {
            uint16_t cw = (uint16_t)U32();
            memcpy(reverb, script + at, REVERB_SIZE); at += REVERB_SIZE;
            memset(ctx, 0xa5, CTX_SIZE);
            set_control_word(cw);
            int r = setup(ctx, reverb);
            set_control_word(initial);
            uint8_t rec[4 + 0xc8 + REVERB_SIZE];
            memcpy(rec, &r, 4); memcpy(rec + 4, ctx, 0xc8); memcpy(rec + 4 + 0xc8, reverb, REVERB_SIZE);
            emit(out, 'S', rec, sizeof rec);
        } else if (op == 2) {
            uint32_t count = U32();
            uint8_t *send = malloc(count * 8 + 8), *dry = malloc(count * 8 + 8);
            memcpy(send, script + at, count * 8); at += count * 8;
            memcpy(dry, script + at, count * 8); at += count * 8;
            kernel(ctx, dry, send, count, 0);
            uint8_t *rec = malloc(count * 8 + 0xc8);
            memcpy(rec, dry, count * 8); memcpy(rec + count * 8, ctx, 0xc8);
            emit(out, 'K', rec, count * 8 + 0xc8);
            free(rec); free(send); free(dry);
        } else if (op == 3) {
            emit(out, 'D', ctx, CTX_SIZE);
        } else if (op == 4) {
            uint16_t cw = (uint16_t)U32();
            uint32_t first = U32(), last = U32();
            memcpy(reverb, script + at, REVERB_SIZE); at += REVERB_SIZE;
            for (uint32_t cutoff = first; cutoff <= last; cutoff++) {
                float hf = (float)cutoff;
                uint8_t x[10], c[10], rec[28];
                uint16_t sw;
                set_control_word(cw);
                __asm__ volatile(
                    "flds %3\n fmuls (%4)\n fidivl (%5)\n fld %%st(0)\n fstpt %0\n fcos\n fnstsw %2\n fstpt %1\n"
                    : "=m"(x), "=m"(c), "=m"(sw)
                    : "m"(hf), "r"((uintptr_t)HFDAMP_SCALE), "r"((uintptr_t)RATE)
                    : "memory");
                memcpy(reverb + 0x10, &hf, 4);
                memset(ctx, 0xa5, 0xc8);
                setup(ctx, reverb);
                set_control_word(initial);
                memcpy(rec, x, 10); memcpy(rec + 10, c, 10); memcpy(rec + 20, &sw, 2);
                memcpy(rec + 22, ctx + 0x68, 4);
                rec[26] = rec[27] = 0;
                emit(out, 'X', rec, 22);
                emit(out, 'k', ctx + 0x68, 4);
                emit(out, 'm', ctx + 0x80, 4);
            }
        } else if (op == 5) {
            memcpy(ctx, script + at, CTX_SIZE); at += CTX_SIZE;
        } else {
            fprintf(stderr, "bad op %u\n", op);
            return 2;
        }
    }
    __asm__ volatile("stmxcsr %0" : "=m"(mxcsr));
    fclose(out);
    if ((mxcsr & 0xffc0) != 0x1f80) { fprintf(stderr, "MXCSR changed: %#x\n", mxcsr); return 3; }
    return 0;
}
