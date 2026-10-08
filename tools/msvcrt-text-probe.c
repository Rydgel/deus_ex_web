/* The shipped MSVCRT's text conversions (Deus Ex GOTY System/MSVCRT.dll) run
 * on the real CPU under Wine: scripts/validate-msvcrt-text-hardware.mjs builds
 * this with i686-w64-mingw32-gcc, copies the game's MSVCRT.dll to a private
 * name (so Wine's builtin msvcrt cannot stand in) and feeds it a case file.
 *
 * Core's appSprintf (10123490) pushes 0x400 and calls MSVCRT _vsnwprintf
 * through IAT 102ab508; appAtof (101235c0) converts the UTF-16 string with
 * appToAnsi and calls MSVCRT atof through IAT 102ab518, whose x87 result
 * execStringToFloat (101326b0) stores with FSTP m32.
 *
 * Usage: msvcrt-text-probe.exe <MSVCRT copy> <case file> [x87 control word, hex]
 * (the word is loaded with FLDCW before the first case; without it the process
 * default is used and printed as "#cw=")
 * Case lines:  P <hex wide format, 4 hex digits per unit> <hex double bits>
 *              A <hex ANSI bytes>                (empty string: "-")
 * Output (one per case): "P <hex wide result>" / "A <hex float32 bits> <hex double bits>" */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <windows.h>

typedef unsigned int u32;
typedef unsigned long long u64;
typedef int (__cdecl *vsnwprintf_t)(unsigned short *, size_t, const unsigned short *, void *);
typedef double (__cdecl *atof_t)(const char *);

static int unhex(const char *s, unsigned char *out, int max, int digitsPerUnit, int *units) {
  int n = 0;
  if (s[0] == '-' && !s[1]) { *units = 0; return 0; }
  for (; s[0] && s[1] && n < max; ) {
    unsigned v = 0;
    for (int d = 0; d < digitsPerUnit; d++) {
      char c = *s++;
      v = v * 16 + (c <= '9' ? c - '0' : (c | 32) - 'a' + 10);
    }
    if (digitsPerUnit == 2) out[n] = (unsigned char)v; else ((unsigned short *)out)[n] = (unsigned short)v;
    n++;
  }
  *units = n;
  return n;
}

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  HMODULE module = LoadLibraryA(argv[1]);
  if (!module) { fprintf(stderr, "LoadLibrary failed %lu\n", GetLastError()); return 3; }
  vsnwprintf_t print = (vsnwprintf_t)GetProcAddress(module, "_vsnwprintf");
  atof_t parse = (atof_t)GetProcAddress(module, "atof");
  if (!print || !parse) { fprintf(stderr, "missing export\n"); return 4; }
  unsigned short cw;
  if (argc > 3) {
    cw = (unsigned short)strtoul(argv[3], NULL, 16);
    __asm__ volatile("fldcw %0" : : "m"(cw));
  }
  __asm__ volatile("fnstcw %0" : "=m"(cw));
  printf("#cw=%04x\n", cw);
  FILE *file = fopen(argv[2], "r");
  if (!file) { fprintf(stderr, "no case file\n"); return 5; }
  static char line[8192];
  while (fgets(line, sizeof line, file)) {
    char kind = line[0];
    if (kind == 'P') {
      char fmt[4096], bits[64];
      if (sscanf(line + 2, "%4095s %63s", fmt, bits) != 2) continue;
      unsigned short wfmt[1024], out[1024];
      int units;
      unhex(fmt, (unsigned char *)wfmt, 1000, 4, &units);
      wfmt[units] = 0;
      u64 raw = strtoull(bits, NULL, 16);
      double value;
      memcpy(&value, &raw, 8);
      memset(out, 0, sizeof out);
      int n = print(out, 0x400, wfmt, &value);   /* va_list is a pointer to the packed arguments */
      printf("P %d ", n);
      if (n <= 0) printf("-"); else for (int i = 0; i < n; i++) printf("%04x", out[i]);
      printf("\n");
    } else if (kind == 'A') {
      char text[4096], bytes[2048];
      if (sscanf(line + 2, "%4095s", text) != 1) strcpy(text, "-");
      int units;
      unhex(text, (unsigned char *)bytes, 2000, 2, &units);
      bytes[units] = 0;
      double d = parse(bytes);
      float f = (float)d;
      u32 fb;
      u64 db;
      memcpy(&fb, &f, 4);
      memcpy(&db, &d, 8);
      printf("A %08x %016llx\n", fb, db);
    }
  }
  return 0;
}
