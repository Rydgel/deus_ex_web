/* appTan as the scene frame reaches it, on the real FPU
 * (scripts/validate-x87-tan-hardware.mjs builds this with i686-w64-mingw32-gcc
 * and runs it under Wine/CrossOver).
 *
 * For a float32 FOV: x = FLD m32 FOV, FMUL m64 0.008726646259971648 (PI/360),
 * FSTP m64 (Engine's ComputeRenderSize argument); then Core appTan's
 * FLD m64 x, FPTAN, FSTP st(0), FSTP m64. Prints "fov,x,tan" as hex bits.
 * FOVs: every integer 1..179, every float32 within 2000 ulps of 75 and 90, and
 * 200,000 pseudo-random float32 values in [1, 179]. */
#include <stdio.h>
#include <string.h>

typedef unsigned int u32;
typedef unsigned long long u64;

static const double HALF_DEGREE = 0.008726646259971648;

static void row(float fov) {
  double x, t;
  __asm__ volatile("flds %1\n\tfmull %2\n\tfstpl %0" : "=m"(x) : "m"(fov), "m"(HALF_DEGREE));
  __asm__ volatile("fldl %1\n\tfptan\n\tfstp %%st(0)\n\tfstpl %0" : "=m"(t) : "m"(x));
  u32 f; u64 xb, tb;
  memcpy(&f, &fov, 4); memcpy(&xb, &x, 8); memcpy(&tb, &t, 8);
  printf("%08x,%016llx,%016llx\n", f, xb, tb);
}

int main(void) {
  unsigned short cw;
  __asm__ volatile("fnstcw %0" : "=m"(cw));
  printf("#cw=%04x\n", cw);
  for (int i = 1; i < 180; i++) row((float)i);
  float centers[] = {75.0f, 90.0f};
  for (int c = 0; c < 2; c++) {
    u32 bits; memcpy(&bits, &centers[c], 4);
    for (int d = -2000; d <= 2000; d++) { u32 b = bits + d; float f; memcpy(&f, &b, 4); row(f); }
  }
  u32 seed = 0x2468ace1u;
  for (int k = 0; k < 200000; k++) {
    seed = seed * 1664525u + 1013904223u;
    float f = 1.0f + (float)((seed >> 8) / 16777216.0) * 178.0f;
    row(f);
  }
  return 0;
}
