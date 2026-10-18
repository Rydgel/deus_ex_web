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
 *   wine dx-live-win.exe strobe poll [count] [interval_ms] [levelinfo]
 *       Render.dll's Strobe state (flag 0x10b49ea8, the TimeSeconds it last saw 0x10b49ea4), `count` samples `interval_ms` apart:
 *       <qpc_us> flag=<0|1> time=<float>; with the address of a LevelInfo (hex, the live player's +0xa8) also its TimeSeconds (+0x478),
 *       ` level=<float>`: a read of the level's clock that does not walk the object array
 *   wine dx-live-win.exe strobe hold <flag>
 *       stops the Strobe function (0x10b05b30) from flipping the flag (its `jne` at 0x10b05b4b becomes a `jmp`) and writes the flag:
 *       a held state to capture frames in; `strobe release` restores the instruction (the flag keeps its value)
 *
 *   wine dx-live-win.exe galaxy poll <count> <interval_ms> <out prefix>
 *       Galaxy.dll's output state, read only (no debugger; docs/audio-output-scope.md §5.1), the addresses rebased to Galaxy.dll's
 *       load base. Once, to <prefix>.json: WAVEFORMATEX 0x1067b6d8, the output path 0x10698178 (1 DirectSound, 2 WinMM), the
 *       format bits 0x10698179, the 3D type 0x1069817a, the open flag 0x10698394, the kernel mode 0x10697cfc, the CPU flags
 *       (MMX 0x1068dc80, SSE 0x10698340, 3DNow 0x10698190), the output rate 0x10697d18, the latency 0x1064a65c, the effect slots
 *       0x1068828d, the secondary buffer 0x10697cc8 and staging ring 0x10697ccc pointers, the live UGalaxyAudioSubsystem's
 *       config words (+0x2c..+0x7c, +0x74 the 3D voices), the live player's XLevel and Level (one map load from the next) and,
 *       per thread of the game, eight sampled EIPs (with their modules)
 *       and its x87 control word and MXCSR (GetThreadContext, CONTEXT_EXTENDED_REGISTERS: the FXSAVE area). The 64 KB pan
 *       table [0x10698390] to <prefix>.pan.bin. Then `count` samples `interval_ms` apart to <prefix>.poll.txt:
 *       <qpc_us> <size> <A> <B> <ahead> <frames mixed 0x10698194> <cnt1 0x10698204> <cnt2 0x1069834c>
 *       (size, A, B and ahead are one 16-byte read)
 *
 *   wine dx-live-win.exe galaxy capture <out file> <seconds> <map> [stop file]
 *       Galaxy.dll from the game's launch (docs/audio-output-scope.md §5.2, Stage 4 row 4.3.7 check 3): starts DeusEx.exe <map>
 *       INI=DeusEx-ad.ini USERINI=User-ad.ini under the debugger, arms breakpoints when Galaxy.dll loads (it must be at its preferred
 *       base) and records, in event order, every library call the subsystem makes (glxInit's EffectsChannels, the output open,
 *       the volume setters, glxLoadMusic with its input bytes and status, each sample's glxSample record and data at its first
 *       glxStartSample, glxStart/Stop/ControlMusic,
 *       glxUnloadMusic, glxStart/Control/StopSample, glxControlVoice with its result, glxSetSampleReverb's block, glxUnloadSample,
 *       Update's inline voice clears and break flag, Update's critical section), every game-thread breakpoint inside the library
 *       lock (after the call's own EnterCriticalSection, or inside Update's), so their order against the timer thread's is the
 *       critical section's and no game-thread trap can meet a timer-thread one (CrossOver garbles two concurrent int3 traps:
 *       the second is reported from its exception dispatcher and the thread resumes past the int3); each timer callback's cursor
 *       pair, Lock results, R, heads, `ahead` and a 32-bit FNV-1a of each copied staging segment (the whole staging ring at a
 *       resync; the first 24 callbacks' segments in full); and the stream decoder thread's messages and each MPEG decoder call's
 *       arguments, results and output bytes. Until <seconds> pass or the stop file appears; then it disarms, detaches and exits
 *       (the game goes on). Records: u32 type, u32 payload length, u32 thread id, payload (see the GX_ constants).
 *
 *   wine dx-live-win.exe fire hold|release|read <texture name>
 *       Fire.dll (relocated or not): `hold` makes UFireTexture::ConstantTimeTick (0x10507ff0 at the preferred base) return at once (its
 *       `push ebp` becomes `ret`), so every FireTexture keeps its pixels while the game draws on, a held texture to capture frames in
 *       (as `strobe hold`); `release` restores the byte. `read` prints a FireTexture's state (docs/fire-texture.md "Layout"): the
 *       header fields, mip 0's P8 pixels (Mips +0xa4; FMipmap.DataArray's data at +0x1c) as hex, and whether the tick is held
 *
 *   wine dx-live-win.exe list <Class>
 *       the live level's actors whose class derives from <Class>: class, name, global slot, Location, state, OddsOfAppearing
 *
 *   wine dx-live-win.exe stamps <seconds> <name,name,...>
 *       which frame stamps an actor's LastRenderTime (Render.dll 0x10b25161): per stamp of a listed actor its name and the
 *       frame's Recursion, iSurf, Mirror and parent (the main frame has recursion 0, a mirror's child 1 or more)
 *
 *   wine dx-live-win.exe rngpin <seconds> <hex state>
 *       every URender::SetupDynamics run (Render.dll 0x10b22d90) starts from that CRT rand state for <seconds>: a frame whose render
 *       iterators draw from the shared stream (a laser's last item) is the same frame whenever it is taken
 *
 *   wine dx-live-win.exe weapon <seconds>
 *       Render.dll's third-person weapon draw (docs/weapon-attachment.md): breakpoints at the Pawn.Weapon read in DrawActorSprite
 *       (0x10b256a3), the special-triangle test in DrawLodMesh (0x10b0f212: the three special vertices, camera space), the store of
 *       the hand coordinates (0x10b0f44d: the 12 floats) and the two DrawMesh calls that draw the weapon (0x10b257da) and its
 *       muzzle flash (0x10b259c3: the FCoords built from the hand coordinates and the weapon's fields). One JSON line per hit
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
 *         rng-file <path>         one hex CRT rand state per line; line k is written at the entry of unfrozen tick k, so the original draws the
 *                                 stream another capture's trace recorded (its rngIn): the same pawn decisions, to trace them with `call`
 *         monitor <seconds>       after the resume, stay attached (breakpoints removed) that long, reporting fatal exceptions
 *         kill-on-crash <0|1>     terminate the game at its first fatal first-chance exception, after reporting it (default 1:
 *                                 no crash dialog is left on the desktop)
 *         call <addr> <label> <nwords> [gate] [always] [name0] [namee] [deref <argidx> <ndwords> <byteoffset>]... (up to three)
 *                 [abs <addr> <n>] [absptr <addr> <n> <off>] (up to four, read at the return) [ecxobj <off>] (the object named at ECX+off)
 *                                 (<addr> may be Module.dll@0xADDR: a preferred-base address rebased to where the module is loaded)
 *                                 a breakpoint at a function's entry (call-ticks only): its label, ECX, the first
 *                                 `nwords` stack dwords and, at its return (a one-shot breakpoint at the return
 *                                 address), EAX, those dwords again and `ndwords` at the pointer passed as argument
 *                                 `argidx`, to <out>.calls.jsonl. A `gate` function arms the others while it runs for
 *                                 the pawn `call-pawn` names (ECX); the rest log only inside a gate unless `always`.
 *                                 `name0` / `namee` also name the actor in argument 0 / ECX; `retname` names ECX, its class (+0x24) and
 *                                 index (+0x04) at the RETURN (an AddObject or UnhashObject record: the object the registry slot is for).
 *         watch-write <offset>    a hardware write watch (DR0) on that offset of the call-pawn, armed for the traced ticks; each
 *                                 write is a "write" record with the new value, the EIP after the writing instruction and 12 stack dwords
 *                                 `fname <i>` (up to two) logs the text of args[i], an FName, as "fnames"; every record carries `inTick` (inside a
 *                                 ULevel::Tick of the level: 0 for a console command or key edge typed while the level is held) and `rng` (the CRT
 *                                 rand state at the breakpoint)
 *         call-ticks <first> <last>   the unfrozen ticks whose calls are traced
 *         call-pawn <name>        the actor whose gate calls arm the tracing (any when omitted)
 *         call-frames             keep the calls armed between ticks (the renders after each traced tick), until the entry of the tick after
 *                                 call-ticks' last; `namearg <i> <off>` on a call logs the object name at *(args[i]+off) (off -1: args[i]
 *                                 itself) as argName, at the call and at its return (re-read: the Hit a MoveActor wrote); `ecxwords <n> <off>` logs n dwords at ECX+off at the return
 *         watch <A,B,..> <Field:off:type[:mask]>...   fields of those actors
 *         late-watch <A,B,..> <Field:...>...   the same, for actors the level may not hold yet (a carcass spawned mid-scene): a name
 *                                 not found when the tracer attaches is bound at the first tick exit after an object of that name, spawned
 *                                 into the traced level, appears (offered at a `retname` call's return at UObject::AddObject, and by the
 *                                 GObjObjects slots that changed since the last tick); the actor's rows start at that tick
 *       Types: f f3 i3 u8 u16 u32 bit(mask) name obj state, chain[:max] (a linked list through the field's offset, Actor.Inventory
 *       +0xc0 the owner's first item and each item's next: the names in order, at most max, default 32).
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
  int late;   /* `late-watch`: a name not on the level when the tracer attaches is bound when an object of that name appears (a carcass spawned mid-scene) */
} WatchGroup;
typedef struct { char name[96]; uintptr_t address; int group; } Watched;
/* A late-watch name not bound yet: `candidate` is an object of that name the registry gained (an AddObject return, or a slot of GObjObjects
   that changed since the last tick), bound at the next tick exit once its XLevel is the traced level (SpawnActor sets it after AddObject). */
typedef struct { char name[96]; int group; uintptr_t candidate; int bound; } LateName;
static LateName late_names[64]; static int late_count;

static char out_path[512] = "trace.jsonl", player_name[96] = "JCDentonMale";
static int release_at = 1, run_ticks = 100, pre_watch = -1, max_seconds = 0;
static int soft_at[64], soft_count, soft_idx, soft_state;   /* pause-at: unfrozen tick counts at which the level is held for console input */
static float forced_delta = 0;
static unsigned *rng_force = NULL; static int rng_force_count = 0;   /* rng-file: the CRT rand state to write at each unfrozen tick's entry */
static int monitor_seconds = 0, kill_on_crash = 1, actor_trace_first = 0, actor_trace_last = -1;
static WatchGroup groups[16]; static int group_count;
static Watched watched[1024]; static int watched_count;

