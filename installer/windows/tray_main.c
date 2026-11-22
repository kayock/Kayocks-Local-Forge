// LocalForge Companion — Windows tray GUI (native Win32, zero runtime deps).
//
// Purpose: give non-technical users a window/tray icon to start/stop/restart
// the LocalForge companion, read + copy the pairing code, see paired devices,
// authorized workspaces, and locally detected inference providers — without
// ever opening a terminal.
//
// Data sources (no prompting, no scraping):
//   %LOCALAPPDATA%\LocalForgeCompanion\status.json  — written by the
//     companion via --status-file (pid, port, pairingCode, workspaces,
//     devices). The tray spawns the companion with that flag.
//
// Controls: Start / Stop / Restart / Open LocalForge buttons, Copy-code
// button, tray icon with context menu. Stop uses `taskkill /PID <pid> /T /F`
// so the companion AND its child processes (builds, dev servers) all die.
//
// Build: zig cc -target x86_64-windows-gnu -O2 -mwindows -municode
//        -luser32 -lshell32 -lgdi32 -ladvapi32 -lcomctl32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <ws2tcpip.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define APP_NAME        L"LocalForgeCompanionTray"
#define WINDOW_TITLE    L"LocalForge Companion"
#define WM_TRAYICON     (WM_APP + 1)
#define IDI_TRAY        1
#define TIMER_TICK      1500
#define MAX_STATUS      16384

// Published LocalForge website (the IDE the pairing code is entered into).
#define LOCALFORGE_URL  L"https://d1jnn9t1yrn0-d.space-z.ai"

// Known local inference servers (detection only — the tray never talks to
// models; the IDE discovers them through the companion at request time).
static const struct { int port; const wchar_t* name; } PROBE_PORTS[] = {
    { 11434, L"Ollama" },
    { 1234,  L"LM Studio" },
    { 8080,  L"llama.cpp (llama-server)" },
    { 8000,  L"Lemonade Server" },
    { 1337,  L"llama-server (alt port)" },
};

// Control IDs
enum {
    IDC_START = 101, IDC_STOP, IDC_RESTART, IDC_OPEN,
    IDC_COPYCODE, IDC_EXIT,
    IDC_STATUS, IDC_ADDRESS, IDC_CODE, IDC_DEVICES,
    IDC_WORKSPACES, IDC_PROVIDERS, IDC_HINT, IDC_HEALTH
};

enum AppState { APP_STOPPED = 0, APP_RUNNING, APP_UNKNOWN };

static HWND g_hwnd;
static HANDLE g_childProcess = NULL;      // companion we spawned (this tray run)
static HICON g_hIcon;
static NOTIFYICONDATAW g_nid;
static char g_statusJson[MAX_STATUS];     // last known status.json (UTF-8 bytes)
static int g_statusFresh = 0;             // status.json read OK on last tick
static int g_port = 7337;
static DWORD g_pidFromStatus = 0;

// UTF-8 → UTF-16 (status.json may contain non-ASCII workspace/device labels)
static void toW(const char* src, wchar_t* dst, size_t dstLen) {
    if (!src || !*src) { if (dstLen) dst[0] = 0; return; }
    if (MultiByteToWideChar(CP_UTF8, 0, src, -1, dst, (int)dstLen) <= 0 && dstLen) dst[0] = 0;
}

// ---------- tiny JSON helpers (status.json is flat + 2 small arrays) ----------

// Copy a "key": "value" string (with \" and \\ unescaping) into out (UTF-8).
static int json_str(const char* json, const char* key, char* out, size_t outLen) {
    char pat[64];
    _snprintf_s(pat, sizeof(pat), _TRUNCATE, "\"%s\"", key);
    const char* p = strstr(json, pat);
    if (!p) return 0;
    p = strchr(p + strlen(pat), ':');
    if (!p) return 0;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '"') return 0;
    p++;
    size_t o = 0;
    while (*p && *p != '"' && o + 1 < outLen) {
        if (*p == '\\' && (p[1] == '\\' || p[1] == '"')) { out[o++] = p[1]; p += 2; }
        else if (*p == '\\' && p[1] == 'u') { // \uXXXX — approximate with '?'
            out[o++] = '?';
            p += 6;
        } else out[o++] = *p++;
    }
    out[o] = 0;
    return 1;
}

