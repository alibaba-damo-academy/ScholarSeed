# Platform artwork

| Platform | Source | Packaged icon | Status |
| --- | --- | --- | --- |
| macOS arm64 / x64 | `icon.png` (provided `logo-mac.png`) | `icon.icns` | current configuration |
| Windows x64 | `windows.png` (provided `logo-win.png`) + `windows.ico` | `windows.ico` for EXE / Velopack | current configuration |
| macOS menu bar | `tray.svg` (provided `shushen.svg`) | monochrome `tray.png`, resized to 18 logical pixels and marked as a template image | current configuration |
| Windows tray | `tray.svg` (provided `shushen.svg`) | deep-green `tray.ico` / white `tray-white.ico` | current configuration |

The macOS artwork includes its supplied transparent margin; Windows uses its
separate full-canvas artwork. Preserve both originals and their alpha channels.
Application-internal logos are independent and are not changed by these assets.

Tray artwork is independent of application artwork. `tray.png` is a transparent
256px rasterization of `tray.svg` with black foreground and the original alpha.
macOS uses template rendering to choose the menu-bar foreground automatically.
Both Windows ICOs contain 16, 20, 24, 32, 40, 48, 64, 128 and 256px representations
with the original alpha. Windows selects white for the dark system/taskbar theme
and the source SVG's deep green for the light system/taskbar theme, independently of the app theme.
The tray listens to native theme updates and removes that listener when its owning
window closes. At startup and on those updates, Windows reads the current user's
`Personalize/SystemUsesLightTheme` registry value through a bounded, hidden
`reg.exe` query. Electron 44 can initially report the application theme for system
UI, so its system-theme getter is only a logged fallback if the query fails.
Windows native theme switching still requires real-host acceptance.
Updating tray resources must not
regenerate or overwrite `icon.png`, `icon.icns`, `windows.png` or `windows.ico`.
The legacy packaged name `windows-tray.ico` still supplies the Windows window
application icon; preserve its mapping to `windows.ico`, not the new tray asset.

Regenerate the macOS ICNS on macOS from the repository root:

```sh
.venv/bin/python scripts/cd/icons.py --from-png apps/desktop/resources/icon.png
```

Always pass `--from-png`; omitting it renders the script's legacy artwork.
This command writes `icon.png` and `icon.icns`, never `windows.png` or
`windows.ico`. Replace `windows.png` directly when updating Windows artwork, then
regenerate `windows.ico` from that PNG. Both package.json and scripts/shared/target.cjs
must select the same platform-specific path.

Required acceptance: build and inspect the real macOS application/DMG and Windows
EXE/Velopack on their respective operating systems. Asset checks alone do not prove
the installed application, shortcut, or installer appearance.
