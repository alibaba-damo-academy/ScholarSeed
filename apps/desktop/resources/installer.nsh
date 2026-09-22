; ScholarSeed 自定义 NSIS 脚本。
;
; electron-builder 从 buildResources 目录（本仓为 resources/）自动包含 installer.nsh；其中
; !macro customInstall 会在 installSection.nsh 的 addStartMenuLink / addDesktopLink 之后被插入执行
; （见 app-builder-lib templates/nsis/installSection.nsh 的 `!ifmacrodef customInstall`）。
;
; 本文件承载两块内容：
;
; A. 快捷方式兜底（历史修复）：Windows 版本更新后桌面 / 开始菜单快捷方式消失且不再恢复。
;    根因（对 electron-builder 26.3.5 模板逐字核实，26.15.7 行为相同）：更新时 ${isUpdated} 为真，
;    addDesktopLink / addStartMenuLink 只有两条出路——
;      ① $keepShortcuts == "false" 时才 CreateShortCut；
;      ② $keepShortcuts == "true" 时，仅当旧链接仍存在才把旧名 Rename 成新名。
;    更新时 $keepShortcuts 常为 "true"（由注册表 KeepShortcuts 门控），于是走 ②：一旦旧版卸载器已删掉
;    旧快捷方式、或品牌改名导致 $oldDesktopLink 与真实旧图标对不上（$oldShortcutName 缺省回退到
;    productName "ScholarSeed"，与当前 SHORTCUT_NAME "书深" 不一致），${FileExists} 为假 → 既不 Rename
;    也不 Create → 快捷方式永久丢失。
;    createDesktopShortcut:"always" 治不了：其 RECREATE_DESKTOP_SHORTCUT 分支被 ${ifNot} ${isUpdated}
;    挡死，更新时根本不执行。
;    兜底策略：安装末尾无条件检查，缺哪个就按当前 SHORTCUT_NAME / MENU 补建哪个。仅在缺失时创建，
;    不覆盖用户已有的快捷方式；对「改名 / 旧卸载器删除 / keepShortcuts 只 Rename」所有成因都成立。
;
; B. 更新握手与单次拉起（proposal 108 §5.1/§5.2，P0）：
;    - 新协议：app 以 `--updated /SCHOLARSEED_UPDATE_ID=<uuid>` + env(SCHOLARSEED_HOME,
;      SCHOLARSEED_UPDATE_NONCE) 拉起本安装器；customInit 校验上下文 → 写 ready.ini → 等
;      decision.ini（commit 才继续；cancel/超时在**卸载发生前**退出）→ 等旧进程退出（≤60s，
;      不强杀）。旧 0.2.0 客户端不带协议参数 → legacy 模式，原 silent force-run 路径原样保留。
;    - 握手文件为 UTF-16LE 带 BOM 的 key=value 行（NSIS FileReadUTF16LE/FileWriteUTF16LE 与
;      Node 'utf16le' 双方原生、不依赖系统代码页，见 handshake.ts 头注释与 bug 87108457）。
;    - install.log 只写 ASCII 字符（阶段/事件/结果/updateId 都是常量或十六进制；不记路径），
;      因此普通 FileWrite（ANSI）在任何代码页下字节一致，Node/Python 按 UTF-8 直接可读。
;    - 自动拉起唯一所有者是自定义 Finish 页的 PRE 回调（协议模式安装成功后跳过 Finish 并拉起
;      一次）；customInstall 末尾只置 installComplete 标志，不启动应用。
;    - 协议模式跳过「安装模式」选择页（customInstallMode）：assisted 非静默下该页
;      （multiUserUi 的 PAGE_INSTALL_MODE）没有 skipPageIfUpdated 包裹，必弹且阻塞——2026-09-22
;      真机事故里自动更新就停在这一页等人工点击，安装始终没发生。模板在页 PRE 里给了
;      customInstallMode 钩子：置 $isForceCurrentInstall=1 即走 setInstallModePerUser + Abort 跳页，
;      与握手「同用户、非提权」前提一致；仅当确有 per-user 旧安装时才强制，否则回退模板默认页。
;      跳页后非静默只剩进度页与（被 ssFinishPre 跳过的）Finish 页，即「更新仅进度窗」。
;    - 目录 ACL 未在 NSIS 侧逐条检查（GetNamedSecurityInfo 链在 NSIS 里不可维护）；等效防护是
;      身份绑定：ready/decision 必须携带与 env+request.ini 一致的 updateId+nonce（128bit 随机），
;      加上 SID 比对与 reparse 拒绝，第三方进程既猜不出凭据也伪造不了记录。
;    - 函数间不使用栈传参（避免 NSIS Exch 约定踩坑）：入参/出参一律走全局 Var，注释写明各函数
;      的读写寄存器。
;
; 待 Windows 真机出包验证：本文件所有行为在 macOS 上只能验证 makensis 编译通过（交叉出包），
; 不能验证运行时行为（见 proposal 108 §11）。

