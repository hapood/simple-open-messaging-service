"""Regression tests for the APK alignment build gate (standard library only)."""

import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location(
    "alignment", Path(__file__).with_name("check-apk-alignment.py")
)
alignment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alignment)


def elf(segment_alignment=16384, address=0):
    data = bytearray(120)
    data[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<Q", data, 32, 64)
    struct.pack_into("<HH", data, 54, 56, 1)
    struct.pack_into("<IIQQQQQQ", data, 64, 1, 5, 0, address, 0, 120, 120, segment_alignment)
    return bytes(data)


class AlignmentTests(unittest.TestCase):
    def test_accepts_16kb_and_larger_power_of_two_alignment(self):
        for size in (16384, 65536):
            alignment.check_elf(elf(size))

    def test_rejects_4kb_alignment(self):
        with self.assertRaisesRegex(ValueError, "4096"):
            alignment.check_elf(elf(4096))

    def test_rejects_incongruent_segment(self):
        with self.assertRaisesRegex(ValueError, "congruent"):
            alignment.check_elf(elf(address=4096))

    def test_rejects_invalid_elf(self):
        with self.assertRaisesRegex(ValueError, "ELF"):
            alignment.check_elf(b"not an ELF")

    def test_checks_zip_alignment_independently(self):
        for aligned in (True, False):
            with self.subTest(aligned=aligned), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "test.apk"
                entry = zipfile.ZipInfo("lib/arm64-v8a/libtest.so")
                if aligned:
                    padding = 16384 - 30 - len(entry.filename.encode())
                    entry.extra = struct.pack("<HH", 0xFFFF, padding - 4) + bytes(padding - 4)
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr(entry, elf())
                if aligned:
                    alignment.check_apk(path)
                else:
                    with self.assertRaisesRegex(ValueError, "ZIP entry"):
                        alignment.check_apk(path)

    def test_compression_does_not_hide_bad_elf_alignment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.apk"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("lib/arm64-v8a/libtest.so", elf(4096))
            with self.assertRaisesRegex(ValueError, "4096"):
                alignment.check_apk(path)


if __name__ == "__main__":
    unittest.main()