/* ---------------- call tracing (config `call`) ---------------- */
static int in_our_tick = 0; static uintptr_t rng_ptd = 0;   /* inside a ULevel::Tick of the traced level; the msvcrt thread-data block of the rand state (+0x14) */
#define MAXCALLS 32
#define MAXRET 64
typedef struct { uintptr_t address; unsigned char original; char module[40]; char label[24]; int nwords, deref_count, deref_arg[3], deref_n[3], deref_off[3], gate, always, name0, namee, retname, namearg, namearg_off, ecx_n, ecx_off, span_on, span_arg, span_off, fret, fname_count, fname_arg[2], abs_count, abs_ptr[4], abs_n[4], abs_off[4], ecxobj, ecxobj_off; unsigned abs_addr[4]; char only[48]; } CallBp;
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
    else if (!strcmp(tok, "rng-file")) {   /* one hex rand state per line: line k is written at the entry of unfrozen tick k (another capture's rngIn: its draws, replayed) */
      char *v = strtok(NULL, "\r\n"); while (v && *v == ' ') v++;
      FILE *rf = v ? fopen(v, "r") : NULL; char rl[64];
      if (!rf) fprintf(stderr, "rng-file: cannot open %s\n", v ? v : "(none)");
      else { rng_force = (unsigned *)malloc(sizeof(unsigned) * 100000); while (rng_force_count < 100000 && fgets(rl, sizeof(rl), rf)) rng_force[rng_force_count++] = (unsigned)strtoul(rl, NULL, 16); fclose(rf); fprintf(stderr, "rng-file: %d states\n", rng_force_count); }
    }
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
      /* `Module.dll@0xADDR`: an address at the module's preferred base, rebased after attaching (Wine rebases a DLL whose preferred
         base another one took first, Extension.dll's 0x10000000 among them). */
      char *at = strchr(a, '@'); if (at) { *at = 0; strncpy(c->module, a, sizeof(c->module) - 1); a = at + 1; }
      c->address = strtoul(a, NULL, 0); strncpy(c->label, l, sizeof(c->label) - 1); c->nwords = atoi(n); if (c->nwords > 16) c->nwords = 16;
      for (char *o; (o = strtok(NULL, " \t\r\n"));) {
        if (!strcmp(o, "gate")) c->gate = 1; else if (!strcmp(o, "always")) c->always = 1;
        else if (!strcmp(o, "name0")) c->name0 = 1; else if (!strcmp(o, "namee")) c->namee = 1; else if (!strcmp(o, "retname")) c->retname = 1;
        else if (!strcmp(o, "namearg")) { c->namearg = atoi(strtok(NULL, " \t\r\n")) + 1; c->namearg_off = (int)strtol(strtok(NULL, " \t\r\n"), NULL, 0); }
        else if (!strcmp(o, "only")) { char *v = strtok(NULL, " \t\r\n"); if (v) strncpy(c->only, v, sizeof(c->only) - 1); }
        else if (!strcmp(o, "span")) { c->span_on = 1; c->span_arg = atoi(strtok(NULL, " \t\r\n")); c->span_off = (int)strtol(strtok(NULL, " \t\r\n"), NULL, 0); }
        else if (!strcmp(o, "fret")) c->fret = 1;
        else if (!strcmp(o, "fname") && c->fname_count < 2) c->fname_arg[c->fname_count++] = atoi(strtok(NULL, " \t\r\n"));
        else if (!strcmp(o, "ecxwords")) { c->ecx_n = atoi(strtok(NULL, " \t\r\n")); c->ecx_off = (int)strtol(strtok(NULL, " \t\r\n"), NULL, 0); if (c->ecx_n > 64) c->ecx_n = 64; }
        /* `abs <addr> <n>`: n dwords at an absolute address (a global: Render.dll's light-map grid) at the return; `absptr <addr> <n> <off>`:
           n dwords at *(addr)+off (the object a global points at); up to four. `ecxobj <off>`: the name of the object whose pointer is
           at ECX+off (ComputeFromActor's FLightInfo holds its light actor at +0). */
        else if (!strcmp(o, "abs") && c->abs_count < 4) { c->abs_addr[c->abs_count] = (unsigned)strtoul(strtok(NULL, " \t\r\n"), NULL, 0); c->abs_n[c->abs_count] = atoi(strtok(NULL, " \t\r\n")); if (c->abs_n[c->abs_count] > 128) c->abs_n[c->abs_count] = 128; c->abs_ptr[c->abs_count] = 0; c->abs_off[c->abs_count] = 0; c->abs_count++; }
        else if (!strcmp(o, "absptr") && c->abs_count < 4) { c->abs_addr[c->abs_count] = (unsigned)strtoul(strtok(NULL, " \t\r\n"), NULL, 0); c->abs_n[c->abs_count] = atoi(strtok(NULL, " \t\r\n")); if (c->abs_n[c->abs_count] > 128) c->abs_n[c->abs_count] = 128; c->abs_off[c->abs_count] = (int)strtol(strtok(NULL, " \t\r\n"), NULL, 0); c->abs_ptr[c->abs_count] = 1; c->abs_count++; }
        else if (!strcmp(o, "ecxobj")) { c->ecxobj = 1; c->ecxobj_off = (int)strtol(strtok(NULL, " \t\r\n"), NULL, 0); }
        else if (!strcmp(o, "deref") && c->deref_count < 3) { c->deref_arg[c->deref_count] = atoi(strtok(NULL, " \t\r\n")); c->deref_n[c->deref_count] = atoi(strtok(NULL, " \t\r\n")); c->deref_off[c->deref_count] = (int)strtol(strtok(NULL, " \t\r\n"), NULL, 0); if (c->deref_n[c->deref_count] > 128) c->deref_n[c->deref_count] = 128; c->deref_count++; }
      }
      call_count++;
    }
    else if ((!strcmp(tok, "watch") || !strcmp(tok, "late-watch")) && group_count < 16) {
      WatchGroup *g = &groups[group_count++]; g->late = !strcmp(tok, "late-watch");
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
    else if (!strcmp(f->type, "chain")) {
      /* a linked list through one object field (Actor.Inventory +0xc0: an owner's first item, then each item's next): the names in order,
         at most `mask` of them (default 32), stopping at a repeat */
      uintptr_t seen[64]; int n = 0, most = f->mask > 1 && f->mask <= 64 ? (int)f->mask : 32;
      memcpy(&u, p, 4); fprintf(out, "[");
      while (u && n < most) {
        int again = 0; for (int k = 0; k < n; k++) if (seen[k] == u) again = 1;
        if (again) break;
        seen[n] = u; fprintf(out, "%s\"%s\"", n ? "," : "", object_name(u)); n++;
        u = read_u32(u + f->offset);
      }
      fprintf(out, "]");
    }
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
  /* late-watch names the level does not hold yet: bound when they appear (late_offer, late_bind) */
  for (int g = 0; g < group_count; g++) {
    if (!groups[g].late) continue;
    char list[2048]; strncpy(list, groups[g].names, sizeof(list) - 1); list[sizeof(list) - 1] = 0;
    for (char *n = strtok(list, ","); n; n = strtok(NULL, ",")) {
      int held = 0; for (int i = 0; i < watched_count; i++) if (watched[i].group == g && !strcmp(watched[i].name, n)) held = 1;
      if (!held && late_count < 64) { LateName *l = &late_names[late_count++]; memset(l, 0, sizeof(*l)); strncpy(l->name, n, sizeof(l->name) - 1); l->group = g; }
    }
  }
  return 1;
}

/* An object the registry gained (its name is set: AddObject's return, or a changed slot): a candidate for a late-watch name. */
static int late_pending(void) { for (int i = 0; i < late_count; i++) if (!late_names[i].bound) return 1; return 0; }
static void late_offer(uintptr_t obj) {
  if (!obj || !late_pending()) return;
  const char *name = object_name(obj);
  for (int i = 0; i < late_count; i++) if (!late_names[i].bound && !strcmp(late_names[i].name, name)) late_names[i].candidate = obj;
}
/* The slots of GObjObjects that changed since the last tick exit are offered too: one read of the pointer array per tick while a name is
   pending (a slot reused at the same address is missed there; an AddObject breakpoint, `call ... retname` at UObject::AddObject, offers
   every new object at its return). The first call takes the array the tracer attached to. */
