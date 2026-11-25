"""Isolate Mach-O code from timestamp-dependent signatures in a verified ditto ZIP32.

Only the DEFLATE representation changes. The compressed ranges in each member's
central-directory comment can be reused without changing the signed file.
"""

import argparse
import json
from pathlib import Path
import shutil
import stat
import struct
import tempfile
import zipfile
import zlib

PREFIX = b"SSZIP-RANGES/1 "
CHUNK = 1 << 20
MAX_ARCHIVE = (1 << 30) - 1  # Squirrel download budget.
MAX_SLICES = 32
THIN = {
    bytes.fromhex("cefaedfe"): ("<", 28),
    bytes.fromhex("cffaedfe"): ("<", 32),
    bytes.fromhex("feedface"): (">", 28),
    bytes.fromhex("feedfacf"): (">", 32),
}
FAT = {
    bytes.fromhex("cafebabe"): (">", "IIIII"),
    bytes.fromhex("bebafeca"): ("<", "IIIII"),
    bytes.fromhex("cafebabf"): (">", "IIQQII"),
    bytes.fromhex("bfbafeca"): ("<", "IIQQII"),
}


def thin_range(source, start, size):
    source.seek(start)
    header = source.read(28)
    format_info = THIN.get(header[:4])
    if len(header) != 28 or not format_info:
        return None
    endian, header_size = format_info
    count, length = struct.unpack_from(endian + "II", header, 16)
    if length > min(CHUNK, size - header_size) or count > length // 8:
        return None
    source.seek(start + header_size)
    commands = source.read(length)
    cursor = 0
    code_end = None
    for _ in range(count):
        if cursor + 8 > len(commands):
            return None
        command, command_size = struct.unpack_from(endian + "II", commands, cursor)
        if command_size < 8 or command_size > len(commands) - cursor:
            return None
        if command == 0x1D:  # LC_CODE_SIGNATURE, a linkedit_data_command
            if command_size != 16 or code_end is not None:
                return None
            code_end, signature_size = struct.unpack_from(endian + "II", commands, cursor + 8)
            if not signature_size or code_end + signature_size > size:
                return None
        cursor += command_size
    if cursor != length or code_end is None or code_end <= header_size + length:
        return None
    return start + header_size + length, start + code_end


def stable_ranges(source, size):
    source.seek(0)
    magic = source.read(4)
    if magic in THIN:
        code = thin_range(source, 0, size)
        return [code] if code else []
    if magic not in FAT:
        return []
    endian, fields = FAT[magic]
    count_bytes = source.read(4)
    if len(count_bytes) != 4:
        return []
    count = struct.unpack(endian + "I", count_bytes)[0]
    entry = struct.Struct(endian + fields)
    if not 0 < count <= MAX_SLICES:
        return []
    table = source.read(count * entry.size)
    if len(table) != count * entry.size:
        return []
    end = 8 + len(table)
    ranges = []
    for start, length in sorted((row[2], row[3]) for row in entry.iter_unpack(table)):
        if start < end or start + length > size:
            return []
        code = thin_range(source, start, length)
        if not code:
            return []
        ranges.append(code)
        end = start + length
    return ranges


def runtime_candidate(member):
    parts = member.filename.split("/")
    mode = member.external_attr >> 16
    return (
        member.file_size >= 32
        and not member.comment
        and member.compress_type == zipfile.ZIP_DEFLATED
        and stat.S_IFMT(mode) in (0, stat.S_IFREG)
        and len(parts) >= 5
        and parts[0].endswith(".app")
        and parts[1] == "Contents"
        and (
            (parts[2] == "Frameworks" and parts[3].endswith(".framework"))
            or (parts[2:4] == ["Resources", "backend"] and parts[4] in ("python", "texlive"))
        )
    )


def transfer(source, write, length):
    if length < 0:
        raise ValueError("invalid ZIP byte range")
    while length:
        data = source.read(min(CHUNK, length))
        if not data:
            raise ValueError("truncated archive")
        write(data)
        length -= len(data)


def deflate_segments(source, output, ranges, size):
    compressor = zlib.compressobj(6, zlib.DEFLATED, -15)
    stream_start = output.tell()
    source.seek(0)
    cursor = 0
    compressed = []

    def write(data):
        output.write(compressor.compress(data))

    for start, end in ranges:
        transfer(source, write, start - cursor)
        output.write(compressor.flush(zlib.Z_FULL_FLUSH))
        offset = output.tell() - stream_start
        transfer(source, write, end - start)
        output.write(compressor.flush(zlib.Z_FULL_FLUSH))
        compressed.append((offset, output.tell() - stream_start - offset))
        cursor = end
    transfer(source, write, size - cursor)
    output.write(compressor.flush(zlib.Z_FINISH))
    return PREFIX + json.dumps(compressed, separators=(",", ":")).encode("ascii")


