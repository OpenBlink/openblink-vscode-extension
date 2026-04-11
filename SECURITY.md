# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly by emailing the maintainers directly. Do **not** open a public GitHub issue for security-sensitive bugs.

## Dependency Audit

This project regularly runs `npm audit` to detect known vulnerabilities in its dependency tree. The following are known transitive issues as of the latest audit:

### `serialize-javascript` (transitive, via `copy-webpack-plugin` and `mocha`)

- **Severity:** High
- **Details:** Vulnerable to RCE via `RegExp.flags` / `Date.prototype.toISOString()` and CPU exhaustion via crafted array-like objects.
- **Impact on this project:** Low. `serialize-javascript` is only used at **build time** (webpack plugin) and in the **test runner** (mocha). It is never shipped in the extension bundle or executed at runtime.
- **Mitigation:** Monitor upstream for a patched release. No user-facing risk.

### `tar` (transitive, via `@abandonware/noble` -> `@mapbox/node-pre-gyp`)

- **Severity:** High
- **Details:** Multiple path-traversal and symlink-poisoning vulnerabilities in archive extraction.
- **Impact on this project:** Low. `tar` is only used during `npm install` to extract native addon pre-built binaries for the Noble BLE library. It does not process user-supplied archives at runtime.
- **Mitigation:** Monitor upstream for a patched release of `@mapbox/node-pre-gyp` or a migration to a maintained alternative.

## Security Considerations for Contributors

- **Never commit secrets** (API keys, tokens, credentials) to the repository.
- **Validate all external input** — BLE data, file content, and user-provided configuration values must be validated before use.
- **Use `Buffer.readUInt16LE()` / `Buffer.readUInt8()`** instead of manual bit-shifting for parsing binary data to avoid sign-extension and endianness bugs.
- **Sanitize file paths** — when constructing paths from configuration or user input, validate against path traversal (`..`, absolute paths).
- **BLE protocol** — the firmware transfer protocol uses CRC-16 (polynomial 0xD175, seed 0xFFFF) for integrity verification. The polynomial was selected based on analysis from [Koopman's CRC research](https://users.ece.cmu.edu/~koopman/crc/index.html) for optimal Hamming distance at the target data lengths (up to 65535 bytes).
