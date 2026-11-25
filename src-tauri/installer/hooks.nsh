!include LogicLib.nsh

!define SC_LOG "$TEMP\SillyCat-install.log"
!define SC_SETUP "$TEMP\MicrosoftEdgeWebview2Setup.exe"
!define SC_OS_KEY "SOFTWARE\Microsoft\Windows NT\CurrentVersion"
Var scLogHandle
Var scMajor
Var scPv
Var scAbort

; The handle is open only for this installation, including the template's file-copy phase.
Function scWriteLog
  Exch $0
  ${If} $scLogHandle != ""
    FileWriteUTF16LE $scLogHandle "$0$\r$\n"
  ${EndIf}
  Pop $0
FunctionEnd

!macro scLog text
  Push "${text}"
  Call scWriteLog
!macroend

Function scExportLog
  ${If} $scLogHandle != ""
    FileClose $scLogHandle
    StrCpy $scLogHandle ""
    System::Call 'kernel32::CopyFileW(w "${SC_LOG}", w "$DESKTOP\捣蛋猫-安装日志.txt", i 0) i'
    ClearErrors
  ${EndIf}
FunctionEnd

Function .onInstFailed
  !insertmacro scLog "Installation failed"
  Call scExportLog
FunctionEnd

!macro scReadOs reader field
  ${reader} $0 HKLM "${SC_OS_KEY}" "${field}"
  !insertmacro scLog "${field}=$0"
!macroend

; One machine key applies per architecture. Always inspect the per-user key as well.
!macro scReadPv hive subkey
  ReadRegStr $0 ${hive} "${subkey}\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  !insertmacro scLog "${hive}\${subkey}\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}\pv=$0"
  ${If} $scPv == ""
  ${AndIf} $0 != ""
  ${AndIf} $0 != "0.0.0.0"
    StrCpy $scPv $0
  ${EndIf}
!macroend

!macro scDetectRuntime
  StrCpy $scPv ""
  ${If} ${RunningX64}
    SetRegView 64
    !insertmacro scReadPv HKLM "SOFTWARE\WOW6432Node"
    !insertmacro scLog "32-bit OS machine key: not applicable"
  ${Else}
    !insertmacro scLog "64-bit OS machine key: not applicable"
    !insertmacro scReadPv HKLM "SOFTWARE"
  ${EndIf}
  SetRegView 32
  !insertmacro scReadPv HKCU "SOFTWARE"
  !insertmacro scLog "Detected WebView2 version=$scPv"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
    Goto sc_done
  ${EndIf}
  Push $0
  Push $1
  FileOpen $scLogHandle "${SC_LOG}" w
  ${If} $scLogHandle != ""
    FileWriteWord $scLogHandle 65279
  ${EndIf}
  !insertmacro scLog "Product=${PRODUCTNAME} ${VERSION}"
  !insertmacro scLog "PassiveMode=$PassiveMode"
  ${If} ${Silent}
    !insertmacro scLog "Silent=1"
  ${Else}
    !insertmacro scLog "Silent=0"
  ${EndIf}
  !insertmacro scLog "InstallDir=$INSTDIR"
  !insertmacro scLog "TEMP=$TEMP"
  ${If} ${RunningX64}
    !insertmacro scLog "OS bitness=64"
    SetRegView 64
  ${Else}
    !insertmacro scLog "OS bitness=32"
  ${EndIf}
  !insertmacro scReadOs ReadRegStr ProductName
  !insertmacro scReadOs ReadRegStr CurrentVersion
  !insertmacro scReadOs ReadRegStr CurrentBuild
  !insertmacro scReadOs ReadRegStr CSDVersion
  !insertmacro scReadOs ReadRegDWORD UBR
  ReadRegDWORD $scMajor HKLM "${SC_OS_KEY}" "CurrentMajorVersionNumber"
  !insertmacro scLog "CurrentMajorVersionNumber=$scMajor"
  SetRegView 32
  StrCpy $scAbort ""
!ifndef SC_WIN7
  ; A missing DWORD reads as empty and compares numerically as zero.
  ${If} $scMajor < 10
    !insertmacro scLog "Legacy Windows: win7 package recommended"
    ${IfNot} ${Silent}
    ${AndIf} $PassiveMode != 1
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(scLegacyWindows)" IDNO sc_declined
    ${EndIf}
  ${EndIf}
!endif
  !insertmacro scDetectRuntime
  ${If} $scPv != ""
    Goto sc_finish
  ${EndIf}
!ifdef SC_WIN7
  !insertmacro scLog "WebView2 missing: manual installation of version 109 required"
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode != 1
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(scMissingLegacyRuntime)" IDNO sc_declined
  ${EndIf}
!else
  ${If} $scMajor < 10
    DetailPrint "$(scLegacyRuntimeHint)"
    !insertmacro scLog "Skipping bootstrapper on legacy Windows"
    Goto sc_finish
  ${EndIf}
  Delete "${SC_SETUP}"
  DetailPrint "$(webview2Downloading)"
  NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "${SC_SETUP}"
  Pop $0
  !insertmacro scLog "Download result=$0"
  ${If} $0 != "success"
    DetailPrint "$(webview2DownloadError)"
    Goto sc_setup_failed
  ${EndIf}
  DetailPrint "$(installingWebview2)"
  ClearErrors
  ExecWait '"${SC_SETUP}" /silent /install' $1
  ${If} ${Errors}
    StrCpy $0 1
    StrCpy $1 "unavailable" ; ExecWait has no process exit code on launch failure.
  ${Else}
    StrCpy $0 0
    IntFmt $1 "%d" $1
  ${EndIf}
  !insertmacro scLog "ExecWait error=$0 exit code=$1"
  ${If} $0 = 1
  ${OrIf} $1 != 0
    DetailPrint "$(webview2InstallError)"
    Goto sc_setup_failed
  ${EndIf}
  Delete "${SC_SETUP}"
  !insertmacro scDetectRuntime
  Goto sc_finish
sc_setup_failed:
  Delete "${SC_SETUP}"
  StrCpy $scAbort "$(webview2AbortError)"
!endif
  Goto sc_finish

sc_declined:
  !insertmacro scLog "User declined to continue"
  StrCpy $scAbort "$(scInstallCancelled)"
sc_finish:
  !insertmacro SetContext
  Pop $1
  Pop $0
  ClearErrors
  ${If} $scAbort != ""
    Call scExportLog
    Abort "$scAbort"
  ${EndIf}
sc_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $scLogHandle != ""
    FileClose $scLogHandle
    StrCpy $scLogHandle ""
    Delete "${SC_LOG}"
    ClearErrors
  ${EndIf}
!macroend
