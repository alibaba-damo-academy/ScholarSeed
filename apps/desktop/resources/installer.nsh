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
;      per-user 按已验证目录选定范围；per-machine 在 customInit 请求 UAC，管理员内层回调
;      原用户外层完成握手，内层由模板跳过范围页。用户目录 I/O 与重启均留在外层。
;      跳页后非静默只剩进度页与（被 ssFinishPre 跳过的）Finish 页，即「更新仅进度窗」。
;    - 目录 ACL 未在 NSIS 侧逐条检查（GetNamedSecurityInfo 链在 NSIS 里不可维护）；等效防护是
;      身份绑定：ready/decision 必须携带与 env+request.ini 一致的 updateId+nonce（128bit 随机），
;      加上 SID 比对与 reparse 拒绝，第三方进程既猜不出凭据也伪造不了记录。
;    - legacy（手动双击 / 旧客户端 /S --force-run）进入页面序列前先过 ssEnforceAppClosed：
;      轮询检测旧应用是否仍在运行（tasklist+findstr 纯查询，不强杀），仍在则提示手动退出、
;      关闭后自动继续，取消即中止；静默模式限时等待后中止。补上默认 CHECK_APP_RUNNING 在
;      per-machine 内层提权实例被 ${UAC_IsInnerInstance} 守卫跳过、握手协议又覆盖不到的缺口。
;    - 普通函数通过全局 Var 传参；UAC 回调用 $R8 传目标、$R9 返回明确结果，外层上下文保留在 Var。
;      注释写明各函数
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
  Var ssInstallScope
  !define SS_SCOPE_USER "user"
  !define SS_SCOPE_MACHINE "machine"
!endif

; 运行中的旧应用查询宏（纯查询、绝不强杀）：${_RETURN} 收管道退出码，0 = 仍在运行，非 0 = 未运行。
; 用 tasklist + findstr 按镜像名精确锚定，不依赖 PowerShell 语言模式（真机 langMode=
; ConstrainedLanguage，模板里 CIM 路径匹配不可靠），也与 proposal 108「等待退出、不强杀」纪律一致。
; 无标签、无函数，可在同一构建内安全多次展开。
!include "${__FILEDIR__}\diagnostics.nsh"

!macro ssDetectAppRunning _RETURN
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop ${_RETURN}
!macroend

; The native owner must release its journal roots through normal shutdown.
; The builder default may force-terminate the owner, leaving unprovable family roots.
!ifdef SS_NATIVE_CARRIER
  !macro customCheckAppRunning
    !ifndef BUILD_UNINSTALLER
      ${if} $ssMaintenance == "1"
        Call ssCheckController
        ${if} ${Errors}
          StrCpy $ssLogResult "maintenance-controller-unavailable"
          Call ssHandshakeFail
        ${endIf}
      ${endIf}
    !endif
    !insertmacro ssDetectAppRunning $R0
    !insertmacro ssInstallerDiagnostic "phase=process-check code=$R0"
    ${if} $R0 != 1
      !insertmacro ssLocalizedMessage $R9 "ScholarSeed is running or its status could not be checked. Close it and retry." "ScholarSeed 正在运行或无法确认运行状态，请关闭后重试。"
      IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "$R9"
      !insertmacro ssInstallerDiagnostic "phase=process-check result=rejected"
      SetErrorLevel 2
      Quit
    ${endIf}
  !macroend
!endif

!macro ssLocalizedMessage _OUTPUT _ENGLISH _CHINESE
  StrCpy ${_OUTPUT} "${_ENGLISH}"
  ${if} $LANGUAGE == ${LANG_SIMPCHINESE}
  ${orIf} $LANGUAGE == ${LANG_TRADCHINESE}
    StrCpy ${_OUTPUT} "${_CHINESE}"
  ${endIf}
!macroend

!include "${__FILEDIR__}\privileges.nsh"

