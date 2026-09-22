; ScholarSeed 自定义 NSIS 脚本。
;
; electron-builder 从 buildResources 目录（本仓为 resources/）自动包含 installer.nsh；其中
; !macro customInstall 会在 installSection.nsh 的 addStartMenuLink / addDesktopLink 之后被插入执行
; （见 app-builder-lib templates/nsis/installSection.nsh 的 `!ifmacrodef customInstall`）。
;
; 修的 bug：Windows 版本更新后桌面 / 开始菜单快捷方式消失且不再恢复。
;
; 根因（对 electron-builder 26.3.5 模板逐字核实）：更新时 ${isUpdated} 为真，addDesktopLink /
; addStartMenuLink 只有两条出路——
;   ① $keepShortcuts == "false" 时才 CreateShortCut；
;   ② $keepShortcuts == "true" 时，仅当旧链接仍存在才把旧名 Rename 成新名。
; 更新时 $keepShortcuts 常为 "true"（由注册表 KeepShortcuts 门控），于是走 ②：一旦旧版卸载器已删掉
; 旧快捷方式、或品牌改名导致 $oldDesktopLink 与真实旧图标对不上（$oldShortcutName 缺省回退到
; productName "ScholarSeed"，与当前 SHORTCUT_NAME "书深" 不一致），${FileExists} 为假 → 既不 Rename
; 也不 Create → 快捷方式永久丢失。
; createDesktopShortcut:"always" 治不了：其 RECREATE_DESKTOP_SHORTCUT 分支被 ${ifNot} ${isUpdated}
; 挡死，更新时根本不执行。
;
; 兜底策略：安装末尾无条件检查，缺哪个就按当前 SHORTCUT_NAME / MENU 补建哪个。仅在缺失时创建，
; 不覆盖用户已有的快捷方式；对「改名 / 旧卸载器删除 / keepShortcuts 只 Rename」所有成因都成立。

!macro customInstall
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${ifNot} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${endIf}
  !endif

  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${ifNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${endIf}
  !endif

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
