<#
  NOKTA - prepare the project, then run it.

      .\KUR.ps1

  What it does, and why each step is here:

  flutter create ONLY WRITES FILES THAT ARE MISSING. It will not overwrite an
  existing build.gradle.kts, so anything a previous run left in that file
  survives every "recreate" and the second run cheerfully reports "Wrote 3
  files" while the broken one sits there untouched. Deleting the generated
  Gradle files first is what actually makes this regenerate them.

  The manifest and res/ are OURS - hand written, with the NOKTA icon and the
  dark launch plate in them. flutter create would replace both with the stock
  template and Flutter's blue icon, so they are copied out first and put back
  afterwards.
#>
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Fail($m) { Write-Host "`n  HATA: $m`n" -ForegroundColor Red; exit 1 }

if (-not (Test-Path 'pubspec.yaml')) { Fail 'Bu dosyayi proje klasorunde calistirin (pubspec.yaml yaninda).' }

Step 1 "Elle yazilmis manifest ve ikon yedekleniyor"
Copy-Item 'android\app\src\main\AndroidManifest.xml' 'AndroidManifest.backup.xml' -Force
if (Test-Path 'res.backup') { Remove-Item 'res.backup' -Recurse -Force }
Copy-Item 'android\app\src\main\res' 'res.backup' -Recurse -Force

Step 2 "Android/iOS projesi uretiliyor"
foreach ($f in @(
    'android\app\build.gradle.kts', 'android\app\build.gradle',
    'android\build.gradle.kts', 'android\build.gradle',
    'android\settings.gradle.kts', 'android\settings.gradle')) {
  if (Test-Path $f) { Remove-Item $f -Force }
}
flutter create --org com.noktapp --project-name nokta --platforms=android,ios .
if ($LASTEXITCODE -ne 0) { Fail 'flutter create basarisiz. Yukaridaki hatayi gonderin.' }

Step 3 "Manifest ve ikon geri konuyor"
Copy-Item 'AndroidManifest.backup.xml' 'android\app\src\main\AndroidManifest.xml' -Force
Copy-Item 'res.backup\*' 'android\app\src\main\res' -Recurse -Force
Remove-Item 'AndroidManifest.backup.xml' -Force
Remove-Item 'res.backup' -Recurse -Force

Step 4 "Paketler indiriliyor"
flutter pub get
if ($LASTEXITCODE -ne 0) { Fail 'flutter pub get basarisiz.' }

Step 5 "Kod kontrol ediliyor"
flutter analyze --no-fatal-infos
if ($LASTEXITCODE -ne 0) {
  Write-Host "`n  flutter analyze hata buldu. Yukaridaki satirlari oldugu gibi gonderin -" -ForegroundColor Yellow
  Write-Host "  bu makinede Flutter SDK'si olmadan yazildi, derleyici ilk kez burada konusuyor.`n" -ForegroundColor Yellow
  exit 1
}

Step 6 "Sinamalar calistiriliyor"
# Ucuz ve erken: uygulamanin acilip acilmadigini ve kart/kod/fiyat
# hesaplarini kontrol eder. Bir misafirin yanlis SAYI gorecegi yerler bunlar.
flutter test
if ($LASTEXITCODE -ne 0) {
  Write-Host "`n  Sinama basarisiz. Yukaridaki satirlari oldugu gibi gonderin.`n" -ForegroundColor Yellow
  exit 1
}

Write-Host "`nHazir." -ForegroundColor Green
Write-Host "  Telefonu USB ile bagla, sonra:  flutter run"
Write-Host "  Play Store paketi icin:         .\YAYIN.ps1"
Write-Host ""
