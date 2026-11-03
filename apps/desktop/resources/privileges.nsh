!ifndef BUILD_UNINSTALLER
!define SS_NATIVE_TOKEN_QUERY 0x0008
!define SS_NATIVE_PROCESS_QUERY 0x1000
!define SS_NATIVE_TOKEN_USER 1
!define SS_NATIVE_TOKEN_SESSION 12
!define SS_NATIVE_TOKEN_ELEVATION 20
!define SS_NATIVE_TOKEN_INTEGRITY 25
!define SS_NATIVE_HIGH_IL 12288
!define SS_NATIVE_MEDIUM_IL 8192
!define SS_NATIVE_TOKEN_QUERY_DUPLICATE 0x000A
!define SS_NATIVE_TOKEN_TYPE 8
!define SS_NATIVE_TOKEN_ELEVATION_TYPE 18
!define SS_NATIVE_TOKEN_UI_ACCESS 26
!define SS_NATIVE_PRIMARY_TOKEN 1
!define SS_NATIVE_ELEVATION_DEFAULT 1
!define SS_NATIVE_ELEVATION_LIMITED 3
!define SS_NATIVE_PROCESS_QUERY_SYNCHRONIZE 0x101000
!define SS_NATIVE_WAIT_TIMEOUT 258
!define SS_MAINTENANCE_OPTION "/SCHOLARSEED_MAINTENANCE"

Var ssNativeToken
Var ssNativeBuffer
Var ssNativeSid
Var ssNativeSession
Var ssNativeElevated
Var ssNativeIntegrity
Var ssNativeProcess
Var ssNativeError
Var ssProcessLow
Var ssProcessHigh
Var ssOriginalParameters
Var ssActualPid
Var ssOriginalElevated
Var ssOriginalIntegrity
Var ssPluginAdmin
Var ssCallerElevated
Var ssCallerIntegrity
Var ssMaintenance
Var ssOriginalSid
Var ssOriginalSession
Var ssControllerPid
Var ssControllerLow
Var ssControllerHigh
Var ssControllerHandle
Var ssImpersonationToken
Var ssAdminSid

!macro ssCloseNativeHandle handle
  ${if} ${handle} != ""
  ${andIf} ${handle} != "0"
    System::Call 'kernel32::CloseHandle(p ${handle})'
    StrCpy ${handle} 0
  ${endIf}
!macroend

