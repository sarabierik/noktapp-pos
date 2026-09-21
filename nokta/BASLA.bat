@echo off
REM NOKTA - cift tiklayin.
REM
REM KUR.ps1'i calistirir: Android/iOS iskeletini uretir, elle yazilmis
REM manifest ve ikonu geri koyar, paketleri indirir, kodu kontrol eder ve
REM sinamalari calistirir. Bir kere calistirmak yeter; sonrasinda klasoru
REM Android Studio'da acabilirsiniz.
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0KUR.ps1"
echo.
pause
