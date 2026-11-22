# LocalForge source audit & targeted repairs — 2026-11-21

**Input:** user-provided LocalForge IDE source archive plus Companion 0.4.4 source.
**Scope:** offline source review and isolated regression tests, no production install or machine altered.
**Version:** IDE package 0.2.1; Companion package 0.4.4. Version numbers were not bumped.

## Verified repairs

1. **Workspace path containment:** `assertInsideReal` now validates the nearest existing ancestor and rejects paths traversing symbolic links that escape the authorized workspace, even if the requested leaf file does not yet exist. Added a second validation after creating parent directories for write, append, and mkdir operations.
2. **Metadata and rename:** `statPath` checks symlink containment. Rename now validates both source and destination, and rejects overwriting an existing destination unless the caller explicitly supplies `overwrite: true`. The authenticated API forwards that flag.
3. **Archive extraction:** validates the archive's own path and extraction destination, validates each output path before and after parent directory creation, rejects `..`, absolute, and Windows-drive member names, and enforces entry/decompression limits before writing.
4. **Static preview:** checks every requested file (including fallbacks and `index.html`) against the canonical configured preview root before serving it. A symlinked preview file can no longer expose an outside file.
5. **Source packaging:** `scripts/build-source-zip.sh` no longer includes `db/custom.db`, is independent of a hard-coded build directory, packages needed root configuration files, and validates both ZIPs for forbidden runtime data. `.gitignore` now excludes live SQLite databases.

## Test results

- Companion: `cd companion && npm test` — **28 passed / 0 failed**.
- New boundary regression tests: **5**; cover file operations through outside symlinks, metadata reads, safe rename semantics, ZIP extraction destinations/member traversal, and preview leakage.
- Both sanitized source ZIPs passed `unzip -tqq` integrity checks and secret-file-name filters.
- Tests use temporary directories; they do **not** test a deployed Windows EXE, Linux DEB, or any real user's running services.

## Not repaired / needs separate implementation

- **Mesh/agent/model-management API gap:** IDE `src/lib/mesh/client.ts` calls `/api/hardware`, `/api/models`, `/api/mesh/...`, `/api/network`, `/api/agents/...`, and `/api/ws/:id/revision`, but this Companion 0.4.4 source does not implement that Phase 2 control-plane contract. The limited hardware summary in `/health` is not equivalent. Do not advertise multi-machine coordination as ready until the matching backend is implemented and integration-tested.
- **Symlink race:** Canonical-path validation prevents the demonstrated static escapes, but any check-then-open filesystem design remains vulnerable to a *concurrent local process* swapping symlinks between validation and use. Complete race resistance would require file-descriptor-relative traversal on platforms that support it. Command execution by an authorized user remains outside this jail design.
- **Potentially overbroad dev proxy:** the `/p/:token/:port` proxy and `Caddyfile` transformer merit additional network-security review before exposure outside a trusted environment.
- **IDE compilation/integration:** Node test suite is available offline; `node_modules` and the Bun runner were absent, so full Next.js compilation and live multi-machine flows were not verified here.
- **Compiled installers:** supplied Windows installers in the 120MB `LocalForgeTray (2).zip` were not rebuilt. They contain the older embedded code unless rebuilt from this repaired source.

## Publishing precautions

The original IDE archive contained a populated `db/custom.db` with a user, password hash, session-token hash, and subscription record. The patched source tree and the new ZIP do **not** contain that database. Do not publish the original user-provided ZIP or older installer package as a source archive; regenerate from the sanitized tree. If a copy of the original database was ever published, assess session revocation and credential rotation appropriately.

No new API keys, account requirements, authentication checks, or model selection defaults were introduced by these targeted repairs. No installations were restarted or modified.
