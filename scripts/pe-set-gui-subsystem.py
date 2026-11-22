#!/usr/bin/env python3
"""Set the PE subsystem to WINDOWS_GUI on a cross-compiled exe.

zig cc (clang/lld-link) does not expose /SUBSYSTEM:WINDOWS; the tray must not
flash a console window, so patch the optional header directly:
PE32+ optional header → Subsystem field (offset 68 within the optional header).
Subsystem 2 = IMAGE_SUBSYSTEM_WINDOWS_GUI, 3 = WINDOWS_CUI.
"""
import struct
import sys


def set_gui(path: str) -> str:
    with open(path, 'rb') as f:
        data = bytearray(f.read())
    if data[:2] != b'MZ':
        return f'{path}: not a PE (missing MZ)'
    e_lfanew = struct.unpack_from('<I', data, 0x3C)[0]
    if data[e_lfanew:e_lfanew + 4] != b'PE\0\0':
        return f'{path}: missing PE signature'
    opt = e_lfanew + 24
    magic = struct.unpack_from('<H', data, opt)[0]
    if magic == 0x20B:      # PE32+
        sub_off = opt + 68
    elif magic == 0x10B:    # PE32
        sub_off = opt + 68
    else:
        return f'{path}: unknown optional header magic {magic:#x}'
    old = struct.unpack_from('<H', data, sub_off)[0]
    struct.pack_into('<H', data, sub_off, 2)  # WINDOWS_GUI
    with open(path, 'wb') as f:
        f.write(data)
    return f'{path}: subsystem {old} -> 2 (WINDOWS_GUI)'


if __name__ == '__main__':
    for p in sys.argv[1:]:
        print(set_gui(p))
