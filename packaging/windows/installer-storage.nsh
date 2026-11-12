# Adapted from sourcepro5/WeChatAgent (MIT), commit 38c1060ce500a294d69a4a2f9e07ca1b63a08b06.
# Modified for WeChatBot: safe owned-file removal and no shell/process killing.
!include LogicLib.nsh
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TEXT "将卸载 WeChatBot 的程序文件。配置、人格、插件、记忆、音乐及同级 data 数据目录会保留，已连接的微信和 DSH 不会被卸载。$\r$\n$\r$\n请先保存设置，并从托盘完整退出 WeChatBot，再继续卸载。"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\WeChatBot-maintenance.exe "${WCG_HELPER}"
  wcg_check_running:
    ClearErrors
    ExecWait '"$PLUGINSDIR\WeChatBot-maintenance.exe" --check-running "$INSTDIR"' $0
    ${If} ${Errors}
      StrCpy $0 11
    ${EndIf}
    ${If} $0 != 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "请保存设置，从托盘完整退出此位置的 WeChatBot，再点击重试。程序不会强制结束应用或丢弃未保存内容。" /SD IDCANCEL IDRETRY wcg_check_running
      SetErrorLevel 2
      Quit
    ${EndIf}
!macroend

!ifdef BUILD_UNINSTALLER
  !include "${WCG_REMOVE_FILES}"
!else
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!include MUI2.nsh
!insertmacro MUI_DIRECTORYPAGE_INTERFACE
!include LogicLib.nsh
!include FileFunc.nsh

Var WcaDataHome
Var WcaMigrationSource
Var WcaRoot
Var WcaProgram
Var WcaPreviousProgram
Var WcaRememberedDataHome
Var WcaStorageError
Var WcaMigrate
Var WcaLegacyRoot

!macro customInit
  ReadRegStr $WcaPreviousProgram HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCpy $WcaLegacyRoot ""
  ${If} $WcaPreviousProgram == ""
    ReadRegStr $WcaLegacyRoot HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WeChatBot" "InstallLocation"
    ${If} $WcaLegacyRoot == ""
      ReadRegStr $WcaLegacyRoot HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WeChatAgent" "InstallLocation"
    ${EndIf}
    ${If} ${FileExists} "$WcaLegacyRoot\app\WeChatBot.exe"
    ${OrIf} ${FileExists} "$WcaLegacyRoot\app\WeChatAgent.exe"
      StrCpy $WcaPreviousProgram "$WcaLegacyRoot\app"
      !insertmacro GetDParameter $0
      ${If} $0 == ""
        StrCpy $INSTDIR $WcaPreviousProgram
      ${EndIf}
    ${Else}
      StrCpy $WcaLegacyRoot ""
    ${EndIf}
  ${EndIf}
  ReadRegStr $WcaDataHome HKCU "Software\WeChatAgent" "DataHome"
  ReadRegStr $0 HKCU "Software\WeChatBot" "DataHome"
  ${If} $0 != ""
    StrCpy $WcaDataHome $0
  ${EndIf}
  ReadINIStr $1 "$WcaPreviousProgram\storage.ini" "Storage" "dataHome"
  ${If} $1 != ""
    StrCpy $WcaDataHome $1
  ${EndIf}
  ReadINIStr $1 "$INSTDIR\storage.ini" "Storage" "dataHome"
  ${If} $1 != ""
    StrCpy $WcaDataHome $1
  ${EndIf}
  StrCpy $WcaMigrationSource $WcaDataHome
  ${If} $WcaMigrationSource == ""
    StrCpy $WcaMigrationSource "$APPDATA\WeChatAgent"
  ${EndIf}
  ${IfNot} ${FileExists} "$WcaMigrationSource\workspace\config\wechatagent.json"
    ReadINIStr $1 "$INSTDIR\storage.ini" "Storage" "migrationSource"
    ${If} $1 == ""
      ReadINIStr $1 "$WcaPreviousProgram\storage.ini" "Storage" "migrationSource"
    ${EndIf}
    ${If} $1 != ""
      StrCpy $WcaMigrationSource $1
    ${Else}
      StrCpy $WcaMigrationSource "$APPDATA\WeChatAgent"
    ${EndIf}
  ${EndIf}
  # Refuse a legacy layout whose own uninstaller would delete the source.
  ${If} ${FileExists} "$WcaMigrationSource\workspace\config\wechatagent.json"
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $0 != ""
      StrCpy $0 "$0\"
      StrLen $1 $0
      StrCpy $2 "$WcaMigrationSource\" $1
      ${If} $0 == $2
        MessageBox MB_ICONSTOP "旧版数据位于旧程序目录内，请先备份到程序目录之外，再继续安装。"
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
  StrCpy $WcaMigrate "1"
  StrCpy $WcaRememberedDataHome $WcaDataHome
  # The only directory page edits WcaRoot, never the app directory.
  StrCpy $WcaRoot $INSTDIR
  ReadINIStr $0 "$INSTDIR\storage.ini" "Storage" "layoutVersion"
  ${If} $0 == "1"
    ${GetParent} "$INSTDIR" $WcaRoot
  ${ElseIf} $INSTDIR == $WcaPreviousProgram
  ${AndIf} $WcaRememberedDataHome != ""
    ${GetFileName} "$INSTDIR" $0
    ${If} $0 == "app"
      ${GetParent} "$INSTDIR" $WcaRoot
    ${EndIf}
  ${EndIf}
  ${If} ${Silent}
    Call WcaStoragePreInstall
  ${EndIf}
  ClearErrors
