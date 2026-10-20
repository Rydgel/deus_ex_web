/* Condition codes of the x87 comparisons ULevel::FindSpot, AdjustSpot and
 * UModel::PointCheck branch on, and FISTP's masked-invalid result, measured on
 * the real FPU (scripts/validate-x87-compare-hardware.mjs builds this with
 * i686-w64-mingw32-gcc and runs it under Wine/CrossOver).
 *
 * Each compare row runs one instruction form on float32 operands (and the
 * double 1.0 for AdjustSpot's) and prints the status word's C3/C2/C0 bits as
 * `test ah, mask` reads them (AH & 0x45):
 *   0  fldl-free  FLD m32 a; FCOMP m64 b ; FNSTSW   AdjustSpot  0x103983b3 (b = 1.0)
 *   1             FLD m32 a; FCOMP m32 b ; FNSTSW   PointCheck  0x103f1b36 / 0x103f1bbd / 0x103f1ef7
 *   2             FLD m32 b; FLD m32 a; FCOMPP; FNSTSW   FindSpot 0x1039896f (st0 = a, st1 = b)
 * and the FISTP rows (op 3): FLD m32 a; FISTP m32int with every exception
 * masked (the hash cell conversion, 0x10359223): the stored int32.
 *
 * Output: "#cw=<control word>", then "<op>,<a>,<b>,<result>" in hex (b is the
 * float32 bits; the m64 form uses the double with the same value). */
#include <stdio.h>
#include <string.h>

typedef unsigned int u32;

static u32 compare(int op, u32 abits, u32 bbits) {
  float a, b;
  double wide;
  unsigned short sw;
  memcpy(&a, &abits, 4);
  memcpy(&b, &bbits, 4);
  wide = b;
  switch (op) {
  case 0: __asm__ volatile("flds %1\n\tfcompl %2\n\tfnstsw %0" : "=m"(sw) : "m"(a), "m"(wide) : "cc"); break;
  case 1: __asm__ volatile("flds %1\n\tfcomps %2\n\tfnstsw %0" : "=m"(sw) : "m"(a), "m"(b) : "cc"); break;
  default: __asm__ volatile("flds %2\n\tflds %1\n\tfcompp\n\tfnstsw %0" : "=m"(sw) : "m"(a), "m"(b) : "cc"); break;
  }
  return (sw >> 8) & 0x45;
}

static u32 to_int(u32 abits) {
  float a;
  int r;
  memcpy(&a, &abits, 4);
  __asm__ volatile("flds %1\n\tfistpl %0" : "=m"(r) : "m"(a) : "cc");
  return (u32)r;
}

static const u32 values[] = {
  0x00000000, 0x80000000, 0x00000001, 0x3f000000, 0xbf000000, 0x3f800000, 0xbf800000, 0x3f800001, 0x3f7fffff,
  0x3fc00000, 0x42c80000, 0x4f000000, 0xcf000000, 0x4effffff, 0x5f000000, 0x7f7fffff,
  0x7f800000, 0xff800000,
  0x7fc00000, 0xffc00000, 0x7fc00001, 0xffc12345, 0x7fffffff, 0x7f800001, 0xffa00000,
};

int main(void) {
  unsigned short cw;
  __asm__ volatile("fnstcw %0" : "=m"(cw));
  printf("#cw=%04x\n", cw);
  const int n = sizeof values / sizeof *values;
  for (int op = 0; op < 3; op++)
    for (int i = 0; i < n; i++)
      for (int j = 0; j < n; j++)
        printf("%d,%08x,%08x,%02x\n", op, values[i], values[j], compare(op, values[i], values[j]));
  for (int i = 0; i < n; i++) printf("3,%08x,00000000,%08x\n", values[i], to_int(values[i]));
  return 0;
}