!macro ssPrivilegeFunctions
Function ssInspectToken
  StrCpy $ssNativeBuffer 0
  StrCpy $ssNativeSid ""
  StrCpy $ssNativeElevated "unknown"
  StrCpy $ssNativeIntegrity "unknown"
  StrCpy $ssNativeSession "unknown"
  System::Call 'advapi32::GetTokenInformation(p $ssNativeToken, i ${SS_NATIVE_TOKEN_ELEVATION}, *i .r0, i 4, *i .r1) i .r2'
  StrCmp $2 0 ss_token_failed
  StrCpy $ssNativeElevated $0
  System::Call 'advapi32::GetTokenInformation(p $ssNativeToken, i ${SS_NATIVE_TOKEN_SESSION}, *i .r0, i 4, *i .r1) i .r2'
  StrCmp $2 0 ss_token_failed
  StrCpy $ssNativeSession $0
  System::Call 'advapi32::GetTokenInformation(p $ssNativeToken, i ${SS_NATIVE_TOKEN_INTEGRITY}, p 0, i 0, *i .r0)'
  StrCmp $0 0 ss_token_failed
  System::Alloc $0
  Pop $ssNativeBuffer
  StrCmp $ssNativeBuffer 0 ss_token_failed
  System::Call 'advapi32::GetTokenInformation(p $ssNativeToken, i ${SS_NATIVE_TOKEN_INTEGRITY}, p $ssNativeBuffer, i r0, *i .r1) i .r2'
  StrCmp $2 0 ss_token_free_failed
  System::Call '*$ssNativeBuffer(p .r0)'
  System::Call 'advapi32::GetSidSubAuthority(p r0, i 0) p .r1'
  StrCmp $1 0 ss_token_free_failed
  System::Call '*$1(i .r0)'
  StrCpy $ssNativeIntegrity $0
  System::Free $ssNativeBuffer
  StrCpy $ssNativeBuffer 0
  System::Call 'advapi32::GetTokenInformation(p $ssNativeToken, i ${SS_NATIVE_TOKEN_USER}, p 0, i 0, *i .r0)'
  StrCmp $0 0 ss_token_failed
  System::Alloc $0
  Pop $ssNativeBuffer
  StrCmp $ssNativeBuffer 0 ss_token_failed
  System::Call 'advapi32::GetTokenInformation(p $ssNativeToken, i ${SS_NATIVE_TOKEN_USER}, p $ssNativeBuffer, i r0, *i .r1) i .r2'
  StrCmp $2 0 ss_token_free_failed
  System::Call '*$ssNativeBuffer(p .r0)'
  System::Call 'advapi32::ConvertSidToStringSidW(p r0, *p .r1) i .r2'
  StrCmp $2 0 ss_token_free_failed
  System::Call '*$1(&w${NSIS_MAX_STRLEN} .r0)'
  StrCpy $ssNativeSid $0
  System::Call 'kernel32::LocalFree(p r1)'
  System::Free $ssNativeBuffer
  StrCpy $ssNativeBuffer 0
  ClearErrors
  Return
  ss_token_free_failed:
  System::Free $ssNativeBuffer
  StrCpy $ssNativeBuffer 0
  ss_token_failed:
  SetErrors
FunctionEnd

; The primary token, not the UAC plugin boolean, defines ordinary maintenance.
; This function performs no user-directory I/O. Its token needs QUERY|DUPLICATE.
Function ssRequireOrdinaryToken
  StrCpy $ssImpersonationToken 0
  StrCpy $ssAdminSid 0
  Call ssInspectToken
  IfErrors ss_ordinary_failed
  StrCmp $ssNativeElevated "0" 0 ss_ordinary_failed
  IntCmp $ssNativeIntegrity ${SS_NATIVE_MEDIUM_IL} 0 ss_ordinary_failed
  IntCmp $ssNativeIntegrity ${SS_NATIVE_HIGH_IL} ss_ordinary_failed 0 ss_ordinary_failed
  System::Call 'advapi32::GetTokenInformation(p $ssNativeToken, i ${SS_NATIVE_TOKEN_TYPE}, *i .r0, i 4, *i .r1) i .r2'
  StrCmp $2 0 ss_ordinary_failed
  StrCmp $0 ${SS_NATIVE_PRIMARY_TOKEN} 0 ss_ordinary_failed
  System::Call 'advapi32::GetTokenInformation(p $ssNativeToken, i ${SS_NATIVE_TOKEN_UI_ACCESS}, *i .r0, i 4, *i .r1) i .r2'
  StrCmp $2 0 ss_ordinary_failed
  StrCmp $0 0 0 ss_ordinary_failed
  System::Call 'advapi32::GetTokenInformation(p $ssNativeToken, i ${SS_NATIVE_TOKEN_ELEVATION_TYPE}, *i .r0, i 4, *i .r1) i .r2'
  StrCmp $2 0 ss_ordinary_failed
  StrCmp $0 ${SS_NATIVE_ELEVATION_DEFAULT} ss_ordinary_groups
  StrCmp $0 ${SS_NATIVE_ELEVATION_LIMITED} 0 ss_ordinary_failed
  ss_ordinary_groups:
  System::Call 'advapi32::DuplicateToken(p $ssNativeToken, i 1, *p .r0) i .r1'
  StrCmp $1 0 ss_ordinary_failed
  StrCpy $ssImpersonationToken $0
  System::Call 'advapi32::ConvertStringSidToSidW(w "S-1-5-32-544", *p .r0) i .r1'
  StrCmp $1 0 ss_ordinary_failed
  StrCpy $ssAdminSid $0
  System::Call 'advapi32::CheckTokenMembership(p $ssImpersonationToken, p $ssAdminSid, *i .r0) i .r1'
  StrCmp $1 0 ss_ordinary_failed
  StrCmp $0 0 0 ss_ordinary_failed
  System::Call 'kernel32::LocalFree(p $ssAdminSid)'
  StrCpy $ssAdminSid 0
  !insertmacro ssCloseNativeHandle $ssImpersonationToken
  ClearErrors
  Return
  ss_ordinary_failed:
  ${if} $ssAdminSid != 0
    System::Call 'kernel32::LocalFree(p $ssAdminSid)'
    StrCpy $ssAdminSid 0
  ${endIf}
  !insertmacro ssCloseNativeHandle $ssImpersonationToken
  SetErrors
