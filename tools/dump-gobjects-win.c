/* Dump the running original Deus Ex GObjObjects registry from inside Wine.
 *
 * Windows build of tools/dump-gobjects.py. CrossOver/Wine on macOS translates
 * the 32-bit Windows address space, so the host cannot read it; run this exe in
 * the same bottle while the game is running:
 *
 *   wine dump-gobjects-win.exe            (all objects)
 *   wine dump-gobjects-win.exe LightSwitch
 *
 * Core.dll structure offsets (module-relative), recovered from the GOTY DLLs:
 *   GObjObjects data +0x19e628, count +0x19e62c
 *   GNames     data +0x1961f0, count +0x1961f4
 *   object +0x04 index, +0x20 FName index, +0x24 class UClass*
 *   FNameEntry text +0x0c (UTF-16)
 *
 * Build (macOS, after `brew install mingw-w64`):
 *   i686-w64-mingw32-gcc -O2 -o dump-gobjects-win.exe dump-gobjects-win.c -lpsapi
 * (or x86_64-w64-mingw32-gcc; ReadProcessMemory is bitness-agnostic.)
 */
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#define OFF_GOG_DATA   0x19E628u
#define OFF_GOG_COUNT  0x19E62Cu
#define OFF_NAMES_DATA 0x1961F0u
#define OFF_NAMES_COUNT 0x1961F4u
#define OFF_OBJECT_INDEX 0x04u
#define OFF_OBJECT_NAME  0x20u
#define OFF_OBJECT_CLASS 0x24u
#define OFF_NAMEENTRY_TEXT 0x0Cu

static DWORD find_pid(const char *name) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32 entry;
    entry.dwSize = sizeof(entry);
    DWORD pid = 0;
    if (Process32First(snap, &entry)) {
        do {
            if (_stricmp(entry.szExeFile, name) == 0) { pid = entry.th32ProcessID; break; }
        } while (Process32Next(snap, &entry));
    }
    CloseHandle(snap);
    return pid;
}

static uintptr_t module_base(DWORD pid, const char *name, HANDLE process) {
    HMODULE modules[1024];
    DWORD needed = 0;
    if (!EnumProcessModulesEx(process, modules, sizeof(modules), &needed, LIST_MODULES_ALL))
        return 0;
    DWORD count = needed / sizeof(HMODULE);
    for (DWORD i = 0; i < count && i < 1024; i++) {
        char buffer[MAX_PATH];
        if (GetModuleBaseNameA(process, modules[i], buffer, sizeof(buffer)) &&
            _stricmp(buffer, name) == 0)
            return (uintptr_t)modules[i];
    }
    return 0;
}

static int read_mem(HANDLE process, uintptr_t address, void *out, SIZE_T size) {
    SIZE_T got = 0;
    return ReadProcessMemory(process, (LPCVOID)address, out, size, &got) && got == size;
}

static unsigned read_u32(HANDLE process, uintptr_t address) {
    unsigned value = 0;
    read_mem(process, address, &value, sizeof(value));
    return value;
}

static void read_wstr(HANDLE process, uintptr_t address, wchar_t *out, int max) {
    out[0] = 0;
    for (int i = 0; i < max - 1; i++) {
        wchar_t ch = 0;
        if (!read_mem(process, address + i * 2, &ch, 2) || ch == 0) break;
        out[i] = ch;
        out[i + 1] = 0;
    }
}

int main(int argc, char **argv) {
    const char *find = argc > 1 ? argv[1] : NULL;
    DWORD pid = find_pid("DeusEx.exe");
    if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
    HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (!process) { fprintf(stderr, "OpenProcess failed (%lu)\n", GetLastError()); return 1; }
    uintptr_t core = module_base(pid, "Core.dll", process);
    if (!core) { fprintf(stderr, "Core.dll not loaded\n"); return 1; }

    uintptr_t gog = read_u32(process, core + OFF_GOG_DATA);
    unsigned gog_count = read_u32(process, core + OFF_GOG_COUNT);
    uintptr_t names = read_u32(process, core + OFF_NAMES_DATA);
    unsigned name_count = read_u32(process, core + OFF_NAMES_COUNT);

    printf("pid=%lu Core.dll base=0x%lx objects=%u names=%u\n",
           (unsigned long)pid, (unsigned long)core, gog_count, name_count);

    for (unsigned slot = 0; slot < gog_count; slot++) {
        uintptr_t obj = read_u32(process, gog + slot * 4);
        if (!obj) continue;
        unsigned index = read_u32(process, obj + OFF_OBJECT_INDEX);
        unsigned name_index = read_u32(process, obj + OFF_OBJECT_NAME);
        uintptr_t cls = read_u32(process, obj + OFF_OBJECT_CLASS);
        wchar_t object_name[256], class_name[256];
        object_name[0] = class_name[0] = 0;
        if (names) {
            uintptr_t entry = read_u32(process, names + name_index * 4);
            if (entry) read_wstr(process, entry + OFF_NAMEENTRY_TEXT, object_name, 256);
            if (cls) {
                unsigned class_name_index = read_u32(process, cls + OFF_OBJECT_NAME);
                uintptr_t class_entry = read_u32(process, names + class_name_index * 4);
                if (class_entry)
                    read_wstr(process, class_entry + OFF_NAMEENTRY_TEXT, class_name, 256);
            }
        }
        if (find) {
            char ascii[256];
            WideCharToMultiByte(CP_ACP, 0, object_name, -1, ascii, sizeof(ascii), NULL, NULL);
            if (!strstr(ascii, find)) continue;
        }
        printf("slot %6u index %6u %ls.%ls\n", slot, index, class_name, object_name);
    }
    CloseHandle(process);
    return 0;
}
