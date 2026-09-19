# Vendored ripgrep for the packaged macOS backend

The Desktop package ships the upstream `rg` executable in
`resources/backend/bin` so the Grep tool is independent of the customer's
shell `PATH`.  The bundle script verifies the checked-in binary checksum before
staging it.

Current source:

- version: `15.1.0`
- target: `aarch64-apple-darwin`
- upstream archive: `ripgrep-15.1.0-aarch64-apple-darwin.tar.gz`
- upstream URL: <https://github.com/BurntSushi/ripgrep/releases/tag/15.1.0>
- archive SHA-256: `378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715`
- license: MIT or the Unlicense, at the user's option

The source archive includes `COPYING`, `LICENSE-MIT`, and `UNLICENSE`.