FunctionEnd

; Pin the controller's process object for the whole protocol. PID disappearance
; or reuse is never treated as successful maintenance authorization.
Function ssBindController
  !insertmacro ssCloseNativeHandle $ssControllerHandle
  System::Call 'kernel32::OpenProcess(i ${SS_NATIVE_PROCESS_QUERY_SYNCHRONIZE}, i 0, i $ssControllerPid) p .r0'
  StrCpy $ssControllerHandle $0
  Call ssCheckController
FunctionEnd

Function ssCheckController
  StrCmp $ssControllerHandle "" ss_controller_failed
  StrCmp $ssControllerHandle 0 ss_controller_failed
  System::Call 'kernel32::WaitForSingleObject(p $ssControllerHandle, i 0) i .r0'
  StrCmp $0 ${SS_NATIVE_WAIT_TIMEOUT} 0 ss_controller_failed
  StrCpy $ssNativeProcess $ssControllerHandle
  Call ssProcessCreation
  StrCpy $ssNativeProcess 0
  IfErrors ss_controller_failed
  StrCmp $ssProcessLow $ssControllerLow 0 ss_controller_failed
  StrCmp $ssProcessHigh $ssControllerHigh 0 ss_controller_failed
  System::Call 'advapi32::OpenProcessToken(p $ssControllerHandle, i ${SS_NATIVE_TOKEN_QUERY_DUPLICATE}, *p .r0) i .r1'
  StrCmp $1 0 ss_controller_failed
  StrCpy $ssNativeToken $0
  Call ssRequireOrdinaryToken
  !insertmacro ssCloseNativeHandle $ssNativeToken
  IfErrors ss_controller_failed
  StrCmp $ssNativeSid $ssOriginalSid 0 ss_controller_failed
  StrCmp $ssNativeSid $ssCallerSid 0 ss_controller_failed
  StrCmp $ssNativeSession $ssOriginalSession 0 ss_controller_failed
  ClearErrors
  Return
  ss_controller_failed:
  SetErrors
FunctionEnd

Function ssProcessCreation
  System::Call 'kernel32::GetProcessTimes(p $ssNativeProcess, *l .r0, *l .r1, *l .r2, *l .r3) i .r4'
  StrCmp $4 0 ss_creation_failed
  System::Call '*(l r0) p .r1'
  StrCmp $1 0 ss_creation_failed
  System::Call '*$1(i .r2, i .r3)'
  StrCpy $ssProcessLow $2
  StrCpy $ssProcessHigh $3
  System::Free $1
  ClearErrors
  Return
  ss_creation_failed:
  SetErrors
FunctionEnd

Function ssPrivilegeFailure
  !insertmacro ssCloseNativeHandle $ssNativeToken
  !insertmacro ssCloseNativeHandle $ssNativeProcess
  !insertmacro ssCloseNativeHandle $ssControllerHandle
  !insertmacro ssLocalizedMessage $R9 "Update permission check failed ($ssNativeError); install cancelled, current version untouched." "更新权限检查失败（$ssNativeError），安装已取消，当前版本未被改动。"
  MessageBox MB_OK|MB_ICONSTOP "$R9"
  SetErrorLevel 2
  Quit
