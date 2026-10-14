/*
 * dxinput — post keyboard input to a running original Deus Ex (DeusEx.exe)
 * inside the same Wine/CrossOver bottle. Used only to stage camera views for
 * the promo video's original-game screenshots; it never reads or writes game
 * memory. UE1's WinDrv (UseDirectInput=False) reads keys from window messages,
 * so posted WM_KEYDOWN/WM_CHAR reach the game without window focus.
 *
 * Build: i686-w64-mingw32-gcc -O2 -o dxinput.exe dxinput.c
 * Usage: wine dxinput.exe find
 *        wine dxinput.exe run script.txt
 * Script lines (one action per line, '#' comments):
 *   sleep <ms>            wait
 *   key <name> [holdMs]   press and release a key
 *   down <name> / up <name>
 *   type <text>           WM_CHAR for every character
 *   cmd <console line>    T (Talk), clear the "Say " prefix, type, Enter
 *   shot                  numpad * (User.ini GreyStar=Shot)
 *   button <title>        BM_CLICK a visible dialog button of DeusEx.exe
 *   move <x> <y> / click <x> <y>   mouse in viewport client coordinates
 *   rclick <x> <y>        right button click (same coordinates)
 *   mclick <x> <y>        middle button click (a mouse key reaches the bindings even under a UI
 *                         screen, which grabs every keyboard key; docs/visual-acceptance.md)
 *   focus                 give the game's top-level window and viewport the Wine foreground and
 *                         keyboard focus (WinDrv reads GetFocus/GetKeyState, so a key held by a
 *                         posted message only counts while the window has focus), and report
 *                         the game thread's active/focus windows
 *   focusinfo             report them without changing anything
 *   sdown <key> / sup <key> / shold <key> <ms>
 *                         the same keys through the Wine input queue (keybd_event), which updates
 *                         the thread's key state as a real key does; a posted WM_KEYDOWN does
 *                         not, and the game's held-key axes (MoveForward and the others) need it
 */
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>
#include <ctype.h>

static DWORD pids[16];
static int pidCount;
static HWND target;
static long bestArea;

static void findPids(void) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32 entry = {sizeof entry};
  if (snap == INVALID_HANDLE_VALUE) return;
  for (BOOL ok = Process32First(snap, &entry); ok; ok = Process32Next(snap, &entry))
    if (_stricmp(entry.szExeFile, "DeusEx.exe") == 0 && pidCount < 16) pids[pidCount++] = entry.th32ProcessID;
  CloseHandle(snap);
}

static int ownedByGame(HWND hwnd) {
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  for (int i = 0; i < pidCount; i++) if (pids[i] == pid) return 1;
  return 0;
}

static void describe(const char *prefix, HWND hwnd) {
  char title[256] = "", cls[256] = "";
  RECT rc = {0};
  GetWindowTextA(hwnd, title, sizeof title);
  GetClassNameA(hwnd, cls, sizeof cls);
  GetClientRect(hwnd, &rc);
  printf("%s hwnd=%p class=\"%s\" title=\"%s\" client=%ldx%ld visible=%d\n", prefix, (void *)hwnd, cls, title,
         rc.right - rc.left, rc.bottom - rc.top, IsWindowVisible(hwnd));
}

static BOOL CALLBACK childProc(HWND hwnd, LPARAM verbose) {
  char cls[256] = "";
  RECT rc = {0};
  if (verbose) describe("  child", hwnd);
  GetClassNameA(hwnd, cls, sizeof cls);
  GetClientRect(hwnd, &rc);
  long area = (long)(rc.right - rc.left) * (rc.bottom - rc.top);
  if (strstr(cls, "Viewport") && area >= bestArea) { bestArea = area; target = hwnd; }
  return TRUE;
}

