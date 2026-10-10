; The helper shares the Rust core and runs without the desktop's elevation manifest.
; It is extracted only to NSIS's temporary directory, never installed as an app runtime.
!define ASTRIAX_MAINTENANCE "${__FILEDIR__}\..\..\target\release\astriax-maintenance.exe"
Var AstriaXRoot
Var AstriaXBackup
Var AstriaXExit
Var AstriaXOwner
Var AstriaXAction

!macro AstriaXPrepare
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=astriax-maintenance.exe "${ASTRIAX_MAINTENANCE}"
  System::Call 'kernel32::GetCurrentProcessId()i.r0'
  StrCpy $AstriaXOwner $0
  DetailPrint "检查运行状态并备份升级前的数据…"
  ExecWait '"$PLUGINSDIR\astriax-maintenance.exe" --maintenance prepare "$INSTDIR" "${BUNDLEID}" "$PLUGINSDIR\maintenance.ini" $AstriaXOwner' $AstriaXExit
  ${If} $AstriaXExit != 0
    ReadINIStr $0 "$PLUGINSDIR\maintenance.ini" "maintenance" "error"
    MessageBox MB_ICONSTOP|MB_OK "无法继续安装：$0" /SD IDOK
    Abort
  ${EndIf}
  ReadINIStr $AstriaXRoot "$PLUGINSDIR\maintenance.ini" "maintenance" "root"
  ReadINIStr $AstriaXBackup "$PLUGINSDIR\maintenance.ini" "maintenance" "backup"
  DetailPrint "升级备份：$AstriaXBackup"
  SetOutPath "$INSTDIR"
!macroend

!macro NSIS_HOOK_PREUPGRADE
  !insertmacro AstriaXPrepare
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AstriaXPrepare
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$PLUGINSDIR\astriax-maintenance.exe" --maintenance commit "$INSTDIR" "${BUNDLEID}" "$PLUGINSDIR\maintenance.ini" $AstriaXOwner' $AstriaXExit
  ${If} $AstriaXExit != 0
    ReadINIStr $0 "$PLUGINSDIR\maintenance.ini" "maintenance" "error"
    MessageBox MB_ICONSTOP|MB_OK "安装维护失败：$0$\r$\n升级备份：$AstriaXBackup" /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=astriax-maintenance.exe "${ASTRIAX_MAINTENANCE}"
    System::Call 'kernel32::GetCurrentProcessId()i.r0'
    StrCpy $AstriaXOwner $0
    ExecWait '"$PLUGINSDIR\astriax-maintenance.exe" --maintenance check "$INSTDIR" "${BUNDLEID}" "$PLUGINSDIR\maintenance.ini" $AstriaXOwner' $AstriaXExit
    ${If} $AstriaXExit != 0
      ReadINIStr $0 "$PLUGINSDIR\maintenance.ini" "maintenance" "error"
      MessageBox MB_ICONSTOP|MB_OK "无法卸载：$0" /SD IDOK
      Abort
    ${EndIf}
    ReadINIStr $AstriaXRoot "$PLUGINSDIR\maintenance.ini" "maintenance" "root"
    StrCpy $AstriaXAction "keep"
    ${GetOptions} $CMDLINE "/DELETE_DATA" $0
    ${IfNot} ${Errors}
      StrCpy $AstriaXAction "delete"
    ${EndIf}
    ${IfNot} ${Silent}
      MessageBox MB_ICONQUESTION|MB_YESNOCANCEL|MB_DEFBUTTON2 "是否删除 AstriaX 的实例、运行时和配置？$\r$\n$AstriaXRoot$\r$\n$\r$\n是：删除应用数据（升级备份保留）$\r$\n否：保留数据，仅卸载程序$\r$\n取消：中止卸载" IDYES astriax_delete IDNO astriax_keep
      Abort
      astriax_delete:
      StrCpy $AstriaXAction "delete"
      astriax_keep:
    ${EndIf}
    ExecWait '"$PLUGINSDIR\astriax-maintenance.exe" --maintenance $AstriaXAction "$INSTDIR" "${BUNDLEID}" "$PLUGINSDIR\maintenance.ini" $AstriaXOwner' $AstriaXExit
    ${If} $AstriaXExit != 0
      ReadINIStr $0 "$PLUGINSDIR\maintenance.ini" "maintenance" "error"
      MessageBox MB_ICONSTOP|MB_OK "数据维护失败，卸载已中止：$0" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
!macroend