def rewrite_member(raw, source_zip, member, next_offset, output, workspace):
    original = member.header_offset
    if runtime_candidate(member):
        with source_zip.open(member) as data:
            magic = data.read(4)
            if magic in THIN or magic in FAT:
                # Seekable backing is needed for fat slice tables. Spool just
                # this one member and keep copies independent of the host RAM.
                with tempfile.TemporaryFile(dir=workspace) as source:
                    source.write(magic)
                    shutil.copyfileobj(data, source, CHUNK)
                    ranges = stable_ranges(source, member.file_size)
                    if ranges:
                        return rewrite_deflated(raw, member, next_offset, output, source, ranges)
    raw.seek(original)
    transfer(raw, output.write, next_offset - original)
    return member.compress_size, member.comment


def rewrite_deflated(raw, member, next_offset, output, source, ranges):
    raw.seek(member.header_offset)
    local = bytearray(raw.read(30))
    if local[:4] != b"PK\x03\x04":
        raise ValueError("invalid local ZIP header")
    name_size, extra_size = struct.unpack_from("<HH", local, 26)
    header = output.tell()
    output.write(local)
    transfer(raw, output.write, name_size + extra_size)
    payload = output.tell()
    comment = deflate_segments(source, output, ranges, member.file_size)
    length = output.tell() - payload
    raw.seek(member.compress_size, 1)
    descriptor_size = next_offset - raw.tell()
    if descriptor_size not in (0, 12, 16):
        raise ValueError("unsupported ZIP data descriptor size")
    descriptor = bytearray(raw.read(descriptor_size))
    if member.flag_bits & 8:
        has_signature = descriptor.startswith(b"PK\x07\x08")
        if len(descriptor) != (16 if has_signature else 12):
            raise ValueError("invalid ZIP data descriptor")
        struct.pack_into("<I", descriptor, 8 if has_signature else 4, length)
    elif descriptor:
        raise ValueError("unexpected bytes after ZIP member")
    output.write(descriptor)
    if not member.flag_bits & 8 or struct.unpack_from("<I", local, 18)[0]:
        end = output.tell()
        output.seek(header + 18)
        output.write(struct.pack("<I", length))
        output.seek(end)
    return length, comment


def write_archive(archive, output, workspace):
    # Retain raw name/extra fields rather than decoding and recreating names
    # with zipfile. ditto can store UTF-8 filenames without the UTF-8 flag.
    with zipfile.ZipFile(archive) as source_zip, archive.open("rb") as raw:
        members = source_zip.infolist()
        if not members or members[0].header_offset != 0 or archive.stat().st_size > MAX_ARCHIVE:
            raise ValueError("expected canonical Squirrel ZIP32")
        ends = [m.header_offset for m in members[1:]] + [source_zip.start_dir]
        rewritten = []
        for member, end in zip(members, ends):
            if end <= member.header_offset:
                raise ValueError("unexpected ZIP member ordering")
            offset = output.tell()
            length, comment = rewrite_member(raw, source_zip, member, end, output, workspace)
            rewritten.append((offset, length, comment))
        central = output.tell()
        raw.seek(source_zip.start_dir)
        for offset, length, comment in rewritten:
            record = bytearray(raw.read(46))
            if record[:4] != b"PK\x01\x02":
                raise ValueError("invalid ZIP central directory")
            names, extra, old_comment = struct.unpack_from("<HHH", record, 28)
            struct.pack_into("<I", record, 20, length)
            struct.pack_into("<H", record, 32, len(comment))
            struct.pack_into("<I", record, 42, offset)
            output.write(record)
            transfer(raw, output.write, names + extra)
            raw.seek(old_comment, 1)
            output.write(comment)
        central_size = output.tell() - central
        end_record = bytearray(raw.read(22 + 65535 + 1))
        if (
            end_record[:4] != b"PK\x05\x06"
            or len(end_record) < 22
            or len(end_record) != 22 + struct.unpack_from("<H", end_record, 20)[0]
        ):
            raise ValueError("expected canonical ZIP32 end record")
        struct.pack_into("<II", end_record, 12, central_size, central)
        output.write(end_record)
        if output.tell() > MAX_ARCHIVE:
            raise ValueError("optimized ZIP exceeds Squirrel download limit")


def optimize(archive: Path, destination: Path):
    output = destination.open("xb")
    try:
        with output:
            write_archive(archive, output, destination.parent)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    optimize(args.archive, args.destination)
