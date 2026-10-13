/* Live observation of the running original Deus Ex under Wine, for the
 * live-scene acceptance (docs/visual-acceptance.md "Live scenes"). Companion
 * of dump-actor-win.c; the same Core.dll registry offsets.
 *
 *   wine dx-live-win.exe rng [count] [interval_ms]
 *       the CRT rand() state of every thread of DeusEx.exe (the msvcrt
 *       thread-data block found through the TEB's TLS slots, whose first
 *       dword is the thread id; the seed word is at +0x14), `count` samples
 *       `interval_ms` apart: <qpc_us> tid=<tid> slot=<n> ptd=0x<addr> state=0x<word>
 *
 *   wine dx-live-win.exe list <Class>
 *       the live level's actors whose class derives from <Class>: class, name, global slot, Location, state, OddsOfAppearing
 *
 *   wine dx-live-win.exe stamps <seconds> <name,name,...>
 *       which frame stamps an actor's LastRenderTime (Render.dll 0x10b25161): per stamp of a listed actor its name and the
 *       frame's Recursion, iSurf, Mirror and parent (the main frame has recursion 0, a mirror's child 1 or more)
 *
 *   wine dx-live-win.exe trace <config>
 *       attaches as a debugger and breaks at ULevel::Tick's entry (Engine.dll
 *       0x103a51a0) and return (0x103a5baf, `ret 8`) for the watched level,
 *       so every observation is made with the game thread stopped between
 *       two exact points of the original's loop. One JSON line per tick:
 *       its input delta, the level clocks and the CRT rand state at entry and
 *       exit, and the watched actors' fields at exit. The config's `release`
 *       clears LevelInfo.bPlayersOnly at the entry of that tick; after
 *       `ticks` unfrozen ticks the level's Tick is skipped (a return from
 *       the function at its entry: the level is paused, with clock and
 *       animations held) until the `<out>.resume` file appears.
 *       Config lines (whitespace separated; # comments):
 *         out <file>              JSON lines
 *         player <name>           the name prefix of the live PlayerPawn (JCDentonMale), whose XLevel is the level
 *         release <n>             clear bPlayersOnly at the nth tick entry (0: never)
 *         ticks <n>               unfrozen ticks to run after the release
 *         pre-watch <n>           ticks to record before the release (default all)
 *         delta <seconds>         replace the input delta of every tick (default: the engine's own)
 *         actor-trace <first> <last>   for those unfrozen ticks, a breakpoint at AActor::Tick (0x103a1aa0) also writes
 *                                 <out>.actors.jsonl: each actor ticked, with the CRT rand state at its entry, so the draws
 *                                 between two entries are the earlier actor's
 *         monitor <seconds>       after the resume, stay attached (breakpoints removed) that long, reporting fatal exceptions
 *         kill-on-crash <0|1>     terminate the game at its first fatal first-chance exception, after reporting it (default 1:
 *                                 no crash dialog is left on the desktop)
 *         call <addr> <label> <nwords> [gate] [always] [name0] [namee] [deref <argidx> <ndwords> <byteoffset>]... (up to three)
 *                                 a breakpoint at a function's entry (call-ticks only): its label, ECX, the first
 *                                 `nwords` stack dwords and, at its return (a one-shot breakpoint at the return
 *                                 address), EAX, those dwords again and `ndwords` at the pointer passed as argument
 *                                 `argidx`, to <out>.calls.jsonl. A `gate` function arms the others while it runs for
 *                                 the pawn `call-pawn` names (ECX); the rest log only inside a gate unless `always`.
 *                                 `name0` / `namee` also name the actor in argument 0 / ECX.
 *         watch-write <offset>    a hardware write watch (DR0) on that offset of the call-pawn, armed for the traced ticks; each
 *                                 write is a "write" record with the new value, the EIP after the writing instruction and 12 stack dwords
 *                                 `fname <i>` (up to two) logs the text of args[i], an FName, as "fnames"; every record carries `inTick` (inside a
 *                                 ULevel::Tick of the level: 0 for a console command or key edge typed while the level is held) and `rng` (the CRT
 *                                 rand state at the breakpoint)
 *         call-ticks <first> <last>   the unfrozen ticks whose calls are traced
 *         call-pawn <name>        the actor whose gate calls arm the tracing (any when omitted)
 *         call-frames             keep the calls armed between ticks (the renders after each traced tick), until the entry of the tick after
 *                                 call-ticks' last; `namearg <i> <off>` on a call logs the object name at *(args[i]+off) (off -1: args[i]
 *                                 itself) as argName; `ecxwords <n> <off>` logs n dwords at ECX+off at the return
 *         watch <A,B,..> <Field:off:type[:mask]>...   fields of those actors
 *       Types: f f3 i3 u8 u16 u32 bit(mask) name obj state.
 *       Offsets are the linked UProperty offsets (see dump-actor-win.c).
 *
 * Retail offsets (docs/script-level-tick.md): ULevel InTick +0x108, TickTag
 * +0x10c, double clock +0xdc; Actor.Level +0xa8, XLevel +0xac, StateFrame
 * +0x0c (StateNode +0x18); LevelInfo TimeDilation +0x474, TimeSeconds +0x478,
 * bPlayersOnly +0x4f0 & 4.
 *
 * Build: i686-w64-mingw32-gcc -O2 -o dx-live-win.exe dx-live-win.c -lpsapi
 */
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define OFF_GOG_DATA   0x19E628u
#define OFF_GOG_COUNT  0x19E62Cu
#define OFF_NAMES_DATA 0x1961F0u
#define OFF_OBJECT_NAME  0x20u
#define OFF_OBJECT_CLASS 0x24u
#define OFF_NAMEENTRY_TEXT 0x0Cu
#define TICK_ENTRY 0x103a51a0u
#define TICK_RET   0x103a5bafu
#define ACTOR_TICK 0x103a1aa0u   /* AActor::Tick entry: ECX is the actor */

typedef LONG (NTAPI *NtQueryInformationThread_t)(HANDLE, ULONG, PVOID, ULONG, PULONG);
typedef struct { LONG ExitStatus; PVOID TebBaseAddress; PVOID ClientIdProcess; PVOID ClientIdThread; ULONG_PTR AffinityMask; LONG Priority; LONG BasePriority; } THREAD_BASIC_INFO;

static HANDLE process;
static DWORD pid;
static LARGE_INTEGER qpf;
static uintptr_t names_table, core_base, engine_base;

static DWORD find_pid(const char *name) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32 entry; entry.dwSize = sizeof(entry);
  DWORD found = 0;
  if (Process32First(snap, &entry))
    do { if (_stricmp(entry.szExeFile, name) == 0) { found = entry.th32ProcessID; break; } } while (Process32Next(snap, &entry));
  CloseHandle(snap);
  return found;
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
static int write_mem(uintptr_t address, const void *in, SIZE_T size) {
  SIZE_T put = 0;
  return WriteProcessMemory(process, (LPVOID)address, in, size, &put) && put == size;
}
static unsigned read_u32(uintptr_t address) { unsigned v = 0; read_mem(address, &v, 4); return v; }
static long long qpc_us(void) {
  LARGE_INTEGER now; QueryPerformanceCounter(&now);
  return (long long)(now.QuadPart * 1000000LL / qpf.QuadPart);
}

/* FName index -> text, cached. */
static char *name_cache[1 << 16];
static const char *name_text(unsigned index) {
  if (index < (1u << 16) && name_cache[index]) return name_cache[index];
  wchar_t text[256]; text[0] = 0;
  uintptr_t entry = read_u32(names_table + index * 4);
  if (entry) for (int i = 0; i < 255; i++) {
    wchar_t ch = 0;
    if (!read_mem(entry + OFF_NAMEENTRY_TEXT + i * 2, &ch, 2) || !ch) break;
    text[i] = ch; text[i + 1] = 0;
  }
  char out[256];
  WideCharToMultiByte(CP_ACP, 0, text, -1, out, sizeof(out), NULL, NULL);
  char *copy = _strdup(out);
  if (index < (1u << 16)) name_cache[index] = copy;
  return copy;
}
static const char *object_name(uintptr_t obj) { return obj ? name_text(read_u32(obj + OFF_OBJECT_NAME)) : "None"; }

/* The CRT thread-data blocks of the process: for each thread, TLS slots whose
 * block starts with the thread id. */
