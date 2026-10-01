/* NaN results of the x87 arithmetic Core's float operators execute, measured
 * on the real FPU (scripts/validate-x87-nan-hardware.mjs builds this with
 * i686-w64-mingw32-gcc and runs it under Wine/CrossOver).
 *
 * Each row runs one instruction form the operator bodies use on float32
 * operands a and b and prints the float32 the FSTP stores:
 *   fmul/fdiv/fadd/fsub  FLD m32 a; F<op> m32 b; FSTP m32  (171/172/174/175)
 *   fmulp/faddp          FLD m32 b; FLD m32 a; F<op>P st(1),st; FSTP m32
 *                        (214's FMUL st(1), VSize's FADDP)
 * Operands are quiet NaNs, infinities, zeros and finite values: a float32
 * load quiets a signaling NaN before either VM sees it.
 *
 * Output: "#cw=<control word>", then "<op>,<a>,<b>,<result>" in hex. */
#include <stdio.h>
#include <string.h>

typedef unsigned int u32;

static u32 run(int op, u32 a, u32 b) {
  float fa, fb, r;
  memcpy(&fa, &a, 4);
  memcpy(&fb, &b, 4);
  switch (op) {
  case 0: __asm__ volatile("flds %1\n\tfmuls %2\n\tfstps %0" : "=m"(r) : "m"(fa), "m"(fb)); break;
  case 1: __asm__ volatile("flds %1\n\tfdivs %2\n\tfstps %0" : "=m"(r) : "m"(fa), "m"(fb)); break;
  case 2: __asm__ volatile("flds %1\n\tfadds %2\n\tfstps %0" : "=m"(r) : "m"(fa), "m"(fb)); break;
  case 3: __asm__ volatile("flds %1\n\tfsubs %2\n\tfstps %0" : "=m"(r) : "m"(fa), "m"(fb)); break;
  case 4: __asm__ volatile("flds %2\n\tflds %1\n\tfmulp\n\tfstps %0" : "=m"(r) : "m"(fa), "m"(fb)); break;
  default: __asm__ volatile("flds %2\n\tflds %1\n\tfaddp\n\tfstps %0" : "=m"(r) : "m"(fa), "m"(fb)); break;
  }
  u32 out;
  memcpy(&out, &r, 4);
  return out;
}

static const u32 values[] = {
  0x00000000, 0x80000000, 0x3f800000, 0xbfc00000, 0x7f7fffff, 0x00000001,
  0x7f800000, 0xff800000,
  0x7fc00000, 0xffc00000, 0x7fc00001, 0xffc00001, 0x7fc00002, 0x7fd00000,
  0xffe12345, 0x7fffffff,
};
static const char *names[] = {"fmul", "fdiv", "fadd", "fsub", "fmulp", "faddp"};

int main(void) {
  unsigned short cw;
  __asm__ volatile("fnstcw %0" : "=m"(cw));
  printf("#cw=%04x\n", cw);
  const int n = sizeof values / sizeof *values;
  for (int op = 0; op < 6; op++)
    for (int i = 0; i < n; i++)
      for (int j = 0; j < n; j++)
        printf("%s,%08x,%08x,%08x\n", names[op], values[i], values[j], run(op, values[i], values[j]));
  /* Random quiet NaN pairs: sign and payload (the larger significand rule). */
  u32 seed = 0x1234567u;
  for (int k = 0; k < 4000; k++) {
    seed = seed * 1664525u + 1013904223u;
    u32 a = (seed & 0x80000000u) | 0x7fc00000u | (seed >> 9 & 0x3fffffu);
    seed = seed * 1664525u + 1013904223u;
    u32 b = (seed & 0x80000000u) | 0x7fc00000u | (seed >> 9 & 0x3fffffu);
    if (k % 4 == 0) b = (b & 0x80000000u) | (a & 0x7fffffffu); /* equal significands */
    int op = k % 6;
    printf("%s,%08x,%08x,%08x\n", names[op], a, b, run(op, a, b));
  }
  return 0;
}
