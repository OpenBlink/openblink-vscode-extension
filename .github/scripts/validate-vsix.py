# SPDX-License-Identifier: BSD-3-Clause

import json
import sys
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

TARGETS = {
    "darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64",
    "linux-arm64", "linux-x64", "linux-armhf",
}
IDENTITY = ".//{http://schemas.microsoft.com/developer/vsx-schema/2011}Identity"
NATIVE_MAGIC = {
    "linux": (b"\x7fELF",),
    "darwin": (
        b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
        b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
        b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
    ),
}


def valid_pe_header(native):
    header = native.read(0x40)
    if len(header) != 0x40 or not header.startswith(b"MZ"):
        return False
    offset = int.from_bytes(header[0x3C:0x40], "little")
    if offset < len(header):
        return False
    native.seek(offset)
    return native.read(4) == b"PE\x00\x00"


def validate(path, tag):
    with ZipFile(path) as archive:
        corrupt = archive.testzip()
        if corrupt:
            raise ValueError(f"invalid archive member: {corrupt}")
        identity = ElementTree.fromstring(archive.read("extension.vsixmanifest")).find(IDENTITY)
        if identity is None:
            raise ValueError("missing VSIX identity")
        target = identity.get("TargetPlatform")
        if target not in TARGETS:
            raise ValueError(f"unexpected target: {target}")
        package = json.loads(archive.read("extension/package.json"))
        for field, attribute in (("name", "Id"), ("publisher", "Publisher"), ("version", "Version")):
            if not package.get(field) or package[field] != identity.get(attribute):
                raise ValueError(f"inconsistent package {field}")
        if tag != f"v{package['version']}":
            raise ValueError(f"package version {package['version']} does not match tag {tag}")
        main = package.get("main")
        if not isinstance(main, str):
            raise ValueError("invalid extension entry point")
        entry = PurePosixPath(main)
        if not entry.parts or entry.is_absolute() or ".." in entry.parts:
            raise ValueError("invalid extension entry point")
        required = {f"extension/{entry}", "extension/out/mrbc.js", "extension/out/mrbc.wasm"}
        for member in sorted(required):
            if archive.getinfo(member).file_size == 0:
                raise ValueError(f"empty archive member: {member}")
        if archive.read("extension/out/mrbc.wasm")[:4] != b"\x00asm":
            raise ValueError("invalid mrbc WASM header")
        if target != "linux-armhf":
            platform = target.split("-", 1)[0]
            binding = (
                "bluetooth-hci-socket/build/Release/bluetooth_hci_socket.node"
                if platform == "linux" else "noble/build/Release/binding.node"
            )
            with archive.open(f"extension/node_modules/@abandonware/{binding}") as native:
                valid = (
                    valid_pe_header(native) if platform == "win32"
                    else native.read(4).startswith(NATIVE_MAGIC[platform])
                )
                if not valid:
                    raise ValueError(f"invalid native binding header for {target}: {binding}")
        return target


def main(directory, tag):
    seen = set()
    for path in sorted(Path(directory).glob("*.vsix")):
        try:
            target = validate(path, tag)
        except (BadZipFile, KeyError, ValueError, ElementTree.ParseError) as error:
            raise SystemExit(f"{path.name}: {error}") from error
        if target in seen:
            raise SystemExit(f"Duplicate VSIX target: {target}")
        seen.add(target)
        binding_check = "native binding not required" if target == "linux-armhf" else "native binding header checked"
        print(f"{path.name}: verified {target} ({binding_check})")
    if missing := TARGETS - seen:
        raise SystemExit(f"Missing VSIX targets: {', '.join(sorted(missing))}")


if __name__ == "__main__":
    main(*sys.argv[1:])
