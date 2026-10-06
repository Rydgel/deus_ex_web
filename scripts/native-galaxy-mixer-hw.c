/* Run Galaxy.dll's SSE mixing kernel (template 0x10622730) and SSE conversion
 * (template 0x10622fe4) on the host CPU, to check that Unicorn executes them
 * exactly (docs/galaxy-music/mixer.md, scripts/validate-galaxy-mixer.mjs).
 *
 * Optional research tool, x86 Linux only: build with
 *   gcc -m32 -O1 -o galaxy-mixer-hw scripts/native-galaxy-mixer-hw.c
 * It embeds no original data: NATIVE_CODE is the oracle's native-code.bin
 * (the two templates and the page 0x1064d000 of the hash-pinned DLL at its
 * preferred base), copied at run time to executable memory and to a fixed
 * mapping at 0x1064d000 (the templates address their gain vectors, mask,
 * 2^-30 constant and saved-ESP slot there). Sample memory is mapped at the
 * oracle's FAB address 0x50000000, so kernel positions are the same values.
 * The kernel repurposes ESP while it runs, as in the original.
 *
 * Usage: galaxy-mixer-hw NATIVE_CODE SCRIPT OUT
 * SCRIPT is a sequence of ops (little-endian u32 fields):
 *   0 reset                      zero the buses and the sample memory
 *   1 buses  [6*0x1040 bytes]    the six buses d00..d14
 *   2 data   addr len [bytes]    sample memory (inside 0x50000000 + 1 MB)
 *   3 kernel music offset count pos frac step L R s1L s1R s2L s2R mode
 *                                writes record 'Z' = the group's three buses
 *   4 convert bus first frames fmt len [bytes]
 *                                writes record 'C' = dst after conv(bus+8*first, frames, dst, fmt)
 * OUT receives the records as tag(1) u32 length payload, the oracle's format. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>

#define KERNEL_SIZE 0x603
#define CONV_SIZE 0x1ed
#define PAGE 0x1064d000u
#define FAB 0x50000000u
#define FAB_SIZE 0x100000u
#define BUS_BYTES 0x1040

typedef void (*kernel_fn)(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t,
                          uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
typedef void (*conv_fn)(uint32_t, uint32_t, uint32_t, uint32_t);

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

static void *fixed(uint32_t address, uint32_t size) {
    void *p = mmap((void *)(uintptr_t)address, size, PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
    if (p != (void *)(uintptr_t)address) { fprintf(stderr, "cannot map %#x\n", address); exit(2); }
    return p;
}

static void emit(FILE *out, char tag, const void *payload, uint32_t size) {
    fputc(tag, out);
    fwrite(&size, 4, 1, out);
    fwrite(payload, 1, size, out);
}

int main(int argc, char **argv) {
    if (argc != 4 || sizeof(void *) != 4) {
        fprintf(stderr, "usage: galaxy-mixer-hw NATIVE_CODE SCRIPT OUT (a 32-bit build)\n");
        return 2;
    }
    size_t code_size, script_size;
    uint8_t *code = slurp(argv[1], &code_size);
    uint8_t *script = slurp(argv[2], &script_size);
    if (code_size != KERNEL_SIZE + CONV_SIZE + 0x1000) { fprintf(stderr, "bad native code\n"); return 2; }
    memcpy(fixed(PAGE, 0x1000), code + KERNEL_SIZE + CONV_SIZE, 0x1000);
    uint8_t *fab = fixed(FAB, FAB_SIZE);
    uint8_t *exec = mmap(0, 0x1000, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (exec == MAP_FAILED) { perror("mmap"); return 2; }
    memcpy(exec, code, KERNEL_SIZE + CONV_SIZE); /* as the setup 0x106231d1 lays them out */
    kernel_fn kernel = (kernel_fn)(void *)exec;
    conv_fn conv = (conv_fn)(void *)(exec + KERNEL_SIZE);
    uint8_t *buses = aligned_alloc(64, 6 * BUS_BYTES);
    uint8_t *dst = aligned_alloc(64, 0x4000);
    memset(buses, 0, 6 * BUS_BYTES);
    uint32_t mxcsr = 0x1f80; /* the Windows thread default; Linux starts with the same */
    __asm__ volatile("ldmxcsr %0" : : "m"(mxcsr));
    FILE *out = fopen(argv[3], "wb");
    if (!out) { perror(argv[3]); return 2; }
    size_t at = 0;
#define U32() (at += 4, *(uint32_t *)(script + at - 4))
    while (at < script_size) {
        uint32_t op = U32();
        if (op == 0) {
            memset(buses, 0, 6 * BUS_BYTES);
            memset(fab, 0, FAB_SIZE);
        } else if (op == 1) {
            memcpy(buses, script + at, 6 * BUS_BYTES);
            at += 6 * BUS_BYTES;
        } else if (op == 2) {
            uint32_t address = U32(), len = U32();
            if (address < FAB || address + len > FAB + FAB_SIZE) { fprintf(stderr, "data outside FAB\n"); return 2; }
            memcpy((void *)(uintptr_t)address, script + at, len);
            at += len;
        } else if (op == 3) {
            uint32_t music = U32(), offset = U32(), a[11];
            for (int i = 0; i < 11; i++) a[i] = U32();
            uint32_t g = music ? 0 : 1;
            uint32_t b0 = (uint32_t)(uintptr_t)(buses + g * BUS_BYTES) + offset;
            uint32_t b1 = (uint32_t)(uintptr_t)(buses + (g + 2) * BUS_BYTES) + offset;
            uint32_t b2 = (uint32_t)(uintptr_t)(buses + (g + 4) * BUS_BYTES) + offset;
            kernel(b0, b1, b2, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10]);
            uint8_t rec[3 * BUS_BYTES];
            for (int k = 0; k < 3; k++) memcpy(rec + k * BUS_BYTES, buses + (g + 2 * k) * BUS_BYTES, BUS_BYTES);
            emit(out, 'Z', rec, sizeof rec);
        } else if (op == 4) {
            uint32_t bus = U32(), first = U32(), frames = U32(), fmt = U32(), len = U32();
            memcpy(dst, script + at, len);
            at += len;
            conv((uint32_t)(uintptr_t)(buses + bus * BUS_BYTES) + 8 * first, frames, (uint32_t)(uintptr_t)dst, fmt);
            emit(out, 'C', dst, len);
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
