@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js and restart this script.
  pause
  exit /b 1
)
if not exist "node_modules\ws\package.json" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Installation failed. Check your network connection and try again.
    pause
    exit /b 1
  )
)
if not defined PORT set "PORT=3000"
echo Starting RIVER on port %PORT%...
echo Keep this window open. Press Ctrl+C to stop.
set "RIVER_OPEN_BROWSER=1"
call npm start
if errorlevel 1 (
  echo The server stopped with an error. Read the message above.
  pause
)
endlocal