static unsigned *late_slots; static unsigned late_slot_count;
static void late_scan(void) {
  if (!late_pending()) return;
  uintptr_t gog = read_u32(core_base + OFF_GOG_DATA); unsigned count = read_u32(core_base + OFF_GOG_COUNT);
  if (!gog || !count || count > (1u << 22)) return;
  unsigned *now = (unsigned *)malloc(count * 4);
  if (!now || !read_mem(gog, now, count * 4)) { free(now); return; }
  if (late_slots) for (unsigned s = 0; s < count; s++) if (now[s] && (s >= late_slot_count || now[s] != late_slots[s])) late_offer(now[s]);
  free(late_slots); late_slots = now; late_slot_count = count;
}
/* At a tick exit: a candidate on the traced level becomes a watched actor, printed from this tick on. */
static void late_bind(void) {
  for (int i = 0; i < late_count; i++) {
    LateName *l = &late_names[i];
    if (l->bound || !l->candidate) continue;
    uintptr_t xlevel = read_u32(l->candidate + 0xac);
    if (!xlevel) continue;   /* not spawned into a level yet: asked again at the next tick exit */
    if (xlevel != level_ptr || strcmp(object_name(l->candidate), l->name)) { l->candidate = 0; continue; }
    if (watched_count >= 1024) continue;
    strncpy(watched[watched_count].name, l->name, sizeof(watched[0].name) - 1);
    watched[watched_count].address = l->candidate; watched[watched_count].group = l->group; watched_count++;
    l->bound = 1;
    fprintf(stderr, "late-watch: %s bound (0x%lx)\n", l->name, (unsigned long)l->candidate);
  }
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
    if (c->namearg && c->namearg - 1 < c->nwords) { uintptr_t o = c->namearg_off < 0 ? now[c->namearg - 1] : (now[c->namearg - 1] ? read_u32(now[c->namearg - 1] + c->namearg_off) : 0); fprintf(cout, ",\"argName\":\"%s\"", object_name(o)); }   /* namearg at the return too: the Hit's Actor a MoveActor just wrote */
    if (c->retname) { char text[96]; strncpy(text, object_name(p->ecx), sizeof(text) - 1); text[sizeof(text) - 1] = 0; fprintf(cout, ",\"ecxName\":\"%s\"", text); fprintf(cout, ",\"ecxClass\":\"%s\"", object_name(read_u32(p->ecx + 0x24))); fprintf(cout, ",\"ecxIndex\":%u", read_u32(p->ecx + 0x04)); late_offer(p->ecx); }
    if (c->ecx_n) { unsigned w[64]; memset(w, 0, sizeof(w)); read_mem(p->ecx + c->ecx_off, w, 4 * c->ecx_n); fprintf(cout, ",\"ecxWords\":"); print_words(cout, w, c->ecx_n); fprintf(cout, ",\"ecxFloats\":"); print_floats(cout, w, c->ecx_n); }
    if (c->ecxobj) fprintf(cout, ",\"ecxObj\":\"%s\"", object_name(read_u32(p->ecx + c->ecxobj_off)));
    if (c->abs_count) {
      fprintf(cout, ",\"abs\":[");
      for (int d = 0; d < c->abs_count; d++) {
        unsigned w[128]; memset(w, 0, sizeof(w));
        uintptr_t at = c->abs_ptr[d] ? read_u32(c->abs_addr[d]) : c->abs_addr[d];
        if (at) read_mem(at + (c->abs_ptr[d] ? c->abs_off[d] : 0), w, 4 * c->abs_n[d]);
        fprintf(cout, "%s{\"addr\":\"0x%x\",\"ptr\":%d,\"at\":\"0x%x\",\"words\":", d ? "," : "", c->abs_addr[d], c->abs_ptr[d], (unsigned)at); print_words(cout, w, c->abs_n[d]);
        fprintf(cout, ",\"floats\":"); print_floats(cout, w, c->abs_n[d]); fprintf(cout, "}");
      }
      fprintf(cout, "]");
    }
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
  for (int i = 0; i < call_count; i++) {
    if (!calls[i].module[0]) continue;
    uintptr_t base = module_base(calls[i].module), preferred = base ? read_u32(base + read_u32(base + 0x3c) + 0x34) : 0;
    if (!base) { fprintf(stderr, "call %s: %s is not loaded\n", calls[i].label, calls[i].module); return 1; }
    calls[i].address = calls[i].address - preferred + base;
    fprintf(stderr, "call %s: %s at 0x%lx (preferred 0x%lx): 0x%lx\n", calls[i].label, calls[i].module, (unsigned long)base, (unsigned long)preferred, (unsigned long)calls[i].address);
  }
  names_table = read_u32(core_base + OFF_NAMES_DATA);
  if (!resolve_actors()) return 1;
  late_scan();
  fprintf(stderr, "level 0x%lx info 0x%lx player 0x%lx, %d watched, %d late-watch names pending\n", (unsigned long)level_ptr, (unsigned long)level_info, (unsigned long)player_ptr, watched_count, late_count);
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
            if (released && rng_ptd && rng_force && unfrozen < rng_force_count) write_mem(rng_ptd + 0x14, &rng_force[unfrozen], 4);   /* rng-file: tick unfrozen+1 starts from the file's state */
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
          if (late_count) { late_scan(); late_bind(); }
          if (record) {
            /* AIProcess (Engine 0x10384080) stops once 2 ms of rdtsc have passed since its start (K = -0.002 s at 0x1042d170
               over GSecondsPerCycle, checked after each receiver that did work, 0x1038447e..0x1038449a) and leaves firstProcess at
               the next receiver: host time, a measured input of the replay ("aiFirst": actor|event of that receiver). The
               UEventManager is ALevelInfo +0x550 (InitEventManager 0x10384a90), firstProcess +0x38; a receiver's eventType +0x28
               (its eventName +0x28), eventActor +0x2c. */
            uintptr_t ai_manager = read_u32(level_info + 0x550), ai_first = ai_manager ? read_u32(ai_manager + 0x38) : 0;
            uintptr_t ai_type = ai_first ? read_u32(ai_first + 0x28) : 0;
            char ai_who[96]; strncpy(ai_who, ai_first ? object_name(read_u32(ai_first + 0x2c)) : "None", sizeof(ai_who) - 1); ai_who[sizeof(ai_who) - 1] = 0;
            fprintf(out, "{\"aiFirst\":\"%s|%s\",", ai_who, ai_type ? name_text(read_u32(ai_type + 0x28)) : "None");
            fprintf(out, "\"n\":%d,\"unfrozen\":%d,\"viewport\":[%u,%u],\"tickType\":%d,\"delta\":%.9g,\"playersOnly\":%d,\"clockIn\":%.17g,\"tsIn\":%.9g,\"rngIn\":\"0x%08x\","
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


/* list <Class>: the live level's actors whose class derives from <Class> (destroyed ones, bDeleteMe, left out). */
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
    /* a destroyed actor (bDeleteMe, Actor +0x28 bit 0x80) keeps its object, name and XLevel until ULevel::CleanupDestroyed purges it,
       and is no longer in the level: a `KillAll` typed in the frozen phase leaves such actors behind */
    if (read_u32(obj + 0x28) & 0x80) continue;
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

/* rngpin <seconds> <hex state>: for <seconds>, every run of URender::SetupDynamics (Render.dll 0x10b22d90: the main frame's, and each
 * child frame's from OccludeFrame) starts from the CRT rand state <hex state> (the word at +0x14 of the game thread's msvcrt thread
 * data). The render iterators' items draw from the shared stream (a LaserIterator's last item sits at a random place along its beam),
 * so a frame taken while this runs is the same frame whenever it is taken: Play pins the same state at its own SetupDynamics runs
 * (visual-acceptance.mjs --rng-pin, view-probe.mjs rngPin). Prints the number of runs pinned. */
#define SETUP_DYNAMICS 0x10b22d90u
static int do_rngpin(int seconds, unsigned state) {
  QueryPerformanceFrequency(&qpf);
  pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  process = OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid);
  core_base = module_base("Core.dll");
  uintptr_t render = module_base("Render.dll");
  if (!process || !core_base || render != 0x10b00000u) { fprintf(stderr, "cannot read DeusEx.exe or Render.dll is at 0x%lx\n", (unsigned long)render); return 1; }
  if (!DebugActiveProcess(pid)) { fprintf(stderr, "DebugActiveProcess failed (%lu)\n", GetLastError()); return 1; }
  DebugSetProcessKillOnExit(FALSE);
  Breakpoint b; bp_arm(&b, SETUP_DYNAMICS);
  DWORD pending_tid = 0; int pending = 0;
  uintptr_t ptd = 0; DWORD ptd_tid = 0;
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
      if (code == EXCEPTION_BREAKPOINT && where == SETUP_DYNAMICS && th) {
        CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER; GetThreadContext(th, &ctx);
        if (!ptd || ptd_tid != ev.dwThreadId) {
          Ptd ptds[8]; int n = find_ptds_of(ev.dwThreadId, ptds, 8);
          ptd = 0; for (int i = 0; i < n; i++) if (read_u32(ptds[i].ptd + 0x14) != 1 && !ptd) ptd = ptds[i].ptd;
          if (!ptd && n) ptd = ptds[n - 1].ptd;
          ptd_tid = ev.dwThreadId;
          fprintf(stderr, "rand state block 0x%lx of thread %lu\n", (unsigned long)ptd, (unsigned long)ev.dwThreadId);
        }
        if (ptd) { write_mem(ptd + 0x14, &state, 4); hits++; }
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
  int quiet = 0;
  while (quiet < 3) {
    if (!WaitForDebugEvent(&ev, 40)) { quiet++; continue; }
    quiet = 0; DWORD status = DBG_CONTINUE;
    if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode; uintptr_t where = (uintptr_t)ev.u.Exception.ExceptionRecord.ExceptionAddress; HANDLE th = thread_of(ev.dwThreadId);
      if (code == EXCEPTION_BREAKPOINT && where == SETUP_DYNAMICS && th) { CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL; GetThreadContext(th, &ctx); ctx.Eip = (DWORD)where; SetThreadContext(th, &ctx); }
      else if (code != EXCEPTION_BREAKPOINT && code != EXCEPTION_SINGLE_STEP) status = DBG_EXCEPTION_NOT_HANDLED;
    }
    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status);
  }
  DebugActiveProcessStop(pid);
  fprintf(stderr, "%ld SetupDynamics runs pinned to 0x%08x in %d s\n", hits, state, seconds);
  return 0;
}

/* weapon <seconds>: the original's third-person weapon draw, event by event (docs/weapon-attachment.md). */
typedef struct { uintptr_t address; const char *site; } WeaponSite;
static const WeaponSite weapon_sites[] = {
  { 0x10b256a3u, "read" },     /* DrawActorSprite: mov ebx,[eax+0x3d0] (EAX = the pawn) */
  { 0x10b0f212u, "special" },  /* DrawLodMesh: ESI, EDX, EDI = the three special vertices, camera space */
  { 0x10b0f44du, "coords" },   /* DrawLodMesh: rep movsd of the hand coordinates (ESI) into 0x10b4ea08 */
  { 0x10b257dau, "weapon" },   /* DrawActorSprite: call DrawMesh for the weapon (EBX; coords at [EBP-0xe8]) */
  { 0x10b259c3u, "flash" },    /* the same call for the muzzle flash */
  { 0x10b26165u, "item" },     /* DrawActorSprite: call DrawMesh for a pawn's SelectedItem when it has no Weapon (EBX = the item, [EBP-0x18] the pawn, coords at [EBP-0x1a8]) */
};
#define WEAPON_SITES ((int)(sizeof(weapon_sites) / sizeof(weapon_sites[0])))
static void print_mem_words(const char *key, uintptr_t address, int count) {
  printf(",\"%s\":[", key);
  for (int i = 0; i < count; i++) printf("%s\"%08x\"", i ? "," : "", read_u32(address + i * 4));
  printf("]");
}
static void weapon_event(const char *site, CONTEXT *ctx) {
  uintptr_t ebp = ctx->Ebp;
  printf("{\"t\":%lld,\"site\":\"%s\"", qpc_us(), site);
  if (!strcmp(site, "read")) {
    uintptr_t pawn = ctx->Eax, weapon = read_u32(pawn + 0x3d0), frame = read_u32(ebp + 8);
    printf(",\"pawn\":\"%s\",\"weapon\":\"%s\",\"selected\":\"%s\"", object_name(pawn), object_name(weapon), object_name(read_u32(pawn + 0x3d8)));
    if (weapon) printf(",\"thirdPersonMesh\":\"%s\",\"mesh\":\"%s\",\"flags39c\":\"%08x\",\"flash\":[%u,%u]", object_name(read_u32(weapon + 0x36c)), object_name(read_u32(weapon + 0x174)), read_u32(weapon + 0x39c), read_u32(weapon + 0x3a0) & 0xff, read_u32(weapon + 0x3a1) & 0xff);
    if (frame) { float mirror = read_float(frame + 0x20); printf(",\"frame\":\"0x%x\",\"recursion\":%u,\"mirror\":%g", (unsigned)frame, read_u32(frame + 0x1c), mirror); }
    printf(",\"hand\":%u", read_u32(0x10b4eb10));
  } else if (!strcmp(site, "special")) {
    uintptr_t verts[3] = { ctx->Esi, ctx->Edx, ctx->Edi }, mesh = ctx->Ebx, pawn = read_u32(ebp + 0xc), frame = read_u32(ebp + 8);
    printf(",\"pawn\":\"%s\",\"mesh\":\"%s\",\"frame\":\"0x%x\",\"mirror\":%g,\"recursion\":%u", object_name(pawn), object_name(mesh), (unsigned)frame, read_float(frame + 0x20), read_u32(frame + 0x1c));
    print_mem_words("prj", frame + 0xec, 4);
    uintptr_t face = read_u32(mesh + 0x174); unsigned short idx[3] = { 0, 0, 0 }; read_mem(face, idx, 6);
    printf(",\"indices\":[%u,%u,%u],\"specialVerts\":%u,\"modelVerts\":%u", idx[0], idx[1], idx[2], read_u32(mesh + 0x184), read_u32(mesh + 0x180));
    for (int i = 0; i < 3; i++) { char key[8]; snprintf(key, sizeof(key), "v%d", i); print_mem_words(key, verts[i], 3); printf(",\"out%d\":%u", i, read_u32(verts[i] + 0xc) & 0xff); }
  } else if (!strcmp(site, "coords")) {
    printf(",\"pawn\":\"%s\"", object_name(read_u32(ebp + 0xc)));
    print_mem_words("w", ctx->Esi, 12);
  } else if (!strcmp(site, "item")) {
    uintptr_t item = ctx->Ebx, pawn = read_u32(ebp - 0x18), frame = read_u32(ebp + 8);
    printf(",\"pawn\":\"%s\",\"item\":\"%s\",\"mesh\":\"%s\",\"frame\":\"0x%x\",\"mirror\":%g", object_name(pawn), object_name(item), object_name(read_u32(item + 0x174)), (unsigned)frame, read_float(frame + 0x20));
    print_mem_words("coords", ebp - 0x1a8, 12);
    print_mem_words("location", item + 0x114, 3); print_mem_words("rotation", item + 0x120, 3);
    printf(",\"drawScale\":\"%08x\",\"style\":%u,\"pawnStyle\":%u,\"weapon\":\"%s\"", read_u32(item + 0x17c), read_u32(item + 0x165) & 0xff, read_u32(pawn + 0x165) & 0xff, object_name(read_u32(pawn + 0x3d0)));
  } else {
    uintptr_t weapon = ctx->Ebx, pawn = read_u32(ebp - 0x18), frame = read_u32(ebp + 8), args = ctx->Esp;
    printf(",\"pawn\":\"%s\",\"weapon\":\"%s\",\"mesh\":\"%s\",\"frame\":\"0x%x\",\"mirror\":%g", object_name(pawn), object_name(weapon), object_name(read_u32(weapon + 0x174)), (unsigned)frame, read_float(frame + 0x20));
    print_mem_words("coords", ebp - 0xe8, 12);
    print_mem_words("location", weapon + 0x114, 3); print_mem_words("rotation", weapon + 0x120, 3);
    printf(",\"drawScale\":\"%08x\",\"scaleGlow\":\"%08x\",\"style\":%u,\"drawType\":%u,\"bits194\":\"%08x\",\"flags39c\":\"%08x\",\"fatness\":%u,\"polyFlags\":\"%08x\"",
           read_u32(weapon + 0x17c), read_u32(weapon + 0x18c), read_u32(weapon + 0x165) & 0xff, read_u32(weapon + 0x164) & 0xff, read_u32(weapon + 0x194), read_u32(weapon + 0x39c), read_u32(weapon + 0x191) & 0xff, read_u32(args + 0x20));
    printf(",\"span\":\"%08x\",\"zone\":\"%08x\",\"leaf\":\"%08x\",\"vol\":\"%08x\",\"pawnStyle\":%u,\"animSeq\":\"%s\",\"animFrame\":\"%08x\",\"texture\":\"%s\"",
           read_u32(args + 0xc), read_u32(args + 0x10), read_u32(args + 0x18), read_u32(args + 0x1c), read_u32(pawn + 0x165) & 0xff, name_text(read_u32(weapon + 0x54)), read_u32(weapon + 0x58), object_name(read_u32(weapon + 0x16c)));
  }
  printf("}\n"); fflush(stdout);
}
static int do_weapon(int seconds) {
  QueryPerformanceFrequency(&qpf);
  pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  process = OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid);
  core_base = module_base("Core.dll");
  uintptr_t render = module_base("Render.dll");
  if (!process || !core_base || render != 0x10b00000u) { fprintf(stderr, "cannot read DeusEx.exe or Render.dll is at 0x%lx\n", (unsigned long)render); return 1; }
  names_table = read_u32(core_base + OFF_NAMES_DATA);
  if (!DebugActiveProcess(pid)) { fprintf(stderr, "DebugActiveProcess failed (%lu)\n", GetLastError()); return 1; }
  DebugSetProcessKillOnExit(FALSE);
  Breakpoint bps[WEAPON_SITES];
  for (int i = 0; i < WEAPON_SITES; i++) bp_arm(&bps[i], weapon_sites[i].address);
  DWORD pending_tid = 0; int pending = -1;
  ULONGLONG until = GetTickCount64() + (ULONGLONG)seconds * 1000;
  long hits[WEAPON_SITES] = { 0 };
  DEBUG_EVENT ev;
  while (GetTickCount64() < until) {
    if (!WaitForDebugEvent(&ev, 100)) continue;
    DWORD status = DBG_CONTINUE;
    if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode;
      uintptr_t where = (uintptr_t)ev.u.Exception.ExceptionRecord.ExceptionAddress;
      HANDLE th = thread_of(ev.dwThreadId);
      int which = -1;
      for (int i = 0; i < WEAPON_SITES; i++) if (where == weapon_sites[i].address) which = i;
      if (code == EXCEPTION_BREAKPOINT && which >= 0 && th) {
        CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER; GetThreadContext(th, &ctx);
        hits[which]++;
        weapon_event(weapon_sites[which].site, &ctx);
        ctx.Eip = (DWORD)where; ctx.EFlags |= 0x100; SetThreadContext(th, &ctx);
        write_mem(bps[which].address, &bps[which].original, 1); FlushInstructionCache(process, (LPCVOID)bps[which].address, 1);
        pending = which; pending_tid = ev.dwThreadId;
      } else if (code == EXCEPTION_SINGLE_STEP && pending >= 0 && ev.dwThreadId == pending_tid) {
        unsigned char cc = 0xCC; write_mem(bps[pending].address, &cc, 1); FlushInstructionCache(process, (LPCVOID)bps[pending].address, 1); pending = -1;
      } else if (code == EXCEPTION_BREAKPOINT || code == EXCEPTION_SINGLE_STEP) {
      } else status = DBG_EXCEPTION_NOT_HANDLED;
    } else if (ev.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT && ev.u.CreateProcessInfo.hFile) CloseHandle(ev.u.CreateProcessInfo.hFile);
    else if (ev.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT && ev.u.LoadDll.hFile) CloseHandle(ev.u.LoadDll.hFile);
    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status);
  }
  for (int i = 0; i < WEAPON_SITES; i++) bp_disarm(&bps[i]);
  int quiet = 0;
  while (quiet < 3) {
    if (!WaitForDebugEvent(&ev, 40)) { quiet++; continue; }
    quiet = 0; DWORD status = DBG_CONTINUE;
    if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode; uintptr_t where = (uintptr_t)ev.u.Exception.ExceptionRecord.ExceptionAddress; HANDLE th = thread_of(ev.dwThreadId);
      int ours = 0; for (int i = 0; i < WEAPON_SITES; i++) if (where == weapon_sites[i].address) ours = 1;
      if (code == EXCEPTION_BREAKPOINT && ours && th) { CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL; GetThreadContext(th, &ctx); ctx.Eip = (DWORD)where; SetThreadContext(th, &ctx); }
      else if (code != EXCEPTION_BREAKPOINT && code != EXCEPTION_SINGLE_STEP) status = DBG_EXCEPTION_NOT_HANDLED;
    }
    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status);
  }
  DebugActiveProcessStop(pid);
  for (int i = 0; i < WEAPON_SITES; i++) fprintf(stderr, "%s: %ld\n", weapon_sites[i].site, hits[i]);
  return 0;
}