typedef struct { DWORD tid; uintptr_t ptd; int slot; } Ptd;
static int find_ptds_of(DWORD only_tid, Ptd *out, int max) {
  NtQueryInformationThread_t query = (NtQueryInformationThread_t)GetProcAddress(GetModuleHandleA("ntdll.dll"), "NtQueryInformationThread");
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  THREADENTRY32 entry; entry.dwSize = sizeof(entry);
  int n = 0;
  if (Thread32First(snap, &entry)) do {
    if (entry.th32OwnerProcessID != pid) continue;
    if (only_tid && entry.th32ThreadID != only_tid) continue;
    HANDLE thread = OpenThread(THREAD_QUERY_INFORMATION, FALSE, entry.th32ThreadID);
    if (!thread) continue;
    THREAD_BASIC_INFO info; ULONG len = 0;
    if (query && query(thread, 0, &info, sizeof(info), &len) == 0 && info.TebBaseAddress) {
      unsigned slots[64];
      if (read_mem((uintptr_t)info.TebBaseAddress + 0xE10, slots, sizeof(slots)))
        for (int s = 0; s < 64; s++) {
          if (!slots[s]) continue;
          if (read_u32(slots[s]) == entry.th32ThreadID && n < max) { out[n].tid = entry.th32ThreadID; out[n].ptd = slots[s]; out[n].slot = s; n++; }
        }
    }
    CloseHandle(thread);
  } while (Thread32Next(snap, &entry));
  CloseHandle(snap);
  return n;
}

/* ---------------- trace configuration ---------------- */
typedef struct { char field[48]; unsigned offset; char type[8]; unsigned mask; } FieldSpec;
typedef struct {
  char names[2048];
  FieldSpec fields[192]; int field_count;
} WatchGroup;
typedef struct { char name[96]; uintptr_t address; int group; } Watched;

static char out_path[512] = "trace.jsonl", player_name[96] = "JCDentonMale";
static int release_at = 1, run_ticks = 100, pre_watch = -1, max_seconds = 0;
static int soft_at[64], soft_count, soft_idx, soft_state;   /* pause-at: unfrozen tick counts at which the level is held for console input */
static float forced_delta = 0;
static int monitor_seconds = 0, kill_on_crash = 1, actor_trace_first = 0, actor_trace_last = -1;
static WatchGroup groups[16]; static int group_count;
static Watched watched[1024]; static int watched_count;

/* ---------------- call tracing (config `call`) ---------------- */
static int in_our_tick = 0; static uintptr_t rng_ptd = 0;   /* inside a ULevel::Tick of the traced level; the msvcrt thread-data block of the rand state (+0x14) */
#define MAXCALLS 32
#define MAXRET 64
typedef struct { uintptr_t address; unsigned char original; char label[24]; int nwords, deref_count, deref_arg[3], deref_n[3], deref_off[3], gate, always, name0, namee, namearg, namearg_off, ecx_n, ecx_off, span_on, span_arg, span_off, fret, fname_count, fname_arg[2]; char only[48]; } CallBp;
typedef struct { uintptr_t address; unsigned char original; int refs; } RetBp;
typedef struct { int active; uintptr_t ret; unsigned esp, ecx; int call; unsigned args[16]; unsigned deref_ptr[3]; unsigned long seq; } Pending;
static CallBp calls[MAXCALLS]; static int call_count;
static RetBp rets[MAXRET]; static int ret_count;
static Pending pend[MAXRET]; static int pend_count;
static int call_first = 0, call_last = -1, calls_armed = 0, gate_depth = 0, call_frames = 0;
static char call_pawn[96] = "";
static unsigned long call_seq = 0;
static FILE *cout;
static int pending_kind = -1, pending_index = -1;   /* a single step to re-arm a call (0) or return (1) breakpoint */
static unsigned watch_off = 0; static uintptr_t watch_pawn = 0; static HANDLE game_thread = NULL;   /* watch-write: a hardware write watch on call-pawn + offset */

static int parse_field(const char *text, FieldSpec *f) {
  char off[32] = "", type[8] = "", mask[32] = "";
  int n = sscanf(text, "%47[^:]:%31[^:]:%7[^:]:%31s", f->field, off, type, mask);
  if (n < 3) return 0;
  f->offset = strtoul(off, NULL, 0);
  strcpy(f->type, type);
  f->mask = n > 3 ? strtoul(mask, NULL, 0) : 1;
  return 1;
}
static int read_config(const char *path) {
  FILE *file = fopen(path, "r");
  if (!file) { fprintf(stderr, "cannot open %s\n", path); return 0; }
  char line[16384];
  while (fgets(line, sizeof line, file)) {
    char *hash = strchr(line, '#'); if (hash) *hash = 0;
    char *tok = strtok(line, " \t\r\n");
    if (!tok) continue;
    if (!strcmp(tok, "out")) { char *v = strtok(NULL, "\r\n"); if (v) { while (*v == ' ') v++; strncpy(out_path, v, sizeof(out_path) - 1); } }
    else if (!strcmp(tok, "player")) strncpy(player_name, strtok(NULL, " \t\r\n"), sizeof(player_name) - 1);
    else if (!strcmp(tok, "release")) release_at = atoi(strtok(NULL, " \t\r\n"));
    else if (!strcmp(tok, "pause-at")) { for (char *v; (v = strtok(NULL, " \t\r\n")) && soft_count < 64;) soft_at[soft_count++] = atoi(v); }
    else if (!strcmp(tok, "ticks")) run_ticks = atoi(strtok(NULL, " \t\r\n"));
    else if (!strcmp(tok, "max-seconds")) max_seconds = atoi(strtok(NULL, " \t\r\n"));   /* stop after that many seconds of unfrozen time, whatever the tick count */
    else if (!strcmp(tok, "delta")) forced_delta = (float)atof(strtok(NULL, " \t\r\n"));
    else if (!strcmp(tok, "actor-trace")) { actor_trace_first = atoi(strtok(NULL, " \t\r\n")); actor_trace_last = atoi(strtok(NULL, " \t\r\n")); }
    else if (!strcmp(tok, "monitor")) monitor_seconds = atoi(strtok(NULL, " \t\r\n"));
    else if (!strcmp(tok, "kill-on-crash")) kill_on_crash = atoi(strtok(NULL, " \t\r\n"));
    else if (!strcmp(tok, "pre-watch")) pre_watch = atoi(strtok(NULL, " \t\r\n"));
    else if (!strcmp(tok, "call-frames")) call_frames = 1;
    else if (!strcmp(tok, "call-ticks")) { call_first = atoi(strtok(NULL, " \t\r\n")); call_last = atoi(strtok(NULL, " \t\r\n")); }
    else if (!strcmp(tok, "watch-write")) watch_off = (unsigned)strtoul(strtok(NULL, " \t\r\n"), NULL, 0);
    else if (!strcmp(tok, "call-pawn")) { char *v = strtok(NULL, " \t\r\n"); if (v) strncpy(call_pawn, v, sizeof(call_pawn) - 1); }
    else if (!strcmp(tok, "call") && call_count < MAXCALLS) {
      CallBp *c = &calls[call_count]; memset(c, 0, sizeof(*c));
      char *a = strtok(NULL, " \t\r\n"), *l = strtok(NULL, " \t\r\n"), *n = strtok(NULL, " \t\r\n");
      if (!a || !l || !n) continue;
      c->address = strtoul(a, NULL, 0); strncpy(c->label, l, sizeof(c->label) - 1); c->nwords = atoi(n); if (c->nwords > 16) c->nwords = 16;
      for (char *o; (o = strtok(NULL, " \t\r\n"));) {
        if (!strcmp(o, "gate")) c->gate = 1; else if (!strcmp(o, "always")) c->always = 1;
        else if (!strcmp(o, "name0")) c->name0 = 1; else if (!strcmp(o, "namee")) c->namee = 1;
        else if (!strcmp(o, "namearg")) { c->namearg = atoi(strtok(NULL, " \t\r\n")) + 1; c->namearg_off = (int)strtol(strtok(NULL, " \t\r\n"), NULL, 0); }
        else if (!strcmp(o, "only")) { char *v = strtok(NULL, " \t\r\n"); if (v) strncpy(c->only, v, sizeof(c->only) - 1); }
        else if (!strcmp(o, "span")) { c->span_on = 1; c->span_arg = atoi(strtok(NULL, " \t\r\n")); c->span_off = (int)strtol(strtok(NULL, " \t\r\n"), NULL, 0); }
        else if (!strcmp(o, "fret")) c->fret = 1;
        else if (!strcmp(o, "fname") && c->fname_count < 2) c->fname_arg[c->fname_count++] = atoi(strtok(NULL, " \t\r\n"));
        else if (!strcmp(o, "ecxwords")) { c->ecx_n = atoi(strtok(NULL, " \t\r\n")); c->ecx_off = (int)strtol(strtok(NULL, " \t\r\n"), NULL, 0); if (c->ecx_n > 64) c->ecx_n = 64; }
        else if (!strcmp(o, "deref") && c->deref_count < 3) { c->deref_arg[c->deref_count] = atoi(strtok(NULL, " \t\r\n")); c->deref_n[c->deref_count] = atoi(strtok(NULL, " \t\r\n")); c->deref_off[c->deref_count] = (int)strtol(strtok(NULL, " \t\r\n"), NULL, 0); if (c->deref_n[c->deref_count] > 128) c->deref_n[c->deref_count] = 128; c->deref_count++; }
      }
      call_count++;
    }
    else if (!strcmp(tok, "watch") && group_count < 16) {
      WatchGroup *g = &groups[group_count++];
      char *n = strtok(NULL, " \t\r\n"); if (!n) continue;
      strncpy(g->names, n, sizeof(g->names) - 1);
      for (char *f; (f = strtok(NULL, " \t\r\n")) && g->field_count < 192;) if (parse_field(f, &g->fields[g->field_count])) g->field_count++;
    }
  }
  fclose(file);
  return 1;
}