!macro customHeader
  !ifndef BUILD_UNINSTALLER

    Function .onInstFailed
      !insertmacro ssInstallerDiagnostic "phase=installation result=failed"
    FunctionEnd

    Function .onInstSuccess
      !insertmacro ssInstallerDiagnostic "phase=installation result=passed"
    FunctionEnd

    !include FileFunc.nsh
    !include StrFunc.nsh
    ${StrStr}

    ; ---- 握手协议常量（与 src/main/handshake.ts 逐字对齐） ----
    !define SS_HANDSHAKE_SCHEMA "1"
    !define SS_MAINTENANCE_SCHEMA "2"
    !define SS_MAINTENANCE_RECORD_BYTES 8192
    !define SS_UPDATE_ID_OPTION "/SCHOLARSEED_UPDATE_ID="
    !define SS_HOME_ENV "SCHOLARSEED_HOME"
    !define SS_NONCE_ENV "SCHOLARSEED_UPDATE_NONCE"
    !define SS_REQUEST_FILE "request.ini"
    !define SS_READY_FILE "ready.ini"
    !define SS_ELEVATION_FILE "elevation.ini"
    !define SS_DECISION_FILE "decision.ini"
    !define SS_INSTALL_LOG "install.log"
    ; 轮转保留上一轮（可能是崩溃轮）的安装器日志：本轮首条日志前把 install.log 改名成它。
    !define SS_INSTALL_PREV_LOG "install-prev.log"
    !define SS_HANDSHAKE_SLEEP_MS 200
    ; 决策等待与旧进程退出等待各 300 × 200ms = 60s（提案 §5.2 第 4/5 条）。
    !define SS_DECISION_WAIT_ROUNDS 300
    !define SS_OLDPROC_WAIT_ROUNDS 300
    !define SS_STILL_ACTIVE 259
    !define SS_TOKEN_QUERY 0x0008
    !define SS_PROCESS_QUERY_LIMITED_INFORMATION 0x1000
    !define SS_TOKEN_USER 1
    !define SS_HANDOFF_REJECTED "rejected"
    !define SS_HANDOFF_COMMITTED "committed"
    !define SS_ELEVATION_REQUIRED "elevation-required"
    !define SS_INSTALLER_READY "ready"
    !define SS_PROCESS_WAIT_ROUNDS 30
    !define SS_PROCESS_QUERY_TIMEOUT_MS 1000

    Var ssTargetDir
    Var ssProtocolSchema
    Var ssDecision
    Var ssReadyResult
    Var ssHandshakeCommitted
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
    ; 每轮安装器只轮转一次 install.log（首条日志前），见 ssLogEvent。
    Var ssLogRotated
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

    !insertmacro ssPrivilegeFunctions

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
    ; ⑤ 根因已于第四轮真机定论并修复（f3133dc3c）：NSIS 3.0.4.1 的 FileFunc GetTime 写不出
    ;    输出变量且留错误标志，标志残留使 FileOpen 后的 IfErrors 误跳（三轮 0 字节真凶）；
    ;    现 GetTime 改 "L" + 紧随 ClearErrors。第五轮真机另证：FileOpen 'a' 在本构建实为
    ;    truncate+write（probe-a 跨轮不增长、cmd >> 的 probe-x 逐轮增长），append 不可用——
    ;    故每次调用 'w' 重写是正解而非权宜：install.log 语义 = 本轮最后完成相位一行，
    ;    install-prev.log = 上一轮同义；崩溃归因靠「崩溃前最后完成相位」足够 confine。
    ;    探针矩阵与 Node 尺寸探针已完成使命撤除。
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
      ; 日志不能继承、消费或制造调用方的错误标志。先保存，结束时恢复。
      IfErrors ss_log_had_error ss_log_clean
      ss_log_had_error:
      Push "1"
      Goto ss_log_begin
      ss_log_clean:
      Push "0"
      ss_log_begin:
      StrCmp $ssHome "" ss_log_done
      IfFileExists "$ssHome\logs" ss_log_dir_ok
      CreateDirectory "$ssHome\logs"
      IfErrors ss_log_done
      ss_log_dir_ok:
      StrCmp $ssLogRotated "1" ss_log_open
      StrCpy $ssLogRotated "1"
      IfFileExists "$ssHome\logs\${SS_INSTALL_LOG}" 0 ss_log_open
      Delete "$ssHome\logs\${SS_INSTALL_PREV_LOG}"
      Rename "$ssHome\logs\${SS_INSTALL_LOG}" "$ssHome\logs\${SS_INSTALL_PREV_LOG}"
      ClearErrors
      ss_log_open:
      FileOpen $ssLogHandle "$ssHome\logs\${SS_INSTALL_LOG}" w
      IfErrors ss_log_done
      ; 行头先落盘再取时间戳：第四轮真机定论——NSIS 3.0.4.1 的 FileFunc GetTime 在本机写不出
      ; 任何输出变量（ts="--T::Z"，"U" 选项无效）且留下错误标志；标志残留会让 ssLogEvent 里
      ; FileOpen 之后的 IfErrors 误跳（写不落盘、三轮 0 字节的真凶），也会让 ssHandshakeInit 的
      ; log-dir 检查误判 log-dir-unavailable（第四轮弹窗）。故：open+行头提前、GetTime 改用有效
      ; 选项 "L"（本地时间，字段随之改名 timestampLocal）、GetTime 后立刻 ClearErrors 切断标志残留。
      FileWrite $ssLogHandle '{"schemaVersion":${SS_HANDSHAKE_SCHEMA},"timestampLocal":"'
      ${GetTime} "" "L" $ssTimeDay $ssTimeMonth $ssTimeYear $ssTimeWeekday $ssTimeHour $ssTimeMinute $ssTimeSecond
      ClearErrors
      FileWrite $ssLogHandle "$ssTimeYear-$ssTimeMonth-$ssTimeDay"
      FileWrite $ssLogHandle 'T'
      FileWrite $ssLogHandle "$ssTimeHour:$ssTimeMinute:$ssTimeSecond"
      FileWrite $ssLogHandle '","processId":'
      FileWrite $ssLogHandle "$ssInstallerPid"
      FileWrite $ssLogHandle ',"updateId":"'
      FileWrite $ssLogHandle "$ssUpdateId"
      FileWrite $ssLogHandle '","phase":"'
      FileWrite $ssLogHandle "$ssLogPhase"
      FileWrite $ssLogHandle '","event":"'
      FileWrite $ssLogHandle "$ssLogEventName"
      FileWrite $ssLogHandle '","result":"'
      FileWrite $ssLogHandle "$ssLogResult"
      FileWrite $ssLogHandle '","actualProcessId":"$ssActualPid","tokenElevated":"$ssOriginalElevated","integrityLevel":"$ssOriginalIntegrity","pluginAdmin":"$ssPluginAdmin","callerElevated":"$ssCallerElevated","callerIntegrityLevel":"$ssCallerIntegrity'
      FileWrite $ssLogHandle '"}$\r$\n'
      FileClose $ssLogHandle
      ss_log_done:
      Pop $R9
      ClearErrors
      StrCmp $R9 "0" ss_log_restore
      SetErrors
      ss_log_restore:
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

    ; boot 探针矩阵：install.log 两轮真机恒 0 字节、而 ready.ini 每轮写成功，坏原语只可能在
    ; 两者用法差集里（FileOpen 'a' / FileSeek / FileWrite-ANSI / GetTime）。这里用四个独立文件
    ; 各试一种写原语组合，Node 侧把六个文件尺寸落进 update.log，真机一轮即可指认：
    ;   a  = 'a' 无 FileSeek + FileWrite-ANSI（若坏而 w 好 → append 模式本身坏，轮转+'w' 即正解）
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

    ; ---------- 旧应用关闭闸门（legacy / 手动路径） ----------

    ; 确保旧版应用彻底退出后才允许进入安装（fail-closed，绝不强杀）。
    ;
    ; 为什么必须有：默认 CHECK_APP_RUNNING 只在非内层实例执行（assisted 模板用
    ; ${UAC_IsInnerInstance} 守卫），per-machine 的内层提权实例整体跳过；而 legacy（手动双击 /
    ; 旧客户端 /S --force-run）不受 proposal 108 握手保护。于是「旧版本仍在运行 → 新安装器
    ; 覆盖旧文件」时，旧卸载器关不掉进程（其 Quit 退出码 0 被 handleUninstallResult 当成卸载
    ; 成功），安装继续写入被占用文件，报「不能打开要写入的文件 Uninstall ScholarSeed.exe」。
    ;
    ; 本函数在进入页面序列前检测：仍在运行则提示用户手动退出（含托盘退出），每次重试重新检测；
    ; 取消即中止。静默（旧客户端 /S）不弹窗，限时等待，仍未退出则中止，避免隐形挂死。
    ; 只在 legacy 分支调用；协议分支继续由 ssWaitOldProcessExit 按 callerPid 收敛。
    ; 读写寄存器：全部自保存/恢复；$R1 = 静默等待轮次；ssLog* 为本函数私有契约。
    Function ssEnforceAppClosed
      !insertmacro ssInstallerDiagnostic "phase=app-close event=start"
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
      ; 本函数在 .onInit（customInit）即可能被调用，早于 installSection 的 InitPluginsDir；
      ; nsExec 的临时文件依赖 $PLUGINSDIR，故此处先初始化（幂等）。
      InitPluginsDir
      StrCpy $R1 "0"
      IfSilent ss_eac_silent_setup
      ; ---- 非静默：每次重试都重新检测，仍在运行则再次提示 ----
      ss_eac_ui_loop:
        !insertmacro ssDetectAppRunning $R0
        ; 非 0（含 nsExec 的 "error"）= 未检测到在跑 → 可继续；0 = 仍在运行。
        StrCmp $R0 "0" 0 ss_eac_closed
        StrCpy $ssLogPhase "app-close"
        StrCpy $ssLogEventName "prompt"
        StrCpy $ssLogResult "running"
        Call ssLogEvent
        !insertmacro ssLocalizedMessage $R9 "ScholarSeed is still running. Please quit it manually (including the tray icon), then click Retry; click Cancel to abort the install." "ScholarSeed 正在运行，安装无法继续。请手动退出 ScholarSeed（含系统托盘图标的「退出」），关闭后单击「重试」继续；单击「取消」将中止安装。"
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$R9" /SD IDCANCEL IDRETRY ss_eac_ui_wait
        StrCpy $ssLogPhase "app-close"
        StrCpy $ssLogEventName "abort"
        StrCpy $ssLogResult "cancelled"
        Call ssLogEvent
        Quit
      ss_eac_ui_wait:
        Goto ss_eac_ui_loop
      ; ---- 静默：不弹窗，限时等待，超时中止 ----
      ss_eac_silent_setup:
      ss_eac_silent_loop:
        !insertmacro ssDetectAppRunning $R0
        ; 非 0（含 nsExec 的 "error"）= 未检测到在跑 → 可继续；0 = 仍在运行。
        StrCmp $R0 "0" 0 ss_eac_closed
        IntOp $R1 $R1 + 1
        IntCmp $R1 ${SS_OLDPROC_WAIT_ROUNDS} ss_eac_silent_abort
        Sleep ${SS_HANDSHAKE_SLEEP_MS}
        Goto ss_eac_silent_loop
      ss_eac_silent_abort:
        !insertmacro ssInstallerDiagnostic "phase=app-close result=timeout"
        StrCpy $ssLogPhase "app-close"
        StrCpy $ssLogEventName "abort"
        StrCpy $ssLogResult "timeout"
        Call ssLogEvent
        Quit
      ss_eac_closed:
        !insertmacro ssInstallerDiagnostic "phase=app-close result=closed"
        StrCpy $ssLogPhase "app-close"
        StrCpy $ssLogEventName "closed"
        StrCpy $ssLogResult "ok"
        Call ssLogEvent
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

    ; ---------- 拉起 ----------

    ; 协议模式下唯一的自动拉起者。$appExe 由 installSection 在文件安装前设好
    ; （StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"），Finish PRE 时必然可用；
    ; 使用真实 exe，继承原更新发起进程身份；UAC 内层通过原进程回调执行。
    Function ssLaunchUpdatedAppOnce
      ; The independent ordinary controller owns restart and post-install checks.
      StrCmp $ssMaintenance "1" ss_launch_done
      StrCmp $ssHandshakeCommitted "1" 0 ss_launch_done
      StrCmp $ssLaunchAttempted "1" ss_launch_done
      StrCpy $ssLaunchAttempted "1"
      StrCpy $ssLogPhase "launch"
      StrCpy $ssLogEventName "begin"
      StrCpy $ssLogResult "attempt"
      Call ssLogEvent
      ClearErrors
      Exec '"$appExe" --updated --scholarseed-update-id=$ssUpdateId'
      StrCpy $ssLogResult "ok"
      ${if} ${Errors}
        StrCpy $ssLogResult "launch-failed"
      ${endIf}
      StrCpy $ssLogPhase "launch"
      StrCpy $ssLogEventName "end"
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
      ${if} $ssMaintenance == "1"
        !insertmacro ssLocalizedMessage $R9 "Launcher update handoff failed ($ssLogResult). Retry the update in the app." "启动器更新交接失败（$ssLogResult）。请在应用内重试更新。"
        SetErrorLevel 2
      ${else}
        !insertmacro ssLocalizedMessage $R9 "Update handoff failed ($ssLogResult); install cancelled, current version untouched. Run the installer manually." "更新交接失败（$ssLogResult），安装已取消，当前版本未被改动。请手动运行安装程序完成更新。"
      ${endIf}
      MessageBox MB_OK|MB_ICONSTOP "$R9"
      Quit
    FunctionEnd

    ; 读写寄存器：$R0/$R1/$R2/$R4/$R5/$R6/$R7/$R8/$R9、$0-$8；全局 Var 见声明区。
    Function ssHandshakeInit
      StrCpy $ssHandshakeMode "legacy"
      StrCpy $ssProtocolSchema "${SS_HANDSHAKE_SCHEMA}"
      ${if} $ssMaintenance == "1"
        StrCpy $ssProtocolSchema "${SS_MAINTENANCE_SCHEMA}"
      ${endIf}
      StrCpy $ssInstallComplete "0"
      StrCpy $ssLaunchAttempted "0"
      StrCpy $ssLogRotated "0"

      ; NSIS 无内建 $PID：显式取当前安装器进程 ID。System 输出记号 .r0 落入 $0（非 $R0），
      ; 故读 $0。在 legacy 提前返回之前设置，保证 ssLogEvent 与 ready.ini 总能拿到。
      System::Call 'kernel32::GetCurrentProcessId() i .r0'
      StrCpy $ssInstallerPid $0

      ${GetParameters} $R0
      ClearErrors
      ${GetOptions} $R0 "${SS_UPDATE_ID_OPTION}" $ssUpdateId
      IfErrors ss_init_legacy        ; 无协议参数 → legacy（旧客户端 /S --force-run 或手动双击）
      StrCpy $ssHandshakeMode "protocol"

      StrCpy $ssHandshakeCommitted "0"
      ${if} ${Silent}
        StrCpy $ssLogResult "silent-protocol-unsupported"
        Call ssHandshakeFail
      ${endIf}
      !insertmacro GetDParameter $R0
      StrCmp $R0 "" 0 ss_init_fail_scope

      ${if} ${UAC_IsInnerInstance}
        StrCmp $ssMaintenance "1" ss_init_fail_scope
        !insertmacro setInstallModePerAllUsers
        ReadRegStr $ssTargetDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
        StrCmp $ssTargetDir "" ss_init_inner_fail
        StrCmp $INSTDIR $ssTargetDir 0 ss_init_inner_fail
        ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
        StrCmp $R0 "" 0 ss_init_inner_fail
        ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
        StrCmp $R0 "" 0 ss_init_inner_fail
        StrCpy $ssInstallScope "${SS_SCOPE_MACHINE}"
        StrCpy $R8 $ssTargetDir
        StrCpy $R9 "${SS_HANDOFF_REJECTED}"
        !insertmacro UAC_AsUser_Call Function ssHandshakeExchange ${UAC_SYNCREGISTERS}
        StrCmp $R9 "${SS_HANDOFF_COMMITTED}" 0 ss_init_inner_fail
        Return
        ss_init_inner_fail:
        !insertmacro ssLocalizedMessage $R9 "Automatic update could not safely take over this installation. The installer has stopped." "无法安全接管此安装，自动更新已停止。"
        MessageBox MB_OK|MB_ICONSTOP "$R9"
        Quit
      ${endIf}

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
      ${if} $ssMaintenance == "1"
        Call ssCheckMaintenanceRecord
        IfErrors ss_init_close_fail
      ${endIf}

      ; 字段顺序与 handshake.ts REQUEST_KEYS 逐字一致
      StrCpy $R5 "schemaVersion="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCmp $R4 $ssProtocolSchema 0 ss_init_close_fail
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
      ${if} $ssMaintenance == "1"
        StrCpy $R5 "controllerPid="
        Call ssReadField
        IfErrors ss_init_close_fail
        StrCpy $ssControllerPid $R4
        IntFmt $0 "%u" $ssControllerPid
        StrCmp $0 $ssControllerPid 0 ss_init_close_fail
        StrCmp $ssControllerPid "0" ss_init_close_fail
        StrCmp $ssControllerPid $ssCallerPid ss_init_close_fail
        StrCmp $ssControllerPid $ssInstallerPid ss_init_close_fail
        StrCpy $R5 "controllerCreationLow="
        Call ssReadField
        IfErrors ss_init_close_fail
        StrCpy $ssControllerLow $R4
        IntFmt $0 "%d" $ssControllerLow
        StrCmp $0 $ssControllerLow 0 ss_init_close_fail
        StrCpy $R5 "controllerCreationHigh="
        Call ssReadField
        IfErrors ss_init_close_fail
        StrCpy $ssControllerHigh $R4
        IntFmt $0 "%d" $ssControllerHigh
        StrCmp $0 $ssControllerHigh 0 ss_init_close_fail
      ${endIf}
      StrCpy $R5 "fromVersion="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCpy $R5 "toVersion="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCpy $R5 "installDir="
      Call ssReadField
      IfErrors ss_init_close_fail
      StrCpy $ssTargetDir $R4
      ; Exactly 10 fields for schema 1, 13 for maintenance schema 2.
      ClearErrors
      FileReadUTF16LE $R2 $R4
      IfErrors 0 ss_init_close_fail
      FileClose $R2

      ; 请求方 SID 与原用户外层 SID 必须一致。
      Call ssCurrentUserSid
      IfErrors ss_init_fail_sid
      StrCmp $R4 $ssCallerSid 0 ss_init_fail_sid
      ${if} $ssMaintenance == "1"
        Call ssBindController
        IfErrors ss_init_fail_controller
      ${endIf}

      Call ssInspectCaller
      StrCpy $ssLogPhase "privileges"
      StrCpy $ssLogEventName "verified"
      StrCpy $ssLogResult "native-token"
      Call ssLogEvent

      ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ReadRegStr $R3 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ; 单一范围安装时另一 hive 缺项是正常情况。下方仍严格比对目录，
      ; 但不能把探测错误带到 ready.ini 的 FileOpen（NSIS 错误标志会保留）。
      ClearErrors
      StrCmp $ssTargetDir "" ss_init_fail_scope
      StrCmp $ssTargetDir $R0 ss_init_user_scope
      StrCmp $ssTargetDir $R3 0 ss_init_fail_scope
      StrCpy $ssInstallScope "${SS_SCOPE_MACHINE}"
      Goto ss_init_scope_selected
      ss_init_user_scope:
      StrCmp $ssTargetDir $R3 ss_init_fail_scope
      StrCpy $ssInstallScope "${SS_SCOPE_USER}"
      ss_init_scope_selected:
      StrCpy $INSTDIR $ssTargetDir
      StrCpy $appExe "$ssTargetDir\${APP_EXECUTABLE_FILENAME}"
      ${if} $ssInstallScope == "${SS_SCOPE_MACHINE}"
        StrCmp $ssMaintenance "1" ss_init_fail_scope
        ; 模板的全局安装会卸载 HKCU 安装，冲突时停止，避免范围迁移。
        ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
        StrCmp $R0 "" 0 ss_init_fail_scope
        ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
        StrCmp $R0 "" 0 ss_init_fail_scope
        ClearErrors
        ${if} $ssOriginalElevated == 1
          !insertmacro setInstallModePerAllUsers
          Goto ss_init_exchange
        ${endIf}
        StrCpy $ssReadyResult "${SS_ELEVATION_REQUIRED}"
        Call ssWriteReady
        IfErrors ss_init_fail_ready
        !insertmacro UAC_RunElevated
        StrCpy $ssLogResult $0
        StrCpy $ssLogPhase "elevation"
        StrCpy $ssLogEventName "exit"
        Call ssLogEvent
        Quit
      ${endIf}
      !insertmacro setInstallModePerUser
      ss_init_exchange:
      StrCmp $INSTDIR $ssTargetDir 0 ss_init_fail_scope
      StrCpy $R8 $ssTargetDir
      Call ssHandshakeExchange
      StrCmp $R9 "${SS_HANDOFF_COMMITTED}" 0 ss_init_exchange_failed
      Return
      ss_init_exchange_failed:
      Quit
      ss_init_fail_scope:
      StrCpy $ssLogResult "install-scope-mismatch"
      Call ssHandshakeFail

      ss_init_fail_controller:
      StrCpy $ssLogResult "maintenance-controller-invalid"
      Call ssHandshakeFail

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
      ss_init_fail_uuid:
      !insertmacro ssLocalizedMessage $R9 "Invalid update parameter; install cancelled." "更新参数无效，安装已取消。"
      MessageBox MB_OK|MB_ICONSTOP "$R9"
      Quit
      ss_init_fail_nonce:
      StrCpy $ssLogResult "nonce-invalid"
      Call ssHandshakeFail
      ; legacy（手动双击 / 旧客户端 /S --force-run）：进入页面序列前先确保旧版应用彻底退出，
      ; 覆盖默认 CHECK_APP_RUNNING 因 ${UAC_IsInnerInstance} 守卫而在 per-machine 内层实例
      ; 被整体跳过的路径；关闭失败即中止（见 ssEnforceAppClosed）。
      ss_init_legacy:
      ${if} $ssMaintenance == "1"
        StrCpy $ssLogResult "maintenance-context-missing"
        Call ssHandshakeFail
      ${endIf}
      Call ssEnforceAppClosed
    FunctionEnd

    ; Schema 2 records are bounded UTF-16LE with BOM, not JSON. The native
    ; transaction API uses JSON; it must serialize this separate NSIS contract.
    Function ssCheckMaintenanceRecord
      ClearErrors
      FileSeek $R2 0 END $0
      IfErrors ss_record_failed
      IntCmp $0 ${SS_MAINTENANCE_RECORD_BYTES} 0 0 ss_record_failed
      IntCmp $0 2 ss_record_failed ss_record_failed
      IntOp $2 $0 - 2
      IntOp $1 $0 & 1
      StrCmp $1 0 0 ss_record_failed
      FileSeek $R2 0 SET
      FileReadByte $R2 $0
      FileReadByte $R2 $1
      IfErrors ss_record_failed
      StrCmp $0 255 0 ss_record_failed
      StrCmp $1 254 0 ss_record_failed
      ; NSIS strings terminate at NUL. Reject hidden suffixes before decoding
      ; any field rather than accepting a truncated textual identity/decision.
      ss_record_scan:
      FileReadByte $R2 $0
      FileReadByte $R2 $1
      IfErrors ss_record_failed
      ${if} $0 == 0
      ${andIf} $1 == 0
        Goto ss_record_failed
      ${endIf}
      IntOp $2 $2 - 2
      IntCmp $2 0 0 ss_record_failed ss_record_scan
      FileSeek $R2 0 SET
      IfErrors ss_record_failed
      ClearErrors
      Return
      ss_record_failed:
      SetErrors
    FunctionEnd

    Function ssWriteControllerRecord
      FileWriteUTF16LE $R2 "controllerPid=$ssControllerPid$\r$\n"
      IfErrors ss_controller_write_failed
      FileWriteUTF16LE $R2 "controllerCreationLow=$ssControllerLow$\r$\n"
      IfErrors ss_controller_write_failed
      FileWriteUTF16LE $R2 "controllerCreationHigh=$ssControllerHigh$\r$\n"
      IfErrors ss_controller_write_failed
      Return
      ss_controller_write_failed:
      SetErrors
    FunctionEnd

    Function ssReadControllerRecord
      StrCpy $R5 "controllerPid="
      Call ssReadField
      IfErrors ss_controller_read_failed
      StrCmp $R4 $ssControllerPid 0 ss_controller_read_failed
      StrCpy $R5 "controllerCreationLow="
      Call ssReadField
      IfErrors ss_controller_read_failed
      StrCmp $R4 $ssControllerLow 0 ss_controller_read_failed
      StrCpy $R5 "controllerCreationHigh="
      Call ssReadField
      IfErrors ss_controller_read_failed
      StrCmp $R4 $ssControllerHigh 0 ss_controller_read_failed
      Return
      ss_controller_read_failed:
      SetErrors
    FunctionEnd

    Function ssReadMaintenanceDecision
      Call ssCheckMaintenanceRecord
      IfErrors ss_maintenance_decision_failed
      StrCpy $R5 "schemaVersion="
      Call ssReadField
      IfErrors ss_maintenance_decision_failed
      StrCmp $R4 "${SS_MAINTENANCE_SCHEMA}" 0 ss_maintenance_decision_failed
      StrCpy $R5 "updateId="
      Call ssReadField
      IfErrors ss_maintenance_decision_failed
      StrCmp $R4 $ssUpdateId 0 ss_maintenance_decision_failed
      StrCpy $R5 "nonce="
      Call ssReadField
      IfErrors ss_maintenance_decision_failed
      StrCmp $R4 $ssNonce 0 ss_maintenance_decision_failed
      Call ssReadControllerRecord
      IfErrors ss_maintenance_decision_failed
      StrCpy $R5 "decision="
      Call ssReadField
      IfErrors ss_maintenance_decision_failed
      StrCpy $ssDecision $R4
      StrCmp $ssDecision "commit" ss_maintenance_decision_eof
      StrCmp $ssDecision "cancel" 0 ss_maintenance_decision_failed
      ss_maintenance_decision_eof:
      ClearErrors
      FileReadUTF16LE $R2 $R4
      IfErrors 0 ss_maintenance_decision_failed
      ClearErrors
      Return
      ss_maintenance_decision_failed:
      SetErrors
    FunctionEnd

    Function ssWriteReady
      StrCpy $ssNativeProcess -1
      Call ssProcessCreation
      StrCpy $ssNativeProcess 0
      IfErrors ss_ready_failed
      StrCpy $R3 $ssProcessLow
      StrCpy $R7 $ssProcessHigh
      ; 文件操作拥有自己的错误状态，不能误用注册表/进程查询的残留。
      ClearErrors
      ${if} $ssReadyResult == "${SS_ELEVATION_REQUIRED}"
        FileOpen $R2 "$R1\${SS_ELEVATION_FILE}" w
      ${else}
        FileOpen $R2 "$R1\${SS_READY_FILE}" w
      ${endIf}
      IfErrors ss_ready_failed
      FileWriteUTF16LE /BOM $R2 "schemaVersion=$ssProtocolSchema$\r$\n"
      IfErrors ss_ready_close_failed
      FileWriteUTF16LE $R2 "updateId=$ssUpdateId$\r$\n"
      IfErrors ss_ready_close_failed
      FileWriteUTF16LE $R2 "nonce=$ssNonce$\r$\n"
      IfErrors ss_ready_close_failed
      FileWriteUTF16LE $R2 "installerPid=$ssInstallerPid$\r$\n"
      IfErrors ss_ready_close_failed
      FileWriteUTF16LE $R2 "installerCreationLow=$R3$\r$\n"
      IfErrors ss_ready_close_failed
      FileWriteUTF16LE $R2 "installerCreationHigh=$R7$\r$\n"
      IfErrors ss_ready_close_failed
      ${if} $ssMaintenance == "1"
        Call ssWriteControllerRecord
        IfErrors ss_ready_close_failed
      ${endIf}
      FileWriteUTF16LE $R2 "result=$ssReadyResult$\r$\n"
      IfErrors ss_ready_close_failed
      FileClose $R2
      IfErrors ss_ready_failed

      Return
      ss_ready_close_failed:
      FileClose $R2
      ss_ready_failed:
      SetErrors
    FunctionEnd

    Function ssHandshakeExchange
      StrCpy $ssLogResult "install-scope-mismatch"
      StrCmp $R8 $ssTargetDir 0 ss_exchange_failed
      ${if} $ssMaintenance == "1"
        Call ssCheckController
        IfErrors ss_exchange_controller
      ${endIf}
      StrCpy $R1 "$ssHome\updates\install\$ssUpdateId"
      StrCpy $ssReadyResult "${SS_INSTALLER_READY}"
      StrCpy $ssLogResult "ready-write-failed"
      Call ssWriteReady
      IfErrors ss_exchange_failed
      StrCpy $ssLogPhase "installer"
      StrCpy $ssLogEventName "ready"
      StrCpy $ssLogResult "ok"
      Call ssLogEvent
      ; 等决策（300 × 200ms）；$R6 = 轮次计数
      StrCpy $R6 0
      ss_decision_loop:
        ${if} $ssMaintenance == "1"
          Call ssCheckController
          IfErrors ss_exchange_controller
        ${endIf}
        IfFileExists "$R1\${SS_DECISION_FILE}" 0 ss_decision_sleep
        FileOpen $R2 "$R1\${SS_DECISION_FILE}" r
        IfErrors ss_decision_sleep
        ${if} $ssMaintenance == "1"
          Call ssReadMaintenanceDecision
          IfErrors ss_decision_close_poll
        ${else}
        StrCpy $R5 "schemaVersion="
        Call ssReadField
        IfErrors ss_decision_close_poll
        StrCmp $R4 $ssProtocolSchema 0 ss_decision_close_poll
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
        StrCpy $ssDecision $R4
        ${endIf}
        FileClose $R2
        StrCmp $ssDecision "commit" ss_decision_commit
        StrCmp $ssDecision "cancel" ss_decision_cancel
        ; 决策值非法：身份全对但内容不认识 → 协议失败，fail-closed
        StrCpy $ssLogResult "decision-value-invalid"
        Goto ss_exchange_failed
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
      Goto ss_exchange_failed
      ss_decision_timeout:
      StrCpy $ssLogPhase "handoff"
      StrCpy $ssLogEventName "decision"
      StrCpy $ssLogResult "timeout"
      Call ssLogEvent
      !insertmacro ssLocalizedMessage $R9 "Timed out waiting for the update decision; install cancelled, current version untouched." "等待更新决策超时，安装已取消，当前版本未被改动。"
      MessageBox MB_OK|MB_ICONSTOP "$R9"
      Goto ss_exchange_failed
      ss_decision_commit:
      StrCpy $ssLogPhase "handoff"
      StrCpy $ssLogEventName "decision"
      StrCpy $ssLogResult "commit"
      Call ssLogEvent

      ; 等旧进程退出；超时 = 中止（绝不强杀、绝不带着活进程进入卸载）
      ${if} $ssMaintenance == "1"
        ; Only the authenticated live controller can commit after proving exit
        ; on its original owner handle and acquiring the native store gate.
        ; Never use legacy OpenProcess failure/PID reuse as that proof.
        Call ssCheckController
        IfErrors ss_exchange_controller
      ${else}
        Call ssWaitOldProcessExit
        IfErrors ss_exchange_oldproc
      ${endIf}
      StrCpy $ssLogPhase "old-process"
      StrCpy $ssLogEventName "exit"
      StrCpy $ssLogResult "ok"
      Call ssLogEvent
      StrCpy $ssHandshakeCommitted "1"
      StrCpy $R9 "${SS_HANDOFF_COMMITTED}"
      Return

      ss_exchange_controller:
      StrCpy $ssLogResult "maintenance-controller-unavailable"
      Goto ss_exchange_failed

      ss_exchange_oldproc:
      StrCpy $ssLogPhase "old-process"
      StrCpy $ssLogEventName "exit"
      StrCpy $ssLogResult "timeout"
      Call ssLogEvent
      ss_exchange_failed:
      ${if} $ssMaintenance == "1"
        SetErrorLevel 2
      ${endIf}
      StrCpy $ssLogPhase "handoff"
      StrCpy $ssLogEventName "rejected"
      Call ssLogEvent
      StrCpy $R9 "${SS_HANDOFF_REJECTED}"
      Return
    FunctionEnd

    ; Finish 页 PRE：协议模式且安装成功 → 拉起一次并跳过 Finish（「仅进度」体验）；
    ; 其余情况（首次安装 / legacy / 安装失败）走标准 Finish。
    Function ssFinishPre
      ${if} $ssHandshakeMode == "protocol"
      ${andIf} $ssInstallComplete == "1"
        ${if} ${UAC_IsInnerInstance}
          !insertmacro UAC_AsUser_Call Function ssLaunchUpdatedAppOnce 0
        ${else}
          Call ssLaunchUpdatedAppOnce
        ${endIf}
        Abort
      ${endIf}
    FunctionEnd

    ; 首装目录页的三个回调必须住在 customHeader 宏内：installer.nsh 被 electron-builder 拼进
    ; sharedHeader（先于模板各 include），顶层代码解析时 LogicLib/nsDialogs 都还没加载，
    ; ${if}/${NSD_*} 会直接 Invalid command（CI makensis 真机踩过）；宏展开点在 installer.nsi
    ; 的 customHeader 插入处，晚于 MUI2/multiUser/assisted 的 include，原语齐全。
    Var ssStoreDirHwnd


    Function ssCompleteUserInstall
  ${if} $ssMaintenance == "1"
    Call ssCheckController
    ${if} ${Errors}
      StrCpy $ssLogResult "maintenance-controller-unavailable"
      Call ssHandshakeFail
    ${endIf}
  ${endIf}
  ; ---- proposal 112 §6.E：legacy 组件仓库轴 → SCHOLARSEED_HOME 一次性协调（install+upgrade 都跑）----
  ; 触发判据用注册表而非 env：升级路径把握手 SCHOLARSEED_HOME 注入进程 env（updater.ts:1127），
  ; env 恒非空，只有 HKCU 注册表才反映「用户是否持久配置过 home」。
  ; 注：旧 store 目录的「可手动删除」告知延后到后续里程碑（需 Windows reg-query 消费 + UI，
  ; 本里程碑不可验证）；残留为无害的可再获取缓存，协调本身绝不搬用户数据。
  ReadRegStr $R0 HKCU "Environment" "${SS_HOME_ENV}"
  StrCmp $R0 "" ss_reconcile_check_legacy
  Goto ss_reconcile_done
  ss_reconcile_check_legacy:
  ReadRegStr $R1 HKCU "Environment" "SCHOLARSEED_RUNTIME_STORE"
  StrCmp $R1 "" ss_reconcile_done
  ; 取 legacy store 的盘根：仅处理盘符路径（第 2 字符为 ':'），取前 3 字符 "D:\"；
  ; UNC/异常形状不猜，不动 home（直接落 revoke）。
  StrCpy $R5 $R1 1 1
  StrCmp $R5 ":" ss_reconcile_drive_ok
  Goto ss_reconcile_revoke
  ss_reconcile_drive_ok:
  StrCpy $R3 $R1 3
  StrCpy $R2 "$R3\.scholarseed"
  ; 分支 2：默认 home 已有用户数据 → 绝不移动 home（会 orphan 文献/会话）。
  ${if} ${FileExists} "$PROFILE\.scholarseed\*.*"
    Goto ss_reconcile_revoke
  ${endIf}
  ; 分支 1：默认 home 无数据。盘不存在/不可写也不动 home，绝不写不可用的 home。
  ${ifNot} ${FileExists} "$R3\*.*"
    Goto ss_reconcile_revoke
  ${endIf}
  CreateDirectory "$R2\ScholarSeedWriteProbe"
  IfErrors ss_reconcile_revoke
  RMDir "$R2\ScholarSeedWriteProbe"
  WriteRegStr HKCU "Environment" "${SS_HOME_ENV}" "$R2"
  ; 同步安装器进程 env，使 Finish 页自动拉起的新 app 继承新 home（NEW-6）。
  System::Call 'kernel32::SetEnvironmentVariable(t "${SS_HOME_ENV}", t "$R2")'
  System::Call 'user32::SendMessageTimeout(i 0xffff, i 0x001A, p 0, t "Environment", i 0x0002, i 5000, *p .r0)'
  ss_reconcile_revoke:
  ; 撤销 legacy 轴注册表值 + 广播（收敛后产品只剩 SCHOLARSEED_HOME 一个数据根）。
  DeleteRegValue HKCU "Environment" "SCHOLARSEED_RUNTIME_STORE"
  System::Call 'user32::SendMessageTimeout(i 0xffff, i 0x001A, p 0, t "Environment", i 0x0002, i 5000, *p .r0)'
  ss_reconcile_done:

  ; 安装成功标志：Finish PRE 的自动拉起只对完成安装的本轮生效（提案 §5.2）。
  StrCpy $ssInstallComplete "1"
  StrCpy $ssLogPhase "install"
  StrCpy $ssLogEventName "complete"
  StrCpy $ssLogResult "ok"
  Call ssLogEvent
      StrCpy $R9 "${SS_HANDOFF_COMMITTED}"
    FunctionEnd

    Function ssWaitAllProcessesExit
      StrCpy $R6 0
      ss_all_processes_poll:
      nsExec::ExecToStack /TIMEOUT=${SS_PROCESS_QUERY_TIMEOUT_MS} '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH'
      Pop $R0
      Pop $R1
      StrCmp $R0 "0" 0 ss_all_processes_failed
      ${StrStr} $R2 $R1 '"${APP_EXECUTABLE_FILENAME}"'
      StrCmp $R2 "" ss_all_processes_closed
      IntOp $R6 $R6 + 1
      IntCmp $R6 ${SS_PROCESS_WAIT_ROUNDS} ss_all_processes_failed
      Sleep ${SS_HANDSHAKE_SLEEP_MS}
      Goto ss_all_processes_poll
      ss_all_processes_failed:
      SetErrors
      Return
      ss_all_processes_closed:
      ClearErrors
    FunctionEnd

    Function ssStorePagePre
      ${if} $ssHandshakeMode == "protocol"
      ${andIf} $ssInstallScope == "${SS_SCOPE_MACHINE}"
        ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
        StrCmp $INSTDIR $ssTargetDir 0 ss_store_update_failed
        StrCmp $R0 $ssTargetDir 0 ss_store_update_failed
        ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
        StrCmp $R0 "" 0 ss_store_update_failed
        Call ssWaitAllProcessesExit
        IfErrors ss_store_update_failed
        Abort
        ss_store_update_failed:
        !insertmacro ssLocalizedMessage $R9 "Update stopped before replacing files. Close ScholarSeed in all Windows sessions and retry." "更新已在替换文件前停止，请关闭所有 Windows 会话中的 ScholarSeed 后重试。"
        MessageBox MB_OK|MB_ICONSTOP "$R9"
        Quit
      ${endIf}
      ${if} ${isUpdated}
        Abort
      ${endIf}
      ${if} $hasPerUserInstallation == "1"
        Abort
      ${endIf}
      ${if} $hasPerMachineInstallation == "1"
        Abort
      ${endIf}
      ; 已配置过数据位置（注册表 home 非空）→ 不再询问。读注册表而非 env：升级路径会把
      ; 握手 SCHOLARSEED_HOME 注入进程 env（updater.ts），env 恒非空，只有注册表才反映
      ; 「用户是否持久配置过」（proposal 112 §6.D-Win）。
      ReadRegStr $R0 HKCU "Environment" "${SS_HOME_ENV}"
      StrCmp $R0 "" ss_store_check_data
      Abort
      ss_store_check_data:
      ; 默认 home 已有用户数据 → 绝不引导改 home（会 orphan 文献/会话）。`*.*` 命中即非空。
      ${if} ${FileExists} "$PROFILE\.scholarseed\*.*"
        Abort
      ${endIf}
      nsDialogs::Create 1018
      Pop $R1
      ${NSD_CreateLabel} 0 0 100% 40u "数据存放位置（可选，仅首次安装可设置）。书深会把文献、项目与运行组件放在此目录下（数 GB）。留空 = 默认：用户目录 .scholarseed。$\r$\nData location (optional, first install only). Literature, projects and runtime components are stored under this folder (several GB). Leave empty for the default: <user profile>\.scholarseed."
      Pop $R2
      ${NSD_CreateDirRequest} 0 50u 85% 12u ""
      Pop $ssStoreDirHwnd
      ${NSD_CreateBrowseButton} 85% 50u 15% 12u "..."
      Pop $R3
      ${NSD_OnClick} $R3 ssStoreBrowse
      nsDialogs::Show
    FunctionEnd

    Function ssStoreBrowse
      Pop $R4
      nsDialogs::SelectFolderDialog "数据存放位置 / Data location" ""
      Pop $R5
      StrCmp $R5 "error" ss_browse_done
      ${NSD_SetText} $ssStoreDirHwnd "$R5"
      ss_browse_done:
    FunctionEnd

    Function ssStorePageLeave
      ${NSD_GetText} $ssStoreDirHwnd $R4
      StrCmp $R4 "" ss_leave_done
      ; 绝对路径校验：盘符（第二字符为 ':'）或 UNC（前导双反斜杠），与 Node 侧 isValidAbsoluteRoot 同判据。
      StrCpy $R5 $R4 1 1
      StrCmp $R5 ":" ss_store_valid
      StrCpy $R5 $R4 2
      StrCmp $R5 "\\" ss_store_valid
      !insertmacro ssLocalizedMessage $R9 "The path must be absolute (drive letter or UNC)." "路径必须是绝对路径（盘符或 UNC）。"
      MessageBox MB_OK|MB_ICONSTOP "$R9"
      Abort
      ss_store_valid:
      ; 可写探针：建了再删；对已存在目录建目录的错误语义不可靠，故探一个子目录。
      CreateDirectory "$R4\ScholarSeedWriteProbe"
      IfErrors ss_store_unwritable
      RMDir "$R4\ScholarSeedWriteProbe"
      ; 用户选的是父目录 P；home = P\.scholarseed（容器根默认 P\Projects 由主进程派生，同父）。
      WriteRegStr HKCU "Environment" "${SS_HOME_ENV}" "$R4\.scholarseed"
      ; 同步安装器进程 env：Finish 页 ExecShellAsUser 自动拉起的新 app 继承本进程 env 块，
      ; 仅写注册表 + 广播不足以让本次自动拉起看到新 home（proposal 112 §6.E NEW-6）。
      System::Call 'kernel32::SetEnvironmentVariable(t "${SS_HOME_ENV}", t "$R4\.scholarseed")'
      ; WM_SETTINGCHANGE 广播，让后续新会话/新进程立即看到新 env（不等下次登录）。
      System::Call 'user32::SendMessageTimeout(i 0xffff, i 0x001A, p 0, t "Environment", i 0x0002, i 5000, *p .r0)'
      Goto ss_leave_done
      ss_store_unwritable:
      !insertmacro ssLocalizedMessage $R9 "The directory is not writable; choose another." "该目录不可写，请换一个。"
      MessageBox MB_OK|MB_ICONSTOP "$R9"
      Abort
      ss_leave_done:
    FunctionEnd

  !endif