/* galaxy poll <count> <interval_ms> <prefix> (see the file comment). */
static uintptr_t galaxy_base;
#define GX(a) (galaxy_base + ((uintptr_t)(a) - 0x10600000u))
static unsigned char read_u8(uintptr_t address) { unsigned char v = 0; read_mem(address, &v, 1); return v; }
typedef struct { uintptr_t base, size; char name[64]; } ModuleRange;
static int module_ranges(ModuleRange *out, int max) {
  HMODULE modules[1024]; DWORD needed = 0; int n = 0;
  if (!EnumProcessModulesEx(process, modules, sizeof(modules), &needed, LIST_MODULES_ALL)) return 0;
  for (DWORD i = 0; i < needed / sizeof(HMODULE) && i < 1024 && n < max; i++) {
    MODULEINFO info;
    if (!GetModuleInformation(process, modules[i], &info, sizeof(info))) continue;
    out[n].base = (uintptr_t)info.lpBaseOfDll; out[n].size = info.SizeOfImage;
    if (!GetModuleBaseNameA(process, modules[i], out[n].name, sizeof(out[n].name))) strcpy(out[n].name, "?");
    n++;
  }
  return n;
}
static const char *module_of(ModuleRange *m, int n, uintptr_t eip) {
  for (int i = 0; i < n; i++) if (eip >= m[i].base && eip < m[i].base + m[i].size) return m[i].name;
  return "?";
}
static int do_galaxy_poll(int count, int interval, const char *prefix) {
  QueryPerformanceFrequency(&qpf);
  pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  galaxy_base = module_base("Galaxy.dll"); core_base = module_base("Core.dll");
  if (!process || !galaxy_base || !core_base) { fprintf(stderr, "cannot read DeusEx.exe (Galaxy.dll 0x%lx)\n", (unsigned long)galaxy_base); return 1; }
  names_table = read_u32(core_base + OFF_NAMES_DATA);
  char path[700];
  /* The pan table. */
  uintptr_t pan = read_u32(GX(0x10698390));
  static unsigned char table[0x10000];
  int pan_ok = pan && read_mem(pan, table, sizeof(table));
  snprintf(path, sizeof(path), "%s.pan.bin", prefix);
  if (pan_ok) { FILE *f = fopen(path, "wb"); if (f) { fwrite(table, 1, sizeof(table), f); fclose(f); } }
  /* The live UGalaxyAudioSubsystem (the object array, by class name). */
  uintptr_t gog = read_u32(core_base + OFF_GOG_DATA), subsystem = 0, player = 0;
  unsigned objects = read_u32(core_base + OFF_GOG_COUNT);
  for (unsigned slot = 0; slot < objects && (!subsystem || !player); slot++) {
    uintptr_t obj = read_u32(gog + slot * 4);
    if (!obj) continue;
    uintptr_t cls = read_u32(obj + OFF_OBJECT_CLASS);
    if (!cls) continue;
    const char *cname = object_name(cls), *oname = object_name(obj);
    if (!subsystem && !strcmp(cname, "GalaxyAudioSubsystem") && strcmp(oname, "GalaxyAudioSubsystem")) subsystem = obj;
    /* The live player (not the class object): its XLevel (+0xac) and Level (+0xa8) tell one map load from the next. */
    if (!player && !strcmp(cname, "JCDentonMale") && strcmp(oname, "JCDentonMale") && read_u32(obj + 0x5d4)) player = obj;
  }
  snprintf(path, sizeof(path), "%s.json", prefix);
  FILE *out = fopen(path, "w");
  if (!out) { fprintf(stderr, "cannot write %s\n", path); return 1; }
  unsigned char wfx[18]; read_mem(GX(0x1067b6d8), wfx, sizeof(wfx));
  fprintf(out, "{\"qpcUs\":%lld,\"galaxyBase\":\"0x%08lx\",\"waveFormat\":\"", qpc_us(), (unsigned long)galaxy_base);
  for (int i = 0; i < 18; i++) fprintf(out, "%02x", wfx[i]);
  fprintf(out, "\",\"path\":%u,\"formatBits\":%u,\"type3d\":%u,\"open\":%u,\"kernelMode\":%u,\"mmx\":%u,\"sse\":%u,\"amd3dnow\":%u,"
    "\"rate\":%u,\"latency\":%u,\"effectSlots\":%u,\"secondary\":\"0x%08x\",\"staging\":\"0x%08x\",\"panTable\":\"0x%08x\",\"panRead\":%d,",
    read_u8(GX(0x10698178)), read_u8(GX(0x10698179)), read_u8(GX(0x1069817a)), read_u8(GX(0x10698394)), read_u8(GX(0x10697cfc)),
    read_u8(GX(0x1068dc80)), read_u8(GX(0x10698340)), read_u8(GX(0x10698190)), read_u32(GX(0x10697d18)), read_u32(GX(0x1064a65c)),
    read_u8(GX(0x1068828d)), read_u32(GX(0x10697cc8)), read_u32(GX(0x10697ccc)), (unsigned)pan, pan_ok);
  if (subsystem) {
    fprintf(out, "\"subsystem\":{\"name\":\"%s\",\"address\":\"0x%08lx\"", object_name(subsystem), (unsigned long)subsystem);
    for (unsigned off = 0x2c; off <= 0x7c; off += 4) fprintf(out, ",\"+0x%02x\":%u", off, read_u32(subsystem + off));
    fprintf(out, "},");
  } else fprintf(out, "\"subsystem\":null,");
  if (player) fprintf(out, "\"player\":{\"name\":\"%s\",\"address\":\"0x%08lx\",\"xlevel\":\"0x%08x\",\"level\":\"0x%08x\"},",
    object_name(player), (unsigned long)player, read_u32(player + 0xac), read_u32(player + 0xa8));
  else fprintf(out, "\"player\":null,");
  /* The threads: sampled EIPs, then the x87 control word and MXCSR. */
  ModuleRange mods[512]; int nmods = module_ranges(mods, 512);
  fprintf(out, "\"threads\":[");
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  THREADENTRY32 entry; entry.dwSize = sizeof(entry);
  int first = 1;
  if (Thread32First(snap, &entry)) do {
    if (entry.th32OwnerProcessID != pid) continue;
    HANDLE th = OpenThread(THREAD_GET_CONTEXT | THREAD_SUSPEND_RESUME | THREAD_QUERY_INFORMATION, FALSE, entry.th32ThreadID);
    if (!th) continue;
    fprintf(out, "%s{\"tid\":%lu,\"priority\":%ld,\"eips\":[", first ? "" : ",", entry.th32ThreadID, (long)GetThreadPriority(th));
    first = 0;
    for (int k = 0; k < 8; k++) {
      CONTEXT ctx; memset(&ctx, 0, sizeof(ctx)); ctx.ContextFlags = CONTEXT_CONTROL;
      if (SuspendThread(th) != (DWORD)-1) { GetThreadContext(th, &ctx); ResumeThread(th); }
      fprintf(out, "%s[\"0x%08lx\",\"%s\"]", k ? "," : "", (unsigned long)ctx.Eip, module_of(mods, nmods, ctx.Eip));
      Sleep(3);
    }
    CONTEXT ctx; memset(&ctx, 0, sizeof(ctx)); ctx.ContextFlags = CONTEXT_FULL | CONTEXT_FLOATING_POINT | CONTEXT_EXTENDED_REGISTERS;
    int got = 0;
    if (SuspendThread(th) != (DWORD)-1) { got = GetThreadContext(th, &ctx); ResumeThread(th); }
    unsigned short fxcw = 0; unsigned mxcsr = 0, mask = 0;
    memcpy(&fxcw, ctx.ExtendedRegisters, 2); memcpy(&mxcsr, ctx.ExtendedRegisters + 24, 4); memcpy(&mask, ctx.ExtendedRegisters + 28, 4);
    fprintf(out, "],\"context\":%d,\"fpcw\":\"0x%04lx\",\"fxsaveFcw\":\"0x%04x\",\"mxcsr\":\"0x%08x\",\"mxcsrMask\":\"0x%08x\"}",
      got, (unsigned long)(ctx.FloatSave.ControlWord & 0xffff), fxcw, mxcsr, mask);
    CloseHandle(th);
  } while (Thread32Next(snap, &entry));
  CloseHandle(snap);
  fprintf(out, "]}\n");
  fclose(out);
  /* The samples. */
  snprintf(path, sizeof(path), "%s.poll.txt", prefix);
  FILE *poll = fopen(path, "w");
  if (!poll) { fprintf(stderr, "cannot write %s\n", path); return 1; }
  for (int k = 0; k < count; k++) {
    unsigned heads[4] = {0}; read_mem(GX(0x10697cd0), heads, sizeof(heads));
    fprintf(poll, "%lld %u %u %u %d %u %d %d\n", qpc_us(), heads[0], heads[1], heads[2], (int)heads[3], read_u32(GX(0x10698194)),
      (int)read_u32(GX(0x10698204)), (int)read_u32(GX(0x1069834c)));
    if (k + 1 < count) Sleep(interval);
  }
  fclose(poll);
  fprintf(stderr, "galaxy poll: %d samples, Galaxy.dll at 0x%lx, subsystem %s\n", count, (unsigned long)galaxy_base, subsystem ? object_name(subsystem) : "not found");
  CloseHandle(process);
  return 0;
}

