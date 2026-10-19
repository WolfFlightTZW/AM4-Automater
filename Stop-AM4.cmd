@echo off
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0operator\AM4-Operator.ps1" -Action Pause