static int json_int(const char* json, const char* key, int defVal) {
    char pat[64];
    _snprintf_s(pat, sizeof(pat), _TRUNCATE, "\"%s\"", key);
    const char* p = strstr(json, pat);
    if (!p) return defVal;
    p = strchr(p + strlen(pat), ':');
    if (!p) return defVal;
    return atoi(p + 1);
}

// List all string values of json[key] array entries under `field`
// (e.g. workspaces[].name, devices[].label) into out (UTF-8), one per line.
static void json_list(const char* json, const char* key, const char* field, char* out, size_t outLen) {
    out[0] = 0;
    char pat[64];
    _snprintf_s(pat, sizeof(pat), _TRUNCATE, "\"%s\"", key);
    const char* p = strstr(json, pat);
    if (!p) return;
    p = strchr(p + strlen(pat), '[');
    if (!p) return;
    const char* end = strchr(p, ']');
    if (!end) return;
    size_t o = 0, count = 0;
    for (const char* q = p; q < end && o + 1 < outLen; q++) {
        char fpat[64];
        _snprintf_s(fpat, sizeof(fpat), _TRUNCATE, "\"%s\"", field);
        q = strstr(q, fpat);
        if (!q || q >= end) break;
        q = strchr(q + strlen(fpat), '"');
        if (!q || q >= end) break;
        q++;
        char item[600];
        size_t i = 0;
        while (*q && *q != '"' && i + 1 < 600) {
            if (*q == '\\' && (q[1] == '\\' || q[1] == '"')) { item[i++] = q[1]; q += 2; }
            else if (*q == '\\' && q[1] == 'u') { q += 6; item[i++] = '?'; }
            else item[i++] = *q++;
        }
        item[i] = 0;
        if (i) {
            o += _snprintf_s(out + o, outLen - o, _TRUNCATE, "%s%s", count ? "\r\n" : "", item);
            count++;
        }
    }
    if (!count) _snprintf_s(out, outLen, _TRUNCATE, "(none yet)");
}

// ---------- data access ----------

static const wchar_t* dataDir(void) {
    static wchar_t dir[MAX_PATH];
    if (!dir[0]) {
        const wchar_t* lad = _wgetenv(L"LOCALAPPDATA");
        if (lad) _snwprintf(dir, MAX_PATH, L"%s\\LocalForgeCompanion", lad);
        else _snwprintf(dir, MAX_PATH, L"%s\\.localforge-companion", _wgetenv(L"USERPROFILE") ? _wgetenv(L"USERPROFILE") : L"C:");
    }
    return dir;
}

static void readStatusFile(void) {
    wchar_t path[MAX_PATH];
    _snwprintf(path, MAX_PATH, L"%s\\status.json", dataDir());
    FILE* f = _wfopen(path, L"rb");
    g_statusFresh = 0;
    if (!f) return;
    size_t n = fread(g_statusJson, 1, MAX_STATUS - 1, f);
    fclose(f);
    g_statusJson[n] = 0;
    // a fresh file with "stoppedAt" and no "pid" change still counts; only
    // treat it as fresh if it looks like our schema
    if (strstr(g_statusJson, "\"pairingCode\"")) g_statusFresh = 1;
    g_pidFromStatus = (DWORD)json_int(g_statusJson, "pid", 0);
    g_port = json_int(g_statusJson, "port", 7337);
}

