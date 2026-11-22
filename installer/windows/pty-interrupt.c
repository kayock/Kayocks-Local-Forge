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
  if (!GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)) {
    fwprintf(stderr, L"GenerateConsoleCtrlEvent failed: %lu\n", GetLastError());
    FreeConsole();
    return 5;
  }
  Sleep(250);
  FreeConsole();
  return 0;
}
