@echo off
setlocal

title PiDeck Dev
cd /d "%~dp0"

call npm run dev

if errorlevel 1 (
  echo.
  echo PiDeck dev exited with an error.
  pause
)

endlocal
