/* Read fields of named objects in the running original Deus Ex (under Wine),
 * for comparing live original state with Play (docs/visual-acceptance.md).
 * Uses the same Core.dll registry offsets as dump-gobjects-win.c.
 *
 *   wine dump-actor-win.exe <name substring> <field:offset:type[:mask]>...
 *
 * Types: f (float), f3 (three floats), i3 (three ints), u8, u32,
 * bit (u32 at offset & mask), obj (UObject* -> its name), name (FName -> text).
 * Offsets are the linked UProperty offsets (UProperty +0x48; bool masks
 * UBoolProperty +0x5c), e.g. Location:0x114:f3 bHidden:0x28:bit:0x2.
 *
 * Build: i686-w64-mingw32-gcc -O2 -o dump-actor-win.exe dump-actor-win.c -lpsapi
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
  if (argc < 2) { fprintf(stderr, "usage: dump-actor-win.exe <name substring> <field:offset:type[:mask]>...\n"); return 2; }
  DWORD pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  uintptr_t core = module_base("Core.dll");
  if (!process || !core) { fprintf(stderr, "cannot read DeusEx.exe\n"); return 1; }
  uintptr_t gog = read_u32(core + OFF_GOG_DATA);
  unsigned count = read_u32(core + OFF_GOG_COUNT);
  names = read_u32(core + OFF_NAMES_DATA);
  for (unsigned slot = 0; slot < count; slot++) {
    uintptr_t obj = read_u32(gog + slot * 4);
    if (!obj) continue;
    char object_name[256], class_name[256];
    name_text(read_u32(obj + OFF_OBJECT_NAME), object_name, sizeof(object_name));
    if (!strstr(object_name, argv[1])) continue;
    uintptr_t cls = read_u32(obj + OFF_OBJECT_CLASS);
    class_name[0] = 0;
    if (cls) name_text(read_u32(cls + OFF_OBJECT_NAME), class_name, sizeof(class_name));
    printf("%s %s", class_name, object_name);
    for (int a = 2; a < argc; a++) {
      char spec[128]; strncpy(spec, argv[a], sizeof(spec) - 1); spec[sizeof(spec) - 1] = 0;
      char *field = strtok(spec, ":"), *off = strtok(NULL, ":"), *type = strtok(NULL, ":"), *mask = strtok(NULL, ":");
      if (!field || !off || !type) continue;
      uintptr_t at = obj + strtoul(off, NULL, 0);
      if (!strcmp(type, "f")) { float v; read_mem(at, &v, 4); printf(" %s=%.9g", field, v); }
      else if (!strcmp(type, "f3")) { float v[3]; read_mem(at, v, 12); printf(" %s=(%.9g,%.9g,%.9g)", field, v[0], v[1], v[2]); }
      else if (!strcmp(type, "i3")) { int v[3]; read_mem(at, v, 12); printf(" %s=(%d,%d,%d)", field, v[0], v[1], v[2]); }
      else if (!strcmp(type, "u8")) { unsigned char v; read_mem(at, &v, 1); printf(" %s=%u", field, v); }
      else if (!strcmp(type, "u32")) printf(" %s=0x%x", field, read_u32(at));
      else if (!strcmp(type, "bit")) printf(" %s=%d", field, (read_u32(at) & strtoul(mask ? mask : "1", NULL, 0)) ? 1 : 0);
      else if (!strcmp(type, "obj")) {
        uintptr_t p = read_u32(at); char text[256] = "None";
        if (p) name_text(read_u32(p + OFF_OBJECT_NAME), text, sizeof(text));
        printf(" %s=%s", field, text);
      } else if (!strcmp(type, "name")) { char text[256]; name_text(read_u32(at), text, sizeof(text)); printf(" %s=%s", field, text); }
    }
    printf("\n");
  }
  CloseHandle(process);
  return 0;
}
