<#
  NOKTApp Garson - Play Store ekran goruntusu alma

      .\EKRAN.ps1

  Telefon USB ile bagli olmali ve USB hata ayiklama acik olmali.
  Uygulamayi telefonda acin. Script her adimda hangi ekrani istedigini
  soyler; o ekrana gelip ENTER'a basarsiniz, goruntu PC'ye iner.

  Dosyalar: play-grafik\ekran\  klasorune kaydedilir.
#>
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# adb'yi bul
$adb = $null
foreach ($y in @(
    "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
    "$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe",
    "C:\Android\Sdk\platform-tools\adb.exe")) {
  if (Test-Path $y) { $adb = $y; break }
}
if (-not $adb) {
  $c = Get-Command adb -ErrorAction SilentlyContinue
  if ($c) { $adb = $c.Source }
}
if (-not $adb) {
  Write-Host "adb bulunamadi. Android Studio kuruluysa genelde burada olur:" -ForegroundColor Red
  Write-Host "  $env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
  exit 1
}

$cihazlar = & $adb devices | Select-String -Pattern "\sdevice$"
if (-not $cihazlar) {
  Write-Host "Telefon gorunmuyor." -ForegroundColor Red
  Write-Host "  - USB kablosunu takin"
  Write-Host "  - Telefonda 'USB hata ayiklama' acik olsun"
  Write-Host "  - Telefonda cikan 'Bu bilgisayara izin ver' sorusuna Izin Ver deyin"
  exit 1
}
Write-Host "Telefon bagli." -ForegroundColor Green

$klasor = 'play-grafik\ekran'
New-Item -ItemType Directory -Force -Path $klasor | Out-Null

$ekranlar = @(
  @{ ad = '1-masalar';   tarif = 'MASA LISTESI - birkac masa dolu olsun, tutarlari gorunsun' },
  @{ ad = '2-urun-ekle'; tarif = 'URUN EKLE sekmesi - solda kategoriler, sagda urunler' },
  @{ ad = '3-adisyon';   tarif = 'ADISYON sekmesi - icinde birkac urun olan bir adisyon' },
  @{ ad = '4-islemler';  tarif = 'ISLEMLER sekmesi' },
  @{ ad = '5-etiket';    tarif = 'MASA ETIKETI - baslikta masa adina dokunun, etiket penceresi acilsin' }
)

$i = 0
foreach ($e in $ekranlar) {
  $i++
  Write-Host ""
  Write-Host "[$i/5] $($e.tarif)" -ForegroundColor Cyan
  Read-Host "      Telefonda bu ekrani acin, sonra ENTER"

  & $adb shell screencap -p /sdcard/noktapp-ekran.png
  & $adb pull /sdcard/noktapp-ekran.png "$klasor\$($e.ad).png" | Out-Null
  & $adb shell rm /sdcard/noktapp-ekran.png

  if (Test-Path "$klasor\$($e.ad).png") {
    $kb = [int]((Get-Item "$klasor\$($e.ad).png").Length / 1KB)
    Write-Host "      alindi: $($e.ad).png  ($kb KB)" -ForegroundColor Green
  } else {
    Write-Host "      ALINAMADI" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Bitti. Dosyalar:" -ForegroundColor Green
Get-ChildItem $klasor -Filter *.png | ForEach-Object { Write-Host "  $($_.Name)" }
Write-Host ""
Write-Host "Simdi bana haber verin - boyutlarini Play Store'un istedigi olcuye getirip" -ForegroundColor Yellow
Write-Host "yuklemeye hazir halde geri yazacagim." -ForegroundColor Yellow
Start-Process explorer.exe (Resolve-Path $klasor).Path
