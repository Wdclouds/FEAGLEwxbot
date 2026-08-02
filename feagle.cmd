@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0feagle.ps1" %*
exit /b %errorlevel%