/* Read the fields of one actor from its memory block. */
static void print_fields(FILE *out, const unsigned char *block, size_t size, uintptr_t actor, const WatchGroup *g) {
  for (int i = 0; i < g->field_count; i++) {
    const FieldSpec *f = &g->fields[i];
    fprintf(out, "%s\"%s\":", i ? "," : "", f->field);
    unsigned long need = f->offset + 12;
    if (need > size) { fprintf(out, "null"); continue; }
    const unsigned char *p = block + f->offset;
    float fv[3]; int iv[3]; unsigned u;
    if (!strcmp(f->type, "f")) { memcpy(fv, p, 4); fprintf(out, "%.9g", fv[0]); }
    else if (!strcmp(f->type, "f3")) { memcpy(fv, p, 12); fprintf(out, "[%.9g,%.9g,%.9g]", fv[0], fv[1], fv[2]); }
    else if (!strcmp(f->type, "i3")) { memcpy(iv, p, 12); fprintf(out, "[%d,%d,%d]", iv[0], iv[1], iv[2]); }
    else if (!strcmp(f->type, "i32")) { memcpy(&iv[0], p, 4); fprintf(out, "%d", iv[0]); }
    else if (!strcmp(f->type, "u8")) fprintf(out, "%u", p[0]);
    else if (!strcmp(f->type, "u16")) { unsigned short w; memcpy(&w, p, 2); fprintf(out, "%u", w); }
    else if (!strcmp(f->type, "u32")) { memcpy(&u, p, 4); fprintf(out, "\"0x%x\"", u); }
    else if (!strcmp(f->type, "bit")) { memcpy(&u, p, 4); fprintf(out, "%d", (u & f->mask) ? 1 : 0); }
    else if (!strcmp(f->type, "name")) { memcpy(&u, p, 4); fprintf(out, "\"%s\"", name_text(u)); }
    else if (!strcmp(f->type, "obj")) { memcpy(&u, p, 4); fprintf(out, "\"%s\"", u ? object_name(u) : "None"); }
    else if (!strcmp(f->type, "state")) {
      /* FStateFrame* at the field offset (Actor +0x0c): StateNode at +0x18, then its name; Node (+4) is the running function/state code. */
      memcpy(&u, p, 4);
      if (!u) fprintf(out, "\"None\""); else {
        unsigned node = read_u32(u + 0x18), fn = read_u32(u + 4);
        fprintf(out, "\"%s|%s\"", node ? object_name(node) : "None", fn ? object_name(fn) : "None");
      }
    }
    else fprintf(out, "null");
  }
  (void)actor;
}

static int read_block(uintptr_t address, unsigned char *buffer, size_t max, size_t *got) {
  for (size_t size = max; size >= 0x100; size /= 2) if (read_mem(address, buffer, size)) { *got = size; return 1; }
  *got = 0; return 0;
}

/* Resolve the player's level and the watched actors through the global object array. */
static uintptr_t level_ptr;      /* ULevel */
static uintptr_t level_info;     /* ALevelInfo */
static uintptr_t player_ptr;
static int resolve_actors(void) {
  uintptr_t gog = read_u32(core_base + OFF_GOG_DATA);
  unsigned count = read_u32(core_base + OFF_GOG_COUNT);
  /* Pass 1: the player with a live Player (viewport) -> its XLevel. */
  for (unsigned slot = 0; slot < count; slot++) {
    uintptr_t obj = read_u32(gog + slot * 4);
    if (!obj) continue;
    if (strncmp(object_name(obj), player_name, strlen(player_name))) continue;
    if (!read_u32(obj + 0x5d4)) continue;      /* PlayerPawn.Player */
    player_ptr = obj; level_ptr = read_u32(obj + 0xac); level_info = read_u32(obj + 0xa8);
  }
  if (!player_ptr) { fprintf(stderr, "no live %s\n", player_name); return 0; }
  /* @player in a watch list is the live PlayerPawn. */
  for (int g = 0; g < group_count; g++) {
    char list[2048]; strncpy(list, groups[g].names, sizeof(list) - 1); list[sizeof(list) - 1] = 0;
    for (char *n = strtok(list, ","); n; n = strtok(NULL, ","))
      if (!strcmp(n, "@player") && watched_count < 1024) { strcpy(watched[watched_count].name, "@player"); watched[watched_count].address = player_ptr; watched[watched_count].group = g; watched_count++; }
  }
  /* Pass 2: watched names on that level. */
  for (unsigned slot = 0; slot < count; slot++) {
    uintptr_t obj = read_u32(gog + slot * 4);
    if (!obj) continue;
    const char *name = object_name(obj);
    for (int g = 0; g < group_count; g++) {
      char list[2048]; strncpy(list, groups[g].names, sizeof(list) - 1); list[sizeof(list) - 1] = 0;
      for (char *n = strtok(list, ","); n; n = strtok(NULL, ","))
        if (!strcmp(n, name) && read_u32(obj + 0xac) == level_ptr && watched_count < 1024) {
          strncpy(watched[watched_count].name, name, sizeof(watched[0].name) - 1);
          watched[watched_count].address = obj; watched[watched_count].group = g; watched_count++;
        }
    }
  }
  return 1;
}

/* ---------------- debugger loop ---------------- */
typedef struct { uintptr_t address; unsigned char original; } Breakpoint;
static Breakpoint bp[3];
static void bp_arm(Breakpoint *b, uintptr_t address) {
  b->address = address; read_mem(address, &b->original, 1);
  unsigned char cc = 0xCC; write_mem(address, &cc, 1); FlushInstructionCache(process, (LPCVOID)address, 1);
}
static void bp_disarm(Breakpoint *b) { write_mem(b->address, &b->original, 1); FlushInstructionCache(process, (LPCVOID)b->address, 1); }

static HANDLE thread_handles[64]; static DWORD thread_ids[64]; static int thread_count;
static HANDLE thread_of(DWORD tid) {
  for (int i = 0; i < thread_count; i++) if (thread_ids[i] == tid) return thread_handles[i];
  HANDLE h = OpenThread(THREAD_GET_CONTEXT | THREAD_SET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, tid);
  if (h && thread_count < 64) { thread_ids[thread_count] = tid; thread_handles[thread_count++] = h; }
  return h;
}


/* The module containing an address, as "Name+0xRVA" (for crash reports). */
static void describe_address(uintptr_t address, char *out, size_t size) {
  HMODULE modules[1024]; DWORD needed = 0;
  out[0] = 0;
  if (!EnumProcessModulesEx(process, modules, sizeof(modules), &needed, LIST_MODULES_ALL)) return;
  for (DWORD i = 0; i < needed / sizeof(HMODULE) && i < 1024; i++) {
    MODULEINFO info;
    if (!GetModuleInformation(process, modules[i], &info, sizeof(info))) continue;
    uintptr_t base = (uintptr_t)info.lpBaseOfDll;
    if (address >= base && address < base + info.SizeOfImage) {
      char name[MAX_PATH]; name[0] = 0;
      GetModuleBaseNameA(process, modules[i], name, sizeof(name));
      snprintf(out, size, "%s+0x%lx", name, (unsigned long)(address - base));
      return;
    }
  }
}
static int is_fatal_exception(DWORD code) {
  return code == 0xC0000005 || code == 0xC000001D || code == 0xC0000094 || code == 0xC0000096 || code == 0xC00000FD ||
         code == 0xC0000025 || code == 0xC000008C || code == 0xC0000374 || code == 0xC0000409;
}
/* First-chance fatal exceptions of the game: the faulting address and registers,
 * the stack and the frame chain, to stderr and `<out>.crash.txt`. */
