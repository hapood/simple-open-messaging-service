#!/usr/bin/env python3
"""Reject APKs whose 64-bit native libraries cannot be mapped on 16 KB pages."""

import struct
import sys
import zipfile

PAGE_SIZE = 16384


def check_elf(data):
    if data[:4] != b"\x7fELF":
        raise ValueError("not an ELF library")
    if data[4] == 1:
        return  # Android's 16 KB page-size requirement applies to 64-bit ABIs.
    if data[4] != 2 or data[5] not in (1, 2):
        raise ValueError("unsupported ELF format")
    endian = "<" if data[5] == 1 else ">"
    offset = struct.unpack_from(endian + "Q", data, 32)[0]
    size, count = struct.unpack_from(endian + "HH", data, 54)
    if size < 56:
        raise ValueError("invalid ELF program-header size")
    loads = 0
    for index in range(count):
        header = offset + index * size
        kind, _, file_offset, address, _, _, _, alignment = struct.unpack_from(
            endian + "IIQQQQQQ", data, header
        )
        if kind != 1:  # PT_LOAD
            continue
        loads += 1
        if alignment < PAGE_SIZE or alignment & (alignment - 1):
            raise ValueError(f"ELF LOAD alignment is {alignment}, requires >= 16384")
        if (address - file_offset) % PAGE_SIZE:
            raise ValueError("ELF LOAD address/offset are not congruent modulo 16384")
    if not loads:
        raise ValueError("ELF has no LOAD segments")


def check_apk(path):
    failures = []
    checked = 0
    with zipfile.ZipFile(path) as archive, open(path, "rb") as raw:
        for entry in archive.infolist():
            if not entry.filename.startswith("lib/") or not entry.filename.endswith(".so"):
                continue
            if entry.filename.split("/")[1] not in ("arm64-v8a", "x86_64"):
                continue
            checked += 1
            try:
                data = archive.read(entry)
                if len(data) < 64 or data[4] != 2:
                    raise ValueError("expected a 64-bit ELF library")
                check_elf(data)
                if entry.compress_type == zipfile.ZIP_STORED:
                    raw.seek(entry.header_offset + 26)
                    name_size, extra_size = struct.unpack("<HH", raw.read(4))
                    offset = entry.header_offset + 30 + name_size + extra_size
                    if offset % PAGE_SIZE:
                        raise ValueError(f"uncompressed ZIP entry offset {offset} is not 16 KB aligned")
            except (ValueError, struct.error) as error:
                failures.append(f"{entry.filename}: {error}")
    if failures:
        raise ValueError("\n".join(failures))
    print(f"16 KB alignment verified: {checked} 64-bit native libraries in {path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: check-apk-alignment.py APK")
    try:
        check_apk(sys.argv[1])
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        sys.exit(str(error))
