@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0operator\Review-Processes.ps1"
pause
