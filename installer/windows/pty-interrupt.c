// LocalForge Windows ConPTY Ctrl+C helper.
// Invoked ONLY with the PID of LocalForge's own PTY shell subprocess.
// No admin rights, services or additional runtime are needed.
// Bun.Terminal on Windows may relay ETX without generating a console CTRL_C
// event. Attach to the shell's isolated ConPTY console, send CTRL_C_EVENT to
// its console group, then detach. This does not kill the shell manually.
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <tlhelp32.h>

// Verify that a console-attached process is descended from our own PTY shell.
// Never terminate the shell itself, the helper, or an unrelated process.
static BOOL is_shell_descendant(DWORD candidate, DWORD shell_pid, HANDLE snapshot) {
  DWORD current = candidate;
  for (int depth = 0; depth < 24 && current != 0; depth++) {
    if (current == shell_pid) return TRUE;
    PROCESSENTRY32W entry = {0};
    entry.dwSize = sizeof(entry);
    if (!Process32FirstW(snapshot, &entry)) return FALSE;
    BOOL found = FALSE;
    do {
      if (entry.th32ProcessID == current) {
        DWORD next = entry.th32ParentProcessID;
        if (next == current) return FALSE;
        current = next;
        found = TRUE;
        break;
      }
    } while (Process32NextW(snapshot, &entry));
    if (!found) return FALSE;
  }
  return FALSE;
}


int wmain(int argc, wchar_t **argv) {
  if (argc != 2) {
    fwprintf(stderr, L"Usage: LocalForgePtyInterrupt.exe <shell-pid>\n");
    return 2;
  }
  wchar_t *end = NULL;
  unsigned long pid = wcstoul(argv[1], &end, 10);
  if (end == argv[1] || !end || *end != L'\0' || pid == 0) {
    fwprintf(stderr, L"Invalid PTY shell PID\n");
    return 2;
  }

  // A background helper could inherit the CI/parent console. Detach first so
  // the Ctrl+C event is delivered only to the PTY shell's console.
  FreeConsole();
  if (!AttachConsole((DWORD)pid)) {
    fwprintf(stderr, L"AttachConsole(%lu) failed: %lu\n", pid, GetLastError());
    return 3;
  }
  // Prevent the helper from being killed by its own CTRL_C_EVENT.
  if (!SetConsoleCtrlHandler(NULL, TRUE)) {
    fwprintf(stderr, L"SetConsoleCtrlHandler failed: %lu\n", GetLastError());
    FreeConsole();
    return 4;
  }
  // Snapshot ONLY processes attached to this isolated pseudo-console before
  // sending the signal. This prevents a newly launched command from becoming
  // a late kill target and avoids touching unrelated/background consoles.
  DWORD members[128];
  DWORD count = GetConsoleProcessList(members, 128);
  if (count > 128) {
    FreeConsole();
    return 6; // fail closed if enumeration is truncated
  }
  if (!GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)) {
    fwprintf(stderr, L"GenerateConsoleCtrlEvent failed: %lu\n", GetLastError());
    FreeConsole();
    return 5;
  }

  // Bun's Windows ConPTY can acknowledge CTRL_C_EVENT without delivering it
  // to foreground child processes. Give them a graceful interrupt window.
  // If they remain attached to THIS console, terminate only descendants of
  // the specific managed PTY shell; never terminate the shell itself.
  Sleep(1200);
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) {
    FreeConsole();
    return 7;
  }
  DWORD me = GetCurrentProcessId();
  int forced = 0;
  for (DWORD i = 0; i < count; i++) {
    DWORD member = members[i];
    if (!member || member == (DWORD)pid || member == me) continue;
    if (!is_shell_descendant(member, (DWORD)pid, snapshot)) continue;
    HANDLE proc = OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, FALSE, member);
    if (!proc) continue;
    if (WaitForSingleObject(proc, 0) == WAIT_TIMEOUT) {
      // STATUS_CONTROL_C_EXIT. Explicit Ctrl+C is a user request to
      // interrupt the command, not a request to end the interactive shell.
      if (TerminateProcess(proc, 0xC000013AUL)) forced++;
    }
    CloseHandle(proc);
  }
  CloseHandle(snapshot);
  FreeConsole();
  return forced > 0 ? 10 : 0;
}
