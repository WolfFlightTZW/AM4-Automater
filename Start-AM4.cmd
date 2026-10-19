@echo off
set "AM4_START=%~dp0Start-AM4.ps1"
powershell.exe -NoProfile -WindowStyle Hidden -Command "$am4Args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',([char]34+$env:AM4_START+[char]34),'-Resume');Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList $am4Args"
