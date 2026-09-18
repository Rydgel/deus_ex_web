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
 * Output: inputHex,resultHex  (result = the fpatan double, as 16 hex digits)
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static unsigned long long probe_atan(double d){
    double r; unsigned short sw;
    __asm__ volatile(
        "fldl %2\n\t"
        "fld1\n\t"
        "fpatan\n\t"
        "fnstsw %1\n\t"
        "fstpl %0\n\t"
        "fninit\n\t"
        : "=m"(r), "=m"(sw) : "m"(d) : "st");
    unsigned long long bits; memcpy(&bits,&r,8);
    return bits;
}

int main(int argc,char**argv){
    for(int i=1;i<argc;i++){
        unsigned long long in=strtoull(argv[i],0,16);
        double d; memcpy(&d,&in,8);
        printf("%016llx,%016llx\n",in,probe_atan(d));
    }
    return 0;
}
