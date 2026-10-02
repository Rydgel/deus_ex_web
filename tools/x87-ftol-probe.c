/* The shipped MSVCRT _ftol (Deus Ex GOTY System/MSVCRT.dll, export at
 * 0x78004dc1) executed on the real FPU: scripts/validate-x87-ftol-hardware.mjs
 * builds this with i686-w64-mingw32-gcc, copies the game's MSVCRT.dll to a
 * private name (so Wine's builtin msvcrt cannot stand in for it) and runs
 * this probe under Wine/CrossOver.
 *
 * Core's execFloatToInt (10131b40) and execFloatToByte (10131aa0) FLD the
 * float32 operand and call _ftol through 1016eec0 -> IAT 102ab4b8; each row
 * does the same: FLDS m32, CALL _ftol, and prints EDX:EAX.
 *
 * Usage: x87-ftol-probe.exe <path to MSVCRT copy>
 * Output: "#cw=<control word>", then "<float32 bits>,<edx>,<eax>" in hex. */
#include <stdio.h>
#include <string.h>
#include <windows.h>

typedef unsigned int u32;

static void *ftol;

static void run(u32 bits, u32 *hi, u32 *lo) {
  float value;
  u32 a, d;
  memcpy(&value, &bits, 4);
  __asm__ volatile("flds %2\n\tcall *%3" : "=a"(a), "=d"(d) : "m"(value), "r"(ftol) : "ecx", "memory", "cc");
  *hi = d;
  *lo = a;
}

static const u32 values[] = {
  0x00000000, 0x80000000, 0x00000001, 0x3f000000, 0xbf000000, 0x3f7fffff,
  0x3f800000, 0xbf800000, 0x43967333, 0xc3967333, /* +-300.9 */
  0x4effffff, 0x4f000000, 0xcf000000, 0xcf000001, /* int32 boundary */
  0x4f800000, 0x4f800001, 0xcf800001, 0x5e800000, /* 2^32.., 2^62 */
  0x5effffff, 0xdeffffff, /* largest magnitude below 2^63 */
  0x5f000000, 0xdf000000, 0x5f000001, 0xdf000001, /* 2^63, -2^63 and beyond */
  0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000, /* FLT_MAX, inf */
  0x7fc00000, 0xffc00000, 0x7fc12345, 0xffe00001, 0x7f800001, 0xffbfffff,
};

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  HMODULE module = LoadLibraryA(argv[1]);
  if (!module) { fprintf(stderr, "LoadLibrary failed %lu\n", GetLastError()); return 3; }
  ftol = (void *)GetProcAddress(module, "_ftol");
  if (!ftol) { fprintf(stderr, "no _ftol export\n"); return 4; }
  unsigned short cw;
  __asm__ volatile("fnstcw %0" : "=m"(cw));
  printf("#cw=%04x\n#ftol=%08x\n", cw, (u32)((char *)ftol - (char *)module));
  u32 hi, lo;
  const int n = sizeof values / sizeof *values;
  for (int i = 0; i < n; i++) {
    run(values[i], &hi, &lo);
    printf("%08x,%08x,%08x\n", values[i], hi, lo);
  }
  /* Every float32 exponent with random sign and mantissa, NaNs included. */
  u32 seed = 0x2468aceu;
  for (int k = 0; k < 20000; k++) {
    seed = seed * 1664525u + 1013904223u;
    u32 bits = seed;
    if (k % 2 == 0) bits = (bits & 0x807fffffu) | ((u32)(k / 2 % 256) << 23);
    run(bits, &hi, &lo);
    printf("%08x,%08x,%08x\n", bits, hi, lo);
  }
  return 0;
}