static int companionAlive(void) {
    DWORD pid = 0;
    if (g_childProcess) {
        DWORD code = 0;
        if (GetExitCodeProcess(g_childProcess, &code) && code == STILL_ACTIVE) pid = GetProcessId(g_childProcess);
    }
    if (!pid && g_pidFromStatus) {
        HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, g_pidFromStatus);
        if (h) {
            DWORD code = 0;
            if (GetExitCodeProcess(h, &code) && code == STILL_ACTIVE) pid = g_pidFromStatus;
            CloseHandle(h);
        }
    }
    return pid ? 1 : 0;
}

// TCP probe with 250ms timeout — 1 = something is listening.
static int portOpen(int port) {
    WSADATA wsa;
    static int wsaOk = 0;
    if (!wsaOk) { if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 0; wsaOk = 1; }
    SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
    if (s == INVALID_SOCKET) return 0;
    u_long nb = 1;
    ioctlsocket(s, FIONBIO, &nb);
    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons((u_short)port);
    InetPtonA(AF_INET, "127.0.0.1", &a.sin_addr);
    int r = connect(s, (struct sockaddr*)&a, sizeof(a));
    if (r == SOCKET_ERROR) {
        fd_set w; FD_ZERO(&w); FD_SET(s, &w);
        struct timeval tv = { 0, 250000 };
        r = select(0, NULL, &w, NULL, &tv);
    }
    closesocket(s);
    return r > 0;
}

// ---------- actions ----------

static void startCompanion(void) {
    if (companionAlive()) return;
    wchar_t exe[MAX_PATH], args[700], dir[MAX_PATH];
    GetModuleFileNameW(NULL, exe, MAX_PATH);
    // exe is <install>\LocalForgeTray.exe; companion sits next to it
    wchar_t* slash = wcsrchr(exe, L'\\');
    if (slash) *slash = 0;
    _snwprintf(args, 700, L"\"%s\\localforge-companion.exe\" --port 7337 --status-file \"%s\\status.json\" --home \"%s\"",
               exe, dataDir(), dataDir());
    _snwprintf(dir, MAX_PATH, L"%s", exe);

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof(si)); si.cb = sizeof(si);
    memset(&pi, 0, sizeof(pi));
    if (CreateProcessW(NULL, args, NULL, NULL, FALSE,
                       CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, NULL, dir, &si, &pi)) {
        if (g_childProcess) CloseHandle(g_childProcess);
        g_childProcess = pi.hProcess;   // keep handle; close hThread
        CloseHandle(pi.hThread);
    }
}

static void stopCompanion(void) {
    DWORD pid = 0;
    if (g_childProcess) {
        DWORD code = 0;
        if (GetExitCodeProcess(g_childProcess, &code) && code == STILL_ACTIVE) pid = GetProcessId(g_childProcess);
    }
    if (!pid) pid = g_pidFromStatus;
    if (!pid) return;
    // /T kills the child tree too (npm builds, dev servers), /F because a
    // detached console app does not process WM_CLOSE.
    wchar_t cmd[160];
    _snwprintf(cmd, 160, L"/PID %lu /T /F", (unsigned long)pid);
    SHELLEXECUTEINFOW sei;
    memset(&sei, 0, sizeof(sei));
    sei.cbSize = sizeof(sei);
    sei.lpVerb = L"open";
    sei.lpFile = L"taskkill.exe";
    sei.lpParameters = cmd;
    sei.nShow = SW_HIDE;
    sei.fMask = SEE_MASK_NOASYNC | SEE_MASK_NOCLOSEPROCESS;
    ShellExecuteExW(&sei);
    if (sei.hProcess) { WaitForSingleObject(sei.hProcess, 4000); CloseHandle(sei.hProcess); }
    if (g_childProcess) { CloseHandle(g_childProcess); g_childProcess = NULL; }
}

static void copyPairingCode(void) {
    char code8[16];
    if (!json_str(g_statusJson, "pairingCode", code8, 16)) return;
    wchar_t code[16];
    toW(code8, code, 16);
    if (!OpenClipboard(g_hwnd)) return;
    EmptyClipboard();
    size_t bytes = (wcslen(code) + 1) * sizeof(wchar_t);
    HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if (h) {
        void* m = GlobalLock(h);
        memcpy(m, code, bytes);
        GlobalUnlock(h);
        SetClipboardData(CF_UNICODETEXT, h);
    }
    CloseClipboard();
    SetDlgItemTextW(g_hwnd, IDC_HINT, L"Copied — paste it in the LocalForge IDE pairing box.");
}

