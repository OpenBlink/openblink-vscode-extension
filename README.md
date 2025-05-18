# Open Blink VSCode Extension

[![English](https://img.shields.io/badge/language-English-blue.svg)](README.md)
[![中文](https://img.shields.io/badge/language-中文-red.svg)](README.zh-CN.md)
[![日本語](https://img.shields.io/badge/language-日本語-green.svg)](README.ja.md)

For more information about Open Blink, please visit [here](https://github.com/OpenBlink/openblink).

This extension provides essentially the same functionality as the [web IDE](https://openblink.org/).
The Open Blink VSCode Extension is a VSCode extension that enables communication with microcontroller devices via BLE. It allows you to easily compile code and write it to devices.

## License

BSD-3-Clause

## Main Features

- BLE device detection and connection
- Firmware compilation and writing
- Device soft reset
- Real-time status display

## Verified Environments

| PC-OS | PC-Model | Board-Name | Firmware-hash |
|-------|---------|--------|--------|
| Windows 11 | ThinkPad E14 Gen4 | M5Stack AtomS3 | 2b4100591c5cbf9a20b6042136f3b1259e26a5d7 |
| macOS 15.0 (24A8332) | MacMini M4 | M5Stack AtomS3 | 2b4100591c5cbf9a20b6042136f3b1259e26a5d7 |

## Target Users

- Developers using Open Blink devices
- Those involved in microcontroller development using BLE

## Installation

1. Open VSCode's extension marketplace
2. Search for "Open Blink VSCode Extension"
3. Click "Install"
(Requires VSCode version 1.96.0 or higher. Cursor environment users, please take special note.)

## Usage

### Connecting Devices

1. Install firmware distributed as a PlatformIO project on compatible devices
2. Click the Open Blink icon in the VSCode sidebar
3. Select "Connect Device"
4. Choose your target device from the list of available devices

### Writing Code

1. Edit your project's source code
2. Click the "Compile and Blink" button to execute compilation and writing

### Other Operations

- Device Reset: Click the "Soft Reset" button
- Disconnect Device: Click the "Disconnect Device" button

## Configuration Options

Coming soon...

## Troubleshooting

Coming soon...

## Support

- [GitHub Issues](https://github.com/OpenBlink/vscode-extension/issues)
- [DeepWiki](https://deepwiki.com/OpenBlink/openblink-vscode-extension)

## Contributing
### Development Environment Setup

```bash
git clone https://github.com/OpenBlink/vscode-extension.git
cd vscode-extension
npm install
```

## Future Work
- [ ] Add tests
- [ ] Organize output logs

---

**Note**: This README will be continuously updated.
