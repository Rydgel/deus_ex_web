/* appTan on the real FPU (scripts/validate-x87-tan-hardware.mjs builds this
 * with i686-w64-mingw32-gcc and runs it under Wine/CrossOver).
 *
 * Default mode, the scene frame's path (docs/x87-tan.md): for a float32 FOV,
 * x = FLD m32 FOV, FMUL m64 0.008726646259971648 (PI/360), FSTP m64 (Engine's
 * ComputeRenderSize argument); then Core appTan's FLD m64 x, FPTAN,
 * FSTP st(0), FSTP m64. Prints "fov,x,tan" as hex bits.
 *
 * "lod" mode, DrawLodMesh's FOV factor (Render 0x10b0ebc1..0x10b0ebe2,
 * docs/script-lodmesh-lod.md): the render pass's control word 0x007f
 * (precision control 24) for the FMUL, FSTP m64, appTan's FLD m64, FPTAN,
 * FSTP st(0), and the caller's FSTP m32 of the extended result. Prints
 * "fov,x,tan32" as hex bits.
 *
 * FOVs: every integer 1..179, every float32 within 2000 ulps of 75 and 90, and
 * 200,000 pseudo-random float32 values in [1, 179]. */
#include <stdio.h>
#include <string.h>

typedef unsigned int u32;
typedef unsigned long long u64;

static const double HALF_DEGREE = 0.008726646259971648;
static int lod;

static void row(float fov) {
  double x, t;
  float t32;
  u32 f, tb32;
  u64 xb, tb;
  __asm__ volatile("flds %1\n\tfmull %2\n\tfstpl %0" : "=m"(x) : "m"(fov), "m"(HALF_DEGREE));
  memcpy(&f, &fov, 4); memcpy(&xb, &x, 8);
  if (lod) {
    __asm__ volatile("fldl %1\n\tfptan\n\tfstp %%st(0)\n\tfstps %0" : "=m"(t32) : "m"(x));
    memcpy(&tb32, &t32, 4);
    printf("%08x,%016llx,%08x\n", f, xb, tb32);
    return;
  }
  __asm__ volatile("fldl %1\n\tfptan\n\tfstp %%st(0)\n\tfstpl %0" : "=m"(t) : "m"(x));
  memcpy(&tb, &t, 8);
  printf("%08x,%016llx,%016llx\n", f, xb, tb);
}

int main(int argc, char **argv) {
  unsigned short cw;
  lod = argc > 1 && strcmp(argv[1], "lod") == 0;
  if (lod) {
    unsigned short render = 0x007f;
    __asm__ volatile("fldcw %0" : : "m"(render));
  }
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