static void report_crash(const DEBUG_EVENT *ev, const char *crash_path, int ticks) {
  FILE *f = fopen(crash_path, "w");
  FILE *sinks[2] = {stderr, f};
  const EXCEPTION_RECORD *r = &ev->u.Exception.ExceptionRecord;
  char where[300];
  describe_address((uintptr_t)r->ExceptionAddress, where, sizeof(where));
  HANDLE th = OpenThread(THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, ev->dwThreadId);
  CONTEXT ctx; memset(&ctx, 0, sizeof(ctx)); ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER;
  int have = th && GetThreadContext(th, &ctx);
  for (int k = 0; k < 2; k++) {
    FILE *o = sinks[k]; if (!o) continue;
    fprintf(o, "EXCEPTION 0x%08lx at 0x%lx (%s) thread %lu, after %d ticks, first chance %lu, %lu parameters", (unsigned long)r->ExceptionCode,
      (unsigned long)(uintptr_t)r->ExceptionAddress, where, (unsigned long)ev->dwThreadId, ticks, (unsigned long)ev->u.Exception.dwFirstChance, (unsigned long)r->NumberParameters);
    for (DWORD i = 0; i < r->NumberParameters && i < 4; i++) fprintf(o, " p%lu=0x%lx", (unsigned long)i, (unsigned long)r->ExceptionInformation[i]);
    fprintf(o, "\n");
    if (have) {
      fprintf(o, "eax=%08lx ebx=%08lx ecx=%08lx edx=%08lx esi=%08lx edi=%08lx ebp=%08lx esp=%08lx eip=%08lx\n", (unsigned long)ctx.Eax, (unsigned long)ctx.Ebx,
        (unsigned long)ctx.Ecx, (unsigned long)ctx.Edx, (unsigned long)ctx.Esi, (unsigned long)ctx.Edi, (unsigned long)ctx.Ebp, (unsigned long)ctx.Esp, (unsigned long)ctx.Eip);
      unsigned char code[16];
      if (read_mem(ctx.Eip, code, 16)) { fprintf(o, "code at eip:"); for (int i = 0; i < 16; i++) fprintf(o, " %02x", code[i]); fprintf(o, "\n"); }
      fprintf(o, "stack:\n");
      for (int i = 0; i < 96; i++) {
        unsigned v = read_u32(ctx.Esp + 4 * i); char d[300]; describe_address(v, d, sizeof(d));
        if (d[0]) fprintf(o, "  [esp+0x%x] 0x%08x %s\n", 4 * i, v, d);
      }
      fprintf(o, "frames (ebp chain):\n");
      uintptr_t frame = ctx.Ebp;
      for (int i = 0; i < 24 && frame; i++) {
        unsigned ret = read_u32(frame + 4), next = read_u32(frame); char d[300]; describe_address(ret, d, sizeof(d));
        fprintf(o, "  ebp=0x%lx ret=0x%08x %s\n", (unsigned long)frame, ret, d);
        if (next <= frame) break;
        frame = next;
      }
    }
    fflush(o);
  }
  if (f) fclose(f);
  if (th) CloseHandle(th);
}

static double read_double(uintptr_t a) { double v = 0; read_mem(a, &v, 8); return v; }
static float read_float(uintptr_t a) { float v = 0; read_mem(a, &v, 4); return v; }
/* Render.dll's Strobe state (0x10b49ea8 the flag, 0x10b49ea4 the TimeSeconds it last saw; docs/visual-acceptance.md "Strobe"):
   set by SetupForSurf's Strobe type function once per drawn frame at a new time, so it is a host input like the rand state. */
static int strobe_ok = 0;
static unsigned strobe_flag(void) { return strobe_ok ? read_u32(0x10b49ea8) : 0; }
static float strobe_time(void) { return strobe_ok ? read_float(0x10b49ea4) : 0; }


/* watch-write: DR0 on the call-pawn's field (4 bytes, write), armed for the traced ticks. A hit is an EXCEPTION_SINGLE_STEP
 * with DR6 bit 0, reported by watch_hit after the writing instruction ran. */