/* ---------------- galaxy capture (see the file comment) ---------------- */
enum { GX_INIT = 1, GX_CHANNELS, GX_OPEN, GX_SAMPLE_VOLUME, GX_MUSIC_VOLUME, GX_LOAD_MUSIC, GX_LOAD_MUSIC_RESULT, GX_UNLOAD_MUSIC,
  GX_START_MUSIC, GX_STOP_MUSIC, GX_CONTROL_MUSIC, GX_CLEAR_ACTIVE, GX_BREAK, GX_LOAD_SAMPLE, GX_LOAD_SAMPLE_RESULT, GX_START_SAMPLE,
  GX_START_SAMPLE_RESULT, GX_CONTROL_SAMPLE, GX_CONTROL_VOICE, GX_CONTROL_VOICE_RESULT, GX_STOP_SAMPLE, GX_SAMPLE_REVERB,
  GX_UNLOAD_SAMPLE, GX_UPDATE_LOCK, GX_UPDATE_UNLOCK, GX_SAMPLE_RECORD,
  GX_CB_POSITION = 30, GX_CB_LOCK, GX_CB_LOST, GX_CB_COPIED, GX_CB_RESYNC, GX_CB_END,
  GX_DEC_MESSAGE = 40, GX_DEC_CALL, GX_DEC_END, GX_END = 99 };
typedef struct { uintptr_t address; unsigned char original; int kind; } GxBp;
enum { K_INIT, K_CHANNELS, K_OPEN, K_SVOL, K_MVOL, K_LOADM, K_LOADM_RET, K_UNLOADM, K_STARTM, K_STOPM, K_CTLM, K_CLEAR, K_BREAK,
  K_LOADS, K_LOADS_RET, K_STARTS, K_STARTS_RET, K_CTLS, K_CTLV, K_CTLV_RET, K_STOPS, K_REVERB, K_UNLOADS, K_ULOCK, K_UUNLOCK,
  K_CB_POS, K_CB_LOCK_RESYNC, K_CB_LOCK_A, K_CB_LOCK_B, K_CB_LOST, K_CB_COPIED, K_CB_RESYNC, K_CB_END, K_DEC_MSG, K_DEC_CALL, K_DEC_END };
