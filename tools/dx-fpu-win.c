/* The x87 control word the running original has at chosen code addresses, and dumps of its light-manager tables
 * (docs/render-pass-precision.md "Measured in the running original"). Companion of dx-live-win.c.
 *
 *   wine dx-fpu-win.exe cw attach <seconds> <spec>...
 *   wine dx-fpu-win.exe cw launch <seconds> <spec>... -- <command line>
 *       A breakpoint at each spec; at every hit the thread's FloatSave.ControlWord, whether the render pass is open
 *       (URender::PreRender 'pass-open' to PostRender 'pass-close'), and the caller (the return address at entry, with
 *       its module). `attach` debugs the running DeusEx.exe; `launch` creates it as a debuggee, so code that runs once
 *       at start (URender::Init, FLightManager::Init, the cooperative-level call) is reached too. A spec is
 *           label=Module.dll:0xADDRESS[:n=BUDGET][:ret]
 *       the address at the module's preferred base (the tool rebases it to where the module loaded), BUDGET hits per
 *       frame (UGameEngine::Draw's spec, label 'frame', resets every budget; default 30), `ret` reads no caller (the
 *       address is not a function entry), `rec` reads Frame = the first stack argument and joins its Recursion (+0x1c: the main
 *       frame 0, a mirror's or sky's child 1 or more) to the row. Labels 'pass-open' and 'pass-close' mark the pass, 'frame' the frame.
 *       Output: the first hits as they happen (stderr), then per spec the distinct (pass, control word, caller module)
 *       rows with counts and the first caller address.
 *
 *   dump=<file>:<address>:<bytes>   (a spec argument) writes that block of the debuggee's memory when the run ends
 *
 *   wine dx-fpu-win.exe dump <file> <address> <bytes>
 *       a block of the running DeusEx.exe's memory to a file (Z:\ paths reach the host's)
 *
 * Build: i686-w64-mingw32-gcc -O2 -o dx-fpu-win.exe dx-fpu-win.c -lpsapi
 */
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <ctype.h>

#define MAXBP 48
#define MAXROW 64
#define MAXMOD 128

typedef struct { int pass; unsigned cw; char mod[24]; unsigned caller; int rec; unsigned long count; } Row;
typedef struct {
  char label[40], module[24]; uintptr_t pref, addr; unsigned char original;
  int armed, loaded, budget, left, ret_ok, want_rec;
  Row rows[MAXROW]; int nrows; unsigned long hits, shown;
} Bp;
typedef struct { char name[24]; uintptr_t base, size, pref; } Mod;

static HANDLE process; static DWORD pid;
static Bp bps[MAXBP]; static int nbp;
static Mod mods[MAXMOD]; static int nmod;
static int pass_open = 0;
static int frame_bp = -1, open_bp = -1, close_bp = -1;
static LARGE_INTEGER qpf;
typedef struct { char file[260]; uintptr_t address; size_t size; } Dump;
static Dump dumps[16]; static int ndump;

static long long qpc_us(void) { LARGE_INTEGER n; QueryPerformanceCounter(&n); return n.QuadPart * 1000000LL / qpf.QuadPart; }
static int read_mem(uintptr_t a, void *o, SIZE_T n) { SIZE_T g = 0; return ReadProcessMemory(process, (LPCVOID)a, o, n, &g) && g == n; }
static int write_mem(uintptr_t a, const void *i, SIZE_T n) { SIZE_T g = 0; return WriteProcessMemory(process, (LPVOID)a, i, n, &g) && g == n; }
static unsigned read_u32(uintptr_t a) { unsigned v = 0; read_mem(a, &v, 4); return v; }

static DWORD find_pid(const char *name) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32 e; e.dwSize = sizeof(e); DWORD found = 0;
  if (Process32First(snap, &e)) do { if (_stricmp(e.szExeFile, name) == 0) { found = e.th32ProcessID; break; } } while (Process32Next(snap, &e));
  CloseHandle(snap); return found;
}

