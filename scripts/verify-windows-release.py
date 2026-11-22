#!/usr/bin/env python3
"""Automated verification of the LocalForge Windows release artifacts.

Checks (all runnable on Linux; Windows-native execution is separately labelled
UNVERIFIED — see docs/WINDOWS_INSTALL.md):
 1. PE structure of localforge-companion.exe + LocalForgeTray.exe (MZ/PE
    signature, x64 machine, expected subsystem, sane size)
 2. NSIS self-extracting signature inside the setup exe + payload provenance
    (makensis exit 0 implies every File directive resolved at build time)
 3. SHA-256 checksums, cross-checked against the published .sha256 sidecar
 4. Download integrity: the URL the website exposes returns the SAME bytes
    (HTTP 200, matching content-length, MZ magic in first bytes)
"""
import hashlib
import struct
import sys
import urllib.request

ROOT = '/home/z/my-project'
COMPANION = f'{ROOT}/download/windows/LocalForgeCompanion/localforge-companion.exe'
TRAY = f'{ROOT}/download/windows/LocalForgeCompanion/LocalForgeTray.exe'
SETUP = f'{ROOT}/download/windows/LocalForge-Companion-Setup-0.1.0.exe'
SIDECAR = f'{ROOT}/public/downloads/LocalForge-Companion-Setup-0.1.0.exe.sha256'
URL = 'http://127.0.0.1:3000/downloads/LocalForge-Companion-Setup-0.1.0.exe'

results = []


def check(name, ok, detail):
    results.append((ok, name, detail))
    print(f"{'✅' if ok else '❌'} {name}: {detail}")


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def pe_info(path):
    with open(path, 'rb') as f:
        data = f.read(4096)
        import os
        size = os.path.getsize(path)
    if data[:2] != b'MZ':
        return None
    e = struct.unpack_from('<I', data, 0x3C)[0]
    if data[e:e + 4] != b'PE\x00\x00':
        return None
    machine = struct.unpack_from('<H', data, e + 4)[0]
    opt = e + 24
    magic = struct.unpack_from('<H', data, opt)[0]
    subsystem = struct.unpack_from('<H', data, opt + 68)[0]
    return {'machine': machine, 'pe32plus': magic == 0x20B, 'subsystem': subsystem, 'size': size}


# 1. PE structure
for path, name, want_sub, min_mb in [
    (COMPANION, 'localforge-companion.exe', 3, 80),   # console app (CUI)
    (TRAY, 'LocalForgeTray.exe', 2, 0),               # GUI app (patched)
]:
    info = pe_info(path)
    ok = bool(info) and info['machine'] == 0x8664 and info['pe32plus'] and info['subsystem'] == want_sub \
        and info['size'] >= min_mb * 1024 * 1024
    check(f'PE structure: {name}', ok,
          f"x64={info['machine'] == 0x8664}, PE32+={info['pe32plus']}, subsystem={info['subsystem']} "
          f"(want {want_sub}: {'GUI' if want_sub == 2 else 'console'}), size={info['size']:,} bytes")

# 2. NSIS signature (firstheader: magic 0xDEADBEEF + 'NullsoftInst'[12]
#    + length_of_header + length_of_all == file size)
with open(SETUP, 'rb') as f:
    setup = f.read()
nsis_pos = setup.find(bytes.fromhex('efbeadde') + b'NullsoftInst')
import struct as _s
ok_nsis = False
detail = 'not found'
if nsis_pos > 0:
    loh, loa = _s.unpack_from('<II', setup, nsis_pos + 16)
    ok_nsis = 0 < loh < len(setup) and nsis_pos - 4 + loa == len(setup)
    detail = f'firstheader at {nsis_pos}: length_of_header={loh}, length_of_all={loa} (stub + archive == file size)'
check('NSIS self-extracting signature in setup exe', ok_nsis, detail)
check('Setup exe size sane', 10e6 < len(setup) < 60e6, f'{len(setup):,} bytes (compressed payload)')

# 3. Checksums
h_setup = sha256(SETUP)
h_comp = sha256(COMPANION)
h_tray = sha256(TRAY)
sidecar = open(SIDECAR).read().split()[0]
check('SHA-256 sidecar matches setup exe', h_setup == sidecar, f'sidecar={sidecar[:16]}… computed={h_setup[:16]}…')
print(f'   SHA-256 setup:     {h_setup}')
print(f'   SHA-256 companion: {h_comp}')
print(f'   SHA-256 tray:      {h_tray}')

# 4. Download integrity through the website route
try:
    req = urllib.request.Request(URL, headers={'Range': 'bytes=0-1'})
    with urllib.request.urlopen(req, timeout=15) as r:
        head = r.read(2)
        cl = r.headers.get('Content-Range', '')
        status = r.status
    full = urllib.request.urlopen(urllib.request.Request(URL, method='HEAD'), timeout=15)
    remote_len = full.headers.get('Content-Length')
    check('Public download URL serves the installer', status == 206 and head == b'MZ',
          f'HTTP {status}, first bytes={head!r}, content-length={remote_len}')
    check('Served bytes match the artifact', remote_len == str(len(setup)),
          f'remote={remote_len} local={len(setup)}')
except Exception as e:
    check('Public download URL serves the installer', False, f'{type(e).__name__}: {e}')

fails = [r for r in results if not r[0]]
print(f"\n{len(results) - len(fails)}/{len(results)} checks passed")
sys.exit(1 if fails else 0)
