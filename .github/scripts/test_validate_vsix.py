# SPDX-License-Identifier: BSD-3-Clause

import json
import unittest
from pathlib import Path
from runpy import run_path
from tempfile import TemporaryDirectory
from zipfile import ZipFile

validate = run_path(str(Path(__file__).with_name("validate-vsix.py")))["validate"]


class TestWindowsBinding(unittest.TestCase):
    def check_binding(self, target, binding):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "extension.vsix"
            with ZipFile(path, "w") as archive:
                archive.writestr("extension.vsixmanifest", f"""
                    <PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
                        <Metadata>
                            <Identity Id="extension" Publisher="publisher" Version="1.0.0" TargetPlatform="{target}" />
                        </Metadata>
                    </PackageManifest>
                """)
                archive.writestr("extension/package.json", json.dumps({
                    "name": "extension", "publisher": "publisher",
                    "version": "1.0.0", "main": "out/extension.js",
                }))
                archive.writestr("extension/out/extension.js", b"// extension")
                archive.writestr("extension/out/mrbc.js", b"// mrbc")
                archive.writestr("extension/out/mrbc.wasm", b"\x00asm")
                archive.writestr("extension/node_modules/@abandonware/noble/build/Release/binding.node", binding)
            return validate(path, "v1.0.0")

    def test_accepts_pe_signature_at_dos_header_offset(self):
        offset = 0x80
        binding = bytearray(offset + 4)
        binding[:2] = b"MZ"
        binding[0x3C:0x40] = offset.to_bytes(4, "little")
        binding[offset:] = b"PE\x00\x00"
        self.assertEqual(self.check_binding("win32-arm64", binding), "win32-arm64")

    def test_rejects_mz_without_pe_signature_at_dos_header_offset(self):
        header = b"MZ" + bytes(0x3A) + (0x80).to_bytes(4, "little")
        for binding in (b"MZ", header, header + b"PE\x00\x00" + bytes(0x40)):
            with self.subTest(size=len(binding)), self.assertRaisesRegex(
                ValueError, "invalid native binding header for win32-x64",
            ):
                self.check_binding("win32-x64", binding)


if __name__ == "__main__":
    unittest.main()
