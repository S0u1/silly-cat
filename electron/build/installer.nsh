; SillyCat Electron demo: 安装阶段日志。
; electron-builder 通过 build/installer.nsh 自动包含本文件（nsis.include 默认值）。
;
; 目的：测试者装不上或中途关窗口时，也能留下日志发回来。日志直接放在当前用户的桌面：SillyCatDemo-install.log
; （桌面写不了就退回 %APPDATA%\SillyCatElectronDemo\SillyCatDemo-install.log）。每次安装都写，不只在出错时写；每次安装追加一段。
; 编码：UTF-8 带 BOM（EF BB BF），行尾 CRLF，Win7 自带记事本能正确显示中文。NSIS 3.0.4.1 没有写 UTF-8 的指令，
; 所以用 WideCharToMultiByte 转码，再用 kernel32::WriteFile 直接往 FileOpen 返回的句柄里写。
;
; 注意（对照 app-builder-lib 26.x 自带模板确认过）：
;  - 模板没有定义 .onInstSuccess / .onInstFailed / .onGUIEnd，这里可以定义；.onUserAbort 是 MUI2 定义的，改用 MUI_CUSTOMFUNCTION_ABORT；升级 electron-builder 后要重新核对，重复定义 makensis 会报错。
;  - 绝对不能定义 customCheckAppRunning、customUnInstallCheck、customUnInstallCheckCurrentUser、customWelcomePage、customFinishPage 这类宏：
;    模板用 !ifmacrodef 判断，一旦定义就会「替换」自带逻辑而不是追加。这里只用纯追加的钩子：preInit、customInit、customFiles_x64、customInstall。
;  - 模板在非静默安装时对安装段执行了 SetDetailsPrint none，所以安装器「详情」列表里基本没有内容；
;    因此除了转储详情列表，还在各阶段写「断点」行，好看出安装停在了哪一步。
;  - 卸载器是用同一份脚本另编一遍（定义了 BUILD_UNINSTALLER），那一遍整体跳过。

!ifndef BUILD_UNINSTALLER

!define SC_LOG_DIR "SillyCatElectronDemo"
!define SC_LOG_NAME "SillyCatDemo-install.log"
!define SC_LV_GETITEMCOUNT 0x1004
!define SC_LV_GETITEMTEXTW 0x1073
!define SC_LV_BUFCHARS 1024
!define SC_LV_BUFBYTES 2048

Var scLogPath
Var scLogFellBack

; 求日志路径（只做一次）：优先当前用户桌面 $DESKTOP\${SC_LOG_NAME}。
; 先 SetShellVarContext current，保证 $DESKTOP 是当前用户的桌面而不是公共桌面（本安装器只装当前用户，这里等于默认值，没有副作用）。
; 桌面写不了（FileOpen 失败）就退回 %APPDATA%\${SC_LOG_DIR}\${SC_LOG_NAME}，并置 $scLogFellBack = 1。
Function scInitPath
  StrCmp $scLogPath "" 0 sc_path_done
  Push $0
  Push $1
  SetShellVarContext current
  StrCpy $scLogFellBack "0"
  StrCpy $scLogPath "$DESKTOP\${SC_LOG_NAME}"
  ClearErrors
  FileOpen $1 "$scLogPath" a
  IfErrors sc_path_fallback
  FileClose $1
  Goto sc_path_pop
  sc_path_fallback:
  StrCpy $scLogFellBack "1"
  ReadEnvStr $0 APPDATA
  StrCmp $0 "" 0 +2
  StrCpy $0 "$APPDATA"
  CreateDirectory "$0\${SC_LOG_DIR}"
  StrCpy $scLogPath "$0\${SC_LOG_DIR}\${SC_LOG_NAME}"
  sc_path_pop:
  Pop $1
  Pop $0
  sc_path_done:
FunctionEnd

; 数字补零成两位：栈顶进，栈顶出
Function scPad2
  Exch $0
  IntCmp $0 10 sc_pad_done 0 sc_pad_done
  StrCpy $0 "0$0"
  sc_pad_done:
  Exch $0
FunctionEnd

