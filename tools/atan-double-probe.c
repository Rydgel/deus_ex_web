/* Measure appAtan(double) on real x87 hardware for the AICanSee(705) native.
 *
 * The Engine worker calls Core.dll's appAtan(double) thunk — `fld1; fpatan`
 * computes atan2(x,1) == atan(x) — with a full-precision double argument that
 * arises inside the body (the horizontal/vertical angular-extent ratios), not
 * a float32.  Unicorn's softfloat is not authoritative for fpatan, so each
 * distinct input bit pattern is measured under Rosetta 2 / Wine instead.
 *
 * Build:  i686-w64-mingw32-gcc -O1 -o .cache/atan-double-probe.exe \
 *             tools/atan-double-probe.c
 * Run:    CX_BOTTLE=DeusEx .../wine .cache/atan-double-probe.exe \
 *             3fb3e7873faca0fc ...
 * Output: inputHex,resultHex,extendedHex  (the fpatan double as 16 hex digits, then the unrounded 80-bit result as 20)
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static unsigned long long probe_atan(double d, unsigned char ext[10]){
    double r; unsigned short sw;
    __asm__ volatile(
        "fldl %3\n\t"
        "fld1\n\t"
        "fpatan\n\t"
        "fnstsw %1\n\t"
        "fld %%st(0)\n\t"
        "fstpt %2\n\t"
        "fstpl %0\n\t"
        "fninit\n\t"
        : "=m"(r), "=m"(sw), "=m"(*(unsigned char (*)[10])ext) : "m"(d) : "st");
    unsigned long long bits; memcpy(&bits,&r,8);
    return bits;
}

int main(int argc,char**argv){
    for(int i=1;i<argc;i++){
        unsigned long long in=strtoull(argv[i],0,16);
        double d; memcpy(&d,&in,8);
        unsigned char ext[10];
        unsigned long long out=probe_atan(d,ext);
        /* input, the result stored as a double (fstpl), then the extended result itself (fstpt, 20 hex digits, exponent word first):
           appAtan returns it unrounded in ST0 (Core 0x10123270: fld qword; fld1; fpatan; ret). */
        printf("%016llx,%016llx,",in,out);
        for(int b=9;b>=0;b--) printf("%02x",ext[b]);
        printf("\n");
    }
    return 0;
}
