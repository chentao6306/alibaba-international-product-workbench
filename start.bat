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

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npm，请重新安装 Node.js。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/3] 正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 goto :failed
) else (
  echo [1/3] 项目依赖已安装。
)

echo [2/3] 正在构建系统...
call npm run build
if errorlevel 1 goto :failed

echo [3/3] 正在启动阿里巴巴国际站商品工作台...
echo 系统地址：http://127.0.0.1:8787/
echo 停止系统：在此窗口按 Ctrl+C
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:8787/"
call npm start
goto :end

:failed
echo.
echo [错误] 启动失败，请查看上方错误信息。
pause
exit /b 1

:end
endlocal
