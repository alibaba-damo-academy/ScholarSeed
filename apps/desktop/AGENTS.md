<a id="appsdesktop-工作约定"></a>
# apps/desktop Working Rules

This file is the navigation entry point for the Desktop subsystem. The sole authority for detailed
specifications is [`docs/`](docs/README.md); dynamic component, token, and debt counts are determined
by source code and generated inventories. Edit only the actual `AGENTS.md`; do not maintain a duplicate
copy of these rules.

<a id="开始前必读"></a>
## Read Before Starting

- Before changing a renderer feature, shell, state, or composition, read [`docs/architecture/renderer.md`](docs/architecture/renderer.md) and [`docs/architecture/ownership.md`](docs/architecture/ownership.md). For pages, panels, components, or interaction visuals, also read the [component reuse, ownership, and ratchet contract](docs/design/components.md), and use the `ui-component-reuse` skill / `npm run ui-find Q="<意图>"`.
- Before changing styles, tokens, or UI components, read [`docs/design/foundations.md`](docs/design/foundations.md), [`docs/design/components.md`](docs/design/components.md), and [`docs/design/interaction.md`](docs/design/interaction.md), and first use the `ui-component-reuse` skill / `npm run ui-find Q="<意图>"`.
- Before changing main, preload, IPC, tests, or acceptance, read [`docs/quality/testing.md`](docs/quality/testing.md); when boundaries are involved, also read the renderer/ownership specifications.
- Before changing package scripts, lifecycle, or TypeScript configuration, first read the [engineering script interfaces](docs/quality/testing.md#工程脚本接口) and [check ownership](docs/quality/testing.md#typescript-检查归属), then verify the actual recipes, canonical inventory, and consumers.
- Before changing the main-window CSP, Session response callbacks, or quit races, you must read the [main-window CSP lifecycle](docs/architecture/ownership.md#主窗口-csp-生命周期); do not bypass the problem by removing the policy or swallowing exceptions.

- For internationalization, copy resources, language preferences, or editor-language integration, first read [`docs/architecture/i18n.md`](docs/architecture/i18n.md) and the [integration specification](docs/architecture/localization.md), and follow the locked i18next / react-i18next approach. Check this task's acceptance according to the [verification specification](docs/quality/testing.md); do not use historical plans or checked boxes as proof of current implementation or acceptance.

<a id="高频硬约束"></a>
## Frequent Hard Constraints

- When changing dependencies, `overrides`, or installation configuration in `package.json`, use the Node/pnpm versions specified by the repository by default, update `pnpm-lock.yaml` in sync, and retain `package-lock.json` for npm compatibility. Do not rely only on test results from an existing `node_modules`. Follow the [testing and acceptance specification](docs/quality/testing.md) to check lockfiles through both installation paths, and deliver only after confirming a clean checkout can install.
- For subsequently added, modified, or integrated features, follow the [internationalization integration specification](docs/architecture/localization.md): add or update Chinese and English resources, parameters, and validation for new or changed visible copy and directly related historical copy in the UI units touched by this task; this includes aria labels, tooltips, errors, and toasts. Do not expand a one-file change to the entire page or overwrite unrelated changes. Do not expand authorization for read-only tasks or when the user prohibits page changes. Run the root command `pnpm ops ci check i18n --base <ref>` and applicable real verification. Do not add consumers of the legacy dictionary. Do not translate user content, protocols, logs, or code.


- Consumer domains may import UI capabilities only from the `components/ui` barrel; deep imports of UI implementations are prohibited.
- `components/ui` must not depend on app, shell, feature, business components, APIs, or stores; compose business changes through contracts/feature contributions.
- Pages must not add native `button/input/select/textarea/table` elements; do not hand-code SVG icons or create equivalent design-system components inside a feature.
- Per-file counts in the reuse ratchet may only decrease; files not listed have a budget of zero. Do not expand `reuse.policy.json` or hand-edit `reuse.baseline.json` to make checks pass. Extend and register missing capabilities according to the [component Owner contract](docs/design/components.md).
- Before page development, consult the [component assets and reuse guide](docs/design/assets.md) and [generated asset list](docs/_generated/components.md); before reuse, verify props, dependencies, and running examples.
- For a new page without a product design, first choose its page type and `Page` composition according to the [Vibe Coding page contract](docs/design/vibe-coding.md); PageBody must not create a scroll container that duplicates the host's.
- Use Tailwind for all styles in owned pages/components that Tailwind can express; hand-written selector CSS is only for necessary overrides of third-party internals. Design owns design tokens, fonts, and necessary keyframes; see the [styling specification](docs/design/foundations.md) for boundaries and existing-style migration.
- CSS rule additions/changes are constrained by the identity ratchet. Precisely register necessary third-party overrides in `scripts/ci/css.exceptions.json`, including the container, selector, library, reason, and verification method; do not expand the historical inventory.
- Subsequent page development must fix only related UI added or modified in this task; it does not require a whole-page rewrite and must not expand to other owners. Merging base code does not automatically migrate pages.
- Use `--vds-*` tokens for new visual values; do not add fixed colors, fixed Tailwind colors, or purely visual inline styles. State the source of dynamic geometry and user-data values.
- Choose overlay stacking by semantic role in `design/zindex.css`: use `--vds-z-inline-flyout` for project/view navigation, `--vds-z-local-control` for local hit controls, `--vds-z-surface-panel`, `--vds-z-scroll-control`, and `--vds-z-session-confirm` respectively for persistent workspace panels, in-session scroll controls, and fallback confirmation; use `AlertDialog` and nested tokens from the dialog family for nested destructive confirmation. Pages must not use private bare z-index values, and `visual.mjs` must resolve every new reference to a real token definition.
- The renderer must not receive Node/Electron capabilities; expose capabilities through main → preload → typed renderer contract.
- Document status terms must distinguish `current`, `required`, `gap`, and `advisory`; do not describe a target state as a current capability.

<a id="跨平台构建硬约束"></a>
## Cross-Platform Build Hard Constraints

When changing main, packaging scripts, Runtime assembly, the filesystem, or subprocess startup, check both macOS and Windows:

- Construct paths with `path.join` / `path.resolve`, construct `PATH` with `path.delimiter`, and support both LF and CRLF when parsing command output.
- Do not assume commands have no extension; verify the startup method for `.exe`, `.cmd`, and `.bat` separately, and never pass untrusted arguments to a shell.
- Obtain the target Python's command directory through that interpreter's `sysconfig.get_path("scripts")`; do not assume it is in the same directory as `python.exe`.
- Do not use the host Python, host npm, host PATH, or source directory to prove that the packaged Runtime works.
- Normalize file permissions according to regular-file/executable semantics; do not directly use Windows' POSIX mode representation to determine integrity.
- When changing the above logic, add a macOS/Windows behavior matrix and corresponding contract tests. Windows verification must at minimum run the root command `pnpm ops cd build local --platform win32 --arch x86_64`, confirm that Velopack Setup/full artifacts are generated, and confirm `release-result.json` has `status: passed`.
- Pin the exact `electron-builder` version; do not use a `^` range. Newer dmg-builder versions download dmgbuild at runtime by default; this repository pins `dmgbuild==1.6.7` as a macOS build-time dependency. The DMG entry point must verify the local executable and set `CUSTOM_DMGBUILD_PATH`; if it is missing, refuse to build instead of falling back to a network download. Do not claim that forced unmount for `hdiutil` error code `16` works based only on an upstream source branch; verify it with a real failure.
- `scripts/image.py` owns DMG capacity and copy failures. Before changing that path, read the [build guide](../../docs/runbooks/build.md), run `node --test apps/desktop/scripts/image.test.cjs`, and verify a real image; a valid DMG checksum does not prove that its contents are complete.

<a id="设计对齐"></a>
## Design Alignment

- Public design requirements and mappings live in `docs/architecture/design-map.md`; read the relevant states and constraints before changing UI.
- Use [design tooling](docs/design/tooling.md) and the public `ui-component-reuse` skill. A private design service is optional, never a prerequisite.
- Distinguish current behavior, confirmed requirements, gaps and advisory guidance. Design evidence and static checks do not prove real product acceptance.

<a id="windows-更新权限维护"></a>
## Windows Update Privilege Maintenance

- Windows installation and updates are managed by a pinned Velopack version. Deliver only the per-user Setup EXE; system-wide installation is not currently supported, and do not build or distribute MSI. macOS retains Squirrel.Mac. Before changing this boundary, read the [Windows update contract](updater/README.md#windows-velopack).
- Update packages must pass offline signature verification, complete member-manifest checks, and path preflight; authorization of an online candidate must match the installation identity. Official Velopack owns application replacement. A separate thin helper uses the `packages` staging area under the installation root after elevation, prepares missing components, and lets the original user's coordinator resume startup. Do not restore the old application store, health rollback, or resident recovery service.
- On Windows, download Python, TeX Live, PowerShell, Codex, and Office as separate ZIPs according to signed manifests. Setup/full/delta packages carry only the application and `runtime.json`; the first installation requires network access. Expand and reuse components under `runtime` in the installation root by their independent versions. On first expansion, verify the complete inventory; for existing versions, check identity, completion receipts, and key entry points. Do not describe fast reuse as a full-disk corruption check. Keep the macOS layout unchanged.
- Before updating, quiesce and confirm that the backend/runtime process families owned by this application have exited. If handoff fails, resume the original version; do not perform health-failure rollback or migrate old update directories.
- Do not kill processes by name or clean up shared Runtime components that another installation might still use; the current manifest alone does not authorize reclaiming shared components.
- Only CI performs official signing and upload. Local unsigned installations, unit tests, or framework probes cannot count as acceptance of officially signed updates/UAC.
- Real machines must cover per-user installation, delta/full updates, Runtime exit recovery, uninstall, and path/signature rejection. Source inspection cannot replace launching the installed product and capturing screenshots.

<a id="windows-公司元数据"></a>
## Windows Company Metadata

- Control Panel Publisher and EXE CompanyName use `author.name` from `package.json`: `Alibaba Damo (Hangzhou) Technology Co., Ltd.`; do not change the certificate Subject or automatic-update signature verification.
- electron-builder's author normalization treats parentheses as a URL and truncates the name, even when author is an object; `build.cjs` must pass through the original object via normalized `extraMetadata.author`.

<a id="完成前"></a>
## Before Completion

- Updated CDP arguments are validated centrally by `src/main/debuglaunch.ts`; retain only explicitly valid local ports, do not enable debugging when no argument is supplied, and do not pass through arbitrary argv. On Windows, pass them with user-data-dir in `receipt.update.lock`; on macOS, save them in one-time context through `relaunch.ts` and restore them in `index.ts` before the app is ready, with an explicitly supplied new port/pipe taking priority. Focused tests: `node --experimental-transform-types --test src/main/debuglaunch.test.ts src/main/relaunch.test.ts`. A real Squirrel upgrade requires both source and target versions to include this protocol; Windows requires native hardware verification. Unit tests and Electron probes do not replace acceptance of the installed build.

- For an unresponsive Windows tray, first collect `$SCHOLARSEED_HOME/logs/window.log`, normally under `.scholarseed/logs/` in the user's home directory; also confirm whether the main process still exists. This file is created only after the first relevant operation is triggered in a build with window diagnostics. Do not use events triggered in unit tests or macOS window restoration as proof that the Windows system tray has passed acceptance.
- Use `resources/windows.ico` / `windows-tray.ico` for the Windows tray icon. Bind the native context menu with `Tray.setContextMenu`, so Quit can be selected while the window is hidden without waiting for a renderer response. Apply snapshots received while the menu is open after it closes, preserving the click behavior of the menu items shown at that time.

- Window-close confirmation requests and system actions are owned by `src/main/tray.ts` and passed through the IPC contract in `src/window.ts` to compose the shared UI in `src/renderer/src/shell/Close.tsx`; do not reintroduce a fixed-size data URL HTML dialog. See `docs/architecture/ownership.md` for the platform matrix. Focused check: `node --experimental-transform-types --test src/main/tray.test.ts src/main/menu.test.ts`. Real close acceptance: after building, run `npx playwright test e2e/close.spec.ts --project=smoke`; do not use `--drive` / headless startup that bypasses close logic to prove close behavior.

```bash
# Run from the repository root
pnpm ops ci check docs desktop
pnpm ops ci test --scope desktop
pnpm ops ci check types desktop
```

When specifications, source, or gates change, run the root command `pnpm ops ci check docs desktop --write` to update generated inventories, then run the checks above. This command does not change the baseline; update the baseline only in a separate, explicitly reviewed debt-reduction change, and never use it to conceal newly added debt.
