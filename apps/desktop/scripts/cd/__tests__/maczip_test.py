"""Exercise ZIP transport framing with signatures that vary in content and size."""

import importlib.util
import io
import json
from pathlib import Path
import stat
import struct
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location("maczip", Path(__file__).parents[1] / "maczip.py")
maczip = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(maczip)
CODE = bytes(range(250)) * 93
NAME = "ScholarSeed.app/Contents/Resources/backend/python/bin/sample"


def thin(magic, signature):
    endian, header = maczip.THIN[magic]
    data = bytearray(header)
    data[:4] = magic
    struct.pack_into(endian + "II", data, 16, 1, 16)
    command = struct.pack(endian + "IIII", 0x1D, 16, header + 16 + len(CODE), len(signature))
    return bytes(data) + command + CODE + signature


def fat(magic, signature):
    endian, fields = maczip.FAT[magic]
    entry = struct.Struct(endian + fields)
    slices = [thin(key, signature) for key in list(maczip.THIN)[:2]]
    offset = 8 + 2 * entry.size
    table = bytearray(magic + struct.pack(endian + "I", 2))
    payload = bytearray()
    for image in slices:
        table.extend(entry.pack(0, 0, offset, len(image), 0, *([0] if len(fields) == 6 else [])))
        payload.extend(image)
        payload.extend(b"padding")
        offset += len(image) + 7
    return bytes(table + payload)


def compressed_bytes(raw, member):
    raw.seek(member.header_offset + 26)
    name, extra = struct.unpack("<HH", raw.read(4))
    raw.seek(name + extra, 1)
    return raw.read(member.compress_size)


class TransportTests(unittest.TestCase):
    def test_all_macho_layouts_and_non_macho(self):
        for factory, magics in ((thin, maczip.THIN), (fat, maczip.FAT)):
            for magic in magics:
                with self.subTest(magic=magic):
                    data = factory(magic, b"signature")
                    ranges = maczip.stable_ranges(io.BytesIO(data), len(data))
                    self.assertEqual(
                        [data[start:end] for start, end in ranges],
                        [CODE] * (1 if factory is thin else 2),
                    )
                    self.assertEqual(maczip.stable_ranges(io.BytesIO(data[:32]), 32), [])
        self.assertEqual(maczip.stable_ranges(io.BytesIO(b"ordinary resource"), 17), [])

    def test_complete_zip_and_stable_framing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous_ranges = None
            for index, signature in enumerate(
                (b"secure timestamp A", b"longer second timestamp" * 5)
            ):
                source, target = root / f"{index}.zip", root / f"{index}-framed.zip"
                image = fat(bytes.fromhex("cafebabf"), signature)
                with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_DEFLATED) as z:
                    z.writestr(NAME, image)
                    z.writestr("__MACOSX/ScholarSeed.app/._café", b"AppleDouble")
                    link = zipfile.ZipInfo(NAME + "-link")
                    link.external_attr = (stat.S_IFLNK | 0o777) << 16
                    link.comment = b"existing member comment"
                    z.writestr(link, b"sample")
                    z.comment = b"original archive comment"
                maczip.optimize(source, target)
                with zipfile.ZipFile(source) as before, zipfile.ZipFile(target) as after:
                    self.assertEqual(before.namelist(), after.namelist())
                    self.assertEqual(before.comment, after.comment)
                    for old, new in zip(before.infolist(), after.infolist()):
                        self.assertEqual(before.read(old), after.read(new))
                        self.assertEqual(old.external_attr, new.external_attr)
                        if old.filename != NAME:
                            self.assertEqual(old.comment, new.comment)
                            self.assertEqual(
                                compressed_bytes(before.fp, old), compressed_bytes(after.fp, new)
                            )
                    member = after.getinfo(NAME)
                    self.assertTrue(member.comment.startswith(maczip.PREFIX))
                    ranges = json.loads(member.comment[len(maczip.PREFIX) :])
                    data = compressed_bytes(after.fp, member)
                    framed = [data[offset : offset + length] for offset, length in ranges]
                    self.assertEqual(len(framed), 2)
                    if previous_ranges is not None:
                        self.assertEqual(previous_ranges, framed)
                    previous_ranges = framed
                with self.assertRaises(FileExistsError):
                    maczip.optimize(source, target)


if __name__ == "__main__":
    unittest.main()
