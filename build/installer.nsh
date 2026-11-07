; Check the actual application image, never the installation directory prefix.
; The stock check can include installers/uninstallers and depends on shell setup.
; Keep running applications intact: the user must close them so pending data saves.
!macro customCheckAppRunning
  !define FL_CHECK_LABEL ${__LINE__}
  Push $R0
  Push $R1
  Push $R2
  chaodekuai_check_${FL_CHECK_LABEL}:
    nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ClearErrors
    FileOpen $R1 "$TEMP\抄得快-setup-${VERSION}.log" a
    IfErrors chaodekuai_logged_${FL_CHECK_LABEL}
    FileSeek $R1 0 END
    FileWrite $R1 "process-check image=${APP_EXECUTABLE_FILENAME} result=$R0 install=$INSTDIR$\r$\n"
    FileClose $R1
  chaodekuai_logged_${FL_CHECK_LABEL}:
    ${If} $R0 == 603
      Goto chaodekuai_ready_${FL_CHECK_LABEL}
    ${ElseIf} $R0 == 0
      StrCpy $R2 "检测到 抄得快.exe 仍在运行。请退出抄得快，等待数据保存完成后点击重试。$\r$\n安装程序不会强制终止正在保存数据的进程。"
      SetErrorLevel 1618
    ${Else}
      StrCpy $R2 "无法检查 抄得快 进程，检测返回码：$R0。$\r$\n尚未更改安装文件。请重试，或查看临时目录中的 抄得快-setup-${VERSION}.log。"
      SetErrorLevel 1603
    ${EndIf}
    ${If} ${Silent}
      Goto chaodekuai_cancel_${FL_CHECK_LABEL}
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$R2" /SD IDCANCEL IDRETRY chaodekuai_check_${FL_CHECK_LABEL}
  chaodekuai_cancel_${FL_CHECK_LABEL}:
    nsProcess::_Unload
    Pop $R2
    Pop $R1
    Pop $R0
    Quit
  chaodekuai_ready_${FL_CHECK_LABEL}:
    nsProcess::_Unload
    !ifndef BUILD_UNINSTALLER
      ; Check the final wizard directory BEFORE uninstallOldVersion.
      Push $R3
      Push $R4
      ReadEnvStr $R3 "CHAODEKUAI_SETUP_BOOTSTRAP"
      ReadEnvStr $R4 "CHAODEKUAI_SETUP_WORK"
      StrCpy $R0 1603
      ${If} $R3 != ""
      ${AndIf} $R4 != ""
        ExecWait '"$R3" /preflight "$INSTDIR" "$R4"' $R0
      ${EndIf}
      Pop $R4
      Pop $R3
      ${If} $R0 != 0
        SetErrorLevel $R0
        Pop $R2
        Pop $R1
        Pop $R0
        Quit
      ${EndIf}
    !endif
    ClearErrors
    SetErrorLevel 0
    Pop $R2
    Pop $R1
    Pop $R0
  !undef FL_CHECK_LABEL
!macroend

!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro customInstall
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  StrCpy $launchLink "$appExe"
  Push $R0
  Push $R1
  Push $R2
  ReadEnvStr $R1 "CHAODEKUAI_SETUP_BOOTSTRAP"
  ReadEnvStr $R2 "CHAODEKUAI_SETUP_WORK"
  StrCpy $R0 1603
  ${If} $R1 != ""
  ${AndIf} $R2 != ""
    ExecWait '"$R1" /verify "$INSTDIR" "$R2"' $R0
  ${EndIf}
  ${If} $R0 != 0
    SetErrorLevel $R0
    Pop $R2
    Pop $R1
    Pop $R0
    Quit
  ${EndIf}
  Pop $R2
  Pop $R1
  ClearErrors
  FileOpen $R0 "$TEMP\抄得快-setup-${VERSION}.log" a
  IfErrors chaodekuai_install_log_done
  FileSeek $R0 0 END
  FileWrite $R0 "install-complete version=${VERSION} directory=$INSTDIR$\r$\n"
  FileClose $R0
  chaodekuai_install_log_done:
  Pop $R0
  ClearErrors
!macroend

!macro customUnInstall
  Delete "$newDesktopLink"
  Delete "$newStartMenuLink"
!macroend