static void note_module(const char *name, uintptr_t base) {
  for (int i = 0; i < nmod; i++) if (mods[i].base == base) return;
  if (nmod >= MAXMOD) return;
  Mod *m = &mods[nmod++]; memset(m, 0, sizeof(*m)); strncpy(m->name, name, sizeof(m->name) - 1); m->base = base;
  unsigned char hdr[0x400]; memset(hdr, 0, sizeof(hdr)); read_mem(base, hdr, sizeof(hdr));
  if (hdr[0] == 'M' && hdr[1] == 'Z') {
    unsigned pe = *(unsigned *)(hdr + 0x3c);
    if (pe + 0x60 < sizeof(hdr)) { m->pref = *(unsigned *)(hdr + pe + 0x34); m->size = *(unsigned *)(hdr + pe + 0x50); }
  }
}
static const char *module_of(uintptr_t a, char *out) {
  for (int i = 0; i < nmod; i++) if (a >= mods[i].base && a < mods[i].base + mods[i].size) { strcpy(out, mods[i].name); return out; }
  strcpy(out, "?"); return out;
}
static void scan_modules(void) {
  HMODULE list[1024]; DWORD need = 0;
  if (!EnumProcessModulesEx(process, list, sizeof(list), &need, LIST_MODULES_ALL)) return;
  for (DWORD i = 0; i < need / sizeof(HMODULE) && i < 1024; i++) {
    char name[MAX_PATH]; if (GetModuleBaseNameA(process, list[i], name, sizeof(name))) note_module(name, (uintptr_t)list[i]);
  }
}

static void arm(Bp *b) {
  if (!b->loaded || b->armed) return;
  unsigned char cc = 0xCC;
  if (!b->original && !read_mem(b->addr, &b->original, 1)) return;
  if (write_mem(b->addr, &cc, 1)) { FlushInstructionCache(process, (LPCVOID)b->addr, 1); b->armed = 1; }
}
static void disarm(Bp *b) {
  if (!b->armed) return;
  write_mem(b->addr, &b->original, 1); FlushInstructionCache(process, (LPCVOID)b->addr, 1); b->armed = 0;
}
/* a module has appeared: rebase and arm the specs that name it */
static void bind_specs(void) {
  for (int i = 0; i < nbp; i++) {
    Bp *b = &bps[i];
    if (b->loaded) continue;
    for (int m = 0; m < nmod; m++) {
      if (_stricmp(mods[m].name, b->module)) continue;
      if (!mods[m].pref) continue;
      b->addr = mods[m].base + (b->pref - mods[m].pref); b->loaded = 1;
      if (mods[m].base != mods[m].pref) fprintf(stderr, "note: %s loaded at 0x%lx, not its preferred 0x%lx; %s rebased to 0x%lx\n", mods[m].name,
        (unsigned long)mods[m].base, (unsigned long)mods[m].pref, b->label, (unsigned long)b->addr);
      arm(b); break;
    }
  }
}

static int parse_spec(const char *text, Bp *b) {
  memset(b, 0, sizeof(*b)); b->budget = b->left = 30; b->ret_ok = 1;
  char copy[256]; strncpy(copy, text, sizeof(copy) - 1); copy[sizeof(copy) - 1] = 0;
  char *eq = strchr(copy, '='); if (!eq) return 0; *eq = 0; strncpy(b->label, copy, sizeof(b->label) - 1);
  char *rest = eq + 1; char *colon = strchr(rest, ':'); if (!colon) return 0; *colon = 0; strncpy(b->module, rest, sizeof(b->module) - 1);
  rest = colon + 1;
  for (char *part = strtok(rest, ":"); part; part = strtok(NULL, ":")) {
    if (!strncmp(part, "0x", 2)) b->pref = (uintptr_t)strtoul(part, NULL, 16);
    else if (!strncmp(part, "n=", 2)) b->budget = b->left = atoi(part + 2);
    else if (!strcmp(part, "ret")) b->ret_ok = 0;
    else if (!strcmp(part, "rec")) b->want_rec = 1;   /* the first stack argument is an FSceneNode: its Recursion (+0x1c) joins the row */
  }
  return b->pref != 0;
}

static HANDLE thread_cache[256]; static DWORD thread_ids[256]; static int thread_n;
static HANDLE thread_of(DWORD tid) {
  for (int i = 0; i < thread_n; i++) if (thread_ids[i] == tid) return thread_cache[i];
  HANDLE h = OpenThread(THREAD_GET_CONTEXT | THREAD_SET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, tid);
  if (h && thread_n < 256) { thread_cache[thread_n] = h; thread_ids[thread_n++] = tid; }
  return h;
}