static BOOL CALLBACK topProc(HWND hwnd, LPARAM verbose) {
  if (!ownedByGame(hwnd)) return TRUE;
  char cls[256] = "";
  RECT rc = {0};
  if (verbose) describe("top", hwnd);
  GetClassNameA(hwnd, cls, sizeof cls);
  GetClientRect(hwnd, &rc);
  long area = (long)(rc.right - rc.left) * (rc.bottom - rc.top);
  if (IsWindowVisible(hwnd) && (strstr(cls, "Viewport") || !target) && area >= bestArea) { bestArea = area; target = hwnd; }
  EnumChildWindows(hwnd, childProc, verbose);
  return TRUE;
}

static int locate(int verbose) {
  findPids();
  if (!pidCount) { fprintf(stderr, "DeusEx.exe is not running in this bottle\n"); return 0; }
  EnumWindows(topProc, verbose);
  if (!target) { fprintf(stderr, "no DeusEx.exe window found\n"); return 0; }
  if (verbose) describe("target", target);
  return 1;
}

static int vkFor(const char *name) {
  static const struct { const char *name; int vk; } table[] = {
    {"TILDE", VK_OEM_3}, {"PRINT", VK_SNAPSHOT}, {"ENTER", VK_RETURN}, {"ESC", VK_ESCAPE}, {"SPACE", VK_SPACE}, {"BACK", VK_BACK}, {"TAB", VK_TAB},
    {"MULTIPLY", VK_MULTIPLY}, {"UP", VK_UP}, {"DOWN", VK_DOWN}, {"LEFT", VK_LEFT}, {"RIGHT", VK_RIGHT},
    {"SHIFT", VK_SHIFT}, {"CTRL", VK_CONTROL}, {"F1", VK_F1}, {"F2", VK_F2}, {"F3", VK_F3}, {"F4", VK_F4},
    {"F5", VK_F5}, {"F6", VK_F6}, {"F7", VK_F7}, {"F8", VK_F8}, {"F9", VK_F9}, {"F10", VK_F10},
    {"F11", VK_F11}, {"F12", VK_F12}, {"HOME", VK_HOME}, {"END", VK_END}, {"PGUP", VK_PRIOR}, {"PGDN", VK_NEXT},
    {"NUM0", VK_NUMPAD0}, {"NUM1", VK_NUMPAD1}, {"NUM2", VK_NUMPAD2}, {"NUM3", VK_NUMPAD3}, {"NUM4", VK_NUMPAD4},
    {"NUM5", VK_NUMPAD5}, {"NUM6", VK_NUMPAD6}, {"NUM7", VK_NUMPAD7}, {"NUM8", VK_NUMPAD8}, {"NUM9", VK_NUMPAD9},
  };
  for (size_t i = 0; i < sizeof table / sizeof table[0]; i++) if (_stricmp(name, table[i].name) == 0) return table[i].vk;
  if (strlen(name) == 1 && isalnum((unsigned char)name[0])) return toupper((unsigned char)name[0]);
  return 0;
}

static int extended(int vk) {
  return vk == VK_UP || vk == VK_DOWN || vk == VK_LEFT || vk == VK_RIGHT || vk == VK_HOME || vk == VK_END ||
         vk == VK_PRIOR || vk == VK_NEXT;
}

static void keyEdge(int vk, int down) {
  UINT scan = MapVirtualKeyA(vk, 0);
  LPARAM lp = 1 | ((LPARAM)scan << 16) | (extended(vk) ? (1 << 24) : 0);
  if (!down) lp |= (1u << 30) | (1u << 31);
  PostMessageA(target, down ? WM_KEYDOWN : WM_KEYUP, vk, lp);
}

/* A key through the input queue: delivered to the focus window (the game's viewport, see focusinfo)
 * and recorded in the thread's key state. */
