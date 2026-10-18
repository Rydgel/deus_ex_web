/* Measure Core's FGlobalMath sine table (TrigFLOAT, 16384 floats) the way the
 * shipped constructor builds it, on the real x87 (Rosetta 2 under CrossOver):
 *
 *   0x1014431e  fild dword [i]
 *   0x10144325  fmul qword [0x10178040]      ; 0.0003834951969714103 (2 pi / 16384)
 *   0x1014432b  fstp qword [esp]             ; the angle, a double
 *   0x1014432e  call 0x101033a0              ; appSin thunk: fld qword [esp+4]; fsin; ret
 *   0x10144333  fstp dword [ebx]             ; the table entry
 *
 * FSIN reduces its operand with a 66-bit approximation of pi, so near a
 * multiple of pi (entry 8192: the angle is the double nearest pi) its result is
 * not the correctly rounded sine a host libm gives (and that the Unicorn oracle,
 * which computes FSIN through a host double, gives too). The fmul runs under the
 * process's precision control, so the table is built under both 53-bit (0x027f)
 * and 64-bit (0x037f) control and both are printed.
 *
 * Output: "pc <cw>" then 16384 lines "<index> <hex word>".
 *
 * Build: i686-w64-mingw32-gcc -O1 -o ad/build/x87-sintable-probe.exe tools/x87-sintable-probe.c
 * Run:   CX_BOTTLE=DeusEx /Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine ad/build/x87-sintable-probe.exe
 */
#include <stdio.h>
#include <string.h>

static void set_cw(unsigned short cw) { __asm__ volatile("fldcw %0" :: "m"(cw)); }

static unsigned entry(int i) {
  static const double scale = 0.0003834951969714103;
  double angle; float out; unsigned word;
  __asm__ volatile("fildl %1\n\tfmull %2\n\tfstpl %0" : "=m"(angle) : "m"(i), "m"(scale));
  __asm__ volatile("fldl %1\n\tfsin\n\tfstps %0" : "=m"(out) : "m"(angle));
  memcpy(&word, &out, 4);
  return word;
}

int main(void) {
  static const unsigned short cws[2] = {0x027f, 0x037f};
  for (int k = 0; k < 2; k++) {
    set_cw(cws[k]);
    printf("pc 0x%04x\n", cws[k]);
    for (int i = 0; i < 0x4000; i++) printf("%d %08x\n", i, entry(i));
  }
  return 0;
}