static void openLocalForge(void) {
    ShellExecuteW(g_hwnd, L"open", LOCALFORGE_URL, NULL, NULL, SW_SHOWNORMAL);
}

// ---------- UI ----------

static void setEdit(int id, const wchar_t* text) {
    SetDlgItemTextW(g_hwnd, id, text);
}

static void updateUi(void) {
    wchar_t buf[1024];
    int alive = companionAlive();

    if (alive) {
        char url8[128];
        wchar_t url[128];
        if (!json_str(g_statusJson, "url", url8, 128))
            _snprintf(url8, 128, "http://127.0.0.1:%d", g_port);
        toW(url8, url, 128);
        _snwprintf(buf, 1024, L"● Running — %s", url);
        setEdit(IDC_STATUS, buf);
        char code8[16];
        if (json_str(g_statusJson, "pairingCode", code8, 16)) {
            wchar_t code[16];
            toW(code8, code, 16);
            setEdit(IDC_CODE, code);
        } else {
            setEdit(IDC_CODE, L"(starting…)");
        }
        char dev8[1024];
        json_list(g_statusJson, "devices", "label", dev8, 1024);
        toW(dev8, buf, 1024);
        if (!wcscmp(buf, L"(none yet)")) _snwprintf(buf, 1024, L"No browsers paired yet — copy the code and pair in the IDE.");
        setEdit(IDC_DEVICES, buf);
        setEdit(IDC_HEALTH, L"Companion reachable. Pairing code is valid until the companion is stopped.");
    } else if (g_statusFresh && g_pidFromStatus) {
        setEdit(IDC_STATUS, L"○ Stopped (was running)");
        setEdit(IDC_CODE, L"— start the companion first —");
        setEdit(IDC_DEVICES, L"—");
        setEdit(IDC_HEALTH, L"Stopped. Press Start, then copy the pairing code.");
    } else {
        setEdit(IDC_STATUS, L"○ Stopped");
        setEdit(IDC_CODE, L"— start the companion first —");
        setEdit(IDC_DEVICES, L"—");
        setEdit(IDC_HEALTH, L"Stopped. Press Start, then copy the pairing code.");
    }

    char ws8[1024];
    json_list(g_statusJson, "workspaces", "name", ws8, 1024);
    toW(ws8, buf, 1024);
    setEdit(IDC_WORKSPACES, buf);

    // provider detection (local ports only)
    wchar_t prov[512];
    size_t o = 0, found = 0;
    for (size_t i = 0; i < sizeof(PROBE_PORTS) / sizeof(PROBE_PORTS[0]); i++) {
        if (portOpen(PROBE_PORTS[i].port)) {
            o += _snwprintf(prov + o, 512 - o, L"%s%s :%d", found ? L"\r\n" : L"", PROBE_PORTS[i].name, PROBE_PORTS[i].port);
            found++;
        }
    }
    if (!found) _snwprintf(prov, 512, L"No local inference servers detected on standard ports.\r\nYou can still add any endpoint in the IDE (Settings → Model providers).");
    setEdit(IDC_PROVIDERS, prov);

    EnableWindow(GetDlgItem(g_hwnd, IDC_START), !alive);
    EnableWindow(GetDlgItem(g_hwnd, IDC_STOP), alive);
    EnableWindow(GetDlgItem(g_hwnd, IDC_RESTART), alive);
    EnableWindow(GetDlgItem(g_hwnd, IDC_COPYCODE), alive);

    // tray tooltip
    wchar_t tip[128];
    _snwprintf(tip, 128, L"LocalForge Companion — %s", alive ? L"Running" : L"Stopped");
    wcsncpy(g_nid.szTip, tip, 127);
    g_nid.szTip[127] = 0;
    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        g_hwnd = hwnd;
        SetTimer(hwnd, TIMER_TICK, TIMER_TICK, NULL);
        // fallthrough: initial paint handled by timer
        break;
    case WM_TIMER:
        if (wp == TIMER_TICK) {
            readStatusFile();
            if (g_statusFresh && !g_childProcess && g_pidFromStatus) {
                // companion started outside this tray run — attach by pid
            }
            updateUi();
        }
        break;
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case IDC_START:    startCompanion(); Sleep(600); readStatusFile(); updateUi(); break;
        case IDC_STOP:     stopCompanion(); Sleep(600); readStatusFile(); updateUi(); break;
        case IDC_RESTART:  stopCompanion(); Sleep(900); startCompanion(); Sleep(900); readStatusFile(); updateUi(); break;
        case IDC_OPEN:     openLocalForge(); break;
        case IDC_COPYCODE: copyPairingCode(); break;
        case IDC_EXIT:     DestroyWindow(hwnd); break;
        }
        break;
    case WM_TRAYICON:
        if (lp == WM_LBUTTONUP || lp == WM_RBUTTONUP) {
            POINT pt;
            GetCursorPos(&pt);
            HMENU menu = CreatePopupMenu();
            AppendMenuW(menu, MF_STRING, IDC_EXIT, L"Exit tray (companion keeps running)");
            SetForegroundWindow(hwnd);
            TrackPopupMenu(menu, TPM_BOTTOMALIGN | TPM_LEFTALIGN, pt.x, pt.y, 0, hwnd, NULL);
            DestroyMenu(menu);
        }
        break;
    case WM_DESTROY:
        KillTimer(hwnd, TIMER_TICK);
        Shell_NotifyIconW(NIM_DELETE, &g_nid);
        PostQuitMessage(0);
        break;
    default:
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
    return 0;
}

