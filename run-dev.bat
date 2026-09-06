@echo off
setlocal

rem Always run from the PiDeck project directory, even when launched by double-click.
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo [PiDeck] npm was not found. Please install Node.js and try again.
    pause
    exit /b 1
)

if not exist package.json (
    echo [PiDeck] package.json was not found in:
    echo %CD%
    pause
    exit /b 1
)

if not exist node_modules (
    echo [PiDeck] node_modules is missing. Run npm install first.
    pause
    exit /b 1
)

echo [PiDeck] Starting development mode...
call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [PiDeck] Development process exited with code %EXIT_CODE%.
    pause
)

exit /b %EXIT_CODE%