static void record(Bp *b, unsigned cw, unsigned caller, int rec) {
  char mod[24] = "-";
  if (b->ret_ok) module_of(caller, mod);
  Row *r = NULL;
  for (int i = 0; i < b->nrows; i++) if (b->rows[i].pass == pass_open && b->rows[i].cw == cw && b->rows[i].rec == rec && !strcmp(b->rows[i].mod, mod)) { r = &b->rows[i]; break; }
  if (!r && b->nrows < MAXROW) { r = &b->rows[b->nrows++]; r->pass = pass_open; r->cw = cw; r->rec = rec; strcpy(r->mod, mod); r->caller = caller; r->count = 0; }
  if (r) r->count++;
  b->hits++;
  if (b->shown < 4 || (r && r->count == 1)) {
    b->shown++;
    fprintf(stderr, "%lld %-28s cw=0x%04x pass=%d caller=0x%08x (%s) rec=%d\n", qpc_us(), b->label, cw, pass_open, caller, mod, rec);
  }
}

static DWORD step_tid; static Bp *step_bp;
static void on_breakpoint(DEBUG_EVENT *ev, uintptr_t where) {
  Bp *b = NULL; int index = -1;
  for (int i = 0; i < nbp; i++) if (bps[i].loaded && bps[i].addr == where) { b = &bps[i]; index = i; break; }
  HANDLE th = thread_of(ev->dwThreadId);
  if (!b || !th) return;
  if (!b->armed) {   /* its int3 fired just before the byte was restored (another thread's step): rewind and run the instruction */
    CONTEXT c; memset(&c, 0, sizeof(c)); c.ContextFlags = CONTEXT_CONTROL; GetThreadContext(th, &c); c.Eip = (DWORD)where; SetThreadContext(th, &c);
    return;
  }
  CONTEXT ctx; memset(&ctx, 0, sizeof(ctx)); ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER | CONTEXT_FLOATING_POINT;
  if (!GetThreadContext(th, &ctx)) { fprintf(stderr, "GetThreadContext failed (%lu)\n", GetLastError()); return; }
  unsigned cw = ctx.FloatSave.ControlWord & 0xffff, caller = b->ret_ok ? read_u32(ctx.Esp) : 0;
  if (index == frame_bp) for (int i = 0; i < nbp; i++) { bps[i].left = bps[i].budget; if (!bps[i].armed && bps[i].loaded && i != index) arm(&bps[i]); }
  if (b->left > 0 || index == frame_bp || index == open_bp || index == close_bp) {
    record(b, cw, caller, b->want_rec ? (int)read_u32(read_u32(ctx.Esp + 4) + 0x1c) : -1);
    if (b->left > 0) b->left--;
  }
  if (index == open_bp) pass_open = 1;
  if (index == close_bp) pass_open = 0;
  /* step over the original instruction with the byte restored, then arm again (or stay off when the budget is spent) */
  write_mem(where, &b->original, 1); FlushInstructionCache(process, (LPCVOID)where, 1); b->armed = 0;
  ctx.ContextFlags = CONTEXT_CONTROL; GetThreadContext(th, &ctx);
  ctx.Eip = (DWORD)where; ctx.EFlags |= 0x100; SetThreadContext(th, &ctx);
  step_tid = ev->dwThreadId; step_bp = b;
}

static char recbuf[16];
static void summary(void) {
  printf("pid %lu; modules:", (unsigned long)pid);
  for (int i = 0; i < nmod; i++) if (!strcmp(mods[i].name, "Render.dll") || !strcmp(mods[i].name, "Core.dll") || !strcmp(mods[i].name, "Engine.dll")
    || !strcmp(mods[i].name, "Galaxy.dll") || !strcmp(mods[i].name, "D3DDrv.dll") || !strcmp(mods[i].name, "DeusEx.exe")) printf(" %s@0x%lx", mods[i].name, (unsigned long)mods[i].base);
  printf("\n");
  for (int i = 0; i < nbp; i++) {
    Bp *b = &bps[i];
    printf("%-30s 0x%08lx %s hits=%lu%s\n", b->label, (unsigned long)b->addr, b->module, b->hits, b->loaded ? "" : "  (module not loaded)");
    for (int r = 0; r < b->nrows; r++)
      printf("    pass=%d cw=0x%04x  caller=%-12s first=0x%08x%s%s  n=%lu\n", b->rows[r].pass, b->rows[r].cw, b->rows[r].mod, b->rows[r].caller,
        b->rows[r].rec >= 0 ? "  recursion=" : "", b->rows[r].rec >= 0 ? (snprintf(recbuf, sizeof(recbuf), "%d", b->rows[r].rec), recbuf) : "", b->rows[r].count);
  }
}

