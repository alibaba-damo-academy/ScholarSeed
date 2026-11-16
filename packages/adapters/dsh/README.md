# scholarseed-dsh

An independent Adapter package reserved by ScholarSeed for **DeepSeek Harness (DSH)**; it is not yet connected to a runnable Harness.

<a id="为什么存在"></a>
## Why It Exists

It preserves a clear vendor integration boundary. A future implementation will use the same public Provider/Session ABI as Codex, depend only on `scholarseed-runtime`, avoid Serve and Desktop dependencies, and not reuse the removed in-house Harness.

<a id="当前状态能力显式不可用"></a>
## Current Status: Capabilities Explicitly Unavailable

This package has no Provider, Session, or `scholarseed_runtime.providers` entry point.
The old `RuntimeProfile` placeholder implementation has been removed and must not be mistaken for an implementation of the new ABI. DSH sessions, tools, approvals, and other capabilities are currently unsupported. No simulated execution or empty success response is provided, and the package does not:

- reduce the interface to the lowest common denominator between Codex and DSH;
- use a fake implementation to make `unsupported` appear usable.

`runtimes.dsh.enabled` in `product.json` is `false`. Keep it that way; installing this package alone will not make the Gateway discover a runnable DSH. If enabled prematurely, startup configuration checks will report the missing Provider.

<a id="接通后要做什么"></a>
## What to Do When Connecting It

1. Implement the Provider/Session defined by `scholarseed_runtime.contract` in this package, along with translation of real native events;
2. Register a `scholarseed_runtime.providers` factory in package metadata and declare the capabilities actually supported and reasons for unsupported capabilities;
3. Verify discovery, sessions, events, approvals, and recovery, and complete real product acceptance;
4. Enable the product configuration only after acceptance. Do not skip integration work by retaining an old-protocol forwarding layer or a fake Harness.