static const struct { uintptr_t address; int kind; } gx_sites[] = {
  {0x1060df30, K_INIT}, {0x1060ebc0, K_CHANNELS}, {0x10613350, K_OPEN},
  {0x1060ec19, K_SVOL}, {0x1060eb79, K_MVOL},                       /* after EnterCriticalSection */
  {0x10618be0, K_LOADM}, {0x1060a783, K_LOADM_RET}, {0x10619465, K_UNLOADM}, {0x106122bd, K_STARTM}, {0x106183bd, K_STOPM},
  {0x1060d0f2, K_CTLM}, {0x1060a82a, K_CLEAR}, {0x1060a88d, K_BREAK},
  /* glxStartSample past its 3D poll call (0x10612370): a breakpoint on a `call` corrupts the game when stepped off under
   * CrossOver (as on Update's unlock call); the stack is the same, so are the argument offsets. */
  {0x10612375, K_STARTS}, {0x1060a43a, K_STARTS_RET}, {0x1060d29b, K_CTLS},
  {0x1060cf21, K_CTLV}, {0x10609a2a, K_CTLV_RET}, {0x1060ce94, K_CTLV_RET}, {0x1060ced0, K_CTLV_RET}, {0x10618437, K_STOPS},
  /* Update's lock (a marker). Not its unlock call at 0x1060abd6: stepping off a breakpoint on that `call` corrupts the
   * game under CrossOver (EDI 0 in UGameEngine::Draw after Update returns; seen in a bisection of the breakpoint kinds). */
  {0x106113df, K_REVERB}, {0x1061951f, K_UNLOADS}, {0x1060954e, K_ULOCK},
  {0x106142d9, K_CB_POS}, {0x10614421, K_CB_LOCK_RESYNC}, {0x1061451c, K_CB_LOCK_A}, {0x106145f4, K_CB_LOCK_B},
  {0x106143e1, K_CB_LOST}, {0x106144d7, K_CB_LOST}, {0x106145af, K_CB_LOST}, {0x10614657, K_CB_COPIED}, {0x106143b3, K_CB_RESYNC},
  {0x10614681, K_CB_END}, {0x1060e363, K_DEC_MSG}, {0x1060e5a1, K_DEC_CALL}, {0x1060e80d, K_DEC_END},
};
#define GX_SITES ((int)(sizeof(gx_sites) / sizeof(gx_sites[0])))
static GxBp gxbp[GX_SITES];
static FILE *gx_out;
static struct { unsigned handle; unsigned char record[0x48]; } gx_samples[4096]; static int gx_nsamples;
static int gx_copied_full = 0;
static void gx_record(unsigned type, DWORD tid, const void *payload, unsigned len, const void *extra, unsigned extra_len) {
  unsigned head[3] = { type, len + extra_len, (unsigned)tid };
  fwrite(head, 4, 3, gx_out);
  if (len) fwrite(payload, 1, len, gx_out);
  if (extra_len) fwrite(extra, 1, extra_len, gx_out);
}
static unsigned fnv1a(const unsigned char *b, size_t n, unsigned h) { for (size_t i = 0; i < n; i++) { h ^= b[i]; h *= 0x01000193u; } return h; }
/* The staging bytes [pos, pos + n) of a ring of `size` bytes at `ring`, wrapping. */
static int gx_ring_bytes(uintptr_t ring, unsigned size, unsigned pos, unsigned n, unsigned char *out) {
  if (n > size) return 0;
  unsigned first = size - pos < n ? size - pos : n;
  return read_mem(ring + pos, out, first) && (n == first || read_mem(ring, out + first, n - first));
}
static unsigned char gx_buffer[0x40000];
static void gx_mem_record(unsigned type, DWORD tid, unsigned w0, unsigned w1, uintptr_t mem) {
  /* glxMemory {'MEMO', 0xc, Data, Length, 0}: the flags, the length and the bytes. */
  unsigned desc[5] = {0}; read_mem(mem, desc, sizeof(desc));
  unsigned len = desc[3], head[3] = { w0, w1, len };
  unsigned char *bytes = (unsigned char *)malloc(len ? len : 1);
  if (len && !read_mem(desc[2], bytes, len)) len = 0, head[2] = 0xffffffffu;
  gx_record(type, tid, head, sizeof(head), bytes, len);
  free(bytes);
}
static void gx_event(int kind, DWORD tid, CONTEXT *c) {
  uintptr_t esp = c->Esp; unsigned w[16] = {0};
  switch (kind) {
    case K_INIT: gx_record(GX_INIT, tid, NULL, 0, NULL, 0); break;
    case K_CHANNELS: read_mem(esp + 4, w, 4); gx_record(GX_CHANNELS, tid, w, 4, NULL, 0); break;
    case K_OPEN: read_mem(esp + 4, w, 16); gx_record(GX_OPEN, tid, w, 16, NULL, 0); break;
    case K_SVOL: case K_MVOL: read_mem(esp + 8, w, 8); gx_record(kind == K_SVOL ? GX_SAMPLE_VOLUME : GX_MUSIC_VOLUME, tid, w, 8, NULL, 0); break;
    case K_LOADM: read_mem(esp + 4, w, 8); gx_mem_record(GX_LOAD_MUSIC, tid, w[1], 0, w[0]); break;
    case K_LOADM_RET: w[0] = c->Eax; gx_record(GX_LOAD_MUSIC_RESULT, tid, w, 4, NULL, 0); break;
    case K_UNLOADM: gx_record(GX_UNLOAD_MUSIC, tid, NULL, 0, NULL, 0); break;
    case K_STARTM: gx_record(GX_START_MUSIC, tid, NULL, 0, NULL, 0); break;
    case K_STOPM: gx_record(GX_STOP_MUSIC, tid, NULL, 0, NULL, 0); break;
    case K_CTLM: read_mem(esp + 0x10, w, 8); gx_record(GX_CONTROL_MUSIC, tid, w, 8, NULL, 0); break;
    case K_CLEAR: w[0] = read_u32(c->Esi + 0x64); gx_record(GX_CLEAR_ACTIVE, tid, w, 4, NULL, 0); break;
    case K_BREAK: gx_record(GX_BREAK, tid, NULL, 0, NULL, 0); break;
    case K_LOADS: read_mem(esp + 4, w, 8); gx_mem_record(GX_LOAD_SAMPLE, tid, w[1], 0, w[0]); break;
    case K_LOADS_RET: {
      unsigned char rec[0x4c] = {0}; memcpy(rec, &c->Eax, 4);
      if (c->Eax) read_mem(c->Eax, rec + 4, 0x48);
      gx_record(GX_LOAD_SAMPLE_RESULT, tid, rec, sizeof(rec), NULL, 0); break;
    }
    case K_STARTS: {
      read_mem(esp + 0x20, w, 24);
      /* A sample seen for the first time (or changed): its 0x48-byte glxSample and its data (an MPEG record's +0x30 bytes;
       * a PCM record's Length frames and the loader's 31 pad bytes), read here, under the library lock, rather than at
       * glxLoadSample (outside it, where a trap could meet the timer thread's). */
      unsigned char rec[0x48];
      if (w[1] && read_mem(w[1], rec, sizeof(rec))) {
        int seen = 0;
        for (int i = 0; i < gx_nsamples; i++) if (gx_samples[i].handle == w[1]) { seen = !memcmp(gx_samples[i].record, rec, sizeof(rec)); if (!seen) memcpy(gx_samples[i].record, rec, sizeof(rec)); break; }
        if (!seen) {
          int known = 0; for (int i = 0; i < gx_nsamples; i++) if (gx_samples[i].handle == w[1]) known = 1;
          if (!known && gx_nsamples < 4096) { gx_samples[gx_nsamples].handle = w[1]; memcpy(gx_samples[gx_nsamples].record, rec, sizeof(rec)); gx_nsamples++; }
          unsigned short type; unsigned length, data; memcpy(&type, rec + 0x2c, 2); memcpy(&length, rec + 0x30, 4); memcpy(&data, rec + 0x44, 4);
          unsigned n = type & 0x4000 ? length : length * (type & 4 ? 2 : 1) * (type & 0x40 ? 2 : 1) + 0x1f;
          if (n > 0x1000000) n = 0;
          unsigned char *bytes = (unsigned char *)malloc(n ? n : 1);
          unsigned head[2] = { w[1], n };
          if (n && (!data || !read_mem(data, bytes, n))) { head[1] = 0xffffffffu; n = 0; }
          unsigned char payload[8 + 0x48]; memcpy(payload, head, 8); memcpy(payload + 8, rec, sizeof(rec));
          gx_record(GX_SAMPLE_RECORD, tid, payload, sizeof(payload), bytes, n);
          free(bytes);
        }
      }
      gx_record(GX_START_SAMPLE, tid, w, 24, NULL, 0); break;
    }
    case K_STARTS_RET: w[0] = c->Eax; gx_record(GX_START_SAMPLE_RESULT, tid, w, 4, NULL, 0); break;
    case K_CTLS: read_mem(esp + 0x14, w, 16); gx_record(GX_CONTROL_SAMPLE, tid, w, 16, NULL, 0); break;
    case K_CTLV: read_mem(esp + 0xc, w, 16); gx_record(GX_CONTROL_VOICE, tid, w, 16, NULL, 0); break;
    case K_CTLV_RET: w[0] = c->Eax; w[1] = (unsigned)c->Eip; gx_record(GX_CONTROL_VOICE_RESULT, tid, w, 8, NULL, 0); break;
    case K_STOPS: w[0] = c->Esi; w[1] = read_u32(esp + 0x40c);  /* the voice, and the return address (a call from glxStartSample or glxUnloadSample is part of it) */
      gx_record(GX_STOP_SAMPLE, tid, w, 8, NULL, 0); break;
    case K_REVERB: { unsigned char block[0x70] = {0}; uintptr_t at = read_u32(esp + 0x18); memcpy(block, &at, 4); if (at) read_mem(at, block + 4, 0x6c);
      gx_record(GX_SAMPLE_REVERB, tid, block, sizeof(block), NULL, 0); break; }
    case K_UNLOADS: w[0] = c->Edi; gx_record(GX_UNLOAD_SAMPLE, tid, w, 4, NULL, 0);
      /* the address may be reused by a later load: the next start dumps it again */
      for (int i = 0; i < gx_nsamples; i++) if (gx_samples[i].handle == w[0]) { gx_samples[i] = gx_samples[--gx_nsamples]; break; }
      break;
    case K_ULOCK: gx_record(GX_UPDATE_LOCK, tid, NULL, 0, NULL, 0); break;
    case K_UUNLOCK: gx_record(GX_UPDATE_UNLOCK, tid, NULL, 0, NULL, 0); break;
    case K_CB_POS: w[0] = c->Eax; read_mem(esp + 0x20, w + 1, 8); gx_record(GX_CB_POSITION, tid, w, 12, NULL, 0); break;
    case K_CB_LOCK_RESYNC: case K_CB_LOCK_A: case K_CB_LOCK_B:
      w[0] = kind - K_CB_LOCK_RESYNC; w[1] = c->Eax; gx_record(GX_CB_LOCK, tid, w, 8, NULL, 0); break;
    case K_CB_LOST: w[0] = (unsigned)c->Eip; gx_record(GX_CB_LOST, tid, w, 4, NULL, 0); break;
    case K_CB_COPIED: case K_CB_RESYNC: {
      unsigned size = read_u32(GX(0x10697cd0)), a = read_u32(GX(0x10697cd4)), b = read_u32(GX(0x10697cd8)), ahead = read_u32(GX(0x10697cdc));
      uintptr_t ring = read_u32(GX(0x10697ccc));
      if (kind == K_CB_RESYNC) {
        w[0] = size; w[1] = a; w[2] = b; w[3] = ahead; w[4] = 0;
        if (size <= sizeof(gx_buffer) && read_mem(ring, gx_buffer, size)) w[4] = fnv1a(gx_buffer, size, 0x811c9dc5u);
        gx_record(GX_CB_RESYNC, tid, w, 20, NULL, 0);
      } else {
        unsigned r = c->Ebx;
        w[0] = r; w[1] = a; w[2] = b; w[3] = ahead; w[4] = w[5] = 0;
        unsigned char *sa = gx_buffer, *sb = gx_buffer + 0x20000;
        int ok = r <= 0x20000 && gx_ring_bytes(ring, size, a, r, sa) && gx_ring_bytes(ring, size, b, r, sb);
        if (ok) { w[4] = fnv1a(sa, r, 0x811c9dc5u); w[5] = fnv1a(sb, r, 0x811c9dc5u); } else w[4] = w[5] = 0xffffffffu;
        if (ok && gx_copied_full < 24) { gx_copied_full++; memcpy(sa + r, sb, r); gx_record(GX_CB_COPIED, tid, w, 24, sa, 2 * r); }
        else gx_record(GX_CB_COPIED, tid, w, 24, NULL, 0);
      }
      break;
    }
    case K_CB_END: w[0] = read_u32(GX(0x10697cd4)); w[1] = read_u32(GX(0x10697cd8)); w[2] = read_u32(GX(0x10697cdc));
      gx_record(GX_CB_END, tid, w, 12, NULL, 0); break;
    case K_DEC_MSG: read_mem(esp + 0x48, w, 12); gx_record(GX_DEC_MESSAGE, tid, w, 12, NULL, 0); break;
    case K_DEC_CALL: {
      /* After 0x1061a690 returns: its 8 cdecl arguments are still on the stack. */
      unsigned a[8]; read_mem(esp, a, sizeof(a));
      unsigned consumed = read_u32(a[6]), produced = read_u32(a[7]);
      unsigned head[10] = { a[0], a[1], a[2], a[3], a[4], a[5], consumed, produced, 0, 0 };
      unsigned n1 = a[3] && produced <= 0x10000 ? produced : 0, n2 = a[4] && produced <= 0x10000 ? produced : 0;
      if (n1 && !read_mem(a[3], gx_buffer, n1)) n1 = 0;
      if (n2 && !read_mem(a[4], gx_buffer + n1, n2)) n2 = 0;
      head[8] = n1; head[9] = n2;
      gx_record(GX_DEC_CALL, tid, head, sizeof(head), gx_buffer, n1 + n2);
      break;
    }
    case K_DEC_END: gx_record(GX_DEC_END, tid, NULL, 0, NULL, 0); break;
  }
}
typedef struct { DWORD tid; int index; } GxPending;
/* The game's threads, from the debug events. (Suspending the others while one steps off a breakpoint did not keep
 * CrossOver from garbling a concurrent trap; the breakpoints are placed so that none can meet another instead.) */
static struct { DWORD tid; HANDLE h; } gx_threads[128]; static int gx_nthreads;
static DWORD gx_suspended_for;
static void gx_thread_add(DWORD tid, HANDLE h) { if (gx_nthreads < 128) { gx_threads[gx_nthreads].tid = tid; gx_threads[gx_nthreads].h = h; gx_nthreads++; } }
static void gx_thread_remove(DWORD tid) { for (int i = 0; i < gx_nthreads; i++) if (gx_threads[i].tid == tid) { gx_threads[i] = gx_threads[--gx_nthreads]; return; } }
static void gx_suspend_others(DWORD tid) {
  for (int i = 0; i < gx_nthreads; i++) if (gx_threads[i].tid != tid) SuspendThread(gx_threads[i].h);
  gx_suspended_for = tid;
}
static void gx_resume_others(void) {
  if (!gx_suspended_for) return;
  for (int i = 0; i < gx_nthreads; i++) if (gx_threads[i].tid != gx_suspended_for) ResumeThread(gx_threads[i].h);
  gx_suspended_for = 0;
}
/* CrossOver sometimes reports one of our int3s from inside its exception dispatcher: the event's address and the thread's
 * context are the dispatcher's, and continuing would resume the game's thread one byte past the int3. The faulting context is
 * then a CONTEXT record on the thread's stack (ContextFlags with the i386 bit, Eip one past one of our breakpoints): record the
 * event from it and rewind that record's Eip, with the trap flag set, so the dispatcher resumes on the original instruction. */
