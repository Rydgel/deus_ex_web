/* Measure Galaxy.dll's FFT twiddle setup (0x1060935d..0x106093a4) on a real
 * x87, for every stage m = 2, 4, ..., 1024:
 *
 *   fild qword m; fdivr dword 2pi_f; fst dword d    ; d = float(2pi_f / m)
 *   fmul qword -2.0                                 ; -2(2pi_f/m), extended
 *   fld st0; fsin; fstp dword sm2                   ; float(sin(-2 delta))
 *   fld dword d; fchs; fst dword d; fsin; fstp sm1  ; float(sin(-d))
 *   fcos                                            ; cm2 = cos(-2 delta), stays extended
 *   fld dword d; fcos                               ; cm1 = cos(-d), stays extended
 *
 * The cosines never leave the x87 stack in Galaxy, so they are printed as
 * 80-bit values. Unicorn computes fsin/fcos through a host double, so these
 * are the oracle's and the kernel's references (docs/lip-sync.md).
 *
 * Output CSV: m,deltaBits,minus2DeltaExt,sm2Bits,sm1Bits,cm2Ext,cm1Ext,statusWord
 * (Ext = 4 hex digits sign/exponent then 16 hex digits significand).
 *
 * Build (macOS, brew install mingw-w64):
 *   i686-w64-mingw32-gcc -O1 -o .cache/galaxy-fft-twiddle-probe.exe tools/galaxy-fft-twiddle-probe.c
 * Run in the CrossOver bottle:
 *   CX_BOTTLE=DeusEx /Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine \
 *     .cache/galaxy-fft-twiddle-probe.exe
 */
#include <stdio.h>
#include <string.h>

static void set_cw(unsigned short cw){ __asm__ volatile("fldcw %0"::"m"(cw)); }
static unsigned short get_sw(void){ unsigned short sw; __asm__ volatile("fnstsw %0":"=m"(sw)); return sw; }

static void ext(const unsigned char *b, char *out){
  unsigned short se; unsigned long long sig;
  memcpy(&sig, b, 8); memcpy(&se, b + 8, 2);
  sprintf(out, "%04x%016llx", se, sig);
}

int main(void){
  set_cw(0x037f);
  printf("m,deltaBits,minus2DeltaExt,sm2Bits,sm1Bits,cm2Ext,cm1Ext,statusWord\n");
  for (int m = 2; m <= 1024; m *= 2) {
    long long mm = m; unsigned twopiBits = 0x40c90fdb; float twopi; double minus2 = -2.0;
    memcpy(&twopi, &twopiBits, 4);
    float d, s2, s1; unsigned char in2[10], c2[10], c1[10];
    __asm__ volatile("fnclex");
    __asm__ volatile(
      "fildll %[mm]\n\t"
      "fdivrs %[tp]\n\t"
      "fsts %[d]\n\t"
      "fmull %[m2]\n\t"
      "fld %%st(0)\n\t"
      "fstpt %[in2]\n\t"
      "fld %%st(0)\n\t"
      "fsin\n\t"
      "fstps %[s2]\n\t"
      "flds %[d]\n\t"
      "fchs\n\t"
      "fsts %[d]\n\t"
      "fsin\n\t"
      "fstps %[s1]\n\t"
      "fcos\n\t"
      "fstpt %[c2]\n\t"
      "flds %[d]\n\t"
      "fcos\n\t"
      "fstpt %[c1]\n\t"
      : [d]"+m"(d), [s2]"=m"(s2), [s1]"=m"(s1), [in2]"=m"(in2), [c2]"=m"(c2), [c1]"=m"(c1)
      : [mm]"m"(mm), [tp]"m"(twopi), [m2]"m"(minus2)
      : "st", "st(1)", "memory");
    unsigned short sw = get_sw();
    unsigned db, s2b, s1b; char e0[24], e2[24], e1[24];
    float dpos = -d; memcpy(&db, &dpos, 4); memcpy(&s2b, &s2, 4); memcpy(&s1b, &s1, 4);
    ext(in2, e0); ext(c2, e2); ext(c1, e1);
    printf("%d,%08x,%s,%08x,%08x,%s,%s,%04x\n", m, db, e0, s2b, s1b, e2, e1, sw);
  }
  return 0;
}