static int do_cw(int launch, int argc, char **argv) {
  QueryPerformanceFrequency(&qpf);
  int seconds = atoi(argv[0]); int i = 1;
  for (; i < argc && strcmp(argv[i], "--"); i++) {
    if (!strncmp(argv[i], "dump=", 5) && ndump < 16) {   /* dump=<file>:<address>:<bytes>, written before the run ends */
      char copy[400]; strncpy(copy, argv[i] + 5, sizeof(copy) - 1); copy[sizeof(copy) - 1] = 0;
      char *a = strrchr(copy, ':'); if (!a) return 2; *a = 0; char *size = a + 1;
      char *b = strrchr(copy, ':'); if (!b) return 2; *b = 0;
      strncpy(dumps[ndump].file, copy, sizeof(dumps[ndump].file) - 1); dumps[ndump].address = (uintptr_t)strtoul(b + 1, NULL, 0); dumps[ndump].size = (size_t)strtoul(size, NULL, 0); ndump++;
      continue;
    }
    if (nbp >= MAXBP || !parse_spec(argv[i], &bps[nbp])) { fprintf(stderr, "bad spec %s\n", argv[i]); return 2; }
    nbp++;
  }
  for (int k = 0; k < nbp; k++) {
    if (!strcmp(bps[k].label, "frame")) frame_bp = k;
    if (!strcmp(bps[k].label, "pass-open")) open_bp = k;
    if (!strcmp(bps[k].label, "pass-close")) close_bp = k;
  }
  HANDLE child_thread = NULL;
  if (launch) {
    if (i >= argc) { fprintf(stderr, "launch needs -- <command line>\n"); return 2; }
    char cmd[1024] = ""; for (int k = i + 1; k < argc; k++) { if (k > i + 1) strcat(cmd, " "); strcat(cmd, argv[k]); }
    STARTUPINFOA si; memset(&si, 0, sizeof(si)); si.cb = sizeof(si); PROCESS_INFORMATION pi; memset(&pi, 0, sizeof(pi));
    if (!CreateProcessA(NULL, cmd, NULL, NULL, FALSE, DEBUG_ONLY_THIS_PROCESS, NULL, "C:\\Deus Ex GOTY Edition\\System", &si, &pi)) {
      fprintf(stderr, "CreateProcess failed (%lu)\n", GetLastError()); return 1; }
    process = pi.hProcess; pid = pi.dwProcessId; child_thread = pi.hThread;
    DebugSetProcessKillOnExit(FALSE);
  } else {
    pid = find_pid("DeusEx.exe");
    if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
    process = OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid);
    if (!process) { fprintf(stderr, "cannot open DeusEx.exe\n"); return 1; }
    /* attach first: a breakpoint written before the debugger is attached would reach the game's own exception handler */
    if (!DebugActiveProcess(pid)) { fprintf(stderr, "DebugActiveProcess failed (%lu)\n", GetLastError()); return 1; }
    DebugSetProcessKillOnExit(FALSE);
    scan_modules(); bind_specs();
  }
  (void)child_thread;
  ULONGLONG until = GetTickCount64() + (ULONGLONG)seconds * 1000ULL;
  DEBUG_EVENT ev; int running = 1;
  while (running && GetTickCount64() < until) {
    if (!WaitForDebugEvent(&ev, 100)) continue;
    DWORD status = DBG_CONTINUE;
    switch (ev.dwDebugEventCode) {
    case CREATE_PROCESS_DEBUG_EVENT:
      if (launch) { note_module("DeusEx.exe", (uintptr_t)ev.u.CreateProcessInfo.lpBaseOfImage); bind_specs(); }
      if (ev.u.CreateProcessInfo.hFile) CloseHandle(ev.u.CreateProcessInfo.hFile);
      break;
    case LOAD_DLL_DEBUG_EVENT: {
      char path[MAX_PATH] = "";
      if (GetMappedFileNameA(process, ev.u.LoadDll.lpBaseOfDll, path, sizeof(path))) {
        char *slash = strrchr(path, '\\'); note_module(slash ? slash + 1 : path, (uintptr_t)ev.u.LoadDll.lpBaseOfDll); bind_specs();
      }
      if (ev.u.LoadDll.hFile) CloseHandle(ev.u.LoadDll.hFile);
      break; }
    case EXIT_PROCESS_DEBUG_EVENT: running = 0; break;
    case EXCEPTION_DEBUG_EVENT: {
      DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode; uintptr_t where = (uintptr_t)ev.u.Exception.ExceptionRecord.ExceptionAddress;
      if (code == EXCEPTION_BREAKPOINT) { on_breakpoint(&ev, where); }
      else if (code == EXCEPTION_SINGLE_STEP) {
        if (step_bp && ev.dwThreadId == step_tid) {
          if (step_bp->left > 0 || (int)(step_bp - bps) == frame_bp || (int)(step_bp - bps) == open_bp || (int)(step_bp - bps) == close_bp) arm(step_bp);
          step_bp = NULL;
        }
      } else status = DBG_EXCEPTION_NOT_HANDLED;
      break; }
    default: break;
    }
    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status);
  }
  for (int k = 0; k < nbp; k++) disarm(&bps[k]);
  /* drain events already queued, rewinding an int3 that fired before its byte was restored */
  int quiet = 0;
  while (quiet < 3 && running) {
    if (!WaitForDebugEvent(&ev, 40)) { quiet++; continue; }
    quiet = 0; DWORD status = DBG_CONTINUE;
    if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode; uintptr_t where = (uintptr_t)ev.u.Exception.ExceptionRecord.ExceptionAddress;
      HANDLE th = thread_of(ev.dwThreadId); int ours = 0;
      for (int k = 0; k < nbp; k++) if (bps[k].loaded && bps[k].addr == where) ours = 1;
      if (code == EXCEPTION_BREAKPOINT && ours && th) { CONTEXT c; c.ContextFlags = CONTEXT_CONTROL; GetThreadContext(th, &c); c.Eip = (DWORD)where; SetThreadContext(th, &c); }
      else if (code != EXCEPTION_BREAKPOINT && code != EXCEPTION_SINGLE_STEP) status = DBG_EXCEPTION_NOT_HANDLED;
    } else if (ev.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) running = 0;
    else if (ev.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT && ev.u.LoadDll.hFile) CloseHandle(ev.u.LoadDll.hFile);
    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status);
  }
  for (int k = 0; k < ndump; k++) {
    unsigned char *buffer = malloc(dumps[k].size);
    if (buffer && read_mem(dumps[k].address, buffer, dumps[k].size)) {
      FILE *out = fopen(dumps[k].file, "wb"); if (out) { fwrite(buffer, 1, dumps[k].size, out); fclose(out); fprintf(stderr, "dumped %lu bytes at 0x%lx to %s\n", (unsigned long)dumps[k].size, (unsigned long)dumps[k].address, dumps[k].file); }
    } else fprintf(stderr, "cannot read %lu bytes at 0x%lx\n", (unsigned long)dumps[k].size, (unsigned long)dumps[k].address);
    free(buffer);
  }
  summary();
  /* detach and leave the game running: the caller quits it through the game's own exit, so the next start is not a Recovery Mode start */
  if (running) DebugActiveProcessStop(pid);
  return 0;
}

static int do_dump(const char *file, uintptr_t address, size_t size) {
  pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  if (!process) { fprintf(stderr, "cannot open DeusEx.exe\n"); return 1; }
  unsigned char *buffer = malloc(size);
  if (!buffer || !read_mem(address, buffer, size)) { fprintf(stderr, "cannot read %lu bytes at 0x%lx\n", (unsigned long)size, (unsigned long)address); return 1; }
  FILE *out = fopen(file, "wb"); if (!out) { fprintf(stderr, "cannot write %s\n", file); return 1; }
  fwrite(buffer, 1, size, out); fclose(out); free(buffer);
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 4 && !strcmp(argv[1], "cw") && (!strcmp(argv[2], "attach") || !strcmp(argv[2], "launch")))
    return do_cw(!strcmp(argv[2], "launch"), argc - 3, argv + 3);
  if (argc >= 5 && !strcmp(argv[1], "dump")) return do_dump(argv[2], (uintptr_t)strtoul(argv[3], NULL, 0), (size_t)strtoul(argv[4], NULL, 0));
  fprintf(stderr, "usage: dx-fpu-win.exe cw attach|launch <seconds> <spec>... [-- <command line>] | dump <file> <address> <bytes>\n");
  return 2;
}