static void watch_set(int on) {
  if (!watch_off || !watch_pawn || !game_thread) return;
  CONTEXT dc; memset(&dc, 0, sizeof(dc)); dc.ContextFlags = CONTEXT_DEBUG_REGISTERS;
  if (!GetThreadContext(game_thread, &dc)) return;
  dc.Dr0 = on ? (DWORD)(watch_pawn + watch_off) : 0; dc.Dr6 = 0; dc.Dr7 = on ? (0x1u | (1u << 16) | (3u << 18)) : 0;
  SetThreadContext(game_thread, &dc);
}
static void cb_write(uintptr_t address, unsigned char byte) { write_mem(address, &byte, 1); FlushInstructionCache(process, (LPCVOID)address, 1); }
/* Arm or remove every call breakpoint (the traced ticks' span) and the pending return breakpoints. */
static void calls_set(int on) {
  if (on == calls_armed) return;
  watch_set(on);
  for (int i = 0; i < call_count; i++) {
    if (on) { read_mem(calls[i].address, &calls[i].original, 1); cb_write(calls[i].address, 0xCC); }
    else cb_write(calls[i].address, calls[i].original);
  }
  if (!on) { for (int i = 0; i < ret_count; i++) if (rets[i].refs > 0) cb_write(rets[i].address, rets[i].original); ret_count = 0; pend_count = 0; gate_depth = 0; }
  calls_armed = on;
}
static int is_call_address(uintptr_t where) {
  if (!calls_armed) return 0;
  for (int i = 0; i < call_count; i++) if (calls[i].address == where) return 1;
  for (int i = 0; i < ret_count; i++) if (rets[i].refs > 0 && rets[i].address == where) return 1;
  return 0;
}
static void print_words(FILE *o, const unsigned *w, int n) {
  fprintf(o, "[");
  for (int i = 0; i < n; i++) { float f; memcpy(&f, &w[i], 4); fprintf(o, "%s\"0x%x\"", i ? "," : "", w[i]); (void)f; }
  fprintf(o, "]");
}
static void print_floats(FILE *o, const unsigned *w, int n) {
  fprintf(o, "[");
  for (int i = 0; i < n; i++) { float f; memcpy(&f, &w[i], 4); fprintf(o, i ? ",%.9g" : "%.9g", (f == f && f > -1e30f && f < 1e30f) ? f : 0.0f); }
  fprintf(o, "]");
}
/* An FSpanBuffer (StartY, EndY, ValidLines, Index**) as [[y,[start,end,...]],...] for the lines that have spans. */
static void print_span(FILE *o, uintptr_t sb) {
  if (!sb) { fprintf(o, "null"); return; }
  int y0 = (int)read_u32(sb), y1 = (int)read_u32(sb + 4); uintptr_t index = read_u32(sb + 12);
  if (y1 - y0 > 4096 || y1 < y0) { fprintf(o, "\"bad\""); return; }
  fprintf(o, "{\"y0\":%d,\"y1\":%d,\"lines\":[", y0, y1);
  int first = 1;
  for (int y = y0; y < y1; y++) {
    uintptr_t link = read_u32(index + 4 * (y - y0));
    if (!link) continue;
    fprintf(o, "%s[%d,[", first ? "" : ",", y); first = 0;
    for (int k = 0; link && k < 64; k++) { int a = (int)read_u32(link), b = (int)read_u32(link + 4); fprintf(o, "%s%d,%d", k ? "," : "", a, b); link = read_u32(link + 8); }
    fprintf(o, "]]");
  }
  fprintf(o, "]}");
}
/* A traced call's entry or return. Returns 1 when the breakpoint was one of ours (the thread's state is set). */
static int handle_call_event(HANDLE th, DWORD tid, uintptr_t where, int unfrozen) {
  if (!is_call_address(where)) return 0;
  CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER; GetThreadContext(th, &ctx);
  int step_kind = -1, step_index = -1;
  /* a return: the latest pending record at this address whose entry frame lies below the stack pointer now */
  int found = -1;
  for (int i = pend_count - 1; i >= 0; i--) if (pend[i].active && pend[i].ret == where && ctx.Esp > pend[i].esp) { found = i; break; }
  if (found >= 0) {
    Pending *p = &pend[found]; CallBp *c = &calls[p->call];
    unsigned now[16]; memset(now, 0, sizeof(now));
    read_mem(p->esp + 4, now, 4 * c->nwords);
    fprintf(cout, "{\"u\":%d,\"seq\":%lu,\"ev\":\"ret\",\"fn\":\"%s\",\"of\":%lu,\"eax\":\"0x%x\",\"args\":", unfrozen, ++call_seq, c->label, p->seq, (unsigned)ctx.Eax);
    print_words(cout, now, c->nwords);
    if (c->deref_count) {
      fprintf(cout, ",\"deref\":[");
      for (int d = 0; d < c->deref_count; d++) {
        unsigned deref[128]; memset(deref, 0, sizeof(deref));
        if (p->deref_ptr[d]) read_mem(p->deref_ptr[d] + c->deref_off[d], deref, 4 * c->deref_n[d]);
        fprintf(cout, "%s{\"arg\":%d,\"words\":", d ? "," : "", c->deref_arg[d]); print_words(cout, deref, c->deref_n[d]);
        fprintf(cout, ",\"floats\":"); print_floats(cout, deref, c->deref_n[d]); fprintf(cout, "}");
      }
      fprintf(cout, "]");
    }
    if (c->fret) {   /* the x87 ST(0) at the return: ten bytes of the FNSAVE image, little endian, and the value as a long double */
      CONTEXT fc; memset(&fc, 0, sizeof(fc)); fc.ContextFlags = CONTEXT_FLOATING_POINT;
      if (GetThreadContext(th, &fc)) {
        unsigned top = (fc.FloatSave.StatusWord >> 11) & 7; unsigned char *st0 = fc.FloatSave.RegisterArea; long double v = 0; memcpy(&v, st0, 10);
        fprintf(cout, ",\"st0\":\"");
        for (int b = 9; b >= 0; b--) fprintf(cout, "%02x", st0[b]);
        fprintf(cout, "\",\"st0f\":%.21Lg,\"fpTop\":%u,\"fpTag\":%u", v, top, (unsigned)fc.FloatSave.TagWord);
      }
    }
    if (c->ecx_n) { unsigned w[64]; memset(w, 0, sizeof(w)); read_mem(p->ecx + c->ecx_off, w, 4 * c->ecx_n); fprintf(cout, ",\"ecxWords\":"); print_words(cout, w, c->ecx_n); fprintf(cout, ",\"ecxFloats\":"); print_floats(cout, w, c->ecx_n); }
    fprintf(cout, "}\n"); fflush(cout);
    if (c->gate && gate_depth > 0) gate_depth--;
    p->active = 0; while (pend_count > 0 && !pend[pend_count - 1].active) pend_count--;
    for (int i = 0; i < ret_count; i++) if (rets[i].address == where && rets[i].refs > 0) {
      if (--rets[i].refs == 0) cb_write(where, rets[i].original); else { step_kind = 1; step_index = i; cb_write(where, rets[i].original); }
      break;
    }
  } else {
    for (int i = 0; i < call_count; i++) if (calls[i].address == where) {
      CallBp *c = &calls[i];
      int armed = gate_depth > 0 || c->always;
      if (c->gate) {
        char text[96] = ""; strncpy(text, object_name(ctx.Ecx), sizeof(text) - 1);
        if (call_pawn[0] && strcmp(text, call_pawn)) armed = 0; else armed = 1;
      }
      if (armed && c->only[0]) {
        unsigned a0[16]; memset(a0, 0, sizeof(a0)); read_mem(ctx.Esp + 4, a0, 4 * (c->nwords > 16 ? 16 : c->nwords));
        uintptr_t o = (c->namearg && c->namearg - 1 < c->nwords) ? (c->namearg_off < 0 ? a0[c->namearg - 1] : (a0[c->namearg - 1] ? read_u32(a0[c->namearg - 1] + c->namearg_off) : 0)) : 0;
        if (!o || strcmp(object_name(o), c->only)) armed = 0;
      }
      if (armed && c->gate && watch_off && !watch_pawn) { watch_pawn = (uintptr_t)ctx.Ecx; watch_set(1); }
      if (armed) {
        unsigned args[16]; memset(args, 0, sizeof(args)); read_mem(ctx.Esp + 4, args, 4 * c->nwords);
        unsigned long seq = ++call_seq;
        fprintf(cout, "{\"u\":%d,\"seq\":%lu,\"ev\":\"enter\",\"fn\":\"%s\",\"ecx\":\"0x%x\",\"ret\":\"0x%x\",\"inTick\":%d,\"rng\":\"0x%08x\"", unfrozen, seq, c->label, (unsigned)ctx.Ecx, read_u32(ctx.Esp), in_our_tick, rng_ptd ? read_u32(rng_ptd + 0x14) : 0);
        if (c->namee) fprintf(cout, ",\"ecxName\":\"%s\"", object_name(ctx.Ecx));
        if (c->name0 && c->nwords > 0) fprintf(cout, ",\"arg0Name\":\"%s\"", object_name(args[0]));
        if (c->namearg && c->namearg - 1 < c->nwords) { uintptr_t o = c->namearg_off < 0 ? args[c->namearg - 1] : (args[c->namearg - 1] ? read_u32(args[c->namearg - 1] + c->namearg_off) : 0); fprintf(cout, ",\"argName\":\"%s\"", object_name(o)); }
        if (c->fname_count) {   /* arguments that are FNames (an index into the name table): their text */
          fprintf(cout, ",\"fnames\":[");
          for (int k = 0; k < c->fname_count; k++) fprintf(cout, "%s\"%s\"", k ? "," : "", c->fname_arg[k] < c->nwords ? name_text(args[c->fname_arg[k]]) : "?");
          fprintf(cout, "]");
        }
        if (c->span_on && c->span_arg < c->nwords && args[c->span_arg]) { fprintf(cout, ",\"span\":"); print_span(cout, read_u32(args[c->span_arg] + c->span_off)); }
        fprintf(cout, ",\"args\":"); print_words(cout, args, c->nwords); fprintf(cout, ",\"floats\":"); print_floats(cout, args, c->nwords);
        if (c->deref_count) {
          fprintf(cout, ",\"deref\":[");
          for (int d = 0; d < c->deref_count; d++) {
            unsigned deref[128]; memset(deref, 0, sizeof(deref));
            if (c->deref_arg[d] >= 0 && c->deref_arg[d] < c->nwords && args[c->deref_arg[d]]) read_mem(args[c->deref_arg[d]] + c->deref_off[d], deref, 4 * c->deref_n[d]);
            fprintf(cout, "%s{\"arg\":%d,\"words\":", d ? "," : "", c->deref_arg[d]); print_words(cout, deref, c->deref_n[d]);
            fprintf(cout, ",\"floats\":"); print_floats(cout, deref, c->deref_n[d]); fprintf(cout, "}");
          }
          fprintf(cout, "]");
        }
        fprintf(cout, "}\n"); fflush(cout);
        if (c->gate) gate_depth++;
        unsigned ret = read_u32(ctx.Esp);
        if (pend_count < MAXRET) {
          Pending *p = &pend[pend_count++]; memset(p, 0, sizeof(*p));
          p->active = 1; p->ret = ret; p->esp = ctx.Esp; p->ecx = ctx.Ecx; p->call = i; p->seq = seq;
          for (int d = 0; d < c->deref_count; d++) p->deref_ptr[d] = (c->deref_arg[d] >= 0 && c->deref_arg[d] < c->nwords) ? args[c->deref_arg[d]] : 0;
          int slot = -1;
          for (int k = 0; k < ret_count; k++) if (rets[k].address == ret) { slot = k; break; }
          if (slot < 0 && ret_count < MAXRET) { slot = ret_count++; rets[slot].address = ret; rets[slot].refs = 0; }
          if (slot >= 0) { if (rets[slot].refs == 0) { read_mem(ret, &rets[slot].original, 1); cb_write(ret, 0xCC); } rets[slot].refs++; }
        }
      }
      step_kind = 0; step_index = i; cb_write(where, c->original);
      break;
    }
  }
  ctx.Eip = (DWORD)where;
  if (step_kind >= 0) { ctx.EFlags |= 0x100; pending_kind = step_kind; pending_index = step_index; }
  SetThreadContext(th, &ctx);
  (void)tid;
  return 1;
}
static int watch_hit(HANDLE th, uintptr_t where, int unfrozen) {
  if (!watch_off || !watch_pawn || !th || !cout) return 0;
  CONTEXT dc; memset(&dc, 0, sizeof(dc)); dc.ContextFlags = CONTEXT_DEBUG_REGISTERS | CONTEXT_CONTROL;
  if (!GetThreadContext(th, &dc) || !(dc.Dr6 & 1)) return 0;
  unsigned now = read_u32(watch_pawn + watch_off), stack[12]; memset(stack, 0, sizeof(stack)); read_mem(dc.Esp, stack, sizeof(stack));
  float f; memcpy(&f, &now, 4);
  fprintf(cout, "{\"u\":%d,\"seq\":%lu,\"ev\":\"write\",\"eip\":\"0x%lx\",\"new\":\"0x%x\",\"float\":%.9g,\"stack\":", unfrozen, ++call_seq, (unsigned long)where, now, (f == f && f > -1e30f && f < 1e30f) ? f : 0.0f);
  print_words(cout, stack, 12); fprintf(cout, "}\n"); fflush(cout);
  dc.Dr6 = 0; dc.ContextFlags = CONTEXT_DEBUG_REGISTERS; SetThreadContext(th, &dc);
  return 1;
}
static int finish_call_step(void) {
  if (pending_kind < 0) return 0;
  if (calls_armed) {
    if (pending_kind == 0) cb_write(calls[pending_index].address, 0xCC);
    else if (rets[pending_index].refs > 0) cb_write(rets[pending_index].address, 0xCC);
  }
  pending_kind = -1;
  return 1;
}

