# LocalForge Companion for Windows — installation & troubleshooting

Target: **Windows 10/11 x64**. No administrator rights, no Node.js, no npm,
no Python, no PowerShell required for normal use.

## What you get

| File | What it is |
| --- | --- |
| `LocalForge-Companion-Setup-<version>.exe` | Per-user installer (NSIS). ~25 MB. |
| `LocalForgeCompanion\localforge-companion.exe` | The companion service with the Bun runtime **embedded** — a single ~93 MB exe, nothing else to install. |
| `LocalForgeCompanion\LocalForgeTray.exe` | Tray GUI: status, pairing code (+Copy), paired devices, authorized workspaces, detected local inference providers, Start / Stop / Restart / Open LocalForge. Native Win32 binary (~190 KB). |

## Install (beginner path)

1. On the LocalForge website, open the IDE and click **Download LocalForge
   Companion for Windows** (the connection screen; the file is also at
   `/downloads/LocalForge-Companion-Setup-<version>.exe`).
2. Run the downloaded `LocalForge-Companion-Setup-<version>.exe`.
   - **SmartScreen note:** the installer is **NOT digitally signed** (it is
     self-published). Windows may show *"Windows protected your PC"* with an
     *Unknown publisher*. Click **More info → Run anyway**. This is expected
     for this build; do **not** disable antivirus or Defender — running after
     the SmartScreen confirmation is enough. A code-signed build (OV or EV
     certificate) is planned; until then the SHA-256 checksum published next
     to the download is the integrity reference.
3. Keep **Start the LocalForge Companion tray now** checked and finish.
4. The tray app appears (bottom-right). It **auto-starts the companion** and
   shows the **pairing code**. Click **Copy**.
5. Open the LocalForge website → **Launch IDE** → paste the code → **Pair**.
6. Settings → Model providers → **Discover** finds Ollama (:11434),
   LM Studio (:1234), llama.cpp/llama-server (:8080), Lemonade (:8000) or add
   any OpenAI-compatible endpoint / LAN server manually.
7. Authorize a project folder — done. Files, prompts and inference traffic
   stay on your machine (companion binds to `127.0.0.1` only).

The installer can also add a **desktop shortcut** and a **"Start with
Windows"** autostart entry (both optional, autostart off by default — the
companion runs only while you start it; there are no services or drivers).

## Day-to-day

- **Start / Stop / Restart** — tray buttons. *Stop* uses `taskkill /T /F`, so
  child processes (npm builds, dev servers) are cleaned up too.
- **Pairing code** — visible in the tray at all times (and re-printed in the
  companion console if you ever start it manually); **Copy** puts it on the
  clipboard. The code stays valid while the companion runs; press Restart to
  rotate it. `Settings → Companion → Reset pairing code` in the IDE invalidates
  previously paired browsers.
- **Hide to tray** — closing the window keeps the companion running (by
  design); use *Stop* to actually stop it.

## Where your data lives (and why upgrades/uninstall keep it)

`%LOCALAPPDATA%\LocalForgeCompanion\` — `state.json` (pairing tokens stored as
SHA-256 hashes, authorized workspaces), `status.json` (tray GUI data),
`logs\` (structured JSONL metadata — commands, exit codes, durations; never
file contents or prompts).

Upgrades: run the new installer over the old one — `$INSTDIR` files are
replaced, the data folder is untouched (pairing, workspaces and settings
survive). Uninstall removes only the install folder, shortcuts and registry
entries; **the data folder is intentionally preserved** (delete
`%LOCALAPPDATA%\LocalForgeCompanion` manually if you want a full wipe).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| SmartScreen blocks the installer | More info → Run anyway (unsigned build). Verify the SHA-256 checksum if unsure. |
| "Windows can't verify the publisher" | Same as above — expected for an unsigned installer. |
| IDE says "Companion not reachable" | Is the tray icon showing **Running**? If stopped, press **Start**. Check the address shown in the tray (default `http://127.0.0.1:7337`). |
| Pairing code rejected | Codes contain no confusing chars (no 0/O/1/I). Press **Restart** in the tray and copy the fresh code. After 6 failed attempts the companion rate-limits for a minute. |
| Port 7337 already in use | Another companion instance is running — Restart from the tray, or change the port in IDE Settings → Companion (Direct URL) and restart the companion with the same port via `localforge-companion.exe --port <port>`. |
| Browser blocks the connection | Chrome/Edge/Firefox treat `http://127.0.0.1` as trusted even on HTTPS pages. If your browser shows a "local network access" prompt (newer Chrome), click **Allow** — it is your own browser talking to your own machine. |
| **Safari / iOS** | Safari does not treat `127.0.0.1` as trusted from an HTTPS page — **use Chrome, Edge or Firefox on Windows** for the public site. |
| Corporate VPN / security software blocks loopback | Ask IT to allow `LocalForgeCompanion` to bind `127.0.0.1:7337`. Do not disable the security software. |
| Model not discovered | Start your inference server first (Ollama/LM Studio/llama-server/Lemonade), then Discover again, or add the endpoint URL manually. LocalForge never installs servers or downloads models for you. |
| Companion window flashes a console | It should not — the tray spawns it windowless. If you started it manually, the console IS the interface (pairing code is printed there). |

## Verification status (honest labels)

- ✅ **Verified on Linux (build environment):** installer compiled with NSIS
  3.11 (exit 0, payload files resolved); PE32+ x64 structure of both
  executables; tray GUI subsystem=GUI (no console flash); NSIS firstheader
  consistency; SHA-256 checksums; the website download URL serving byte-exact
  installer; companion server behavior (pairing, CORS + Private-Network
  preflight for the published HTTPS origin, streaming, chat proxy, tool calls)
  by 27 automated companion tests.
- ⚠️ **UNVERIFIED — requires a real Windows 10/11 x64 machine:** installer
  run (install/upgrade/uninstall), tray GUI operation, `taskkill` child-tree
  cleanup, Start-Menu shortcut resolution, SmartScreen dialog text, autostart
  entry, and a live pairing session from Chrome/Edge on Windows to the
  published HTTPS site with a real local model server. The code paths are the
  same ones covered by the automated tests (cmd.exe wrapper, marker parsing,
  screening lists are unit-covered), but per Microsoft's own guidance nothing
  counts as "tested on Windows" until it has run on Windows.

## For developers

Rebuild the installer on any Linux machine:
`bun run build:windows` (requires `bun`, `zig`, `makensis` + `NSISDIR`;
see `installer/windows/build-windows.sh`). Source:
`installer/windows/` (`tray_main.c`, `installer.nsi`, `entry-companion.ts`).
The npm route remains available: `npm install -g @localforge/companion`.

## Phase 2 source-build verification (Companion v0.4.5)

GitHub Actions now performs an additional **production Next.js build**, then
cross-compiles an unsigned Windows Companion installer and attempts a silent
install/`--help` startup smoke test on a Windows runner. The build is uploaded
as a short-lived **test candidate artifact**, not automatically deployed or
published as a stable release. Actual Windows desktop/tray behavior, existing
installation upgrades, LAN discovery, GPU inference, signing and SmartScreen
remain unverified until tested on real hardware.

The installer opt-in *Start with Windows* section is now unselected by default.
The `npm run build:windows` script points to the actual build script at
`installer/windows/build-windows.sh`. The build script now accepts Zig and NSIS
from `PATH` in addition to its earlier manually installed toolchain paths.
