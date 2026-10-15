/* Write one 32-bit field of a named object in the running original Deus Ex (under Wine): a measurement's input
 * (docs/frame-projection.md "Detail textures": the render device's DetailTextures field, which D3DDrv::SetRes clears
 * when Wine's ddraw device lacks D3DTEXOPCAPS_BLENDDIFFUSEALPHA). Same object lookup as dump-actor-win.c.
 *
 *   wine poke-object-win.exe <exact object name> <offset> <u32 value>
 *
 * Build: i686-w64-mingw32-gcc -O2 -o poke-object-win.exe poke-object-win.c -lpsapi
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
  if (argc != 4) { fprintf(stderr, "usage: poke-object-win.exe <exact object name> <offset> <u32 value>\n"); return 2; }
  DWORD pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_VM_OPERATION, FALSE, pid);
  uintptr_t core = module_base("Core.dll");
  if (!process || !core) { fprintf(stderr, "cannot open DeusEx.exe\n"); return 1; }
  uintptr_t gog = read_u32(core + OFF_GOG_DATA);
  unsigned count = read_u32(core + OFF_GOG_COUNT);
  names = read_u32(core + OFF_NAMES_DATA);
  int found = 0;
  for (unsigned slot = 0; slot < count; slot++) {
    uintptr_t obj = read_u32(gog + slot * 4);
    if (!obj) continue;
    char object_name[256];
    name_text(read_u32(obj + OFF_OBJECT_NAME), object_name, sizeof(object_name));
    if (strcmp(object_name, argv[1])) continue;
    uintptr_t at = obj + strtoul(argv[2], NULL, 0);
    unsigned before = read_u32(at), value = (unsigned)strtoul(argv[3], NULL, 0);
    SIZE_T put = 0;
    int ok = WriteProcessMemory(process, (LPVOID)at, &value, 4, &put) && put == 4;
    printf("%s +%s: 0x%x -> 0x%x (now 0x%x)%s\n", object_name, argv[2], before, value, read_u32(at), ok ? "" : "  WRITE FAILED");
    found++;
  }
  CloseHandle(process);
  return found == 1 ? 0 : 1;
}