/* Remove the breakpoints, then take every debug event still queued: an int3 the
 * thread raised before the byte was restored is rewound to the instruction (the
 * default would deliver it to the game as an unhandled breakpoint), and the
 * other events continue as the game's own. Runs until the queue stays empty. */
static void drain_and_disarm(int *disarmed) {
  if (*disarmed) return;
  bp_disarm(&bp[0]); bp_disarm(&bp[1]); if (bp[2].address) bp_disarm(&bp[2]); *disarmed = 1;
  calls_set(0);
  DEBUG_EVENT ev; int quiet = 0;
  while (quiet < 3) {
    if (!WaitForDebugEvent(&ev, 40)) { quiet++; continue; }
    quiet = 0;
    DWORD status = DBG_CONTINUE;
    if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode;
      uintptr_t where = (uintptr_t)ev.u.Exception.ExceptionRecord.ExceptionAddress;
      HANDLE th = thread_of(ev.dwThreadId);
      if (code == EXCEPTION_BREAKPOINT && (where == bp[0].address || where == bp[1].address || (bp[2].address && where == bp[2].address)) && th) {
        CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL; GetThreadContext(th, &ctx); ctx.Eip = (DWORD)where; SetThreadContext(th, &ctx);
      } else if (code != EXCEPTION_BREAKPOINT && code != EXCEPTION_SINGLE_STEP) status = DBG_EXCEPTION_NOT_HANDLED;
    } else if (ev.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT && ev.u.CreateProcessInfo.hFile) CloseHandle(ev.u.CreateProcessInfo.hFile);
    else if (ev.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT && ev.u.LoadDll.hFile) CloseHandle(ev.u.LoadDll.hFile);
    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status);
  }
}