static int gx_recover(DWORD tid, uintptr_t where, int *npending, GxPending *pending, long *hits) {
  HANDLE th = thread_of(tid);
  CONTEXT now; memset(&now, 0, sizeof(now)); now.ContextFlags = CONTEXT_CONTROL;
  if (!th || !GetThreadContext(th, &now)) return 0;
  static unsigned stack[2048];
  if (!read_mem(now.Esp, stack, sizeof(stack))) { SIZE_T n = 0; ReadProcessMemory(process, (LPCVOID)(uintptr_t)now.Esp, stack, 4096, &n); if (!n) return 0; }
  const unsigned EIP_AT = 0xb8 / 4;
  for (int k = EIP_AT; k < 2048 - 0x40; k++) {
    for (int i = 0; i < GX_SITES; i++) {
      if (stack[k] != gxbp[i].address + 1) continue;
      unsigned flags = stack[k - EIP_AT];
      if ((flags & 0xffff0000u) != 0x00010000u) continue;
      uintptr_t rec = now.Esp + 4 * (k - EIP_AT);
      CONTEXT c; memset(&c, 0, sizeof(c));
      if (!read_mem(rec, &c, sizeof(CONTEXT) < 0x2cc ? sizeof(CONTEXT) : 0x2cc)) return 0;
      fprintf(stderr, "galaxy capture: recovered int3 0x%08lx of thread %lu from a CONTEXT at 0x%08lx (event at 0x%08lx, eip %08lx)\n",
        (unsigned long)gxbp[i].address, tid, (unsigned long)rec, (unsigned long)where, now.Eip);
      c.Eip = (DWORD)gxbp[i].address;
      gx_event(gxbp[i].kind, tid, &c);
      hits[i]++;
      unsigned eip = (unsigned)gxbp[i].address, eflags = c.EFlags | 0x100;
      write_mem(rec + 0xb8, &eip, 4); write_mem(rec + 0xc0, &eflags, 4);
      write_mem(gxbp[i].address, &gxbp[i].original, 1); FlushInstructionCache(process, (LPCVOID)gxbp[i].address, 1);
      if (*npending < 64) { pending[*npending].tid = tid; pending[*npending].index = i; (*npending)++; }
      return 1;
    }
  }
  return 0;
}