; 当前本地时间 "YYYY-MM-DD HH:MM:SS"，结果压栈
Function scNow
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  System::Alloc 16
  Pop $0
  System::Call 'kernel32::GetLocalTime(i r0)'
  System::Call '*$0(&i2 .r1, &i2 .r2, &i2, &i2 .r3, &i2 .r4, &i2 .r5, &i2 .r6)'
  System::Free $0
  Push $2
  Call scPad2
  Pop $2
  Push $3
  Call scPad2
  Pop $3
  Push $4
  Call scPad2
  Pop $4
  Push $5
  Call scPad2
  Pop $5
  Push $6
  Call scPad2
  Pop $6
  StrCpy $0 "$1-$2-$3 $4:$5:$6"
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

; 给日志追加一行：栈顶进（一行文字）。UTF-8，文件为空时先写 BOM，行尾 CRLF。
; 不改动其他寄存器，也保持调用前的错误标志。
Function scAppendLine
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy $6 0
  IfErrors 0 +2
  StrCpy $6 1
  ClearErrors
  Call scInitPath
  FileOpen $1 "$scLogPath" a
  IfErrors sc_append_end
  FileSeek $1 0 END $2
  IntCmp $2 0 0 sc_append_bom_done sc_append_bom_done
  System::Alloc 4
  Pop $3
  System::Call '*$3(&i1 239, &i1 187, &i1 191)'
  System::Call 'kernel32::WriteFile(i r1, i r3, i 3, *i .r4, i 0)'
  System::Free $3
  sc_append_bom_done:
  StrCpy $0 "$0$\r$\n"
  System::Call 'kernel32::WideCharToMultiByte(i 65001, i 0, w r0, i -1, i 0, i 0, i 0, i 0) i .r2'
  IntCmp $2 1 sc_append_close sc_append_close sc_append_convert
  sc_append_convert:
  System::Alloc $2
  Pop $3
  System::Call 'kernel32::WideCharToMultiByte(i 65001, i 0, w r0, i -1, i r3, i r2, i 0, i 0) i .r5'
  IntOp $5 $2 - 1
  System::Call 'kernel32::WriteFile(i r1, i r3, i r5, *i .r4, i 0)'
  System::Free $3
  sc_append_close:
  FileClose $1
  sc_append_end:
  StrCmp $6 1 sc_append_seterr sc_append_clrerr
  sc_append_seterr:
  SetErrors
  Goto sc_append_exit
  sc_append_clrerr:
  ClearErrors
  sc_append_exit:
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; 带时间的一行：栈顶进（文字）
Function scStage
  Exch $0
  Push $1
  Call scNow
  Pop $1
  Push "[$1] $0"
  Call scAppendLine
  Pop $1
  Pop $0
FunctionEnd

!macro scStageMacro TEXT
  Push "${TEXT}"
  Call scStage
!macroend

; 系统版本：读 HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion
Function scLogSysInfo
  Push $0
  Push $1
  Push $2
  Push $3
  SetRegView 64
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "ProductName"
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentVersion"
  ReadRegStr $2 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuild"
  StrCmp $2 "" 0 +2
  ReadRegStr $2 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ReadRegStr $3 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CSDVersion"
  Push "os: ProductName=[$0] CurrentVersion=[$1] CurrentBuild=[$2] CSDVersion=[$3]"
  Call scAppendLine
  ReadEnvStr $0 PROCESSOR_ARCHITECTURE
  ReadEnvStr $1 PROCESSOR_ARCHITEW6432
  Push "arch: PROCESSOR_ARCHITECTURE=[$0] PROCESSOR_ARCHITEW6432=[$1]"
  Call scAppendLine
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; 安装器自身路径、命令行、安装目录
Function scLogContext
  Push "installer: $EXEPATH"
  Call scAppendLine
  Push "cmdline: $CMDLINE"
  Call scAppendLine
  Push "instdir: $INSTDIR"
  Call scAppendLine
FunctionEnd

