/* Read the travel text a running original Deus Ex (under Wine) kept for its level: every ULevel object's URL and its TravelInfo map
 * (key = the player's name, value = the text UGameEngine::Tick exported for the player and its inventory, docs/travel.md).
 *
 * LoadMap copies the TMap<FString,FString> it was given into the new level (ULevel+0xe4, 0x1038d0a6..0x1038d0bf), and `?restart` reuses it,
 * so after an arrival by SendPlayer / LocalTravel the text is still in memory and can be read here without a breakpoint.
 *
 *   wine dump-travel-win.exe [<substring of the level object's name, default MyLevel>]
 *
 * Layout (docs/travel.md): ULevel+0x44 FURL URL (Protocol +0, Host +0xc, Port +0x18, Map +0x1c, Op TArray +0x28, Portal +0x34, Valid +0x40);
 * ULevel+0xe4 TMap<FString,FString> TravelInfo: Pairs TArray (Data +0, Num +4, Max +8), Hash pointer +0xc, HashCount +0x10;
 * a pair is 28 bytes: HashNext (int), Key FString (+4: Data, Num, Max), Value FString (+0x10: Data, Num, Max); FString data is UTF-16LE.
 *
 * Build: i686-w64-mingw32-gcc -O2 -o dump-travel-win.exe dump-travel-win.c -lpsapi
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
#define OFF_LEVEL_URL 0x44u
#define OFF_LEVEL_TRAVEL 0xE4u

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
/* an FString at `address`: UTF-16 data pointer, length including the terminator; printed as latin-1 bytes (the exported text is ASCII) */
static void print_fstring(uintptr_t address) {
  unsigned data = read_u32(address), num = read_u32(address + 4);
  if (!data || num == 0 || num > (1u << 24)) return;
  for (unsigned i = 0; i + 1 < num; i++) {
    unsigned short ch = 0;
    if (!read_mem(data + i * 2, &ch, 2)) break;
    putchar(ch < 256 ? ch : '?');
  }
}

int main(int argc, char **argv) {
  const char *want = argc > 1 ? argv[1] : "MyLevel";
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
    char object_name[256], class_name[256] = "None";
    uintptr_t cls = read_u32(obj + OFF_OBJECT_CLASS);
    if (cls) name_text(read_u32(cls + OFF_OBJECT_NAME), class_name, sizeof(class_name));
    if (strcmp(class_name, "Level")) continue;
    name_text(read_u32(obj + OFF_OBJECT_NAME), object_name, sizeof(object_name));
    if (!strstr(object_name, want)) continue;
    found++;
    printf("Level %s slot %u at 0x%x\n", object_name, slot, (unsigned)obj);
    uintptr_t url = obj + OFF_LEVEL_URL;
    printf("  URL.Map: "); print_fstring(url + 0x1c);
    printf("\n  URL.Portal: "); print_fstring(url + 0x34);
    unsigned ops = read_u32(url + 0x28), nop = read_u32(url + 0x2c);
    for (unsigned i = 0; i < nop && i < 64; i++) { printf("\n  URL.Op[%u]: ", i); print_fstring(ops + i * 12); }
    uintptr_t pairs = read_u32(obj + OFF_LEVEL_TRAVEL);
    unsigned npairs = read_u32(obj + OFF_LEVEL_TRAVEL + 4), hash = read_u32(obj + OFF_LEVEL_TRAVEL + 0xc), hashCount = read_u32(obj + OFF_LEVEL_TRAVEL + 0x10);
    printf("\n  TravelInfo: %u pairs, hash 0x%x count %u\n", npairs, hash, hashCount);
    for (unsigned i = 0; i < npairs && i < 64; i++) {
      uintptr_t pair = pairs + i * 28;
      printf("  [%u] key: ", i); print_fstring(pair + 4);
      printf("\n  [%u] value:\n", i); print_fstring(pair + 0x10);
      printf("\n  [%u] end\n", i);
    }
  }
  if (!found) { fprintf(stderr, "no Level object named like %s\n", want); return 1; }
  CloseHandle(process);
  return 0;
}
