; LocalForge Companion — Windows per-user installer (NSIS 3.x)
;
; Installs: LocalForgeCompanion\{localforge-companion.exe, LocalForgeTray.exe}
;   - localforge-companion.exe : standalone companion (Bun runtime embedded,
;     no Node.js/npm/Python needed on the user's machine)
;   - LocalForgeTray.exe       : tray GUI (status, pairing code, workspaces,
;     providers, Start/Stop/Restart/Open LocalForge)
;
; Design decisions:
;   - Per-user install to %LOCALAPPDATA%\Programs\LocalForge Companion:
;     no administrator privileges required (the companion binds 127.0.0.1:7337,
;     an unprivileged port, and only writes to the user's profile).
;   - Companion data (pairing tokens, authorized workspaces, logs) lives in
;     %LOCALAPPDATA%\LocalForgeCompanion — OUTSIDE $INSTDIR — so upgrades and
;     uninstall never touch user settings, authorized workspaces or pairing.
;   - No services, no drivers, no autorun: the companion runs only when the
;     user starts it (tray auto-starts it; "Start with Windows" is optional
;     and off by default).
;   - The installer is NOT digitally signed (self-published build). Windows
;     SmartScreen will show an "Unknown publisher" warning — see
;     docs/WINDOWS_INSTALL.md for what the user should do.

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define /ifndef VERSION "0.5.0"
!define PRODUCT_NAME "LocalForge Companion"
!define PRODUCT_PUBLISHER "LocalForge"
!define PRODUCT_URL "https://d1jnn9t1yrn0-d.space-z.ai"
!define EXE_VERSION "${VERSION}.0"

Name "${PRODUCT_NAME} ${VERSION}"
OutFile "..\..\download\windows\LocalForge-Companion-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\LocalForge Companion"
InstallDirRegKey HKCU "Software\LocalForge\Companion" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\LocalForgeCompanion\LocalForgeTray.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start the LocalForge Companion tray now"
!define MUI_FINISHPAGE_RUN_CHECKED

; Installer pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\windows\LICENSE.txt"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; Uninstaller pages
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "LocalForge Companion (required)" SEC_CORE
  SectionIn RO
  SetOutPath "$INSTDIR\LocalForgeCompanion"
  File "..\..\download\windows\LocalForgeCompanion\localforge-companion.exe"
  File "..\..\download\windows\LocalForgeCompanion\LocalForgeTray.exe"
  File "..\..\download\windows\LocalForgeCompanion\LocalForgePtyInterrupt.exe"

  ; Real PTY backend: prebuilt node-pty sidecar loaded at runtime from
  ; <exe-dir>/pty-sidecar/node-pty (companion/src/pty.js resolves it relative
  ; to the installed executable). Without this directory the companion falls
  ; back to the NDJSON streaming terminal.
  File /r "..\..\download\windows\LocalForgeCompanion\pty-sidecar"

  ; registry: uninstall info + install dir memory
  WriteRegStr HKCU "Software\LocalForge\Companion" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\LocalForge\Companion" "Version" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalForgeCompanion" \
                 "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalForgeCompanion" \
                 "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalForgeCompanion" \
                 "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalForgeCompanion" \
                 "URLInfoAbout" "${PRODUCT_URL}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalForgeCompanion" \
                 "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalForgeCompanion" \
                 "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalForgeCompanion" \
                 "NoRepair" 1
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Start Menu shortcut" SEC_SM
  CreateDirectory "$SMPROGRAMS\LocalForge"
  CreateShortcut "$SMPROGRAMS\LocalForge\LocalForge Companion.lnk" "$INSTDIR\LocalForgeCompanion\LocalForgeTray.exe" \
                 "" "$INSTDIR\LocalForgeCompanion"
  CreateShortcut "$SMPROGRAMS\LocalForge\LocalForge IDE (website).lnk" "${PRODUCT_URL}" \
                 "" "$INSTDIR\LocalForgeCompanion"
  CreateShortcut "$SMPROGRAMS\LocalForge\Uninstall LocalForge Companion.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section /o "Desktop shortcut" SEC_DESK
  CreateShortcut "$DESKTOP\LocalForge Companion.lnk" "$INSTDIR\LocalForgeCompanion\LocalForgeTray.exe" \
                 "" "$INSTDIR\LocalForgeCompanion"
SectionEnd

Section /o "Start with Windows (run companion at login)" SEC_AUTORUN
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LocalForgeCompanionTray" \
                 '"$INSTDIR\LocalForgeCompanion\LocalForgeTray.exe" /minimize'
SectionEnd

; ---- descriptions on the components page ----
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} "The companion service and tray app. Required — connects the LocalForge IDE in your browser to this computer."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SM} "Create a LocalForge Companion shortcut in the Start Menu."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESK} "Create a shortcut on the desktop."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_AUTORUN} "Start the companion automatically when you log in. Leave off if you prefer to start it manually."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ---- uninstaller: removes ONLY the installed files + shortcuts + registry.
;      %LOCALAPPDATA%\LocalForgeCompanion (pairing, workspaces, logs) is
;      intentionally PRESERVED so reinstalling keeps the user's setup. ----
Section "Uninstall"
  ; stop a running companion + tray before removing files
  ExecWait 'taskkill.exe /IM localforge-companion.exe /T /F'
  ExecWait 'taskkill.exe /IM LocalForgeTray.exe /T /F'
  Delete "$INSTDIR\LocalForgeCompanion\localforge-companion.exe"
  Delete "$INSTDIR\LocalForgeCompanion\LocalForgeTray.exe"
  Delete "$INSTDIR\LocalForgeCompanion\LocalForgePtyInterrupt.exe"
  RMDir /r "$INSTDIR\LocalForgeCompanion\pty-sidecar"
  RMDir "$INSTDIR\LocalForgeCompanion"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\LocalForge\LocalForge Companion.lnk"
  Delete "$SMPROGRAMS\LocalForge\LocalForge IDE (website).lnk"
  Delete "$SMPROGRAMS\LocalForge\Uninstall LocalForge Companion.lnk"
  RMDir "$SMPROGRAMS\LocalForge"
  Delete "$DESKTOP\LocalForge Companion.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalForgeCompanion"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LocalForgeCompanionTray"
  ; HKCU\Software\LocalForge\Companion InstallDir is kept intentionally
SectionEnd

; ---- version metadata on the setup exe ----
VIProductVersion "${EXE_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1033 "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey /LANG=1033 "FileDescription" "${PRODUCT_NAME} installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "MIT License"