!macroend

; 安装模式页 PRE 钩子：个人安装按已验证范围跳页；全局安装由模板的 UAC 内层分支跳页。
; 必须是顶层宏，不能放进 customHeader：NSIS 禁止在宏内定义宏，且 !ifmacrodef 探测要求它独立存在。
; 卸载器构建没有握手 Var，宏体整体排除以免编译期引用未声明变量。
!macro customInstallMode
  !ifdef SS_NATIVE_CARRIER
    StrCpy $isForceCurrentInstall "1"
  !endif
  !ifndef BUILD_UNINSTALLER
    ${if} $ssHandshakeMode == "protocol"
      ${if} $ssInstallScope == "${SS_SCOPE_USER}"
        StrCpy $isForceCurrentInstall "1"
      ${elseIf} $ssInstallScope == "${SS_SCOPE_MACHINE}"
        StrCpy $isForceMachineInstall "1"
      ${endIf}
    ${endIf}
  !endif
!macroend

; initMultiUser runs before customInit, including silent installation. Check its
; actual selection and registry discovery before handshake or template elevation.
!macro ssRequireNativeUserScope
  !insertmacro ssInstallerDiagnostic "phase=scope-check"
  ${if} $installMode != "CurrentUser"
  ${orIf} $hasPerMachineInstallation == "1"
  ${orIf} $perMachineInstallationFolder != ""
  ${orIf} ${isForAllUsers}
    !insertmacro ssLocalizedMessage $R9 "This installer supports a current-user installation only. A machine-wide installation cannot be upgraded with this package." "此安装包仅支持当前用户安装，不能用于升级计算机范围的安装。"
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "$R9"
    !insertmacro ssInstallerDiagnostic "phase=scope-check result=rejected"
    SetErrorLevel 2
    Quit
  ${endIf}