FunctionEnd

; 只记录当前进程权限；安装范围与提权由 ssHandshakeInit 决定。
Function ssPrivilegeInit
  ${GetParameters} $ssOriginalParameters
  StrCpy $ssMaintenance "0"
  ClearErrors
  ${GetOptions} $ssOriginalParameters "${SS_MAINTENANCE_OPTION}" $0
  ${ifNot} ${Errors}
    StrCpy $ssMaintenance "1"
    StrCpy $ssNativeError "invalid-maintenance-parameter"
    StrCmp $0 "" 0 ss_privilege_failed
    !ifndef SS_NATIVE_CARRIER
      StrCpy $ssNativeError "maintenance-native-carrier-required"
      Goto ss_privilege_failed
    !endif
    ${if} ${isForAllUsers}
      StrCpy $ssNativeError "maintenance-current-user-required"
      Goto ss_privilege_failed
    ${endIf}
  ${endIf}
  ClearErrors
  ${GetOptions} $ssOriginalParameters "${SS_UPDATE_ID_OPTION}" $ssUpdateId
  ${if} ${Errors}
    StrCmp $ssMaintenance "1" ss_privilege_failed ss_privilege_done
  ${endIf}
  StrCpy $ssNativeError "invalid-update-parameter"
  Call ssValidateUuid
  IfErrors ss_privilege_failed
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  StrCpy $ssActualPid $0
  StrCpy $ssNativeError "native-token-query-failed"
  System::Call 'advapi32::OpenProcessToken(p -1, i ${SS_NATIVE_TOKEN_QUERY_DUPLICATE}, *p .r0) i .r1'
  StrCmp $1 0 ss_privilege_failed
  StrCpy $ssNativeToken $0
  Call ssInspectToken
  IfErrors ss_privilege_failed
  ${if} $ssMaintenance == "1"
    StrCpy $ssNativeError "ordinary-maintenance-token-required"
    Call ssRequireOrdinaryToken
    IfErrors ss_privilege_failed
  ${endIf}
  !insertmacro ssCloseNativeHandle $ssNativeToken
  StrCpy $ssOriginalSid $ssNativeSid
  StrCpy $ssOriginalSession $ssNativeSession
  StrCpy $ssOriginalElevated $ssNativeElevated
  StrCpy $ssOriginalIntegrity $ssNativeIntegrity
  !insertmacro UAC_IsAdmin
  StrCpy $ssPluginAdmin $0
  Goto ss_privilege_done
  ss_privilege_failed:
  Call ssPrivilegeFailure
  ss_privilege_done:
  ClearErrors
FunctionEnd

Function ssInspectCaller
  StrCpy $ssCallerElevated "unknown"
  StrCpy $ssCallerIntegrity "unknown"
  System::Call 'kernel32::OpenProcess(i ${SS_NATIVE_PROCESS_QUERY}, i 0, i $ssCallerPid) p .r0'
  StrCpy $ssNativeProcess $0
  StrCmp $0 0 ss_caller_probe_done
  System::Call 'advapi32::OpenProcessToken(p $ssNativeProcess, i ${SS_NATIVE_TOKEN_QUERY}, *p .r0) i .r1'
  StrCmp $1 0 ss_caller_probe_done
  StrCpy $ssNativeToken $0
  Call ssInspectToken
  IfErrors ss_caller_probe_done
  StrCpy $ssCallerElevated $ssNativeElevated
  StrCpy $ssCallerIntegrity $ssNativeIntegrity
  ss_caller_probe_done:
  !insertmacro ssCloseNativeHandle $ssNativeToken
  !insertmacro ssCloseNativeHandle $ssNativeProcess
  ClearErrors
FunctionEnd
!macroend
!endif
