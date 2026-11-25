!include LogicLib.nsh

!define SC_LOG "$TEMP\SillyCat-install.log"
!define SC_SETUP "$TEMP\MicrosoftEdgeWebview2Setup.exe"
!define SC_OS_KEY "SOFTWARE\Microsoft\Windows NT\CurrentVersion"
Var scLogHandle
!define MUI_CUSTOMFUNCTION_GUIINIT scGuiInit
Var scBuild
Var scLegacy
Var scGuiBuild
Var scGuiPv
Var scGuiDecision
Var scUnattended
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
  StrCpy $1 $0 1
  ${If} $scPv == ""
  ${AndIf} $1 > 0
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

Function scDetectBuild
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  ReadRegStr $scBuild HKLM "${SC_OS_KEY}" "CurrentBuildNumber"
  ${If} $scBuild == ""
    ReadRegStr $scBuild HKLM "${SC_OS_KEY}" "CurrentBuild"
  ${EndIf}
  StrCpy $scLegacy 0
  ; Reject partial integer conversions such as "7601bad". Strip leading zeroes
  ; before conversion because NSIS interprets a leading zero as octal.
  StrCpy $0 $scBuild
  StrCpy $1 $0 1
  ${While} $1 == "0"
    StrCpy $0 $0 "" 1
    StrCpy $1 $0 1
  ${EndWhile}
  IntFmt $1 "%u" $0
  ${If} $1 != $0
  ${OrIf} $1 <= 0
    !insertmacro scLog "Unknown Windows build: $scBuild"
  ${ElseIf} $1 < 10240
    StrCpy $scLegacy 1
  ${EndIf}
FunctionEnd

; Tauri declares its mode variables and GUID after including the hooks.
; Its custom language includes emit this function once, after those declarations.
!macro scDefineGuiInit
!ifndef SC_GUI_INIT_DEFINED
!define SC_GUI_INIT_DEFINED
Function scGuiInit
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    Return
  ${EndIf}
  Push $0
  Push $1
  Call scDetectBuild
  !insertmacro scDetectRuntime
  StrCpy $scGuiBuild $scBuild
  StrCpy $scGuiPv $scPv
  StrCpy $scGuiDecision "no prompt"
  ${If} ${RunningX64}
    SetRegView 64
  ${Else}
    SetRegView 32
  ${EndIf}
  Pop $1
  Pop $0
  ClearErrors
!ifdef SC_WIN7
  ${If} $scPv == ""
    ${If} $scLegacy = 1
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(scMissingLegacyRuntime)" IDNO sc_quit
    ${Else}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(scMissingRuntime)" IDNO sc_quit
    ${EndIf}
!else
  ${If} $scLegacy = 1
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(scLegacyWindows)" IDNO sc_quit
!endif
    StrCpy $scGuiDecision "user continued"
  ${EndIf}
  Return
sc_quit:
  Quit
FunctionEnd
!endif
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
  StrCpy $scUnattended 0
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
    StrCpy $scUnattended 1
  ${EndIf}
  ${If} $scGuiDecision != ""
    !insertmacro scLog "GUI build=$scGuiBuild pv=$scGuiPv decision=$scGuiDecision"
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
  !insertmacro scReadOs ReadRegDWORD CurrentMajorVersionNumber
  Call scDetectBuild
  !insertmacro scLog "Effective Windows build=$scBuild"
  !insertmacro scDetectRuntime
  StrCpy $scAbort ""
!ifdef SC_WIN7
  ${If} $scPv == ""
    !insertmacro scLog "WebView2 missing: manual installation required"
    ${If} $scUnattended = 1
      StrCpy $scAbort "$(scMissingRuntimeBlocked)"
    ${EndIf}
  ${EndIf}
!else
  ${If} $scLegacy = 1
    !insertmacro scLog "Skipping bootstrapper on legacy Windows"
    ${If} $scUnattended = 1
      StrCpy $scAbort "$(scLegacyWindowsBlocked)"
    ${ElseIf} $scPv == ""
      DetailPrint "$(scLegacyRuntimeHint)"
    ${EndIf}
    Goto sc_finish
  ${EndIf}
  ${If} $scPv != ""
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
  StrCpy $1 5
  ${Do}
    Push $1
    !insertmacro scDetectRuntime
    Pop $1
    ${If} $scPv != ""
      Delete "${SC_SETUP}"
      Goto sc_finish
    ${EndIf}
    Sleep 1000
    IntOp $1 $1 - 1
  ${LoopWhile} $1 > 0
  !insertmacro scLog "$(scRuntimeNotRegistered)"
  DetailPrint "$(scRuntimeNotRegistered)"
sc_setup_failed:
  Delete "${SC_SETUP}"
  StrCpy $scAbort "$(webview2AbortError)"
sc_finish:
!endif
  !insertmacro SetContext
  Pop $1
  Pop $0
  ClearErrors
  ${If} $scAbort != ""
    !insertmacro scLog "$scAbort"
    Call scExportLog
    ${If} $scUnattended = 0
      MessageBox MB_OK|MB_ICONSTOP "$scAbort"
    ${EndIf}
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