!macroend

!macro preInit
  !ifndef BUILD_UNINSTALLER
    Call ssPrivilegeInit
  !endif
!macroend

!macro customInit
  !insertmacro ssInstallerDiagnostic "phase=initialize"
  !ifdef SS_NATIVE_CARRIER
    !insertmacro ssRequireNativeUserScope
  !endif
  Call ssHandshakeInit
  !ifdef SS_NATIVE_CARRIER
    ${if} ${isForAllUsers}
      SetErrorLevel 2
      Quit
    ${endIf}
    !ifndef BUILD_UNINSTALLER
      ${if} $ssInstallScope == "${SS_SCOPE_MACHINE}"
        SetErrorLevel 2
        Quit
      ${endIf}
    !endif
  !endif
!macroend

!macro customInstall
  !insertmacro ssInstallerDiagnostic "phase=files-installed"

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

  ${if} $ssHandshakeMode == "protocol"
  ${andIf} ${UAC_IsInnerInstance}
    StrCpy $R9 "${SS_HANDOFF_REJECTED}"
    !insertmacro UAC_AsUser_Call Function ssCompleteUserInstall ${UAC_SYNCREGISTERS}
    StrCmp $R9 "${SS_HANDOFF_COMMITTED}" 0 ss_install_callback_failed
    StrCpy $ssInstallComplete "1"
    Goto ss_install_callback_done
    ss_install_callback_failed:
    SetErrorLevel 1
    Quit
    ss_install_callback_done:
  ${else}
    Call ssCompleteUserInstall
  ${endIf}
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

