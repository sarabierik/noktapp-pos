@echo off
REM ---------------------------------------------------------------------
REM  NOKTApp POS - build the Windows installer. Double-click this file.
REM  Result: dist\NoktAppPOS-Setup-<surum>.exe
REM ---------------------------------------------------------------------
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "installer\derle.ps1"
pause
