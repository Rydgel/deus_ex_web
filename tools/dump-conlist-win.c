/* Dump live Deus Ex actors' ConListItems chains to confirm ConBindEvents.
 *
 * Companion to tools/dump-gobjects-win.c. Reads the running game's memory from a
 * sibling Win32 process in the same Wine bottle. Run it while standing in the
 * target map (ConBindEvents runs at level load, so no interaction is needed):
 *
 *   # every actor that has a bound conversation (no argument):
 *   CX_BOTTLE=DeusEx wine 'C:\Deus Ex GOTY Edition\System\dump-conlist-win.exe'
 *   # a specific actor by name, or every instance of a class (incl. None cases):
 *   CX_BOTTLE=DeusEx wine 'C:\...\dump-conlist-win.exe' UNATCOTroop0
 *   CX_BOTTLE=DeusEx wine 'C:\...\dump-conlist-win.exe' LightSwitch
 *
 * With no argument it prints every actor whose ConListItems is non-None; with an
 * argument it prints each object whose name or class matches (the chain in order,
 * each item's con Conversation, or the None case).
 *
 * Core.dll offsets (GOTY): GObjObjects data +0x19e628 / count +0x19e62c;
 * object index +0x04, Name +0x20, Class +0x24; FNameEntry text +0x0c (UTF-16);
 * GNames data +0x1961f0. Actor.ConListItems is at +0x2dc (Stage-3 handoff hint);
 * the tool also scans the actor for any ConListItem-typed pointer and resolves
 * each item's member words against the live object table, so ConListItem.con /
 * .next member offsets are discovered, not assumed.
 *
 * Build (macOS, mingw-w64):
 *   i686-w64-mingw32-gcc -O2 -o dump-conlist-win.exe dump-conlist-win.c -lpsapi
 */
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define OFF_GOG_DATA   0x19E628u
#define OFF_GOG_COUNT  0x19E62Cu
#define OFF_NAMES_DATA 0x1961F0u
#define OFF_OBJ_NAME   0x20u
#define OFF_OBJ_CLASS  0x24u
#define OFF_NAMEENTRY  0x0Cu
#define OFF_CONLIST    0x2DCu
#define SCAN_BYTES     0x400u
#define ITEM_BYTES     0x40u

static HANDLE proc;
static uintptr_t names;
static unsigned count;
static uintptr_t *optr;
static unsigned *onamei, *oclassi;

/* sorted (pointer -> table index) for O(log n) resolution */
typedef struct { uintptr_t p; int i; } PI;
static PI *sorted; static unsigned nsorted;

/* class-name cache keyed by the class FName index (few distinct classes) */
static unsigned cc_key[16384]; static char cc_name[16384][64]; static int cc_n;

