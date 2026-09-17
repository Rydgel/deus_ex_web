/* Measure the real x87 sequence behind FVector::Rotation (Core.dll
 * 0x10144390, reached from Engine pawn-locomotion natives through IAT
 * 0x1059a0a0).  Unicorn implements FPATAN by round-tripping through a host
 * double and is NOT authoritative for it; this probe reproduces the exact
 * shipped instruction sequence under Wine so the measurements come from a
 * real FPU:
 *
 *   yaw:   fld y64; fld x64; fpatan; fmul qword S;  _ftol (RC=truncate)
 *   hyp:   fld y32; fld x32; fld st1; fmul st2; fld st1; fmul st2;
 *          faddp st1; fstp q64; fstp st0; fstp st0; [fld q64; fsqrt; ret];
 *          fstp q64
 *   pitch: fld z64; fld hyp64; fpatan; fmul qword S; _ftol
 *   out rotator = {pitch, yaw, 0}
 *
 * S is the embedded double at Core 0x10178050 = 10430.219195527361
 * (bytes b95a990e1c5fc440).  _ftol is the shipped MSVCRT body: fnstcw,
 * set RC=truncate, fistp qword, restore; the low DWORD is the result.
 *
 * Usage: pawn-rotation-probe.exe reads "xbits ybits zbits" hex lines on
 * stdin, prints "xbits,ybits,zbits,pitch,yaw,roll" on stdout.  A leading
 * "# default_cw=XXXX" line reports the CRT control word.
 *
 * Build: i686-w64-mingw32-gcc -O1 -o .cache/pawn-rotation-probe.exe \
 *          tools/pawn-rotation-probe.c
 * Run:   CX_BOTTLE=DeusEx wine .cache/pawn-rotation-probe.exe < inputs.txt
 */
#include <stdio.h>
#include <string.h>
#include <stdint.h>

static unsigned short get_cw(void){ unsigned short cw; __asm__ volatile("fnstcw %0":"=m"(cw)); return cw; }

static const double ROT_SCALE = 10430.219195527361; /* 0x10178050 bits */

/* fpatan(y,x)*S then the shipped _ftol (fnstcw; RC=truncate; fistp qword;
 * restore) — returns the low dword exactly like the caller keeps eax. */
static int32_t atan_trunc(double x, double y){
    long long v = 0;
    unsigned short oldcw = 0, truncw = 0;
    __asm__ volatile(
        "fldl %3\n\t"              /* y */
        "fldl %2\n\t"              /* x */
        "fpatan\n\t"               /* st0 = atan2(y,x) */
        "fmull %4\n\t"             /* * S (embedded double multiply) */
        "fnstcw %1\n\t"
        "movzwl %1, %%eax\n\t"
        "orw $0x0c00, %%ax\n\t"    /* RC = truncate */
        "movw %%ax, %5\n\t"
        "fldcw %5\n\t"
        "fistpq %0\n\t"
        "fldcw %1\n\t"
        : "=m"(v), "=m"(oldcw)
        : "m"(x), "m"(y), "m"(ROT_SCALE), "m"(truncw)
        : "eax", "st");
    return (int32_t)(v & 0xffffffff);
}

static void rotation(float xf, float yf, float zf, int32_t out[3]){
    double x = (double)xf, y = (double)yf, z = (double)zf;
    double hyp = 0;
    int32_t yaw = atan_trunc(x, y);
    /* the exact hypot chain: f32 squares summed in 80-bit, stored double,
     * CRT fsqrt on the double, stored double again */
    __asm__ volatile(
        "flds %2\n\t"          /* y32 */
        "flds %1\n\t"          /* x32 */
        "fld %%st(1)\n\t"      /* y */
        "fmul %%st(2)\n\t"     /* y*y */
        "fld %%st(1)\n\t"      /* x */
        "fmul %%st(2)\n\t"     /* x*x */
        "faddp %%st(1)\n\t"    /* x^2+y^2 */
        "fstpl %0\n\t"         /* store double */
        "fstp %%st(0)\n\t"
        "fstp %%st(0)\n\t"
        : "=m"(hyp) : "m"(xf), "m"(yf) : "st");
    __asm__ volatile(
        "fldl %0\n\t"
        "fsqrt\n\t"
        "fstpl %0\n\t"
        : "+m"(hyp) :: "st");
    int32_t pitch = atan_trunc(hyp, z);
    out[0]=pitch; out[1]=yaw; out[2]=0;
}

int main(void){
    fprintf(stderr, "CRT default control word = 0x%04x\n", get_cw());
    printf("# default_cw=%04x\n", get_cw());
    char line[128];
    while (fgets(line, sizeof line, stdin)) {
        unsigned xb, yb, zb;
        if (sscanf(line, "%x %x %x", &xb, &yb, &zb) != 3) continue;
        float xf, yf, zf;
        memcpy(&xf,&xb,4); memcpy(&yf,&yb,4); memcpy(&zf,&zb,4);
        int32_t out[3];
        rotation(xf,yf,zf,out);
        printf("%08x,%08x,%08x,%08x,%08x,%08x\n", xb,yb,zb,
               (unsigned)out[0],(unsigned)out[1],(unsigned)out[2]);
    }
    return 0;
}
