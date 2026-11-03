; ASCII, fixed-field diagnostics on the inherited stdout pipe. No files, user
; paths, environment values or update credentials are opened or logged here.
; Preserve registers and NSIS's sticky error flag even when stdout is absent.
!ifndef SS_INSTALLER_DIAGNOSTICS
!define SS_INSTALLER_DIAGNOSTICS
!macro ssInstallerDiagnostic MESSAGE
  Push $0
  Push $1
  Push $2
  IfErrors 0 +3
    StrCpy $2 "1"
    Goto +2
  StrCpy $2 "0"
  StrLen $1 "[nsis] ${MESSAGE}$\r$\n"
  System::Call 'kernel32::GetStdHandle(i -11) p .r0'
  System::Call 'kernel32::WriteFile(p r0, m "[nsis] ${MESSAGE}$\r$\n", i r1, *i .r1, p 0)'
  StrCmp $2 "1" 0 +3
    SetErrors
    Goto +2
  ClearErrors
  Pop $2
  Pop $1
  Pop $0
!macroend
!endif