; ssHandshakeMode 必须在顶层声明，不能留在 customHeader 内：customInstallMode 钩子由 multiUserUi
; 的 PAGE_INSTALL_MODE 在 installer.nsi 早于 customHeader 展开处插入并引用 $ssHandshakeMode；nsis
; 3.0.4.x 此时该 Var 尚未声明会报 warning 6000，而 electron-builder 把 warning 当 error 直接失败。
; 顶层声明落在 electron-builder 的 sharedHeader 中、先于 installer.nsi 主体，前向引用即可解析。
; 卸载器构建不展开握手逻辑，与 customHeader 内其余 Var 同样用 BUILD_UNINSTALLER 排除。
!ifndef BUILD_UNINSTALLER
  Var ssHandshakeMode
!endif

!macro customHeader
  !ifndef BUILD_UNINSTALLER

    !include FileFunc.nsh

    ; ---- 握手协议常量（与 src/main/handshake.ts 逐字对齐） ----
    !define SS_HANDSHAKE_SCHEMA "1"
    !define SS_UPDATE_ID_OPTION "/SCHOLARSEED_UPDATE_ID="
    !define SS_HOME_ENV "SCHOLARSEED_HOME"
    !define SS_NONCE_ENV "SCHOLARSEED_UPDATE_NONCE"
    !define SS_REQUEST_FILE "request.ini"
    !define SS_READY_FILE "ready.ini"
    !define SS_DECISION_FILE "decision.ini"
    !define SS_INSTALL_LOG "install.log"
    !define SS_HANDSHAKE_SLEEP_MS 200
    ; 决策等待与旧进程退出等待各 300 × 200ms = 60s（提案 §5.2 第 4/5 条）。
    !define SS_DECISION_WAIT_ROUNDS 300
    !define SS_OLDPROC_WAIT_ROUNDS 300
    !define SS_STILL_ACTIVE 259
    !define SS_TOKEN_QUERY 0x0008
    !define SS_PROCESS_QUERY_LIMITED_INFORMATION 0x1000
    !define SS_TOKEN_USER 1

    Var ssUpdateId
    Var ssNonce
    Var ssHome
    Var ssCallerSid
    Var ssCallerPid
    Var ssInstallerPid
    Var ssCreationLow
    Var ssCreationHigh
    Var ssInstallComplete
    Var ssLaunchAttempted
    ; ssLogEvent 的日志文件句柄：用具名 Var 而非 $9 等寄存器，杜绝与调用方/GetTime 的寄存器别名。
    Var ssLogHandle
    ; ssLogEvent 的入参（全局 Var 传参，见头注释）
    Var ssLogPhase
    Var ssLogEventName
    Var ssLogResult
    ; ssLogEvent 的 GetTime 输出槽
    Var ssTimeDay
    Var ssTimeMonth
    Var ssTimeYear
    Var ssTimeWeekday
    Var ssTimeHour
    Var ssTimeMinute
    Var ssTimeSecond

    ; ---------- 通用小工具 ----------

    ; 入参 $R8 = 字符串；出参 $R9 = 长度（NSIS 没有内建 StrLen 指令）。
    ; 读写寄存器：$R7（临时）、$R8、$R9。
    Function ssStrLen
      StrCpy $R9 0
      ss_strlen_loop:
        StrCpy $R7 $R8 1 $R9
        StrCmp $R7 "" ss_strlen_done
        IntOp $R9 $R9 + 1
        Goto ss_strlen_loop
      ss_strlen_done:
    FunctionEnd

    ; 入参 $R7 = 单个字符；非 [0-9a-f] 时置错误标志。
    Function ssIsHexChar
      ClearErrors
      StrCmp $R7 "0" ss_hex_ok
      StrCmp $R7 "1" ss_hex_ok
      StrCmp $R7 "2" ss_hex_ok
      StrCmp $R7 "3" ss_hex_ok
      StrCmp $R7 "4" ss_hex_ok
      StrCmp $R7 "5" ss_hex_ok
      StrCmp $R7 "6" ss_hex_ok
      StrCmp $R7 "7" ss_hex_ok
      StrCmp $R7 "8" ss_hex_ok
      StrCmp $R7 "9" ss_hex_ok
      StrCmp $R7 "a" ss_hex_ok
      StrCmp $R7 "b" ss_hex_ok
      StrCmp $R7 "c" ss_hex_ok
      StrCmp $R7 "d" ss_hex_ok
      StrCmp $R7 "e" ss_hex_ok
      StrCmp $R7 "f" ss_hex_ok
      SetErrors
      ss_hex_ok:
    FunctionEnd

    ; 去掉 $R4 末尾的 \r / \n。读写寄存器：$R4、$R7。
    Function ssTrimEnd
      ss_trim_loop:
        StrCpy $R7 $R4 "" -1
        StrCmp $R7 "$\r" ss_trim_cut
        StrCmp $R7 "$\n" ss_trim_cut
        Goto ss_trim_done
      ss_trim_cut:
        StrCpy $R4 $R4 -1
        Goto ss_trim_loop
      ss_trim_done:
    FunctionEnd

    ; 从已打开句柄 $R2 读一行 key=value：入参 $R5 = 期望的 "key="（含等号）。
    ; 成功：$R4 = 值；失败置错误标志。读写寄存器：$R2、$R4、$R5，临时 $R6/$R7/$R8/$R9。
    Function ssReadField
      Push $R6
      ClearErrors
      FileReadUTF16LE $R2 $R4
      IfErrors ss_readfield_fail
      Call ssTrimEnd
      StrCpy $R8 $R5
      Call ssStrLen          ; $R9 = len("key=")，前缀长度运行时计算，不做编译期硬编码
      StrCpy $R7 $R4 $R9
      StrCmp $R7 $R5 0 ss_readfield_fail
      StrCpy $R4 $R4 "" $R9
      ClearErrors
      Goto ss_readfield_ok
      ss_readfield_fail:
        SetErrors
      ss_readfield_ok:
      Pop $R6
    FunctionEnd

    ; $ssUpdateId 形状校验：36 位、破折号在 8/13/18/23、其余为小写十六进制。
    ; 这是 updateId 参与任何路径拼接前的唯一闸（防路径穿越），与 Node 侧 isValidUpdateId 同判据。
    ; 读写寄存器：$R6/$R7/$R8/$R9；错误标志 = 校验结果。
    Function ssValidateUuid
      ClearErrors
      StrCpy $R8 $ssUpdateId
      Call ssStrLen
      IntCmp $R9 36 0 ss_uuid_bad ss_uuid_bad
      StrCpy $R7 $ssUpdateId 1 8
      StrCmp $R7 "-" 0 ss_uuid_bad
      StrCpy $R7 $ssUpdateId 1 13
      StrCmp $R7 "-" 0 ss_uuid_bad
      StrCpy $R7 $ssUpdateId 1 18
      StrCmp $R7 "-" 0 ss_uuid_bad
      StrCpy $R7 $ssUpdateId 1 23
      StrCmp $R7 "-" 0 ss_uuid_bad
      StrCpy $R6 0
      ss_uuid_loop:
        IntCmp $R6 36 ss_uuid_ok
        StrCpy $R7 $ssUpdateId 1 $R6
        IntCmp $R6 8 ss_uuid_next 0 0
        IntCmp $R6 13 ss_uuid_next 0 0
        IntCmp $R6 18 ss_uuid_next 0 0
        IntCmp $R6 23 ss_uuid_next 0 0
        Call ssIsHexChar
        IfErrors ss_uuid_bad
        ss_uuid_next:
        IntOp $R6 $R6 + 1
        Goto ss_uuid_loop
      ss_uuid_ok:
      ClearErrors
      Return
      ss_uuid_bad:
      SetErrors
    FunctionEnd

    ; 入参 $R8 = 32 位小写十六进制串（nonce）；错误标志 = 校验结果。
    ; 读写寄存器：$R6/$R7/$R8/$R9。
    Function ssValidateHex32
      ClearErrors
      Call ssStrLen
      IntCmp $R9 32 0 ss_hex32_bad ss_hex32_bad
      StrCpy $R6 0
      ss_hex32_loop:
        IntCmp $R6 32 ss_hex32_ok
        StrCpy $R7 $R8 1 $R6
        Call ssIsHexChar
        IfErrors ss_hex32_bad
        IntOp $R6 $R6 + 1
        Goto ss_hex32_loop
      ss_hex32_ok:
      ClearErrors
      Return
      ss_hex32_bad:
      SetErrors
    FunctionEnd

    ; ---------- install.log ----------

    ; 入参（全局 Var）：ssLogPhase / ssLogEventName / ssLogResult（均须为 ASCII）。
    ; 写一行 ASCII JSON 到 <home>/logs/install.log。写失败静默跳过：日志是附带动作，
    ; 不能反过来弄坏安装（与 Node 侧 persistUpdateLog 同纪律）。$ssHome 为空（早期失败）同样跳过。
    ;
    ; 2026-09-22 真机 install.log 恒 0 字节（握手各阶段明确跑过却一行没落）后的加固形态，
    ; 逐条切断嫌疑链，运行时行为待 Windows 出包验证：
    ; ① 句柄用具名 Var ssLogHandle，不再借 $9 —— 排除寄存器别名致 FileWrite 写到坏句柄；
    ; ② 入函数先 Push 全部 20 个寄存器、出函数逆序 Pop —— ${GetTime} 等 FileFunc 函数会扫
    ;    $0-$9/$R0-$R9，调用方（ssHandshakeInit 的 $R1 握手目录、$R2 文件句柄）任何一个被扫掉
    ;    都是静默错写/错读；
    ; ③ 日志目录已存在时跳过 CreateDirectory —— 排除「对已存在目录建目录置错误标志」被
    ;    IfErrors 当成失败而整段跳过；
    ; ④ 时间戳分段 FileWrite，不写 "$ssTimeDayT..." 这种串 —— NSIS 变量名按最长标识符解析，
    ;    T/Z 会被并进变量名（ssTimeDayT 未声明），整段展开成空串或字面量。
    ; 读写寄存器：无对外泄漏（全部自保存/恢复）；ssTime* Var 与 ssLogHandle 为本函数私有契约。
    Function ssLogEvent
      Push $0
      Push $1
      Push $2
      Push $3
      Push $4
      Push $5
      Push $6
      Push $7
      Push $8
      Push $9
      Push $R0
      Push $R1
      Push $R2
      Push $R3
      Push $R4
      Push $R5
      Push $R6
      Push $R7
      Push $R8
      Push $R9
      StrCmp $ssHome "" ss_log_done
      IfFileExists "$ssHome\logs" ss_log_dir_ok
      CreateDirectory "$ssHome\logs"
      IfErrors ss_log_done
      ss_log_dir_ok:
      ; UTC 时间戳（GetTime "U"）：day month year weekday hour min sec
      ${GetTime} "" "U" $ssTimeDay $ssTimeMonth $ssTimeYear $ssTimeWeekday $ssTimeHour $ssTimeMinute $ssTimeSecond
      FileOpen $ssLogHandle "$ssHome\logs\${SS_INSTALL_LOG}" a
      IfErrors ss_log_done
      FileSeek $ssLogHandle 0 END
      FileWrite $ssLogHandle '{"schemaVersion":${SS_HANDSHAKE_SCHEMA},"timestampUtc":"'
      FileWrite $ssLogHandle "$ssTimeYear-$ssTimeMonth-$ssTimeDay"
      FileWrite $ssLogHandle 'T'
      FileWrite $ssLogHandle "$ssTimeHour:$ssTimeMinute:$ssTimeSecond"
      FileWrite $ssLogHandle 'Z","processId":'
      FileWrite $ssLogHandle "$ssInstallerPid"
      FileWrite $ssLogHandle ',"updateId":"'
      FileWrite $ssLogHandle "$ssUpdateId"
      FileWrite $ssLogHandle '","phase":"'
      FileWrite $ssLogHandle "$ssLogPhase"
      FileWrite $ssLogHandle '","event":"'
      FileWrite $ssLogHandle "$ssLogEventName"
      FileWrite $ssLogHandle '","result":"'
      FileWrite $ssLogHandle "$ssLogResult"
      FileWrite $ssLogHandle '"}$\r$\n'
      FileClose $ssLogHandle
      ss_log_done:
      Pop $R9
      Pop $R8
      Pop $R7
      Pop $R6
      Pop $R5
      Pop $R4
      Pop $R3
      Pop $R2
      Pop $R1
      Pop $R0
      Pop $9
      Pop $8
      Pop $7
      Pop $6
      Pop $5
      Pop $4
      Pop $3
      Pop $2
      Pop $1
      Pop $0
    FunctionEnd

    ; ---------- SID ----------

    ; 取当前进程用户 SID 到 $R4；失败置错误标志。只用 System::Call（原生 API），
    ; 不经 PowerShell，不受受限语言模式影响。读写寄存器：$R4、$0-$7。
    Function ssCurrentUserSid
      ClearErrors
      System::Call 'advapi32::OpenProcessToken(p -1, i ${SS_TOKEN_QUERY}, *p .r1) i .r0'
      StrCmp $0 "0" ss_sid_fail
      ; 先取所需缓冲区大小（TokenUser）
      System::Call 'advapi32::GetTokenInformation(p r1, i ${SS_TOKEN_USER}, p 0, i 0, *i .r2) i .r0'
      StrCmp $2 "0" ss_sid_close_fail
      System::Alloc $2
      Pop $3
      System::Call 'advapi32::GetTokenInformation(p r1, i ${SS_TOKEN_USER}, p r3, i r2, *i .r0) i .r4'
      StrCmp $4 "0" ss_sid_free_fail
      ; TOKEN_USER 首成员是 SID_AND_ATTRIBUTES{PSID,...}：偏移 0 处读出 PSID
      System::Call '*$3(p .r5)'
      System::Call 'advapi32::ConvertSidToStringSidW(p r5, *p .r6) i .r4'
      StrCmp $4 "0" ss_sid_free_fail
      System::Call '*$6(&w${NSIS_MAX_STRLEN} .r7)'
      System::Call 'kernel32::LocalFree(p r6)'
      System::Free $3
      System::Call 'kernel32::CloseHandle(p r1)'
      StrCpy $R4 $7
      Return
      ss_sid_free_fail:
      System::Free $3
      ss_sid_close_fail:
      System::Call 'kernel32::CloseHandle(p r1)'
      ss_sid_fail:
      SetErrors
    FunctionEnd

    ; ---------- 旧进程退出等待 ----------

    ; 等 $ssCallerPid 退出（≤60s）。创建时刻与 request.ini 记录不一致 = PID 已被复用，
    ; 视为原进程已退出（不等无关进程）。超时置错误标志；调用方必须中止安装
    ; （绝不强杀、绝不带着活进程进入卸载）。读写寄存器：$R6/$R7、$0-$8。
    Function ssWaitOldProcessExit
      StrCpy $R6 0
      ss_wait_loop:
        System::Call 'kernel32::OpenProcess(i ${SS_PROCESS_QUERY_LIMITED_INFORMATION}, i 0, i $ssCallerPid) p .r1'
        StrCmp $1 "0" ss_wait_exited
        System::Alloc 8
        Pop $2
        System::Alloc 8
        Pop $3
        System::Alloc 8
        Pop $4
        System::Alloc 8
        Pop $5
        System::Call 'kernel32::GetProcessTimes(p r1, p r2, p r3, p r4, p r5) i .r0'
        StrCmp $0 "0" ss_wait_check_exit
        System::Call '*$2(i .r0, i .r7)'
        StrCmp $0 $ssCreationLow 0 ss_wait_reused
        StrCmp $7 $ssCreationHigh 0 ss_wait_reused
        ss_wait_check_exit:
        System::Call 'kernel32::GetExitCodeProcess(p r1, *i .r7) i .r8'
        StrCmp $8 "0" ss_wait_running
        IntCmp $7 ${SS_STILL_ACTIVE} ss_wait_running
        ; 已退出
        System::Free $2
        System::Free $3
        System::Free $4
        System::Free $5
        System::Call 'kernel32::CloseHandle(p r1)'
        Goto ss_wait_exited
        ss_wait_reused:
        System::Free $2
        System::Free $3
        System::Free $4
        System::Free $5
        System::Call 'kernel32::CloseHandle(p r1)'
        Goto ss_wait_exited
        ss_wait_running:
        System::Free $2
        System::Free $3
        System::Free $4
        System::Free $5
        System::Call 'kernel32::CloseHandle(p r1)'
        IntOp $R6 $R6 + 1
        IntCmp $R6 ${SS_OLDPROC_WAIT_ROUNDS} ss_wait_timeout
        Sleep ${SS_HANDSHAKE_SLEEP_MS}
        Goto ss_wait_loop
      ss_wait_exited:
      ClearErrors
      Return
      ss_wait_timeout:
      SetErrors
    FunctionEnd

    ; ---------- 拉起 ----------

    ; 协议模式下唯一的自动拉起者。$appExe 由 installSection 在文件安装前设好
    ; （StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"），Finish PRE 时必然可用；
    ; 用真实 exe 而非可能陈旧的快捷方式（提案 §5.2）。ExecShellAsUser 保证不继承管理员身份。
    ; 读写寄存器：$0（ExecShellAsUser 状态串，随即转存进日志）。
    Function ssLaunchUpdatedAppOnce
      StrCmp $ssLaunchAttempted "1" ss_launch_done
      StrCpy $ssLaunchAttempted "1"
      StrCpy $ssLogPhase "launch"
      StrCpy $ssLogEventName "begin"
      StrCpy $ssLogResult "attempt"
      Call ssLogEvent
      ${StdUtils.ExecShellAsUser} $0 "$appExe" "open" "--updated --scholarseed-update-id=$ssUpdateId"
      StrCpy $ssLogPhase "launch"
      StrCpy $ssLogEventName "end"
      StrCpy $ssLogResult $0
      Call ssLogEvent
      ss_launch_done:
    FunctionEnd

    ; ---------- 握手主流程 ----------

    ; 协议上下文缺失/伪造/超时一律在 customInit 内 Quit：此时页面尚未开始、
    ; uninstallOldVersion 尚未执行（installSection.nsh 顺序），旧安装完好无损。
    ; 入参（全局 Var）：ssLogResult = 原因码（ASCII）。
    Function ssHandshakeFail
      StrCpy $ssLogPhase "context"
      StrCpy $ssLogEventName "invalid"
      Call ssLogEvent
      MessageBox MB_OK|MB_ICONSTOP "更新交接失败（$ssLogResult），安装已取消，当前版本未被改动。请手动运行安装程序完成更新。$\r$\nUpdate handoff failed ($ssLogResult); install cancelled, current version untouched. Run the installer manually."
      Quit
    FunctionEnd

    ; 读写寄存器：$R0/$R1/$R2/$R4/$R5/$R6/$R7/$R8/$R9、$0-$8；全局 Var 见声明区。
    Function ssHandshakeInit
      StrCpy $ssHandshakeMode "legacy"
      StrCpy $ssInstallComplete "0"
      StrCpy $ssLaunchAttempted "0"

      ; NSIS 无内建 $PID：显式取当前安装器进程 ID。System 输出记号 .r0 落入 $0（非 $R0），
      ; 故读 $0。在 legacy 提前返回之前设置，保证 ssLogEvent 与 ready.ini 总能拿到。
      System::Call 'kernel32::GetCurrentProcessId() i .r0'
      StrCpy $ssInstallerPid $0

      ${GetParameters} $R0
      ClearErrors
      ${GetOptions} $R0 "${SS_UPDATE_ID_OPTION}" $ssUpdateId
      IfErrors ss_init_return        ; 无协议参数 → legacy（旧客户端 /S --force-run 或手动双击）
      StrCpy $ssHandshakeMode "protocol"

      Call ssValidateUuid
      IfErrors ss_init_fail_uuid

      ReadEnvStr $ssHome ${SS_HOME_ENV}
      StrCmp $ssHome "" ss_init_fail_home

      ReadEnvStr $ssNonce ${SS_NONCE_ENV}
      StrCmp $ssNonce "" ss_init_fail_nonce
      StrCpy $R8 $ssNonce
      Call ssValidateHex32
      IfErrors ss_init_fail_nonce

      StrCpy $ssLogPhase "installer"
      StrCpy $ssLogEventName "start"
      StrCpy $ssLogResult "protocol"
      Call ssLogEvent

      ; 日志目录必须可写且非 reparse：无法建立安全日志时拒绝交接（提案 §5.1）。
      CreateDirectory "$ssHome\logs"
      IfErrors ss_init_fail_logdir
      ClearErrors
      ${GetFileAttributes} "$ssHome\logs" "REPARSE_POINT" $R6
      IfErrors ss_init_fail_logdir
      StrCmp $R6 "1" ss_init_fail_logdir

      ; 握手目录与 request.ini（$R1 此后一直保持目录路径，ssReadField/等待循环不得占用）
      StrCpy $R1 "$ssHome\updates\install\$ssUpdateId"
      IfFileExists "$R1\${SS_REQUEST_FILE}" 0 ss_init_fail_request
      ClearErrors
      ${GetFileAttributes} "$R1" "REPARSE_POINT" $R6
      IfErrors ss_init_fail_request
      StrCmp $R6 "1" ss_init_fail_request

      FileOpen $R2 "$R1\${SS_REQUEST_FILE}" r
      IfErrors ss_init_fail_request

      ; 字段顺序与 handshake.ts REQUEST_KEYS 逐字一致
      StrCpy $R5 "schemaVersion="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCmp $R4 "${SS_HANDSHAKE_SCHEMA}" 0 ss_init_close_fail
      StrCpy $R5 "updateId="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCmp $R4 $ssUpdateId 0 ss_init_close_fail
      StrCpy $R5 "nonce="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCmp $R4 $ssNonce 0 ss_init_close_fail
      StrCpy $R5 "callerSid="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCpy $ssCallerSid $R4
      StrCpy $R5 "callerPid="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCpy $ssCallerPid $R4
      StrCpy $R5 "callerCreationLow="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCpy $ssCreationLow $R4
      StrCpy $R5 "callerCreationHigh="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCpy $ssCreationHigh $R4
      StrCpy $R5 "fromVersion="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCpy $R5 "toVersion="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCpy $R5 "installDir="
      Call ssReadField
      IfErrors ss_init_close_fail
      ; 必须恰好 10 行：第 11 次读到内容 = 记录被追加过，拒绝
      ClearErrors
      FileReadUTF16LE $R2 $R4
      IfErrors 0 ss_init_close_fail
      FileClose $R2

      ; 请求方 SID 与当前进程 SID 必须一致（同用户、非提权范围）
      Call ssCurrentUserSid
      IfErrors ss_init_fail_sid
      StrCmp $R4 $ssCallerSid 0 ss_init_fail_sid

      ; 写 ready.ini（UTF-16LE 带 BOM；字段顺序 = handshake.ts READY_KEYS）。
      ; 自身创建时刻尽力获取；取不到用 0/0（Node 侧只做形状校验，该值仅用于日志关联）。
      StrCpy $R3 "0"
      StrCpy $R7 "0"
      System::Call 'kernel32::GetCurrentProcess() p .r1'
      System::Alloc 8
      Pop $2
      System::Alloc 8
      Pop $3
      System::Alloc 8
      Pop $4
      System::Alloc 8
      Pop $5
      System::Call 'kernel32::GetProcessTimes(p r1, p r2, p r3, p r4, p r5) i .r0'
      StrCmp $0 "0" ss_ready_write
      System::Call '*$2(i .r0, i .r7)'
      StrCpy $R3 $0
      StrCpy $R7 $7
      ss_ready_write:
      System::Free $2
      System::Free $3
      System::Free $4
      System::Free $5
      FileOpen $R2 "$R1\${SS_READY_FILE}" w
      IfErrors ss_init_fail_ready
      FileWriteUTF16LE /BOM $R2 "schemaVersion=${SS_HANDSHAKE_SCHEMA}$\r$\n"
      FileWriteUTF16LE $R2 "updateId=$ssUpdateId$\r$\n"
      FileWriteUTF16LE $R2 "nonce=$ssNonce$\r$\n"
      FileWriteUTF16LE $R2 "installerPid=$ssInstallerPid$\r$\n"
      FileWriteUTF16LE $R2 "installerCreationLow=$R3$\r$\n"
      FileWriteUTF16LE $R2 "installerCreationHigh=$R7$\r$\n"
      FileWriteUTF16LE $R2 "result=ready$\r$\n"
      FileClose $R2

      StrCpy $ssLogPhase "installer"
      StrCpy $ssLogEventName "ready"
      StrCpy $ssLogResult "ok"
      Call ssLogEvent

      ; 等决策（300 × 200ms）；$R6 = 轮次计数
      StrCpy $R6 0
      ss_decision_loop:
        IfFileExists "$R1\${SS_DECISION_FILE}" 0 ss_decision_sleep
        FileOpen $R2 "$R1\${SS_DECISION_FILE}" r
        IfErrors ss_decision_sleep
        StrCpy $R5 "schemaVersion="
        Call ssReadField
        IfErrors ss_decision_close_poll
        StrCmp $R4 "${SS_HANDSHAKE_SCHEMA}" 0 ss_decision_close_poll
        StrCpy $R5 "updateId="
        Call ssReadField
        IfErrors ss_decision_close_poll
        StrCmp $R4 $ssUpdateId 0 ss_decision_close_poll
        StrCpy $R5 "nonce="
        Call ssReadField
        IfErrors ss_decision_close_poll
        StrCmp $R4 $ssNonce 0 ss_decision_close_poll
        StrCpy $R5 "decision="
        Call ssReadField
        IfErrors ss_decision_close_poll
        FileClose $R2
        StrCmp $R4 "commit" ss_decision_commit
        StrCmp $R4 "cancel" ss_decision_cancel
        ; 决策值非法：身份全对但内容不认识 → 协议失败，fail-closed
        StrCpy $ssLogResult "decision-value-invalid"
        Call ssHandshakeFail
        ss_decision_close_poll:
        FileClose $R2
        ss_decision_sleep:
        IntOp $R6 $R6 + 1
        IntCmp $R6 ${SS_DECISION_WAIT_ROUNDS} ss_decision_timeout
        Sleep ${SS_HANDSHAKE_SLEEP_MS}
        Goto ss_decision_loop

      ss_decision_cancel:
      StrCpy $ssLogPhase "handoff"
      StrCpy $ssLogEventName "decision"
      StrCpy $ssLogResult "cancel"
      Call ssLogEvent
      Quit
      ss_decision_timeout:
      StrCpy $ssLogPhase "handoff"
      StrCpy $ssLogEventName "decision"
      StrCpy $ssLogResult "timeout"
      Call ssLogEvent
      MessageBox MB_OK|MB_ICONSTOP "等待更新决策超时，安装已取消，当前版本未被改动。$\r$\nTimed out waiting for the update decision; install cancelled, current version untouched."
      Quit
      ss_decision_commit:
      StrCpy $ssLogPhase "handoff"
      StrCpy $ssLogEventName "decision"
      StrCpy $ssLogResult "commit"
      Call ssLogEvent

      ; 等旧进程退出；超时 = 中止（绝不强杀、绝不带着活进程进入卸载）
      Call ssWaitOldProcessExit
      IfErrors ss_init_fail_oldproc
      StrCpy $ssLogPhase "old-process"
      StrCpy $ssLogEventName "exit"
      StrCpy $ssLogResult "ok"
      Call ssLogEvent
      Return

      ss_init_close_fail:
      FileClose $R2
      StrCpy $ssLogResult "request-record-invalid"
      Call ssHandshakeFail
      ss_init_fail_request:
      StrCpy $ssLogResult "request-missing"
      Call ssHandshakeFail
      ss_init_fail_logdir:
      StrCpy $ssLogResult "log-dir-unavailable"
      Call ssHandshakeFail
      ss_init_fail_ready:
      StrCpy $ssLogResult "ready-write-failed"
      Call ssHandshakeFail
      ss_init_fail_sid:
      StrCpy $ssLogResult "sid-mismatch"
      Call ssHandshakeFail
      ss_init_fail_home:
      StrCpy $ssLogResult "home-env-missing"
      Call ssHandshakeFail
      ss_init_fail_oldproc:
      StrCpy $ssLogPhase "old-process"
      StrCpy $ssLogEventName "exit"
      StrCpy $ssLogResult "timeout"
      Call ssLogEvent
      MessageBox MB_OK|MB_ICONSTOP "旧版本进程未在限定时间内退出，安装已取消。请关闭应用后重试。$\r$\nThe running application did not exit in time; install cancelled. Close it and try again."
      Quit
      ss_init_fail_uuid:
      MessageBox MB_OK|MB_ICONSTOP "更新参数无效，安装已取消。$\r$\nInvalid update parameter; install cancelled."
      Quit
      ss_init_fail_nonce:
      StrCpy $ssLogResult "nonce-invalid"
      Call ssHandshakeFail
      ss_init_return:
    FunctionEnd

    ; Finish 页 PRE：协议模式且安装成功 → 拉起一次并跳过 Finish（「仅进度」体验）；
    ; 其余情况（首次安装 / legacy / 安装失败）走标准 Finish。
    Function ssFinishPre
      ${if} $ssHandshakeMode == "protocol"
      ${andIf} $ssInstallComplete == "1"
        Call ssLaunchUpdatedAppOnce
        Abort
      ${endIf}
    FunctionEnd

  !endif