; C. 卸载期缓存清理：用户目录下的组件 store（content-addressed、数 GB）与暂存包缓存
;    （%LOCALAPPDATA%\scholarseed-update）都是「可再获取」的缓存而非用户数据；NSIS 卸载器
;    默认只清 INSTDIR，二者卸载后残留在用户目录。store 根 = <home>\runtime（proposal 112 收敛）；
;    home 取注册表 SCHOLARSEED_HOME（首装向导/升级协调写入），否则默认 $PROFILE\.scholarseed。
;    清理分两档：
;    - 版本更新（旧卸载器带 --updated 被新安装器拉起）：只删不一致的瞬态 —— staging（中断的
;      解压）与 locks（死进程锁）；components/manifests 原样保留，跨版本命中是 proposal 108 P2a
;      的收益，更新绝不能动它；
;    - 真正卸载：整删 store 与暂存包缓存，并撤掉 env 登记（HKCU Environment + 广播）；
;      .scholarseed 其余内容（会话/配置/技能/文献）是用户数据，一字不动。
;    更新档不碰暂存包缓存：新安装器正从其中那个 exe 运行。
!macro customUnInit
  !ifdef SS_NATIVE_CARRIER
    !insertmacro ssRequireNativeUserScope
  !endif
!macroend

!macro customUnInstall
  !ifdef SS_NATIVE_CARRIER
    ; Updates retain the native Current/Prepared closure. A real uninstall asks
    ; the installed launcher to retire its own namespace before removing it.
    ${ifNot} ${isUpdated}
      ClearErrors
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --retire-update-store' $R0
      ${if} ${Errors}
      ${orIf} $R0 != 0
        !insertmacro ssLocalizedMessage $R9 "The update store could not be safely removed. Uninstallation stopped; close ScholarSeed and retry." "无法安全清理更新数据，卸载已停止。请关闭 ScholarSeed 后重试。"
        IfSilent +2
        MessageBox MB_OK|MB_ICONSTOP "$R9"
        SetErrorLevel 2
        Quit
      ${endIf}
    ${endIf}
  !else
  ; store 根 = <home>\runtime；home 取注册表 SCHOLARSEED_HOME（收敛后唯一数据根），否则默认。
  ReadRegStr $R0 HKCU "Environment" "SCHOLARSEED_HOME"
  StrCmp $R0 "" 0 ss_uninst_home_set
  StrCpy $R0 "$PROFILE\.scholarseed"
  ss_uninst_home_set:
  StrCpy $R0 "$R0\runtime"
  ${if} ${isUpdated}
    RMDir /r "$R0\staging"
    RMDir /r "$R0\locks"
  ${else}
    RMDir /r "$R0"
    DeleteRegValue HKCU "Environment" "SCHOLARSEED_HOME"
    System::Call 'user32::SendMessageTimeout(i 0xffff, i 0x001A, p 0, t "Environment", i 0x0002, i 5000, *p .r1)'
    RMDir /r "$LOCALAPPDATA\scholarseed-update"
  ${endIf}
  !endif
!macroend

; D. 首装高级步骤：组件 store 位置（可选）。assisted 模板的 customPageAfterChangeDir 钩子在
;    目录页之后插页；该页没有 skipPageIfUpdated 包裹，故 PRE 里自行跳过非首装场景：
;    --updated（更新）、既有 per-user/per-machine 安装（重装/修复）、env 已登记（配置过）。
;    留空 = 默认路径，普通用户直接下一步即透明；仅非空且校验通过才写 HKCU Environment 并广播
;    （.cmd 启动器在打包机生成、读不了机器本地文件，env 是 batch/NSIS/Node 三方同源的唯一档）。
;    入口锁在首装：安装后不可改（改 = 数 GB 重解压 + 旧 store 孤儿），设置页只读展示。
!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_INIT
  PageEx custom
    PageCallbacks ssStorePagePre ssStorePageLeave
    Caption " "
  PageExEnd
!macroend
