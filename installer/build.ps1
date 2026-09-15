# ---------------------------------------------------------------------------
#  Build the Windows installer, start to finish.
#      powershell -ExecutionPolicy Bypass -File installer\build.ps1
#  Result:  dist\NoktAppPOS-Setup-<version>.exe   (one file, nothing else needed)
# ---------------------------------------------------------------------------
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "1/5  MariaDB motoru hazirlaniyor" -ForegroundColor Cyan
powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\prepare-mariadb.ps1"

Write-Host "2/5  Servis bagimliliklari" -ForegroundColor Cyan
Set-Location "$root\pos-service"
npm install --omit=dev --no-audit --no-fund

Write-Host "3/5  Kabuk bagimliliklari" -ForegroundColor Cyan
Set-Location "$root\desktop-shell"
npm install --no-audit --no-fund

Write-Host "4/5  Kurulum dosyasi olusturuluyor" -ForegroundColor Cyan
npx electron-builder --win nsis --config electron-builder.yml --publish never

Write-Host "5/5  Tamam" -ForegroundColor Green
Set-Location $root

# electron-updater wants the sha512 base64-encoded, while Get-FileHash returns
# it as hex, so convert it here - these are the two values the panel asks for.
function Get-Sha512Base64([string]$Path) {
  $hex = (Get-FileHash -Path $Path -Algorithm SHA512).Hash
  $bytes = New-Object byte[] ($hex.Length / 2)
  for ($i = 0; $i -lt $hex.Length; $i += 2) {
    $bytes[$i / 2] = [Convert]::ToByte($hex.Substring($i, 2), 16)
  }
  return [Convert]::ToBase64String($bytes)
}

$exes = Get-ChildItem -Path (Join-Path $root 'dist') -Filter '*.exe' -ErrorAction SilentlyContinue
if (-not $exes) {
  Write-Host "Kurulum dosyasi olusmadi. Yukaridaki hatalara bakin." -ForegroundColor Red
  exit 1
}
foreach ($exe in $exes) {
  $mb = "{0:N0}" -f ($exe.Length / 1MB)
  Write-Host ""
  Write-Host ("  Dosya : " + $exe.Name)   -ForegroundColor Green
  Write-Host ("  Boyut : " + $mb + " MB  (" + $exe.Length + " byte)")
  Write-Host ("  sha512: " + (Get-Sha512Base64 $exe.FullName))
}
Write-Host ""
Write-Host "Panele yukleyin:  pos.noktapp.com/indir/  ve panelden Surumler > Yeni surum yayinla" -ForegroundColor Yellow
