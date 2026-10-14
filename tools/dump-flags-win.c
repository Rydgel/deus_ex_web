/* List the FlagBase of a player in the running original Deus Ex (under Wine): every flag's name, type, expiration and
 * value, and the base's default expiration, for every object whose name contains the argument (the player is JCDentonMale<N>, numbered
 * by the load count). For the live acceptance of the mission scripts' start state
 * (docs/visual-acceptance.md "Live scenes": the flags the original holds at the frozen start of a directly opened map).
 *
 *   wine dump-flags-win.exe [<substring of the player's object name, default JCDentonMale>] [<FlagBase offset in the player, default 0x890>]
 *
 * Layout (docs/script-native-flagbase-research.md): XFlagBase 64 bucket heads at +0x28..+0x124, default expiration +0x128;
 * XFlag +0x28 FName index, +0x2c hash, +0x30 FlagBase, +0x34 next, +0x38 type byte, +0x3c expiration, FlagBool +0x40 value.
 * The player's FlagBase pointer is DeusExPlayer.FlagBase (+0x890, docs/script-loadmap-gc.md).
 *
 * Build: i686-w64-mingw32-gcc -O2 -o dump-flags-win.exe dump-flags-win.c -lpsapi
 */
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define OFF_GOG_DATA   0x19E628u
#define OFF_GOG_COUNT  0x19E62Cu
#define OFF_NAMES_DATA 0x1961F0u
#define OFF_OBJECT_NAME  0x20u
#define OFF_OBJECT_CLASS 0x24u
#define OFF_NAMEENTRY_TEXT 0x0Cu

static HANDLE process;
static uintptr_t names;

static DWORD find_pid(const char *name) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32 entry; entry.dwSize = sizeof(entry);
  DWORD pid = 0;
  if (Process32First(snap, &entry))
    do { if (_stricmp(entry.szExeFile, name) == 0) { pid = entry.th32ProcessID; break; } } while (Process32Next(snap, &entry));
  CloseHandle(snap);
  return pid;
}
static uintptr_t module_base(const char *name) {
  HMODULE modules[1024]; DWORD needed = 0;
  if (!EnumProcessModulesEx(process, modules, sizeof(modules), &needed, LIST_MODULES_ALL)) return 0;
  for (DWORD i = 0; i < needed / sizeof(HMODULE) && i < 1024; i++) {
    char buffer[MAX_PATH];
    if (GetModuleBaseNameA(process, modules[i], buffer, sizeof(buffer)) && _stricmp(buffer, name) == 0) return (uintptr_t)modules[i];
  }
  return 0;
}
static int read_mem(uintptr_t address, void *out, SIZE_T size) {
  SIZE_T got = 0;
  return ReadProcessMemory(process, (LPCVOID)address, out, size, &got) && got == size;
}
static unsigned read_u32(uintptr_t address) { unsigned v = 0; read_mem(address, &v, 4); return v; }
static void name_text(unsigned index, char *out, int max) {
  wchar_t text[256]; text[0] = 0;
  uintptr_t entry = read_u32(names + index * 4);
  if (entry) for (int i = 0; i < 255; i++) {
    wchar_t ch = 0;
    if (!read_mem(entry + OFF_NAMEENTRY_TEXT + i * 2, &ch, 2) || !ch) break;
    text[i] = ch; text[i + 1] = 0;
  }
  WideCharToMultiByte(CP_ACP, 0, text, -1, out, max, NULL, NULL);
}

int main(int argc, char **argv) {
  const char *want = argc > 1 ? argv[1] : "JCDentonMale";
  unsigned fb_off = argc > 2 ? (unsigned)strtoul(argv[2], NULL, 0) : 0x890;
  DWORD pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  uintptr_t core = module_base("Core.dll");
  if (!process || !core) { fprintf(stderr, "cannot read DeusEx.exe\n"); return 1; }
  uintptr_t gog = read_u32(core + OFF_GOG_DATA);
  unsigned count = read_u32(core + OFF_GOG_COUNT);
  names = read_u32(core + OFF_NAMES_DATA);
  int found = 0;
  for (unsigned slot = 0; slot < count; slot++) {
    uintptr_t obj = read_u32(gog + slot * 4);
    if (!obj) continue;
    char object_name[256];
    name_text(read_u32(obj + OFF_OBJECT_NAME), object_name, sizeof(object_name));
    if (!strstr(object_name, want)) continue;
    found++;
    uintptr_t base = read_u32(obj + fb_off);
    char class_name[256] = "None", base_class[256] = "None";
    uintptr_t cls = read_u32(obj + OFF_OBJECT_CLASS);
    if (cls) name_text(read_u32(cls + OFF_OBJECT_NAME), class_name, sizeof(class_name));
    if (!base) { found--; continue; }
    uintptr_t bcls = read_u32(base + OFF_OBJECT_CLASS);
    if (bcls) name_text(read_u32(bcls + OFF_OBJECT_NAME), base_class, sizeof(base_class));
    if (strcmp(base_class, "FlagBase")) { found--; continue; }   /* a Class object or a carcass reading another field at that offset */
    int def = (int)read_u32(base + 0x128);
    printf("%s %s slot %u: FlagBase 0x%x (%s) defaultExpiration %d\n", class_name, object_name, slot, (unsigned)base, base_class, def);
    int total = 0;
    for (int bucket = 0; bucket < 64; bucket++) {
      uintptr_t flag = read_u32(base + 0x28 + bucket * 4);
      for (int guard = 0; flag && guard < 100000; guard++) {
        char flag_name[256];
        name_text(read_u32(flag + 0x28), flag_name, sizeof(flag_name));
        unsigned char type = 0; read_mem(flag + 0x38, &type, 1);
        int expiration = (int)read_u32(flag + 0x3c);
        unsigned value = read_u32(flag + 0x40);
        printf("  flag %s type %u expiration %d value 0x%x bucket %d\n", flag_name, type, expiration, value, bucket);
        total++;
        flag = read_u32(flag + 0x34);
      }
    }
    printf("  %d flags\n", total);
  }
  if (!found) { fprintf(stderr, "no object named like %s\n", want); return 1; }
  CloseHandle(process);
  return 0;
}