static DWORD find_pid(const char *n) {
  HANDLE s = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (s == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32 e; e.dwSize = sizeof(e); DWORD pid = 0;
  if (Process32First(s, &e)) do {
    if (_stricmp(e.szExeFile, n) == 0) { pid = e.th32ProcessID; break; }
  } while (Process32Next(s, &e));
  CloseHandle(s); return pid;
}
static uintptr_t module_base(const char *n) {
  HMODULE m[1024]; DWORD need = 0;
  if (!EnumProcessModulesEx(proc, m, sizeof(m), &need, LIST_MODULES_ALL)) return 0;
  for (DWORD i = 0; i < need / sizeof(HMODULE); i++) {
    char b[MAX_PATH];
    if (GetModuleBaseNameA(proc, m[i], b, sizeof(b)) && _stricmp(b, n) == 0) return (uintptr_t)m[i];
  }
  return 0;
}
static int rmem(uintptr_t a, void *o, SIZE_T n) { SIZE_T g = 0; return ReadProcessMemory(proc, (LPCVOID)a, o, n, &g) && g == n; }
static unsigned ru(uintptr_t a) { unsigned v = 0; rmem(a, &v, 4); return v; }
static void name_of(unsigned idx, char *out, int max) {
  out[0] = 0; uintptr_t e = ru(names + idx * 4); if (!e) return;
  for (int i = 0; i < max - 1; i++) {
    unsigned short ch = 0;
    if (!rmem(e + OFF_NAMEENTRY + i * 2, &ch, 2) || !ch) break;
    out[i] = ch < 128 ? (char)ch : '?'; out[i + 1] = 0;
  }
}
static int pi_cmp(const void *a, const void *b) {
  uintptr_t x = ((const PI *)a)->p, y = ((const PI *)b)->p;
  return x < y ? -1 : x > y ? 1 : 0;
}
static int find_by_ptr(uintptr_t p) {
  if (!p) return -1;
  int lo = 0, hi = (int)nsorted - 1;
  while (lo <= hi) { int m = (lo + hi) / 2; if (sorted[m].p < p) lo = m + 1; else if (sorted[m].p > p) hi = m - 1; else return sorted[m].i; }
  return -1;
}
static const char *class_of(int idx) {
  unsigned key = oclassi[idx];
  for (int i = 0; i < cc_n; i++) if (cc_key[i] == key) return cc_name[i];
  if (cc_n < 16384) { cc_key[cc_n] = key; name_of(key, cc_name[cc_n], 64); return cc_name[cc_n++]; }
  static char tmp[64]; name_of(key, tmp, 64); return tmp;
}

static void walk(int actor) {
  char nm[128]; name_of(onamei[actor], nm, sizeof(nm));
  printf("\nactor %s [%s] @0x%lx\n", nm, class_of(actor), (unsigned long)optr[actor]);
  uintptr_t head = ru(optr[actor] + OFF_CONLIST); int hi = find_by_ptr(head);
  if (hi < 0 || strcmp(class_of(hi), "ConListItem") != 0) {
    head = 0;
    for (unsigned off = 0; off < SCAN_BYTES; off += 4) {
      uintptr_t w = ru(optr[actor] + off); int j = find_by_ptr(w);
      if (j >= 0 && strcmp(class_of(j), "ConListItem") == 0) { head = w; printf("  (ConListItems at +0x%x)\n", off); break; }
    }
  } else printf("  ConListItems @+0x%x\n", OFF_CONLIST);
  if (!head) { printf("  ConListItems = None (binds no conversation)\n"); return; }
  int order = 0; uintptr_t item = head;
  for (int guard = 0; item && guard < 64; guard++) {
    int ii = find_by_ptr(item); if (ii < 0) { printf("  <unknown 0x%lx>\n", (unsigned long)item); break; }
    uintptr_t con = 0, next = 0;
    for (unsigned off = 0; off < ITEM_BYTES; off += 4) {
      uintptr_t w = ru(item + off); int j = find_by_ptr(w); if (j < 0) continue;
      const char *jc = class_of(j);
      if (!con && strcmp(jc, "Conversation") == 0) con = w;
      else if (!next && w != item && strcmp(jc, "ConListItem") == 0) next = w;
    }
    int ci = find_by_ptr(con); char cn[128] = "None"; if (ci >= 0) name_of(onamei[ci], cn, sizeof(cn));
    printf("  [%d] %s -> con=%s%s\n", order++, class_of(ii), cn, next ? "" : " (last)");
    item = next;
  }
}

int main(int argc, char **argv) {
  const char *filter = NULL;
  for (int i = 1; i < argc; i++) if (argv[i][0] != '-') filter = argv[i];
  DWORD pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  proc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  if (!proc) { fprintf(stderr, "OpenProcess failed (%lu)\n", GetLastError()); return 1; }
  uintptr_t core = module_base("Core.dll");
  if (!core) { fprintf(stderr, "Core.dll not loaded\n"); return 1; }
  uintptr_t gog = ru(core + OFF_GOG_DATA);
  count = ru(core + OFF_GOG_COUNT);
  names = ru(core + OFF_NAMES_DATA);
  printf("pid=%lu Core.dll=0x%lx objects=%u\n", (unsigned long)pid, (unsigned long)core, count);

  optr = calloc(count, sizeof(*optr));
  onamei = calloc(count, sizeof(*onamei));
  oclassi = calloc(count, sizeof(*oclassi));
  sorted = calloc(count, sizeof(*sorted));
  for (unsigned i = 0; i < count; i++) {
    uintptr_t o = ru(gog + i * 4); optr[i] = o; if (!o) continue;
    onamei[i] = ru(o + OFF_OBJ_NAME);
    uintptr_t cls = ru(o + OFF_OBJ_CLASS); oclassi[i] = cls ? ru(cls + OFF_OBJ_NAME) : 0;
    sorted[nsorted].p = o; sorted[nsorted].i = (int)i; nsorted++;
  }
  qsort(sorted, nsorted, sizeof(*sorted), pi_cmp);

  int shown = 0;
  for (unsigned i = 0; i < count; i++) {
    if (!optr[i]) continue;
    if (filter) {
      char nm[128]; name_of(onamei[i], nm, sizeof(nm));
      if (_stricmp(nm, filter) != 0 && _stricmp(class_of(i), filter) != 0) continue;
      walk(i); shown++;
    } else {
      /* No filter: every actor whose ConListItems (+0x2dc) is a ConListItem. */
      int hi = find_by_ptr(ru(optr[i] + OFF_CONLIST));
      if (hi >= 0 && strcmp(class_of(hi), "ConListItem") == 0) { walk(i); shown++; }
    }
  }
  if (!shown) {
    if (filter) printf("\n(no object named or classed '%s')\n", filter);
    else printf("\n(no actor has a non-None ConListItems)\n");
  }
  return 0;
}
