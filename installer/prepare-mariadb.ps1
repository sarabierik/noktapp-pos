# ---------------------------------------------------------------------------
#  Run this ONCE on the build machine.
#  It downloads the MariaDB zip, throws away everything the till does not need
#  (tests, docs, client libraries, embedded server) and leaves a ~90 MB folder
#  at vendor\mariadb which the installer then carries inside itself.
#  After this, building the installer needs no internet at all.
# ---------------------------------------------------------------------------
param(
  [string]$Version = "10.11.9",
  [string]$Root    = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = "Stop"
$vendor = Join-Path $Root "vendor"
$target = Join-Path $vendor "mariadb"
$zip    = Join-Path $env:TEMP "mariadb-$Version-winx64.zip"

if (Test-Path (Join-Path $target "bin\mariadbd.exe")) {
  Write-Host "MariaDB motoru zaten hazir: $target" -ForegroundColor Green
  exit 0
}

New-Item -ItemType Directory -Force -Path $vendor | Out-Null

# Already downloaded once into another build folder? Copy it across instead of
# pulling 90 MB again. Saves ten minutes on every fresh extract.
$parent = Split-Path -Parent $Root
if (Test-Path $parent) {
  $found = Get-ChildItem $parent -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'vendor\mariadb' } |
    Where-Object { Test-Path (Join-Path $_ 'bin\mariadbd.exe') } |
    Select-Object -First 1
  if ($found) {
    Write-Host "Mevcut MariaDB motoru bulundu, kopyalaniyor: $found" -ForegroundColor Green
    Copy-Item $found $target -Recurse -Force
    Write-Host "Hazir: $target" -ForegroundColor Green
    exit 0
  }
}

$url = "https://archive.mariadb.org/mariadb-$Version/winx64-packages/mariadb-$Version-winx64.zip"
Write-Host "Indiriliyor: $url"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

Write-Host "Aciliyor..."
$tmp = Join-Path $env:TEMP "mariadb-extract"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$src = Get-ChildItem $tmp -Directory | Select-Object -First 1

Write-Host "Gereksiz dosyalar temizleniyor..."
foreach ($d in @("include","lib\plugin\debug","sql-bench","mysql-test","COPYING*","*.md","docs","scripts")) {
  $p = Join-Path $src.FullName $d
  if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
# only the binaries the product actually starts
$keepBin = @("mariadbd.exe","mariadb.exe","mariadb-dump.exe","mariadb-install-db.exe",
             "mariadb-admin.exe","mariadb-check.exe","mariadbd.pdb")
Get-ChildItem (Join-Path $src.FullName "bin") -File | Where-Object { $keepBin -notcontains $_.Name } |
  Remove-Item -Force -ErrorAction SilentlyContinue

if (Test-Path $target) { Remove-Item $target -Recurse -Force }
Move-Item $src.FullName $target

$size = "{0:N0}" -f ((Get-ChildItem $target -Recurse | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "Hazir: $target  ($size MB)" -ForegroundColor Green