static int do_galaxy_capture(const char *out_path, int seconds, const char *map, const char *stop_path) {
  QueryPerformanceFrequency(&qpf);
  gx_out = fopen(out_path, "wb");
  if (!gx_out) { fprintf(stderr, "cannot write %s\n", out_path); return 1; }
  static char cmdline[512];
  snprintf(cmdline, sizeof(cmdline), "\"C:\\Deus Ex GOTY Edition\\System\\DeusEx.exe\" %s INI=DeusEx-ad.ini USERINI=User-ad.ini", map);
  STARTUPINFOA si; PROCESS_INFORMATION pi; memset(&si, 0, sizeof(si)); si.cb = sizeof(si); memset(&pi, 0, sizeof(pi));
  if (!CreateProcessA("C:\\Deus Ex GOTY Edition\\System\\DeusEx.exe", cmdline, NULL, NULL, FALSE, DEBUG_ONLY_THIS_PROCESS, NULL,
      "C:\\Deus Ex GOTY Edition\\System", &si, &pi)) { fprintf(stderr, "CreateProcess failed (%lu)\n", GetLastError()); return 1; }
  pid = pi.dwProcessId; process = pi.hProcess;
  DebugSetProcessKillOnExit(FALSE);
  fprintf(stderr, "galaxy capture: DeusEx.exe pid %lu\n", pid);
  /* Per-thread re-arm after a hit: the thread single-steps the original instruction. */
  GxPending pending[64]; int npending = 0;
  int armed = 0; long events = 0, hits[GX_SITES] = {0};
  ULONGLONG until = GetTickCount64() + (ULONGLONG)seconds * 1000;
  DEBUG_EVENT ev; int exited = 0;
  while (!exited && GetTickCount64() < until) {
    if (stop_path) { FILE *f = fopen(stop_path, "r"); if (f) { fclose(f); break; } }
    if (!WaitForDebugEvent(&ev, 100)) continue;
    DWORD status = DBG_CONTINUE;
    if (ev.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) {
      /* The DLL's export directory name (the loader list may not hold it yet at this event). */
      char name[64] = "";
      uintptr_t image = (uintptr_t)ev.u.LoadDll.lpBaseOfDll;
      unsigned nt = read_u32(image + 0x3c), exports = read_u32(image + nt + 0x78);
      if (nt && exports) { unsigned at = read_u32(image + exports + 0x0c); if (at) read_mem(image + at, name, sizeof(name) - 1); }
      HMODULE base = (HMODULE)ev.u.LoadDll.lpBaseOfDll;
      if (!_stricmp(name, "Galaxy.dll") && !armed) {
        galaxy_base = (uintptr_t)base;
        if (galaxy_base != 0x10600000u) { fprintf(stderr, "Galaxy.dll at 0x%lx, not its preferred base\n", (unsigned long)galaxy_base); break; }
        /* GX_ONLY (diagnostics): a comma-separated list of breakpoint kinds to arm, or "none". */
        const char *only = getenv("GX_ONLY");
        for (int i = 0; i < GX_SITES; i++) {
          gxbp[i].address = gx_sites[i].address; gxbp[i].kind = gx_sites[i].kind;
          read_mem(gxbp[i].address, &gxbp[i].original, 1);
          int arm = 1;
          if (only) { char key[16]; snprintf(key, sizeof(key), ",%d,", gx_sites[i].kind); char list[256]; snprintf(list, sizeof(list), ",%s,", only); arm = strstr(list, key) != NULL; }
          if (!arm) { gxbp[i].address = 0; continue; }
          unsigned char cc = 0xCC; write_mem(gxbp[i].address, &cc, 1);
        }
        FlushInstructionCache(process, NULL, 0);
        armed = 1;
        fprintf(stderr, "galaxy capture: Galaxy.dll loaded, %d breakpoints armed\n", GX_SITES);
      }
      if (ev.u.LoadDll.hFile) CloseHandle(ev.u.LoadDll.hFile);
    } else if (ev.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
      if (ev.u.CreateProcessInfo.hFile) CloseHandle(ev.u.CreateProcessInfo.hFile);
      gx_thread_add(ev.dwThreadId, ev.u.CreateProcessInfo.hThread);
    } else if (ev.dwDebugEventCode == CREATE_THREAD_DEBUG_EVENT) {
      /* a thread created while the others are suspended for a step starts suspended too */
      gx_thread_add(ev.dwThreadId, ev.u.CreateThread.hThread);
      if (gx_suspended_for) SuspendThread(ev.u.CreateThread.hThread);
    } else if (ev.dwDebugEventCode == EXIT_THREAD_DEBUG_EVENT) {
      gx_thread_remove(ev.dwThreadId);
    } else if (ev.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) {
      exited = 1;
    } else if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode;
      uintptr_t where = (uintptr_t)ev.u.Exception.ExceptionRecord.ExceptionAddress;
      int which = -1;
      if (armed && code == EXCEPTION_BREAKPOINT) for (int i = 0; i < GX_SITES; i++) if (gxbp[i].address == where) { which = i; break; }
      if (armed && code == EXCEPTION_BREAKPOINT && which < 0) {
        /* CrossOver sometimes reports another address for one of our int3s: the thread's EIP is then just past it. */
        HANDLE th = thread_of(ev.dwThreadId);
        CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL;
        if (th && GetThreadContext(th, &ctx)) for (int i = 0; i < GX_SITES; i++) if (gxbp[i].address + 1 == ctx.Eip) {
          fprintf(stderr, "galaxy capture: breakpoint reported at 0x%08lx, thread %lu's EIP 0x%08lx: ours at 0x%08lx\n",
            (unsigned long)where, ev.dwThreadId, (unsigned long)ctx.Eip, (unsigned long)gxbp[i].address);
          which = i; where = gxbp[i].address; break;
        }
      }
      int step = -1;
      if (code == EXCEPTION_SINGLE_STEP) for (int i = 0; i < npending; i++) if (pending[i].tid == ev.dwThreadId) { step = i; break; }
      if (which >= 0) {
        HANDLE th = thread_of(ev.dwThreadId);
        CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER;
        if (!th || !GetThreadContext(th, &ctx)) fprintf(stderr, "galaxy capture: no context for thread %lu at 0x%08lx (%lu)\n", ev.dwThreadId, (unsigned long)where, GetLastError());
        else {
          ctx.Eip = (DWORD)where;
          gx_event(gxbp[which].kind, ev.dwThreadId, &ctx);
          hits[which]++; events++;
          /* Write back only EIP and EFlags (a fresh CONTEXT_CONTROL): under CrossOver a CONTEXT_INTEGER write can put back
           * stale registers (seen: EDI 0 after Galaxy's Update returned into UGameEngine::Draw). */
          CONTEXT set; memset(&set, 0, sizeof(set)); set.ContextFlags = CONTEXT_CONTROL;
          GetThreadContext(th, &set);
          set.Eip = (DWORD)where; set.EFlags |= 0x100; set.ContextFlags = CONTEXT_CONTROL;
          SetThreadContext(th, &set);
          write_mem(where, &gxbp[which].original, 1); FlushInstructionCache(process, (LPCVOID)where, 1);
          if (npending < 64) { pending[npending].tid = ev.dwThreadId; pending[npending].index = which; npending++; }
        }
      } else if (step >= 0) {
        unsigned char cc = 0xCC; int index = pending[step].index;
        write_mem(gxbp[index].address, &cc, 1); FlushInstructionCache(process, (LPCVOID)gxbp[index].address, 1);
        pending[step] = pending[--npending];
        if (gx_suspended_for == ev.dwThreadId) gx_resume_others();
      } else if (armed && code == EXCEPTION_BREAKPOINT && gx_recover(ev.dwThreadId, where, &npending, pending, hits)) {
        events++;
      } else if (code == EXCEPTION_BREAKPOINT || code == EXCEPTION_SINGLE_STEP) {
        /* the loader's initial breakpoint, or a stale step: log the thread's context and every thread's EIP */
        HANDLE th = thread_of(ev.dwThreadId);
        CONTEXT ctx; memset(&ctx, 0, sizeof(ctx)); ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER;
        if (th) GetThreadContext(th, &ctx);
        fprintf(stderr, "galaxy capture: %s at 0x%08lx thread %lu (not ours): eip %08lx esp %08lx eflags %08lx; pending %d\n",
          code == EXCEPTION_BREAKPOINT ? "breakpoint" : "single step", (unsigned long)where, ev.dwThreadId, ctx.Eip, ctx.Esp, ctx.EFlags, npending);
        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0); THREADENTRY32 te; te.dwSize = sizeof(te);
        if (Thread32First(snap, &te)) do {
          if (te.th32OwnerProcessID != pid) continue;
          HANDLE t2 = thread_of(te.th32ThreadID); CONTEXT c2; memset(&c2, 0, sizeof(c2)); c2.ContextFlags = CONTEXT_CONTROL;
          if (t2 && GetThreadContext(t2, &c2)) {
            int at_bp = -1; for (int i = 0; i < GX_SITES; i++) if (gxbp[i].address + 1 == c2.Eip || gxbp[i].address == c2.Eip) at_bp = i;
            fprintf(stderr, "    thread %lu eip %08lx%s\n", te.th32ThreadID, c2.Eip, at_bp >= 0 ? " (at one of ours)" : "");
          }
        } while (Thread32Next(snap, &te));
        CloseHandle(snap);
      } else {
        status = DBG_EXCEPTION_NOT_HANDLED;
        HANDLE th = thread_of(ev.dwThreadId);
        CONTEXT ctx; memset(&ctx, 0, sizeof(ctx)); ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER;
        if (th) GetThreadContext(th, &ctx);
        ULONG_PTR *info = ev.u.Exception.ExceptionRecord.ExceptionInformation;
        fprintf(stderr, "galaxy capture: exception 0x%08lx (%s chance) at 0x%08lx thread %lu, info %lx %lx; eax %08lx ebx %08lx ecx %08lx edx %08lx esi %08lx edi %08lx esp %08lx\n",
          code, ev.u.Exception.dwFirstChance ? "first" : "second", (unsigned long)where, ev.dwThreadId,
          (unsigned long)info[0], (unsigned long)info[1], ctx.Eax, ctx.Ebx, ctx.Ecx, ctx.Edx, ctx.Esi, ctx.Edi, ctx.Esp);
      }
    }
    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status);
  }
  /* Disarm, rewind any thread caught on a breakpoint, finish pending steps, then detach. */
  gx_resume_others();
  if (armed && !exited) {
    for (int i = 0; i < GX_SITES; i++) { write_mem(gxbp[i].address, &gxbp[i].original, 1); }
    FlushInstructionCache(process, NULL, 0);
    int quiet = 0;
    while (quiet < 5) {
      if (!WaitForDebugEvent(&ev, 50)) { quiet++; continue; }
      quiet = 0; DWORD status = DBG_CONTINUE;
      if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
        DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode; uintptr_t where = (uintptr_t)ev.u.Exception.ExceptionRecord.ExceptionAddress;
        int ours = 0; for (int i = 0; i < GX_SITES; i++) if (gxbp[i].address == where) ours = 1;
        HANDLE th = thread_of(ev.dwThreadId);
        if (code == EXCEPTION_BREAKPOINT && ours && th) { CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL; GetThreadContext(th, &ctx); ctx.Eip = (DWORD)where; SetThreadContext(th, &ctx); }
        else if (code != EXCEPTION_BREAKPOINT && code != EXCEPTION_SINGLE_STEP) status = DBG_EXCEPTION_NOT_HANDLED;
      } else if (ev.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT && ev.u.LoadDll.hFile) CloseHandle(ev.u.LoadDll.hFile);
      ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status);
    }
  }
  gx_record(GX_END, 0, &events, 4, NULL, 0);
  fclose(gx_out);
  if (!exited) DebugActiveProcessStop(pid);
  fprintf(stderr, "galaxy capture: %ld events%s\n", events, exited ? " (the game exited)" : "");
  for (int i = 0; i < GX_SITES; i++) if (hits[i]) fprintf(stderr, "  0x%08lx kind %d: %ld\n", (unsigned long)gxbp[i].address, gxbp[i].kind, hits[i]);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: dx-live-win.exe rng [count] [interval_ms] | trace <config>\n"); return 2; }
  if (!strcmp(argv[1], "trace")) return argc > 2 ? do_trace(argv[2]) : 2;
  if (!strcmp(argv[1], "weapon")) return argc > 2 ? do_weapon(atoi(argv[2])) : 2;
  if (!strcmp(argv[1], "rngpin")) return argc > 3 ? do_rngpin(atoi(argv[2]), (unsigned)strtoul(argv[3], NULL, 16)) : 2;
  if (!strcmp(argv[1], "stamps")) return argc > 3 ? do_stamps(atoi(argv[2]), argv[3]) : 2;
  if (!strcmp(argv[1], "list")) { QueryPerformanceFrequency(&qpf); return argc > 2 ? do_list(argv[2]) : 2; }
  if (!strcmp(argv[1], "galaxy")) {
    if (argc >= 6 && !strcmp(argv[2], "poll")) return do_galaxy_poll(atoi(argv[3]), atoi(argv[4]), argv[5]);
    if (argc >= 6 && !strcmp(argv[2], "capture")) return do_galaxy_capture(argv[3], atoi(argv[4]), argv[5], argc > 6 ? argv[6] : NULL);
    fprintf(stderr, "galaxy poll <count> <interval_ms> <out prefix> | galaxy capture <out file> <seconds> <map> [stop file]\n"); return 2;
  }
  QueryPerformanceFrequency(&qpf);
  pid = find_pid("DeusEx.exe");
  if (!pid) { fprintf(stderr, "DeusEx.exe not running\n"); return 1; }
  process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_VM_OPERATION | PROCESS_SUSPEND_RESUME, FALSE, pid);
  if (!process) { fprintf(stderr, "cannot open DeusEx.exe\n"); return 1; }
  if (!strcmp(argv[1], "strobe")) {
    if (module_base("Render.dll") != 0x10b00000u) { fprintf(stderr, "Render.dll is not at its preferred base\n"); CloseHandle(process); return 1; }
    const uintptr_t FLAG = 0x10b49ea8, TIME = 0x10b49ea4, JUMP = 0x10b05b4b;
    const char *verb = argc > 2 ? argv[2] : "poll";
    if (!strcmp(verb, "poll")) {
      int count = argc > 3 ? atoi(argv[3]) : 1, interval = argc > 4 ? atoi(argv[4]) : 10;
      uintptr_t info = argc > 5 ? (uintptr_t)strtoul(argv[5], NULL, 16) : 0;
      for (int k = 0; k < count; k++) {
        printf("%lld flag=%u time=%.9g", qpc_us(), read_u32(FLAG), read_float(TIME));
        if (info) printf(" level=%.9g", read_float(info + 0x478));
        printf("\n");
        if (k + 1 < count) Sleep(interval);
      }
    } else if (!strcmp(verb, "hold") || !strcmp(verb, "release")) {
      unsigned char op = 0; read_mem(JUMP, &op, 1);
      if (op != 0x75 && op != 0xeb) { fprintf(stderr, "unexpected byte 0x%02x at 0x%lx\n", op, (unsigned long)JUMP); CloseHandle(process); return 1; }
      if (!strcmp(verb, "hold")) {
        unsigned flag = argc > 3 ? (unsigned)atoi(argv[3]) & 1 : read_u32(FLAG);
        cb_write(JUMP, 0xeb); write_mem(FLAG, &flag, 4);
      } else cb_write(JUMP, 0x75);
      read_mem(JUMP, &op, 1);
      printf("%s: byte 0x%02x flag=%u time=%.9g\n", verb, op, read_u32(FLAG), read_float(TIME));
    } else { fprintf(stderr, "strobe poll|hold|release\n"); CloseHandle(process); return 2; }
    CloseHandle(process); return 0;
  }
  if (!strcmp(argv[1], "fire")) {
    /* the image may be relocated (it was, in a CrossOver process on 2026-10-17): the tick is at its RVA from the loaded base, the
       image checked by its preferred base in the PE header */
    const uintptr_t base = module_base("Fire.dll"), preferred = base ? read_u32(base + read_u32(base + 0x3c) + 0x34) : 0;
    if (!base || preferred != 0x10500000u) { fprintf(stderr, "Fire.dll not found or not the GOTY image (base 0x%lx, preferred 0x%lx)\n", (unsigned long)base, (unsigned long)preferred); CloseHandle(process); return 1; }
    const uintptr_t TICK = base + (0x10507ff0u - 0x10500000u);
    const char *verb = argc > 2 ? argv[2] : "read";
    unsigned char op = 0; read_mem(TICK, &op, 1);
    if (op != 0x55 && op != 0xc3) { fprintf(stderr, "unexpected byte 0x%02x at 0x%lx\n", op, (unsigned long)TICK); CloseHandle(process); return 1; }
    if (!strcmp(verb, "hold") || !strcmp(verb, "release")) {
      cb_write(TICK, !strcmp(verb, "hold") ? 0xc3 : 0x55);
      read_mem(TICK, &op, 1);
      printf("%s: byte 0x%02x at 0x%lx (Fire.dll at 0x%lx)\n", verb, op, (unsigned long)TICK, (unsigned long)base);
    } else if (!strcmp(verb, "read") && argc > 3) {
      core_base = module_base("Core.dll");
      names_table = read_u32(core_base + OFF_NAMES_DATA);
      uintptr_t gog = read_u32(core_base + OFF_GOG_DATA), found = 0;
      unsigned count = read_u32(core_base + OFF_GOG_COUNT);
      for (unsigned slot = 0; slot < count && !found; slot++) {
        uintptr_t obj = read_u32(gog + slot * 4);
        if (obj && !strcmp(object_name(obj), argv[3]) && !strcmp(object_name(read_u32(obj + OFF_OBJECT_CLASS)), "FireTexture")) found = obj;
      }
      if (!found) { fprintf(stderr, "no FireTexture named %s\n", argv[3]); CloseHandle(process); return 1; }
      unsigned char ubits = 0, drawPhase = 0, auxPhase = 0, renderHeat = 0; unsigned usize = read_u32(found + 0x34), vsize = read_u32(found + 0x38);
      read_mem(found + 0x30, &ubits, 1); read_mem(found + 0xd4, &drawPhase, 1); read_mem(found + 0xd5, &auxPhase, 1); read_mem(found + 0xd9, &renderHeat, 1);
      uintptr_t mips = read_u32(found + 0xa4), data = mips ? read_u32(mips + 0x1c) : 0;
      printf("texture %s obj=0x%lx tick=%s usize=%u vsize=%u ubits=%u globalPhase=%u drawPhase=%u auxPhase=%u renderHeat=%u sparks=%u/%u starStatus=%u mips=%u\n",
        argv[3], (unsigned long)found, op == 0xc3 ? "held" : "running", usize, vsize, ubits, read_u32(found + 0xd0), drawPhase, auxPhase, renderHeat,
        read_u32(found + 0xf0), read_u32(found + 0xec), read_u32(found + 0x508), read_u32(found + 0xa8));
      if (!data || !usize || !vsize || usize * vsize > (1u << 20)) { fprintf(stderr, "no mip 0 data\n"); CloseHandle(process); return 1; }
      unsigned char *pixels = malloc(usize * vsize);
      if (!pixels || !read_mem(data, pixels, usize * vsize)) { fprintf(stderr, "cannot read the pixels\n"); CloseHandle(process); return 1; }
      printf("pixels ");
      for (unsigned i = 0; i < usize * vsize; i++) printf("%02x", pixels[i]);
      printf("\n");
      free(pixels);
    } else { fprintf(stderr, "fire hold|release|read <texture name>\n"); CloseHandle(process); return 2; }
    CloseHandle(process); return 0;
  }
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
