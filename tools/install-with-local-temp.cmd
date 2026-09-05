@echo off
setlocal

set "PACKAGE_DIR=%~dp0"
set "LOCAL_TEMP=%PACKAGE_DIR%installer-temp"
if not exist "%LOCAL_TEMP%" mkdir "%LOCAL_TEMP%" >nul 2>&1
if not exist "%LOCAL_TEMP%" (
  echo 无法创建安装临时目录：%LOCAL_TEMP%
  echo 请把安装包复制到有写入权限且有足够空间的磁盘后重试。
  pause
  exit /b 1
)

set "TEMP=%LOCAL_TEMP%"
set "TMP=%LOCAL_TEMP%"
start "抄得快安装" "%PACKAGE_DIR%chaodekuai-1.2.23-setup.exe"
endlocal
