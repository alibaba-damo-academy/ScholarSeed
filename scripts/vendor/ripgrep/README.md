# Reviewed ripgrep downloads for the packaged Desktop backend

The Desktop package ships the upstream `rg` executable in
`resources/backend/bin` so the Grep tool is independent of the customer's
shell `PATH`. The manifest pins each supported platform's download URL, byte
length and SHA-256. The shared artifact cache verifies the binary before staging it.

Current source and license:

- version: `15.1.0`
- targets: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`
- upstream archive: `ripgrep-15.1.0-aarch64-apple-darwin.tar.gz`
- upstream URL: <https://github.com/BurntSushi/ripgrep/releases/tag/15.1.0>
- archive SHA-256: `378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715`
- license: MIT or the Unlicense, at the user's option

The source archive includes `COPYING`, `LICENSE-MIT`, and `UNLICENSE`.
The executable payloads are not stored in Git; see `manifest.json`.