static void addControl(int id, const wchar_t* cls, const wchar_t* text, DWORD style,
                       int x, int y, int w, int h, HFONT font) {
    HWND c = CreateWindowExW(WS_EX_CLIENTEDGE, cls, text, WS_CHILD | WS_VISIBLE | style,
                             x, y, w, h, g_hwnd, (HMENU)(LONG_PTR)id, NULL, NULL);
    SendMessageW(c, WM_SETFONT, (WPARAM)font, TRUE);
}

static void addLabel(const wchar_t* text, int x, int y, int w, HFONT font) {
    HWND c = CreateWindowExW(0, L"STATIC", text, WS_CHILD | WS_VISIBLE | SS_LEFT,
                             x, y, w, 18, g_hwnd, NULL, NULL, NULL);
    SendMessageW(c, WM_SETFONT, (WPARAM)font, TRUE);
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR cmdLine, int nShow) {
    (void)hPrev; (void)cmdLine;
    HANDLE mutex = CreateMutexW(NULL, TRUE, APP_NAME);
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        HWND prev = FindWindowW(WINDOW_TITLE, NULL);
        if (prev) ShowWindow(prev, SW_RESTORE);
        return 0;
    }

    WNDCLASSW wc;
    memset(&wc, 0, sizeof(wc));
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInst;
    wc.lpszClassName = APP_NAME;
    wc.hIcon = LoadIconW(NULL, IDI_APPLICATION);
    wc.hCursor = LoadCursorW(NULL, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    RegisterClassW(&wc);

    HFONT font = CreateFontW(-15, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
    HFONT fontMono = CreateFontW(-16, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET,
                                 OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                 DEFAULT_PITCH | FF_DONTCARE, L"Consolas");

    int W = 480, H = 640;
    RECT wa;
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0);
    int x = wa.right - W - 24, y = wa.bottom - H - 24;

    g_hwnd = CreateWindowExW(0, APP_NAME, WINDOW_TITLE,
                             WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                             x, y, W, H, NULL, NULL, hInst, NULL);
    SendMessageW(g_hwnd, WM_SETFONT, (WPARAM)font, TRUE);

    int m = 16, w = W - 2 * m - 12;
    addLabel(L"Companion", m, m, w, font);
    addControl(IDC_STATUS, L"EDIT", L"Checking…", ES_READONLY | ES_AUTOHSCROLL, m, m + 20, w, 24, font);
    addControl(IDC_HEALTH, L"EDIT", L"", ES_READONLY | ES_AUTOHSCROLL, m, m + 46, w, 22, font);

    addControl(IDC_START, L"BUTTON", L"Start", BS_PUSHBUTTON, m, m + 74, 92, 30, font);
    addControl(IDC_STOP, L"BUTTON", L"Stop", BS_PUSHBUTTON, m + 100, m + 74, 92, 30, font);
    addControl(IDC_RESTART, L"BUTTON", L"Restart", BS_PUSHBUTTON, m + 200, m + 74, 92, 30, font);
    addControl(IDC_OPEN, L"BUTTON", L"Open LocalForge", BS_PUSHBUTTON, m + 300, m + 74, w - 300, 30, font);

    addLabel(L"Pairing code — paste into the IDE", m, m + 116, w, font);
    addControl(IDC_CODE, L"EDIT", L"—", ES_READONLY | ES_CENTER, m, m + 136, w - 110, 30, fontMono);
    addControl(IDC_COPYCODE, L"BUTTON", L"Copy", BS_PUSHBUTTON, m + w - 100, m + 136, 100, 30, font);
    HWND hint = CreateWindowExW(0, L"STATIC", L"", WS_CHILD | WS_VISIBLE | SS_LEFT,
                                m, m + 170, w, 18, g_hwnd, (HMENU)IDC_HINT, NULL, NULL);
    SendMessageW(hint, WM_SETFONT, (WPARAM)font, TRUE);

    addLabel(L"Connected browsers / devices", m, m + 192, w, font);
    addControl(IDC_DEVICES, L"EDIT", L"—", ES_READONLY | ES_MULTILINE | ES_AUTOVSCROLL | WS_VSCROLL, m, m + 212, w, 44, font);

    addLabel(L"Authorized workspaces (folders the IDE may access)", m, m + 260, w, font);
    addControl(IDC_WORKSPACES, L"EDIT", L"(none yet)", ES_READONLY | ES_MULTILINE | ES_AUTOVSCROLL | WS_VSCROLL, m, m + 280, w, 58, font);

    addLabel(L"Detected inference providers (local ports)", m, m + 342, w, font);
    addControl(IDC_PROVIDERS, L"EDIT", L"scanning…", ES_READONLY | ES_MULTILINE | ES_AUTOVSCROLL | WS_VSCROLL, m, m + 362, w, 58, font);

    addLabel(L"Files, prompts and models stay on this computer. The companion binds to 127.0.0.1 only.", m, m + 424, w, font);
    addControl(IDC_EXIT, L"BUTTON", L"Hide to tray", BS_PUSHBUTTON, m, m + 446, w, 30, font);

    // tray icon
    memset(&g_nid, 0, sizeof(g_nid));
    g_nid.cbSize = sizeof(g_nid);
    g_nid.hWnd = g_hwnd;
    g_nid.uID = IDI_TRAY;
    g_nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    g_nid.uCallbackMessage = WM_TRAYICON;
    g_nid.hIcon = g_hIcon = LoadIconW(NULL, IDI_APPLICATION);
    wcsncpy(g_nid.szTip, L"LocalForge Companion", 127);
    Shell_NotifyIconW(NIM_ADD, &g_nid);

    // initial state + auto-start the companion if it is not running
    readStatusFile();
    if (!companionAlive()) startCompanion();
    updateUi();

    ShowWindow(g_hwnd, nShow ? SW_SHOW : SW_SHOW);
    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    // Exiting the tray does NOT stop the companion (by design); users stop it
    // explicitly with the Stop button or via the Exit menu.
    if (mutex) CloseHandle(mutex);
    return 0;
}
