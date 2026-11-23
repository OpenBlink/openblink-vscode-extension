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
        if target.startswith("linux-") and target != "linux-armhf":
            required.add("extension/node_modules/@abandonware/bluetooth-hci-socket/build/Release/bluetooth_hci_socket.node")
        elif not target.startswith("linux-"):
            required.add("extension/node_modules/@abandonware/noble/build/Release/binding.node")
        for member in sorted(required):
            if archive.getinfo(member).file_size == 0:
                raise ValueError(f"empty archive member: {member}")
        if archive.read("extension/out/mrbc.wasm")[:4] != b"\x00asm":
            raise ValueError("invalid mrbc WASM header")
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
        binding_check = "native binding presence not required" if target == "linux-armhf" else "native binding presence only"
        print(f"{path.name}: verified {target} ({binding_check})")
    if missing := TARGETS - seen:
        raise SystemExit(f"Missing VSIX targets: {', '.join(sorted(missing))}")


if __name__ == "__main__":
    main(*sys.argv[1:])
