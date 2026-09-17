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
<#
  flutter create ONLY WRITES FILES THAT ARE MISSING.
  It does not overwrite an existing build.gradle.kts, so anything a previous
  run - or a previous version of YAYIN.ps1 - put in that file survives every
  "Recreating project" you do, and the second run quietly writes "Wrote 3
  files" while the broken one sits there untouched. Deleting the generated
  Gradle files first is what actually makes this step regenerate them.
  The manifest and res/ are ours and are already backed up in step 1.
#>
foreach ($f in @(
    'android\app\build.gradle.kts', 'android\app\build.gradle',
    'android\app\build.gradle.kts.noktapp-yedek', 'android\app\build.gradle.noktapp-yedek',
    'android\build.gradle.kts', 'android\build.gradle',
    'android\settings.gradle.kts', 'android\settings.gradle')) {
  if (Test-Path $f) { Remove-Item $f -Force }
}
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
