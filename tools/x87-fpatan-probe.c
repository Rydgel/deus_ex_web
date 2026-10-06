/* Measure FPATAN on real x87 hardware for Render.dll's spatial light
 * functions (docs/static-lighting.md "Spatially dynamic effects").
 *
 * Core appAtan2 (0x10123280) is `fld qword [esp+4]; fld qword [esp+0xc];
 * fpatan; ret`: atan2(Y, X) left on the stack in extended precision. The
 * Unicorn oracle computes FPATAN through a host double, so the extended
 * results for the pairs a validation needs are measured here instead.
 *
 * Build:  i686-w64-mingw32-gcc -O1 -o .cache/x87-fpatan-probe.exe \
 *             tools/x87-fpatan-probe.c
 * Run:    wine .cache/x87-fpatan-probe.exe pairs.txt 0x007f
 *         (pairs.txt: one "YYYYYYYYYYYYYYYY XXXXXXXXXXXXXXXX" pair of double
 *         bit patterns per line)
 * Output: one line per pair: the 80-bit result as 20 hex digits (sign and
 *         exponent, then the 64-bit significand), first line "#cw=..." with
 *         the control word read back.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void probe(unsigned long long y, unsigned long long x, unsigned short cw, unsigned char out[10]) {
    double dy, dx;
    memcpy(&dy, &y, 8); memcpy(&dx, &x, 8);
    __asm__ volatile(
        "fninit\n\t"
        "fldcw %3\n\t"
        "fldl %1\n\t"
        "fldl %2\n\t"
        "fpatan\n\t"
        "fstpt %0\n\t"
        "fninit\n\t"
        : "=m"(*(unsigned char (*)[10])out) : "m"(dy), "m"(dx), "m"(cw) : "st");
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: x87-fpatan-probe pairs.txt controlword\n"); return 1; }
    FILE *in = fopen(argv[1], "r");
    if (!in) { fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }
    unsigned short cw = (unsigned short)strtoul(argv[2], 0, 0), back;
    __asm__ volatile("fninit\n\tfldcw %1\n\tfnstcw %0\n\tfninit" : "=m"(back) : "m"(cw));
    printf("#cw=%04x\n", back);
    char line[128];
    while (fgets(line, sizeof line, in)) {
        unsigned long long y, x;
        if (sscanf(line, "%llx %llx", &y, &x) != 2) continue;
        unsigned char r[10];
        probe(y, x, cw, r);
        printf("%02x%02x", r[9], r[8]);
        for (int i = 7; i >= 0; i--) printf("%02x", r[i]);
        printf("\n");
    }
    return 0;
}
