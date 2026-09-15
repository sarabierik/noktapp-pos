@echo off
REM ===========================================================================
REM  NoktApp POS - kurulum dosyasini olusturur.
REM  Cift tiklayin. Baska hicbir sey yapmaniza gerek yok.
REM ===========================================================================
chcp 65001 >nul
title NoktApp POS - kurulum dosyasi olusturuluyor
cd /d "%~dp0"

echo.
echo   NoktApp POS
echo   ============================================================
echo   Bu pencere kurulum dosyasini (.exe) olusturur.
echo   Ilk calistirmada 10-15 dakika surer, sonrakilerde 2 dakika.
echo.

REM --- yonetici hakki gerekiyor mu diye bak ---------------------------------
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo   [!] Bu dosyayi SAG TIKLAYIP "Yonetici olarak calistir" secin.
  echo.
  pause
  exit /b 1
)

REM --- Node.js var mi? -----------------------------------------------------
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo   Node.js bulunamadi, kuruluyor...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if %errorlevel% neq 0 (
    echo.
    echo   [!] Node.js kurulamadi. https://nodejs.org adresinden LTS surumunu
    echo       kurup bu dosyayi tekrar calistirin.
    echo.
    pause
    exit /b 1
  )
  REM winget yeni PATH'i bu pencereye vermez, tazeleyelim
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODEV=%%v
echo   Node.js: %NODEV%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\build.ps1"
set BUILDRC=%errorlevel%

echo.
if %BUILDRC% neq 0 (
  echo   [!] Kurulum dosyasi olusturulamadi. Yukaridaki hatayi bize gonderin:
  echo       destek@noktapp.com
  echo.
  pause
  exit /b %BUILDRC%
)

echo   ============================================================
echo   Tamam. Kurulum dosyasi "dist" klasorunde.
echo   ============================================================
echo.
if exist "%~dp0dist" start "" "%~dp0dist"
pause
