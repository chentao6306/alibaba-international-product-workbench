@echo off
setlocal

set "PACKAGE_DIR=%~dp0"
set "LOCAL_TEMP=%PACKAGE_DIR%installer-temp"
if not exist "%LOCAL_TEMP%" mkdir "%LOCAL_TEMP%" >nul 2>&1
if not exist "%LOCAL_TEMP%" (
  echo Cannot create installer temp folder: %LOCAL_TEMP%
  echo Copy the package to a writable drive with enough free space and retry.
  pause
  exit /b 1
)

set "TEMP=%LOCAL_TEMP%"
set "TMP=%LOCAL_TEMP%"
start "Chaodekuai installer" "%PACKAGE_DIR%chaodekuai-1.2.23-setup.exe"
endlocal