; 转储安装器「详情」列表（SysListView32，控件 ID 1016）的全部文字，Unicode 版 LVM_GETITEMTEXTW
Function scDumpDetails
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $0 $0 1016
  StrCmp $0 0 sc_dump_none
  SendMessage $0 ${SC_LV_GETITEMCOUNT} 0 0 $4
  IntCmp $4 0 sc_dump_empty sc_dump_empty
  System::Alloc ${SC_LV_BUFBYTES}
  Pop $3
  System::Alloc 36
  Pop $1
  System::Call '*$1(i 0, i 0, i 0, i 0, i 0, i r3, i ${SC_LV_BUFCHARS}, i 0, i 0)'
  Push "details list ($4 lines):"
  Call scAppendLine
  StrCpy $2 0
  sc_dump_loop:
  IntCmp $2 $4 sc_dump_done 0 sc_dump_done
  System::Call 'user32::SendMessageW(i r0, i ${SC_LV_GETITEMTEXTW}, i r2, i r1)'
  System::Call '*$3(&t${SC_LV_BUFCHARS} .r5)'
  Push "  | $5"
  Call scAppendLine
  IntOp $2 $2 + 1
  Goto sc_dump_loop
  sc_dump_done:
  System::Free $1
  System::Free $3
  Goto sc_dump_end
  sc_dump_empty:
  Push "details list: (empty - the electron-builder template sets SetDetailsPrint none while installing)"
  Call scAppendLine
  Goto sc_dump_end
  sc_dump_none:
  Push "details list: (control not found)"
  Call scAppendLine
  sc_dump_end:
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; ---- 纯追加的模板钩子 ----

!macro preInit
  Call scInitPath
  Push "============================================================"
  Call scAppendLine
  Push "log file: $scLogPath (fell back to %APPDATA% because the desktop was not writable: $scLogFellBack)"
  Call scAppendLine
  !insertmacro scStageMacro "installer started (SillyCatElectronDemo ${VERSION})"
  Call scLogSysInfo
  Call scLogContext
!macroend

!macro customInit
  !insertmacro scStageMacro "init done (.onInit finished)"
  Push "instdir: $INSTDIR"
  Call scAppendLine
!macroend

!macro customFiles_x64
  !insertmacro scStageMacro "app files extracted to $INSTDIR"
!macroend

!macro customInstall
  !insertmacro scStageMacro "install section finished (files, shortcuts and registry done)"
!macroend

; ---- NSIS 回调 ----

Function .onInstSuccess
  !insertmacro scStageMacro "RESULT: SUCCESS"
  Call scLogContext
  IfFileExists "$INSTDIR\SillyCatElectronDemo.exe" sc_ok_exe sc_ok_noexe
  sc_ok_exe:
  Push "check: $INSTDIR\SillyCatElectronDemo.exe exists"
  Call scAppendLine
  Goto sc_ok_dump
  sc_ok_noexe:
  Push "check: WARNING $INSTDIR\SillyCatElectronDemo.exe NOT found"
  Call scAppendLine
  sc_ok_dump:
  Call scDumpDetails
FunctionEnd

Function .onInstFailed
  !insertmacro scStageMacro "RESULT: FAILED (install section aborted)"
  Call scLogContext
  Call scDumpDetails
  Call scInitPath
  StrCmp $scLogFellBack "1" sc_fail_fellback
  MessageBox MB_OK|MB_ICONEXCLAMATION "安装没有完成。$\r$\n$\r$\n请把桌面上的 ${SC_LOG_NAME} 发回给我们（如果猫启动过，再加桌面上的 SillyCatDemo-run.log）。" /SD IDOK
  Goto sc_fail_done
  sc_fail_fellback:
  MessageBox MB_OK|MB_ICONEXCLAMATION "安装没有完成。$\r$\n$\r$\n桌面写不了日志，请把这个文件发回给我们：$\r$\n$scLogPath$\r$\n（如果猫启动过，再加同一文件夹或桌面上的 SillyCatDemo-run.log）。" /SD IDOK
  sc_fail_done:
FunctionEnd

; .onUserAbort 已被 MUI2 的 MUI_FUNCTION_ABORTWARNING 定义（重复定义会报错）；
; 用 MUI 提供的 MUI_CUSTOMFUNCTION_ABORT 挂钩，它在用户确认放弃之后才被调用。
Function scOnUserAbort
  !insertmacro scStageMacro "RESULT: user cancelled / closed the installer window"
  Call scLogContext
  Call scDumpDetails
FunctionEnd
!define MUI_CUSTOMFUNCTION_ABORT scOnUserAbort

Function .onGUIEnd
  !insertmacro scStageMacro "installer window closed"
FunctionEnd

!endif