static int do_trace(const char *config) {
  if (!read_config(config)) return 1;
  QueryPerformanceFrequency(&qpf);
  pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  process = OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid);
  core_base = module_base("Core.dll"); engine_base = module_base("Engine.dll");
  if (!process || !core_base || !engine_base) { fprintf(stderr, "cannot read DeusEx.exe\n"); return 1; }
  if (engine_base != 0x10300000u) { fprintf(stderr, "Engine.dll is at 0x%lx, not its preferred base\n", (unsigned long)engine_base); return 1; }
  strobe_ok = module_base("Render.dll") == 0x10b00000u;
  names_table = read_u32(core_base + OFF_NAMES_DATA);
  if (!resolve_actors()) return 1;
  fprintf(stderr, "level 0x%lx info 0x%lx player 0x%lx, %d watched\n", (unsigned long)level_ptr, (unsigned long)level_info, (unsigned long)player_ptr, watched_count);
  FILE *out = fopen(out_path, "w");
  if (!out) { fprintf(stderr, "cannot write %s\n", out_path); return 1; }
  char resume_path[640]; snprintf(resume_path, sizeof(resume_path), "%s.resume", out_path);
  remove(resume_path);
  char crash_path[640]; snprintf(crash_path, sizeof(crash_path), "%s.crash.txt", out_path);
  remove(crash_path);
  int disarmed = 0, monitoring = 0; ULONGLONG monitor_until = 0;

  if (!DebugActiveProcess(pid)) { fprintf(stderr, "DebugActiveProcess failed (%lu)\n", GetLastError()); return 1; }
  DebugSetProcessKillOnExit(FALSE);
  bp_arm(&bp[0], TICK_ENTRY); bp_arm(&bp[1], TICK_RET);
  if (call_count && call_last >= call_first && call_last > 0) { char cp[640]; snprintf(cp, sizeof(cp), "%s.calls.jsonl", out_path); cout = fopen(cp, "w"); }
  FILE *aout = NULL; char actors_path[640];
  if (actor_trace_last >= actor_trace_first && actor_trace_last > 0) { snprintf(actors_path, sizeof(actors_path), "%s.actors.jsonl", out_path); aout = fopen(actors_path, "w"); bp_arm(&bp[2], ACTOR_TICK); }

  DEBUG_EVENT ev;
  int tick = 0, unfrozen = 0, released = 0, paused = 0, done = 0; long long release_us = 0;
  int pending_rearm = -1; DWORD pending_tid = 0;
  unsigned rng_in = 0;
  double clock_in = 0; float ts_in = 0, delta_in = 0; int tick_type = 0, players_only_in = 0; unsigned strobe_flag_in = 0; float strobe_time_in = 0;
  long long t_in = 0;
  unsigned char block[0x1000];
  int detaching = 0, resume_requested = 0;
  while (!detaching) {
    if (!WaitForDebugEvent(&ev, 200)) {
      if (monitoring && GetTickCount64() >= monitor_until) detaching = 1;
      else if (paused && !monitoring) { FILE *r = fopen(resume_path, "r"); if (r) { fclose(r); resume_requested = 1; } }
      if (resume_requested && !monitoring) goto leave_pause;
      continue;
    }
    DWORD status = DBG_CONTINUE;
    switch (ev.dwDebugEventCode) {
    case EXCEPTION_DEBUG_EVENT: {
      DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode;
      uintptr_t where = (uintptr_t)ev.u.Exception.ExceptionRecord.ExceptionAddress;
      HANDLE th = thread_of(ev.dwThreadId);
      if (code == EXCEPTION_SINGLE_STEP && watch_off && watch_hit(th, where, unfrozen)) {
        /* a hardware write watch on the call-pawn's field */
      } else if (code == EXCEPTION_BREAKPOINT && th && cout && handle_call_event(th, ev.dwThreadId, where, unfrozen)) {
        /* a traced call's entry or return */
      } else if (code == EXCEPTION_SINGLE_STEP && pending_kind >= 0 && finish_call_step()) {
        /* the instruction under a call breakpoint ran: re-armed */
      } else if (code == EXCEPTION_BREAKPOINT && (where == bp[0].address || where == bp[1].address || (aout && where == bp[2].address)) && th) {
        int is_entry = where == bp[0].address, is_actor = aout && where == bp[2].address;
        CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER;
        GetThreadContext(th, &ctx);
        int mine = is_entry ? ((uintptr_t)ctx.Ecx == level_ptr) : in_our_tick;
        if (is_entry && mine) game_thread = th;
        if (is_actor && in_our_tick && released && unfrozen >= actor_trace_first && unfrozen <= actor_trace_last) {
          fprintf(aout, "{\"u\":%d,\"actor\":\"%s\",\"rng\":\"0x%08x\"}\n", unfrozen, object_name((uintptr_t)ctx.Ecx), rng_ptd ? read_u32(rng_ptd + 0x14) : 0);
        }
        int skip_function = 0;
        if (is_actor) mine = 0;
        if (is_entry && mine) {
          unsigned stack[3]; read_mem(ctx.Esp, stack, 12);   /* return, tickType, delta */
          memcpy(&delta_in, &stack[2], 4); tick_type = (int)stack[1];
          if (forced_delta > 0) { delta_in = forced_delta; write_mem(ctx.Esp + 8, &delta_in, 4); }
          tick++;
          if (!rng_ptd) {
            Ptd ptds[8]; int n = find_ptds_of(ev.dwThreadId, ptds, 8);
            unsigned best = 0; for (int i = 0; i < n; i++) { unsigned s = read_u32(ptds[i].ptd + 0x14); if (s != 1 && !rng_ptd) { rng_ptd = ptds[i].ptd; best = s; } }
            if (!rng_ptd && n) rng_ptd = ptds[n - 1].ptd;
            fprintf(stderr, "rand state block 0x%lx (state 0x%x of %d candidates)\n", (unsigned long)rng_ptd, best, n);
          }
          if (release_at > 0 && tick == release_at && !released) {
            unsigned char b; read_mem(level_info + 0x4f0, &b, 1); b &= ~4; write_mem(level_info + 0x4f0, &b, 1); released = 1; release_us = qpc_us();
          }
          if (released && !paused && (unfrozen >= run_ticks || (max_seconds && qpc_us() - release_us > (long long)max_seconds * 1000000))) paused = 1;
          /* pause-at: after that many unfrozen ticks the level's Tick is skipped (as for the final pause) until <out>.go appears, so a
             console command typed meanwhile runs between two ticks; the next entry after the go file runs the tick */
          int soft_skip = 0;
          if (released && !paused && soft_idx < soft_count && unfrozen >= soft_at[soft_idx]) {
            char gp[660]; snprintf(gp, sizeof(gp), "%s.go", out_path);
            FILE *gf = fopen(gp, "r");
            if (soft_state == 1 && gf) { fclose(gf); gf = NULL; remove(gp); soft_state = 0; soft_idx++; }
            else {
              if (gf) fclose(gf);
              if (soft_state == 0) { soft_state = 1; fprintf(stderr, "held after %d unfrozen ticks (tick %d); create %s to go on\n", unfrozen, tick, gp); }
              soft_skip = 1;
            }
          }
          if (soft_skip) skip_function = 1;
          else if (paused) { skip_function = 1; { char sp[660]; snprintf(sp, sizeof(sp), "%s.strobe", out_path); FILE *sf = fopen(sp, "w"); if (sf) { fprintf(sf, "%u %.9g\n", strobe_flag(), strobe_time()); fclose(sf); } } if (paused == 1) { paused = 2; fprintf(stderr, "paused after %d unfrozen ticks (tick %d); remove %s to resume\n", unfrozen, tick, resume_path); } }
          else {
            unsigned char b; read_mem(level_info + 0x4f0, &b, 1); players_only_in = (b & 4) ? 1 : 0;
            clock_in = read_double(level_ptr + 0xdc); ts_in = read_float(level_info + 0x478);
            strobe_flag_in = strobe_flag(); strobe_time_in = strobe_time();
            rng_in = rng_ptd ? read_u32(rng_ptd + 0x14) : 0; t_in = qpc_us();
            in_our_tick = 1;
            if (released) unfrozen++;
            if (cout && released && unfrozen >= call_first && unfrozen <= call_last) calls_set(1);
            else if (cout && call_frames && calls_armed) calls_set(0);   /* call-frames: the render after tick call_last stays armed until the next tick's entry */
            if (aout && released && unfrozen >= actor_trace_first && unfrozen <= actor_trace_last) fprintf(aout, "{\"u\":%d,\"actor\":\"@entry\",\"rng\":\"0x%08x\"}\n", unfrozen, rng_in);
          }
        }
        if (!is_entry && !is_actor && mine) {
          in_our_tick = 0;
          if (cout && calls_armed && !call_frames) calls_set(0);
          if (aout && unfrozen >= actor_trace_first && unfrozen <= actor_trace_last) { fprintf(aout, "{\"u\":%d,\"actor\":\"@exit\",\"rng\":\"0x%08x\"}\n", unfrozen, rng_ptd ? read_u32(rng_ptd + 0x14) : 0); fflush(aout); }
          unsigned vp_x = 0, vp_y = 0;   /* the player's UViewport: SizeX +0x78, SizeY +0x7c (Player at +0x5d4) */
          { uintptr_t vp = player_ptr ? read_u32(player_ptr + 0x5d4) : 0; if (vp) { vp_x = read_u32(vp + 0x78); vp_y = read_u32(vp + 0x7c); } }
          int record = pre_watch < 0 || released || tick > release_at - pre_watch;
          if (record) {
            fprintf(out, "{\"n\":%d,\"unfrozen\":%d,\"viewport\":[%u,%u],\"tickType\":%d,\"delta\":%.9g,\"playersOnly\":%d,\"clockIn\":%.17g,\"tsIn\":%.9g,\"rngIn\":\"0x%08x\","
              "\"clockOut\":%.17g,\"tsOut\":%.9g,\"rngOut\":\"0x%08x\",\"inTick\":%u,\"usIn\":%lld,\"usOut\":%lld,\"strobeIn\":[%u,%.9g],\"strobeOut\":[%u,%.9g],\"actors\":{",
              tick, released ? unfrozen : 0, vp_x, vp_y, tick_type, delta_in, players_only_in, clock_in, ts_in, rng_in,
              read_double(level_ptr + 0xdc), read_float(level_info + 0x478), rng_ptd ? read_u32(rng_ptd + 0x14) : 0, read_u32(level_ptr + 0x108), t_in, qpc_us(),
              strobe_flag_in, strobe_time_in, strobe_flag(), strobe_time());
            for (int i = 0; i < watched_count; i++) {
              size_t got = 0;
              read_block(watched[i].address, block, sizeof(block), &got);
              fprintf(out, "%s\"%s\":{", i ? "," : "", watched[i].name);
              print_fields(out, block, got, watched[i].address, &groups[watched[i].group]);
              fprintf(out, "}");
            }
            fprintf(out, "}}\n"); fflush(out);
          }
        }
        if (skip_function) {
          /* return from ULevel::Tick without running it: pop the return address and its two arguments */
          unsigned ret = read_u32(ctx.Esp);
          ctx.Eip = ret; ctx.Esp += 12;
          SetThreadContext(th, &ctx);
        } else {
          /* run the original instruction under a single step, then re-arm */
          ctx.Eip = (DWORD)where; ctx.EFlags |= 0x100; SetThreadContext(th, &ctx);
          Breakpoint *b = is_entry ? &bp[0] : is_actor ? &bp[2] : &bp[1];
          write_mem(b->address, &b->original, 1); FlushInstructionCache(process, (LPCVOID)b->address, 1);
          pending_rearm = is_entry ? 0 : is_actor ? 2 : 1; pending_tid = ev.dwThreadId;
        }
      } else if (code == EXCEPTION_SINGLE_STEP && pending_rearm >= 0 && ev.dwThreadId == pending_tid) {
        unsigned char cc = 0xCC; write_mem(bp[pending_rearm].address, &cc, 1); FlushInstructionCache(process, (LPCVOID)bp[pending_rearm].address, 1);
        pending_rearm = -1;
      } else if (code == EXCEPTION_BREAKPOINT && (where == bp[0].address || where == bp[1].address || (bp[2].address && where == bp[2].address)) && th) {
        /* our int3 raised after the byte was restored (breakpoints removed): run the original instruction */
        CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL;
        GetThreadContext(th, &ctx); ctx.Eip = (DWORD)where; SetThreadContext(th, &ctx);
      } else if (code == EXCEPTION_BREAKPOINT) {
        /* the initial attach breakpoint */
      } else if (code == EXCEPTION_SINGLE_STEP) {
        /* a trap flag left by one of our single steps */
      } else if (is_fatal_exception(code) && ev.u.Exception.dwFirstChance) {
        report_crash(&ev, crash_path, tick);
        if (kill_on_crash) { TerminateProcess(process, 1); detaching = 1; done = 1; }
        status = DBG_EXCEPTION_NOT_HANDLED;
      } else {
        status = DBG_EXCEPTION_NOT_HANDLED;
      }
      break;
    }
    case CREATE_PROCESS_DEBUG_EVENT: if (ev.u.CreateProcessInfo.hFile) CloseHandle(ev.u.CreateProcessInfo.hFile); break;
    case LOAD_DLL_DEBUG_EVENT: if (ev.u.LoadDll.hFile) CloseHandle(ev.u.LoadDll.hFile); break;
    case EXIT_PROCESS_DEBUG_EVENT: detaching = 1; done = 1; break;
    default: break;
    }
    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status);
    if (monitoring && GetTickCount64() >= monitor_until) detaching = 1;
    if (paused == 2 && !monitoring) { FILE *r = fopen(resume_path, "r"); if (r) { fclose(r); resume_requested = 1; } }
    if (resume_requested && !monitoring) {
    leave_pause:
      resume_requested = 0;
      /* remove the breakpoints and drain what is pending before the game runs on */
      drain_and_disarm(&disarmed);
      paused = 0;
      if (monitor_seconds > 0) { monitoring = 1; monitor_until = GetTickCount64() + (ULONGLONG)monitor_seconds * 1000; fprintf(stderr, "monitoring for %d s\n", monitor_seconds); }
      else detaching = 1;
    }
  }
  if (!done) {
    if (!disarmed) drain_and_disarm(&disarmed);
    DebugActiveProcessStop(pid);
  }
  if (aout) fclose(aout);
  if (cout) fclose(cout);
  fclose(out);
  fprintf(stderr, "stopped after %d ticks\n", tick);
  return 0;
}