static void sendEdge(int vk, int down) {
  UINT scan = MapVirtualKeyA(vk, 0);
  DWORD flags = (down ? 0 : KEYEVENTF_KEYUP) | (extended(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
  keybd_event((BYTE)vk, (BYTE)scan, flags, 0);
}

static void typeText(const char *text) {
  for (const char *c = text; *c; c++) { PostMessageA(target, WM_CHAR, (unsigned char)*c, 1); Sleep(12); }
}

static void press(int vk, int holdMs) { keyEdge(vk, 1); Sleep(holdMs); keyEdge(vk, 0); Sleep(40); }

static void consoleLine(const char *line) {
  press('T', 60);               /* User.ini t=Talk opens the typing line with "Say " */
  Sleep(250);
  for (int i = 0; i < 10; i++) press(VK_BACK, 15);
  typeText(line);
  Sleep(60);
  press(VK_RETURN, 40);
  Sleep(150);
}

static const char *wantedButton;
static int buttonClicked;

static BOOL CALLBACK buttonChild(HWND hwnd, LPARAM unused) {
  char cls[64] = "", title[256] = "";
  (void)unused;
  GetClassNameA(hwnd, cls, sizeof cls);
  GetWindowTextA(hwnd, title, sizeof title);
  if (!buttonClicked && !_stricmp(cls, "Button") && IsWindowVisible(hwnd) && !_stricmp(title, wantedButton)) {
    SendMessageA(hwnd, BM_CLICK, 0, 0);
    buttonClicked = 1;
  }
  return TRUE;
}

static BOOL CALLBACK buttonTop(HWND hwnd, LPARAM unused) {
  if (ownedByGame(hwnd)) EnumChildWindows(hwnd, buttonChild, unused);
  return TRUE;
}

/* Clicks a visible dialog button owned by DeusEx.exe, e.g. "Run Deus Ex" in
 * the Recovery Mode wizard that follows an unclean shutdown. */
static void clickButton(const char *title) {
  wantedButton = title;
  buttonClicked = 0;
  EnumWindows(buttonTop, 0);
  if (!buttonClicked) fprintf(stderr, "no visible button \"%s\"\n", title);
}

static void mouse(int x, int y, int click) {
  LPARAM pos = MAKELPARAM(x, y);
  PostMessageA(target, WM_MOUSEMOVE, 0, pos);
  Sleep(60);
  if (!click) return;
  PostMessageA(target, WM_LBUTTONDOWN, MK_LBUTTON, pos);
  Sleep(80);
  PostMessageA(target, WM_LBUTTONUP, 0, pos);
  Sleep(60);
}

static DWORD gameThread(void) {
  DWORD pid = 0;
  return GetWindowThreadProcessId(target, &pid);
}

static void focusInfo(const char *what) {
  GUITHREADINFO info = {sizeof info};
  if (GetGUIThreadInfo(gameThread(), &info))
    printf("%s: active=%p focus=%p capture=%p foreground=%p target=%p\n", what, (void *)info.hwndActive, (void *)info.hwndFocus,
           (void *)info.hwndCapture, (void *)GetForegroundWindow(), (void *)target);
  else printf("%s: GetGUIThreadInfo failed (%lu)\n", what, GetLastError());
}

/* Wine-side focus only: no compositor involved. */
static void takeFocus(void) {
  HWND top = GetAncestor(target, GA_ROOT);
  DWORD game = gameThread(), mine = GetCurrentThreadId();
  focusInfo("before");
  AttachThreadInput(mine, game, TRUE);
  SetForegroundWindow(top);
  SetActiveWindow(top);
  SetFocus(target);
  AttachThreadInput(mine, game, FALSE);
  Sleep(100);
  focusInfo("after");
}

static void rmouse(int x, int y) {
  LPARAM pos = MAKELPARAM(x, y);
  PostMessageA(target, WM_MOUSEMOVE, 0, pos);
  Sleep(60);
  PostMessageA(target, WM_RBUTTONDOWN, MK_RBUTTON, pos);
  Sleep(80);
  PostMessageA(target, WM_RBUTTONUP, 0, pos);
  Sleep(60);
}

static void mmouse(int x, int y) {
  LPARAM pos = MAKELPARAM(x, y);
  PostMessageA(target, WM_MOUSEMOVE, 0, pos);
  Sleep(60);
  PostMessageA(target, WM_MBUTTONDOWN, MK_MBUTTON, pos);
  Sleep(80);
  PostMessageA(target, WM_MBUTTONUP, 0, pos);
  Sleep(60);
}

static void trim(char *s) {
  size_t n = strlen(s);
  while (n && (s[n - 1] == '\n' || s[n - 1] == '\r' || s[n - 1] == ' ')) s[--n] = 0;
}

static int runScript(const char *path) {
  FILE *file = fopen(path, "r");
  if (!file) { fprintf(stderr, "cannot open %s\n", path); return 1; }
  char line[1024];
  while (fgets(line, sizeof line, file)) {
    trim(line);
    char *p = line;
    while (*p == ' ') p++;
    if (!*p || *p == '#') continue;
    char verb[32] = "";
    int used = 0;
    sscanf(p, "%31s %n", verb, &used);
    char *arg = p + used;
    if (!_stricmp(verb, "sleep")) Sleep(atoi(arg));
    else if (!_stricmp(verb, "key") || !_stricmp(verb, "down") || !_stricmp(verb, "up")) {
      char name[32] = "";
      int hold = 60;
      sscanf(arg, "%31s %d", name, &hold);
      int vk = vkFor(name);
      if (!vk) { fprintf(stderr, "unknown key %s\n", name); continue; }
      if (!_stricmp(verb, "key")) press(vk, hold);
      else keyEdge(vk, !_stricmp(verb, "down"));
    } else if (!_stricmp(verb, "type")) typeText(arg);
    else if (!_stricmp(verb, "cmd")) consoleLine(arg);
    else if (!_stricmp(verb, "shot")) { press(VK_MULTIPLY, 60); Sleep(400); }
    else if (!_stricmp(verb, "button")) clickButton(arg);
    else if (!_stricmp(verb, "sdown") || !_stricmp(verb, "sup") || !_stricmp(verb, "shold")) {
      char name[32] = "";
      int hold = 100;
      sscanf(arg, "%31s %d", name, &hold);
      int vk = vkFor(name);
      if (!vk) { fprintf(stderr, "unknown key %s\n", name); continue; }
      if (!_stricmp(verb, "shold")) { sendEdge(vk, 1); Sleep(hold); sendEdge(vk, 0); Sleep(40); }
      else sendEdge(vk, !_stricmp(verb, "sdown"));
    }
    else if (!_stricmp(verb, "focus")) takeFocus();
    else if (!_stricmp(verb, "focusinfo")) focusInfo("info");
    else if (!_stricmp(verb, "mclick")) {
      int x = 0, y = 0;
      sscanf(arg, "%d %d", &x, &y);
      mmouse(x, y);
    }
    else if (!_stricmp(verb, "rclick")) {
      int x = 0, y = 0;
      sscanf(arg, "%d %d", &x, &y);
      rmouse(x, y);
    }
    else if (!_stricmp(verb, "move") || !_stricmp(verb, "click")) {
      int x = 0, y = 0;
      sscanf(arg, "%d %d", &x, &y);
      mouse(x, y, !_stricmp(verb, "click"));
    }
    else fprintf(stderr, "unknown action %s\n", verb);
    printf("%s %s\n", verb, arg);
    fflush(stdout);
  }
  fclose(file);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: dxinput find | run <script>\n"); return 2; }
  if (!_stricmp(argv[1], "find")) return locate(1) ? 0 : 1;
  if (!_stricmp(argv[1], "run") && argc > 2) return locate(0) ? runScript(argv[2]) : 1;
  fprintf(stderr, "usage: dxinput find | run <script>\n");
  return 2;
}
