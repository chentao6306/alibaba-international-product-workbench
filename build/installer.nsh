!macro customInstall
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  StrCpy $launchLink "$appExe"
!macroend

!macro customUnInstall
  Delete "$newDesktopLink"
  Delete "$newStartMenuLink"
!macroend
