<#
  NOKTApp Garson - prepare the project, then build.

  Run it from the project folder, in the Android Studio terminal or any
  PowerShell window:

      .\KUR.ps1

  It does what BASLA.md describes, but as PowerShell rather than cmd - the
  Android Studio terminal is PowerShell, where `copy /Y` is Copy-Item and does
  not take /Y at all.
#>

$ErrorActionPreference = 'Stop'

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }

if (-not (Test-Path 'pubspec.yaml')) {
  Write-Host "Run this from the project folder - the one with pubspec.yaml in it." -ForegroundColor Red
  exit 1
}

Step 1 "Keeping the hand-written manifest and the icon safe"
Copy-Item 'android\app\src\main\AndroidManifest.xml' 'AndroidManifest.backup.xml' -Force
if (Test-Path 'res.backup') { Remove-Item 'res.backup' -Recurse -Force }
Copy-Item 'android\app\src\main\res' 'res.backup' -Recurse -Force

Step 2 "Generating the Android project (Gradle, MainActivity)"
# flutter create writes a stock manifest and Flutter's own blue icon; step 3
# puts ours back over the top.
flutter create --org com.noktapp --platforms=android .
if ($LASTEXITCODE -ne 0) { Write-Host "flutter create failed - read the error above." -ForegroundColor Red; exit 1 }

Step 3 "Putting our manifest and icon back"
Copy-Item 'AndroidManifest.backup.xml' 'android\app\src\main\AndroidManifest.xml' -Force
Copy-Item 'res.backup\*' 'android\app\src\main\res' -Recurse -Force

Step 4 "Downloading packages"
flutter pub get
if ($LASTEXITCODE -ne 0) { Write-Host "flutter pub get failed." -ForegroundColor Red; exit 1 }

Write-Host "`nReady." -ForegroundColor Green
Write-Host "  In Android Studio: press Run."
Write-Host "  Or from here:      flutter build apk --release"
Write-Host ""
