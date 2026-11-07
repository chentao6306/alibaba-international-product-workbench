@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未安装 Node.js，请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 goto :failed
)

echo 正在启动开发模式...
echo 开发页面：http://127.0.0.1:5173/
echo 停止系统：在此窗口按 Ctrl+C
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:5173/"
call npm run dev
goto :end

:failed
echo.
echo [错误] 启动失败，请查看上方错误信息。
pause
exit /b 1

:end
endlocal
