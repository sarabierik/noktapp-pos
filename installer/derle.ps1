# ---------------------------------------------------------------------------
#  One command, one installer.
#
#  This is build.ps1 with the two checks that turn a confusing failure into a
#  sentence somebody can act on: is Node here, and did the exe actually appear.
#  Everything else it does is build.ps1's job.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "  NOKTApp POS - kurulum dosyasi derleniyor" -ForegroundColor Cyan
Write-Host ""

# --- Node ------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "  Node.js bulunamadi." -ForegroundColor Red
  Write-Host ""
  Write-Host "  https://nodejs.org adresinden LTS surumunu kurun (ileri-ileri-bitir),"
  Write-Host "  bu pencereyi kapatip DERLE.bat dosyasini tekrar calistirin."
  Write-Host ""
  exit 1
}
Write-Host ("  Node    : " + (node -v))
$v = (Get-Content (Join-Path $root 'desktop-shell\package.json') -Raw | ConvertFrom-Json).version
Write-Host ("  Surum   : " + $v)
Write-Host ""
Write-Host "  Ilk derlemede MariaDB motoru (~90 MB) ve Electron (~100 MB) indirilir;" -ForegroundColor Yellow
Write-Host "  bu bir kere olur ve 5-15 dakika surebilir. Sonraki derlemeler 1-2 dakika." -ForegroundColor Yellow
Write-Host ""

& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build.ps1')

# --- did it actually come out? ---------------------------------------------
$exe = Get-ChildItem (Join-Path $root 'dist') -Filter '*.exe' -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime | Select-Object -Last 1
Write-Host ""
if ($exe) {
  Write-Host "  HAZIR: $($exe.FullName)" -ForegroundColor Green
  Write-Host ""
  Write-Host "  Bu dosyayi cift tiklayip kurun. Mevcut $v oncesi surumun uzerine yazar;"
  Write-Host "  veritabanina dokunmaz, ayarlar ve adisyonlar oldugu gibi kalir."
  Start-Process explorer.exe "/select,`"$($exe.FullName)`""
} else {
  Write-Host "  Kurulum dosyasi olusmadi. Yukaridaki kirmizi satirlari bana gonderin." -ForegroundColor Red
}
Write-Host ""
