@echo off
setlocal
rem PiDeckDev 一键打包（NeoNext 开发验证版 · 便携版）
rem 产物：release\PiDeckDev *.exe（免安装便携版，双击即用）
rem 与正式版完全隔离：配置目录(pi-desktop-dev)/通知 AppID 独立

cd /d "%~dp0"

rem GitHub 直连超时兜底：Electron 与构建二进制走 npmmirror 国内镜像
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

where npm >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 npm，请先安装 Node.js 并加入 PATH。
    goto :fail
)

tasklist /fi "imagename eq PiDeckDev.exe" 2>nul | find /i "PiDeckDev.exe" >nul
if not errorlevel 1 (
    echo [提示] 检测到正在运行的 PiDeckDev，请先关闭后再打包（单实例锁互斥）。
    goto :fail
)

echo.
echo [1/3] 构建代码（注入 dev 构建标记）...
set "PIDECK_DEV_BUILD=1"
call npm run build
if errorlevel 1 (
    echo.
    echo [错误] 代码构建失败，请向上翻看错误日志。
    goto :fail
)

echo.
echo [2/3] electron-builder 便携版打包...
call npx electron-builder --win portable --config.productName=PiDeckDev --config.appId=com.ayuayue.pi-desktop-dev
if errorlevel 1 (
    echo.
    echo [错误] 打包失败，请向上翻看错误日志。
    goto :fail
)

echo.
echo [3/3] 打包完成！便携版在 release\ 目录（按时间最新在前）：
dir /b /o-d "release\PiDeckDev*.exe" 2>nul
start "" explorer "release"
echo.
echo 提示：便携版双击即用、免安装；首次启动需解压，稍慢属正常。
echo       数据与 dev 模式共用 %APPDATA%\pi-desktop-dev 配置；与正式版/旧 NeoNisch 互不影响。
goto :end

:fail
echo.
pause
exit /b 1

:end
pause
exit /b 0