!macroend

Function WcaNormalizeDirectory
  Exch $0
  Push $1
  Push $2
  # Unlike NSIS GetFullPathName, this also resolves not-yet-created folders.
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r1, p 0)i.r2'
  ${If} $2 == 0
  ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
    StrCpy $0 ""
  ${Else}
    StrCpy $0 $1
    ${GetRoot} "$0" $1
    ${If} $0 != $1
    ${AndIf} $0 != "$1\"
      wca_trim_separator:
      StrCpy $2 $0 1 -1
      ${If} $2 == "\"
        StrCpy $0 $0 -1
        Goto wca_trim_separator
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

Function WcaSelectStoragePaths
  Push "$WcaRoot"
  Call WcaNormalizeDirectory
  Pop $WcaRoot
  StrCpy $WcaProgram "$WcaRoot\app"
  # Reinstalling a known app preserves its separately selected data path.
  # A different root always starts with that root's own data directory.
  ReadINIStr $0 "$WcaProgram\storage.ini" "Storage" "dataHome"
  ${If} $0 != ""
    StrCpy $WcaDataHome $0
  ${ElseIf} $WcaProgram == $WcaPreviousProgram
  ${AndIf} $WcaRememberedDataHome != ""
    StrCpy $WcaDataHome $WcaRememberedDataHome
  ${Else}
    StrCpy $WcaDataHome "$WcaRoot\data"
  ${EndIf}
FunctionEnd

Function WcaStorageLeave
  # NSIS commits DirVar after this callback; read the current edit control.
  StrCpy $0 $mui.DirectoryPage.Directory
  System::Call 'user32::GetWindowTextW(p r0, w .r1, i ${NSIS_MAX_STRLEN})i.r2'
  StrCpy $WcaRoot $1
  Call WcaPrepareStorage
  ${If} $WcaStorageError != ""
    MessageBox MB_ICONEXCLAMATION "$WcaStorageError"
    Abort
  ${EndIf}
FunctionEnd

Function WcaStoragePreInstall
  Call WcaPrepareStorage
  ${If} $WcaStorageError != ""
    MessageBox MB_ICONSTOP "$WcaStorageError" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd

Function WcaPrepareStorage
  StrCpy $WcaStorageError ""
  ${If} $WcaRoot == ""
    StrCpy $WcaStorageError "请选择安装文件夹。"
    Return
  ${EndIf}
  Call WcaSelectStoragePaths
  ${GetRoot} "$WcaRoot" $0
  ${If} $WcaRoot == $0
  ${OrIf} $WcaRoot == "$0\"
    StrCpy $WcaStorageError "请选择一个安装文件夹，不能直接使用磁盘根目录。"
    Return
  ${EndIf}
  Push "$WcaDataHome"
  Call WcaNormalizeDirectory
  Pop $WcaDataHome
  ${GetRoot} "$WcaDataHome" $0
  ${If} $WcaDataHome == $0
  ${OrIf} $WcaDataHome == "$0\"
    StrCpy $WcaStorageError "旧版数据位置不能是磁盘根目录，请先备份到独立文件夹。"
    Return
  ${EndIf}
  # Compare case-insensitively, including a trailing separator boundary.
  StrCpy $0 "$WcaProgram\"
  StrCpy $1 "$WcaDataHome\"
  StrLen $2 $0
  StrCpy $3 $1 $2
  ${If} $3 == $0
    StrCpy $WcaStorageError "数据不能放在 app 程序目录中，否则卸载时可能被删除。"
    Return
  ${EndIf}
  ${If} $WcaMigrate == "1"
  ${AndIf} $WcaDataHome != $WcaMigrationSource
    StrCpy $0 "$WcaMigrationSource\"
    StrLen $2 $0
    StrCpy $3 $1 $2
    ${If} $3 == $0
      StrCpy $WcaStorageError "新旧数据目录不能互相包含，请选择旧目录之外的安装位置。"
      Return
    ${EndIf}
    StrLen $2 $1
    StrCpy $3 $0 $2
    ${If} $3 == $1
      StrCpy $WcaStorageError "新旧数据目录不能互相包含，请选择旧目录之外的安装位置。"
      Return
    ${EndIf}
  ${EndIf}
  StrCpy $0 "$WcaProgram\"
  StrLen $2 $1
  StrCpy $3 $0 $2
  ${If} $3 == $1
    StrCpy $WcaStorageError "程序目录与数据目录不能互相包含。"
    Return
  ${EndIf}
  # Existing data under a legacy install directory would be deleted by its
  # old uninstaller before extraction. Refuse that target; never move it here.
  ${If} ${FileExists} "$WcaDataHome\workspace\config\wechatagent.json"
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $0 != ""
      StrCpy $0 "$0\"
      StrLen $2 $0
      StrCpy $3 $1 $2
      ${If} $3 == $0
        StrCpy $WcaStorageError "该数据位于旧程序目录内，旧版卸载可能删除它。请先备份并选择程序目录外的位置。"
        Return
      ${EndIf}
    ${EndIf}
  ${EndIf}
  # Probe writability before uninstalling anything; leave no test file behind.
  StrCpy $4 "0"
  ${IfNot} ${FileExists} "$WcaDataHome\*.*"
    StrCpy $4 "1"
  ${EndIf}
  ClearErrors
  CreateDirectory "$WcaDataHome"
  GetTempFileName $5 "$WcaDataHome"
  ${If} ${Errors}
    StrCpy $WcaStorageError "无法写入数据目录，请选择当前用户可写的安装位置。"
    Return
  ${EndIf}
  Delete "$5"
  ${If} $4 == "1"
    RMDir "$WcaDataHome"
  ${EndIf}
  StrCpy $INSTDIR $WcaProgram
FunctionEnd

!macro customInstall
  # Force Unicode INI output; an ANSI INI would corrupt Chinese paths.
  ClearErrors
  FileOpen $0 "$INSTDIR\storage.ini" w
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "无法保存数据位置，安装未完成。请检查程序目录权限。"
    Abort
  ${EndIf}
  FileWriteUTF16LE /BOM $0 "[Storage]$\r$\n"
  FileClose $0
  WriteINIStr "$INSTDIR\storage.ini" "Storage" "layoutVersion" "1"
  WriteINIStr "$INSTDIR\storage.ini" "Storage" "dataHome" "$WcaDataHome"
  ${If} $WcaMigrate == "1"
    WriteINIStr "$INSTDIR\storage.ini" "Storage" "migrationSource" "$WcaMigrationSource"
  ${Else}
    WriteINIStr "$INSTDIR\storage.ini" "Storage" "migrationSource" ""
  ${EndIf}
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "无法保存数据位置，安装未完成。原数据未删除。"
    Abort
  ${EndIf}
  WriteRegStr HKCU "Software\WeChatBot" "DataHome" "$WcaDataHome"
  # Remove the old console uninstaller only after successful migration at the same root.
  ${If} $WcaLegacyRoot == $WcaRoot
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WeChatBot" "InstallLocation"
    ${If} $0 == $WcaRoot
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WeChatBot"
      Delete "$WcaRoot\uninstall.exe"
      Delete "$WcaProgram\uninstall.exe"
    ${EndIf}
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WeChatAgent" "InstallLocation"
    ${If} $0 == $WcaRoot
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WeChatAgent"
    ${EndIf}
    Delete "$WcaRoot\Start-WeChatBot.cmd"
  ${EndIf}
!macroend
!endif