!macroend

; 安装模式页 PRE 钩子（multiUserUi 的 FUNCTION_INSTALL_MODE_PAGE_FUNCTION 内
; !ifmacrodef customInstallMode 插入）：协议模式钉死 per-user 并跳页，见头注释 B 节。
; 必须是顶层宏，不能放进 customHeader：NSIS 禁止在宏内定义宏，且 !ifmacrodef 探测要求它独立存在。
; 卸载器构建没有握手 Var，宏体整体排除以免编译期引用未声明变量。
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${if} $ssHandshakeMode == "protocol"
    ${andIf} $hasPerUserInstallation == "1"
      StrCpy $isForceCurrentInstall "1"
    ${endIf}
  !endif
!macroend

!macro customInit
  Call ssHandshakeInit
!macroend

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

  ; 安装成功标志：Finish PRE 的自动拉起只对完成安装的本轮生效（提案 §5.2）。
  StrCpy $ssInstallComplete "1"
  StrCpy $ssLogPhase "install"
  StrCpy $ssLogEventName "complete"
  StrCpy $ssLogResult "ok"
  Call ssLogEvent
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    ; 复刻模板默认行为（assistedInstaller.nsh 的 else 分支）：定义了 customFinishPage 后
    ; 默认 StartApp + MUI_FINISHPAGE_RUN 不再插入，首次安装必须在这里补回 Run 复选。
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE ssFinishPre
  !insertmacro MUI_PAGE_FINISH
!macroend
