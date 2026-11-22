// Windows companion entry for `bun build --compile`.
// The tray GUI (LocalForgeTray.exe) spawns this executable with:
//   localforge-companion.exe --port 7337 --status-file <path> --show-code
// All server logic is the unchanged companion server (src/server.js).
import '../../companion/src/server.js';
