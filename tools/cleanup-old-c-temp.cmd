@echo off
setlocal
set "TEMP_ROOT=%LOCALAPPDATA%\Temp"

echo 正在清理已确认的旧安装解压残留...
for %%N in (nssA7C3.tmp nsj34BC.tmp nsb5F9E.tmp nsjF786.tmp) do (
  if exist "%TEMP_ROOT%\%%N" rmdir /s /q "%TEMP_ROOT%\%%N" 2>nul
  if exist "%TEMP_ROOT%\%%N" del /f /q "%TEMP_ROOT%\%%N" 2>nul
)

for %%N in (kyp-collector-test-1788227211569 kyp-feature-1788226033706 kyp-feature-collect-1788227735380 kyp-probe-1788222407130 kyp-feature-1788226325821 kyp-feature-1788226360345 kyp-integration-1788222839964 kyp-probe-1788220986154 kyp-probe-1788221388120 kyp-probe-1788221326590 kyp-probe-1788221445830 kyp-probe-1788221153526 kua-yipu-window-test-1788016088875 electron-download-kQKhEP chaodekuai-source-J5win8) do (
  if exist "%TEMP_ROOT%\%%N" rmdir /s /q "%TEMP_ROOT%\%%N" 2>nul
)

echo 清理完成。建议重新启动电脑后再运行安装程序。
pause
endlocal