/* list <Class>: the live level's actors whose class derives from <Class>. */
static int is_a(uintptr_t cls, const char *wanted) {
  for (int depth = 0; cls && depth < 64; depth++) {
    if (!strcmp(object_name(cls), wanted)) return 1;
    cls = read_u32(cls + 0x28);   /* UField.SuperField */
  }
  return 0;
}
static int do_list(const char *wanted) {
  pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  core_base = module_base("Core.dll");
  names_table = read_u32(core_base + OFF_NAMES_DATA);
  group_count = 0;
  if (!resolve_actors()) return 1;
  uintptr_t gog = read_u32(core_base + OFF_GOG_DATA);
  unsigned count = read_u32(core_base + OFF_GOG_COUNT);
  for (unsigned slot = 0; slot < count; slot++) {
    uintptr_t obj = read_u32(gog + slot * 4);
    if (!obj || read_u32(obj + 0xac) != level_ptr) continue;
    uintptr_t cls = read_u32(obj + OFF_OBJECT_CLASS);
    if (!cls || !is_a(cls, wanted)) continue;
    float loc[3]; read_mem(obj + 0x114, loc, 12);
    unsigned sf = read_u32(obj + 0xc); unsigned node = sf ? read_u32(sf + 0x18) : 0;
    float odds = 1; read_mem(obj + 0x160, &odds, 4);   /* Actor.OddsOfAppearing: below 1, a load may have removed the actor */
    printf("%s %s slot=%u loc=(%.1f,%.1f,%.1f) state=%s odds=%g\n", object_name(cls), object_name(obj), slot, loc[0], loc[1], loc[2], node ? object_name(node) : "None", odds);
  }
  return 0;
}


/* stamps <seconds> <name,name,...>: breaks at the instruction that stores Actor.LastRenderTime in Render.dll
 * (0x10b25161, `mov [eax+0x34], ecx`; EAX = the actor, the caller's FSceneNode* at [ebp+8]) for <seconds>, and
 * prints one line per stamp of a listed actor: its name, the frame's Recursion (+0x1c), iSurf (+0x14), Mirror
 * (+0x20) and parent. Which frame (the main frame, recursion 0, or a mirror's child) stamps an actor. */
#define STAMP_SITE 0x10b25161u
static int do_stamps(int seconds, const char *names) {
  QueryPerformanceFrequency(&qpf);
  pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  process = OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid);
  core_base = module_base("Core.dll");
  uintptr_t render = module_base("Render.dll");
  if (!process || !core_base || render != 0x10b00000u) { fprintf(stderr, "cannot read DeusEx.exe or Render.dll is at 0x%lx\n", (unsigned long)render); return 1; }
  names_table = read_u32(core_base + OFF_NAMES_DATA);
  char list[2048]; strncpy(list, names, sizeof(list) - 1); list[sizeof(list) - 1] = 0;
  if (!DebugActiveProcess(pid)) { fprintf(stderr, "DebugActiveProcess failed (%lu)\n", GetLastError()); return 1; }
  DebugSetProcessKillOnExit(FALSE);
  Breakpoint b; bp_arm(&b, STAMP_SITE);
  DWORD pending_tid = 0; int pending = 0;
  ULONGLONG until = GetTickCount64() + (ULONGLONG)seconds * 1000;
  long hits = 0;
  DEBUG_EVENT ev;
  while (GetTickCount64() < until) {
    if (!WaitForDebugEvent(&ev, 100)) continue;
    DWORD status = DBG_CONTINUE;
    if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode;
      uintptr_t where = (uintptr_t)ev.u.Exception.ExceptionRecord.ExceptionAddress;
      HANDLE th = thread_of(ev.dwThreadId);
      if (code == EXCEPTION_BREAKPOINT && where == STAMP_SITE && th) {
        CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER; GetThreadContext(th, &ctx);
        hits++;
        const char *name = object_name((uintptr_t)ctx.Eax);
        int wanted = 0; char copy[2048]; strcpy(copy, list);
        for (char *n = strtok(copy, ","); n; n = strtok(NULL, ",")) if (!strcmp(n, name)) wanted = 1;
        if (wanted) {
          unsigned frame = read_u32(ctx.Ebp + 8), rec = frame ? read_u32(frame + 0x1c) : 0, surf = frame ? read_u32(frame + 0x14) : 0, parent = frame ? read_u32(frame + 8) : 0;
          float mirror = 0; if (frame) read_mem(frame + 0x20, &mirror, 4);
          printf("%lld %s frame=0x%x recursion=%u iSurf=%d mirror=%g parent=0x%x\n", qpc_us(), name, frame, rec, (int)surf, mirror, parent);
        }
        ctx.Eip = (DWORD)where; ctx.EFlags |= 0x100; SetThreadContext(th, &ctx);
        write_mem(b.address, &b.original, 1); FlushInstructionCache(process, (LPCVOID)b.address, 1);
        pending = 1; pending_tid = ev.dwThreadId;
      } else if (code == EXCEPTION_SINGLE_STEP && pending && ev.dwThreadId == pending_tid) {
        unsigned char cc = 0xCC; write_mem(b.address, &cc, 1); FlushInstructionCache(process, (LPCVOID)b.address, 1); pending = 0;
      } else if (code == EXCEPTION_BREAKPOINT || code == EXCEPTION_SINGLE_STEP) {
      } else status = DBG_EXCEPTION_NOT_HANDLED;
    } else if (ev.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT && ev.u.CreateProcessInfo.hFile) CloseHandle(ev.u.CreateProcessInfo.hFile);
    else if (ev.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT && ev.u.LoadDll.hFile) CloseHandle(ev.u.LoadDll.hFile);
    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status);
  }
  bp_disarm(&b);
  /* drain anything already queued, rewinding an int3 that fired before the byte was restored */
  int quiet = 0;
  while (quiet < 3) {
    if (!WaitForDebugEvent(&ev, 40)) { quiet++; continue; }
    quiet = 0; DWORD status = DBG_CONTINUE;
    if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode; uintptr_t where = (uintptr_t)ev.u.Exception.ExceptionRecord.ExceptionAddress; HANDLE th = thread_of(ev.dwThreadId);
      if (code == EXCEPTION_BREAKPOINT && where == STAMP_SITE && th) { CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL; GetThreadContext(th, &ctx); ctx.Eip = (DWORD)where; SetThreadContext(th, &ctx); }
      else if (code != EXCEPTION_BREAKPOINT && code != EXCEPTION_SINGLE_STEP) status = DBG_EXCEPTION_NOT_HANDLED;
    }
    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status);
  }
  DebugActiveProcessStop(pid);
  fprintf(stderr, "%ld stamps seen in %d s\n", hits, seconds);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: dx-live-win.exe rng [count] [interval_ms] | trace <config>\n"); return 2; }
  if (!strcmp(argv[1], "trace")) return argc > 2 ? do_trace(argv[2]) : 2;
  if (!strcmp(argv[1], "stamps")) return argc > 3 ? do_stamps(atoi(argv[2]), argv[3]) : 2;
  if (!strcmp(argv[1], "list")) { QueryPerformanceFrequency(&qpf); return argc > 2 ? do_list(argv[2]) : 2; }
  QueryPerformanceFrequency(&qpf);
  pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_VM_OPERATION | PROCESS_SUSPEND_RESUME, FALSE, pid);
  if (!process) { fprintf(stderr, "cannot open DeusEx.exe\n"); return 1; }
  if (!strcmp(argv[1], "rng")) {
    int count = argc > 2 ? atoi(argv[2]) : 1, interval = argc > 3 ? atoi(argv[3]) : 100;
    Ptd ptds[16]; int n = find_ptds_of(0, ptds, 16);
    if (!n) { fprintf(stderr, "no CRT thread data found\n"); return 1; }
    for (int k = 0; k < count; k++) {
      for (int i = 0; i < n; i++)
        printf("%lld tid=%lu slot=%d ptd=0x%lx state=0x%08x\n", qpc_us(), ptds[i].tid, ptds[i].slot, (unsigned long)ptds[i].ptd, read_u32(ptds[i].ptd + 0x14));
      fflush(stdout);
      if (k + 1 < count) Sleep(interval);
    }
  }
  CloseHandle(process);
  return 0;
}
