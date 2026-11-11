@echo off
setlocal
set "AM4_FORECAST_SCRIPT=%~dp0harness\forecast-command.mjs"
where node.exe >nul 2>nul
if not errorlevel 1 (
  node.exe "%AM4_FORECAST_SCRIPT%" --watch %*
) else if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "%AM4_FORECAST_SCRIPT%" --watch %*
) else (
  echo Node.js 24 or later is required. Install Node.js and try again.
  exit /b 1
)
endlocal
