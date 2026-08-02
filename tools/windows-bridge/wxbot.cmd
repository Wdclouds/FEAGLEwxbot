@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0wxbot.ps1" %*
exit /b %errorlevel%
