"""Content proofs and narrowly scoped overlays for the macOS CI signing cache."""

import argparse
import csv
import ctypes
import hashlib
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import tempfile
import zipfile
from pathlib import Path

FRAMEWORKS = {
    "electron": ("Electron Framework.framework",),
    "frameworks": ("Mantle.framework", "ReactiveObjC.framework", "Squirrel.framework"),
}
KINDS = (*FRAMEWORKS, "python", "texlive")
PRODUCT_WHEELS = {"scholarseed", "scholarseed-runtime", "scholarseed-codex", "damoatrace"}
BUNDLE_SUFFIXES = (".app", ".framework", ".bundle", ".plugin", ".xpc", ".appex")
MACHO = {
    bytes.fromhex(magic)
    for magic in ("feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca")
}
MIB = 1024 * 1024
MAX_SEAL = 16 * MIB
SIGNATURE_ROOM = 4 * MIB
NOFOLLOW = 1  # Darwin XATTR_NOFOLLOW
LIBC = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
LIBC.listxattr.argtypes = (ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int)
LIBC.listxattr.restype = ctypes.c_ssize_t
LIBC.getxattr.argtypes = (
    ctypes.c_char_p,
    ctypes.c_char_p,
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.c_uint32,
    ctypes.c_int,
)
LIBC.getxattr.restype = ctypes.c_ssize_t


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def file_hash(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def slices(image):
    size = os.fstat(image.fileno()).st_size
    magic = image.read(4)
    if magic not in (b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"):
        return [(0, 0, 0, size, 0)]
    endian = ">" if magic[0] == 0xCA else "<"
    (count,) = struct.unpack(endian + "I", image.read(4))
    if not 0 < count <= 32:
        raise ValueError("invalid universal Mach-O")
    entries = [struct.unpack(endian + "IIIII", image.read(20)) for _ in range(count)]
    cursor = image.tell()
    for _, _, start, length, align in sorted(entries, key=lambda e: e[2]):
        if (
            align > 30
            or start % (1 << align)
            or start < cursor
            or not length
            or length > size - start
        ):
            raise ValueError("invalid universal Mach-O slice")
        while cursor < start:
            data = image.read(min(MIB, start - cursor))
            if not data or data.strip(b"\0"):
                raise ValueError("invalid universal Mach-O padding")
            cursor += len(data)
        cursor = start + length
        image.seek(cursor)
    if cursor != size:
        raise ValueError("unexpected trailing universal Mach-O data")
    return entries


def validate_signature_spans(path):
    with path.open("rb") as image:
        for _, _, start, size, _ in slices(image):
            image.seek(start)
            header = image.read(32)
            if len(header) != 32 or header[:4] not in MACHO:
                raise ValueError("invalid Mach-O header")
            endian = "<" if header[0] in (0xCE, 0xCF) else ">"
            header_size = 32 if 0xCF in header[:4] else 28
            count, length = struct.unpack_from(endian + "II", header, 16)
            if length > min(MIB, size - header_size) or count > length // 8:
                raise ValueError("invalid Mach-O load commands")
            image.seek(start + header_size)
            commands = image.read(length)
            cursor = 0
            for _ in range(count):
                command, n = struct.unpack_from(endian + "II", commands, cursor)
                if n < 8 or cursor + n > length:
                    raise ValueError("invalid Mach-O load command")
                if command == 0x1D:  # LC_CODE_SIGNATURE
                    offset, signature = struct.unpack_from(endian + "II", commands, cursor + 8)
                    if (
                        n != 16
                        or offset < header_size + length
                        or not signature
                        or offset + signature != size
                    ):
                        raise ValueError("non-terminal Mach-O signature")
                cursor += n
            if cursor != length:
                raise ValueError("unexpected Mach-O load command bytes")


def allocated_hash(path):
    # codesign may increase a universal file's inter-slice alignment. Bind
    # every CPU and subtype and all normalized slice bytes independently.
    with path.open("rb") as image:
        hashes = []
        for cpu, subtype, start, length, _ in sorted(slices(image)):
            image.seek(start)
            sha = hashlib.sha256()
            while length:
                data = image.read(min(MIB, length))
                if not data:
                    raise ValueError("truncated allocated Mach-O slice")
                sha.update(data)
                length -= len(data)
            hashes.append([cpu, subtype, sha.hexdigest()])
        return digest(hashes)


def attributes(path):
    # CPython's os xattr APIs are Linux-only. Read Darwin attributes on the
    # link itself, where a resource fork or a detached seal can be significant.
    filename = os.fsencode(path)

    def read(call):
        size = call(None, 0)
        if size < 0:
            raise OSError(ctypes.get_errno(), "cannot read signing input attributes", str(path))
        buffer = ctypes.create_string_buffer(size)
        if size and call(buffer, size) != size:
            raise ValueError(f"signing input attributes changed: {path}")
        return buffer.raw

    names = read(lambda buf, n: LIBC.listxattr(filename, buf, n, NOFOLLOW))
    result = []
    for name in sorted(names.rstrip(b"\0").split(b"\0")) if names else ():
        # Neither local creator provenance nor the host EDR scan record is
        # archived. The scanner can attach its record between plan and pack.
        if name in (b"com.apple.provenance", b"com.alibaba.security.edr.antivirus.cloudquery"):
            continue
        value = read(lambda buf, n: LIBC.getxattr(filename, name, buf, n, 0, NOFOLLOW))
        result.append([name.hex(), hashlib.sha256(value).hexdigest()])
    return result


def code_hash(path, workspace):
    # Apple's allocator replaces each slice's signature region with the same
    # empty slot. It adjusts offsets, fat slice tables and __LINKEDIT sizes,
    # retaining instructions, data, other load commands and architecture.
    # Stripping alone leaves __LINKEDIT VM sizes from the old signature.
    validate_signature_spans(path)
    arches = subprocess.check_output(["/usr/bin/lipo", "-archs", path], text=True).split()
    if not 0 < len(arches) <= 32 or len(set(arches)) != len(arches):
        raise ValueError(f"invalid Mach-O architecture set: {path}")
    with tempfile.TemporaryDirectory(dir=workspace) as temp:
        normalized = Path(temp) / "code"
        args = ["/usr/bin/codesign_allocate", "-i", path]
        for arch in arches:
            args.extend(("-a", arch, str(SIGNATURE_ROOM)))
        subprocess.run([*args, "-o", normalized], check=True)
        return allocated_hash(normalized)


def physical(path, root):
    if not path.is_relative_to(root) or path.resolve(strict=False) != path:
        raise ValueError(f"redirected signing cache path: {path}")
    return path


def product_files(python):
    owned = set()
    for record in python.glob("lib/python*/site-packages/*.dist-info/RECORD"):
        distribution = record.parent.name.removesuffix(".dist-info").rsplit("-", 1)[0]
        if re.sub(r"[-_.]+", "-", distribution).lower() not in PRODUCT_WHEELS:
            continue
        with physical(record, python).open(encoding="utf-8", newline="") as source:
            for row in csv.reader(source):
                if len(row) != 3 or not row[0] or os.path.isabs(row[0]):
                    raise ValueError(f"invalid installed wheel RECORD: {record}")
                name = Path(os.path.normpath(record.parent.parent / row[0]))
                if not name.is_relative_to(python):
                    raise ValueError(f"wheel member escapes bundled interpreter: {record}")
                owned.add(name)
    return owned


def walk(directory):
    for entry in sorted(directory.iterdir()):
        yield entry
        if not entry.is_symlink() and entry.is_dir() and not entry.name.endswith(BUNDLE_SUFFIXES):
            yield from walk(entry)


def framework_seals(root):
    versions = root / "Versions"
    if versions.exists():
        physical(versions, root)
        directories = [d for d in versions.iterdir() if not d.is_symlink() and d.is_dir()]
    else:
        directories = [root]
    return {d / "_CodeSignature" / "CodeResources" for d in directories}


def inspect(app, kind):
    backend = app / "Contents/Resources/backend"
    framework = kind in FRAMEWORKS
    roots = (
        [app / "Contents/Frameworks" / name for name in FRAMEWORKS[kind]]
        if framework
        else [backend / kind]
    )
    inputs, unchanged, files, seals, bundles = [], [], [], [], []
    for root in roots:
        if not root.exists():
            continue
        physical(root, app)
        members = list(walk(root))
        if framework and any(
            p.is_dir() and not p.is_symlink() and p.name.endswith(BUNDLE_SUFFIXES) for p in members
        ):
            # A future nested bundle needs its own seal and policy verification.
            continue
        owned = product_files(root) if kind == "python" else set()
        allowed = framework_seals(root) if framework else set()
        seal_dirs = {p.parent for p in allowed}
        if framework:
            bundles.append(root.relative_to(app).as_posix())
            seals.extend(p.relative_to(app).as_posix() for p in allowed)
        for path in [root, *members]:
            name = path.relative_to(app).as_posix()
            mode = path.lstat().st_mode
            regular = stat.S_ISREG(mode)
            macho = False
            if regular and path not in owned:
                with path.open("rb") as f:
                    macho = f.read(4) in MACHO
            if not framework and not macho:
                continue
            if path in allowed and not regular:
                raise ValueError(f"invalid framework resource seal: {name}")
            if path in seal_dirs and not stat.S_ISDIR(mode):
                raise ValueError(f"invalid framework seal directory: {name}")
            metadata = [name, mode, attributes(path)]
            if stat.S_ISLNK(mode):
                target = os.readlink(path)
                if os.path.isabs(target) or not path.resolve(strict=True).is_relative_to(root):
                    raise ValueError(f"framework symlink escapes its input: {name}")
                payload = target
            elif regular:
                payload = file_hash(path)
            elif stat.S_ISDIR(mode):
                payload = None
            else:
                raise ValueError(f"unsupported framework file type: {name}")
            inputs.append([metadata, payload])
            if path not in allowed and path not in seal_dirs:
                unchanged.append([metadata, None if macho else payload])
            if macho:
                files.append(name)
    return {
        "inputSha256": digest(inputs),
        "unchangedSha256": digest(unchanged),
        "files": sorted(files),
        "seals": sorted(seals),
        "bundles": sorted(bundles),
    }


def plan(app):
    return {kind: item for kind in KINDS if (item := inspect(app, kind))["files"]}


def overlay_paths(current, expected):
    if any(current[k] != expected[k] for k in ("unchangedSha256", "files", "seals", "bundles")):
        raise ValueError("runtime input inventory changed while signing")
    return current["files"] + current["seals"]


def prepare_proofs(app, plans, directory):
    for item in plans.values():
        item["proofs"] = {
            name: [code_hash(app / name, directory), (app / name).stat().st_size]
            for name in item["files"]
        }


def pack(app, expected, kind, archive):
    current = inspect(app, kind)
    names = overlay_paths(current, expected)
    with (
        open(archive, "xb", opener=lambda path, flags: os.open(path, flags, 0o600)) as target,
        zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z,
    ):
        for name in names:
            path = physical(app / name, app)
            verify_overlay(path, name, expected, archive.parent)
            z.write(path, name)


def verify_overlay(path, name, expected, directory):
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"missing signed runtime member: {name}")
    size = path.stat().st_size
    if name in expected["proofs"]:
        original, original_size = expected["proofs"][name]
        if not 0 < size <= original_size + MAX_SEAL or code_hash(path, directory) != original:
            raise ValueError(f"signed runtime code differs from build input: {name}")
    elif not 0 < size <= MAX_SEAL:
        raise ValueError(f"invalid signed framework seal size: {name}")


def restore(app, expected, kind, archive):
    current = inspect(app, kind)
    names = overlay_paths(current, expected)
    with (
        tempfile.TemporaryDirectory(dir=app.parent, prefix=".signed-runtime-") as scratch,
        zipfile.ZipFile(archive) as z,
    ):
        stage = Path(scratch)
        # A publisher that lost a concurrent first write can already be signed.
        # Only its signature envelope may have changed since the frozen plan.
        if current["inputSha256"] != expected["inputSha256"]:
            for name in current["files"]:
                verify_overlay(app / name, name, expected, stage)
        if sorted(z.namelist()) != sorted(names):
            raise ValueError("signed runtime archive differs from planned inventory")
        total = sum(info.file_size for info in z.infolist())
        if total > sum(proof[1] for proof in expected["proofs"].values()) + 64 * MIB:
            raise ValueError("oversized signed runtime archive")
        for index, name in enumerate(names):
            destination = physical(app / name, app)
            member = z.getinfo(name)
            limit = MAX_SEAL + expected["proofs"].get(name, [None, 0])[1]
            if (
                member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                or not 0 < member.file_size <= limit
                or member.flag_bits & 1
            ):
                raise ValueError(f"unsupported signed runtime archive entry: {name}")
            staged = stage / str(index)
            mode = 0o644
            if destination.exists():
                # Preserve source mode, ACLs and xattrs when replacing its bytes.
                subprocess.run(["/bin/cp", "-p", destination, staged], check=True)
                mode = stat.S_IMODE(staged.stat().st_mode)
                staged.chmod(mode | stat.S_IWUSR)
            with z.open(member) as src, staged.open("wb") as out:
                shutil.copyfileobj(src, out, MIB)
            staged.chmod(mode)
            verify_overlay(staged, name, expected, stage)
        # No cache bytes enter the build until the entire component is proven.
        for index, name in enumerate(names):
            destination = physical(app / name, app)
            if name in expected["seals"] and not destination.parent.exists():
                destination.parent.mkdir()
                destination.parent.chmod(0o755)
            os.replace(stage / str(index), destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    for op in ("plan", "pack", "restore"):
        cmd = commands.add_parser(op)
        cmd.add_argument("app", type=Path)
        cmd.add_argument("plan_file", type=Path)
        if op != "plan":
            cmd.add_argument("kind", choices=KINDS)
            cmd.add_argument("archive", type=Path)
    args = parser.parse_args()
    app = args.app.resolve(strict=True)
    if args.operation == "plan":
        plans = plan(app)
        prepare_proofs(app, plans, args.plan_file.parent)
        with args.plan_file.open("x") as output:
            json.dump(plans, output)
        print(
            json.dumps(
                {
                    kind: {k: p[k] for k in ("inputSha256", "files", "bundles")}
                    for kind, p in plans.items()
                }
            )
        )
    else:
        expected = json.loads(args.plan_file.read_text())[args.kind]
        (pack if args.operation == "pack" else restore)(app, expected, args.kind, args.archive)


if __name__ == "__main__":
    main()
