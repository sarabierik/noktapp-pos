<#
  NOKTApp Garson - Play Store yayin paketi (.aab)

      .\YAYIN.ps1

  Ne yapar:
    1. Imza anahtarini bulur; yoksa olusturur (sifreyi SIZ yazarsiniz).
    2. flutter create ile uretilen Android projesini yayina hazirlar:
       applicationId, imza ayarlari, minify.
    3. app-release.aab dosyasini uretir ve nerede oldugunu soyler.

  ONEMLI - ANAHTARI KAYBETMEYIN.
  Play Store'a yuklediginiz ilk .aab bu anahtarla imzalanir. Anahtari
  kaybederseniz uygulamayi BIR DAHA guncelleyemezsiniz; yeni bir uygulama
  acmaniz gerekir. Dosyayi ve sifresini yedekleyin:
      %USERPROFILE%\noktapp-garson-upload.jks
#>
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function Step($n,$t){ Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Fail($m){ Write-Host "`n  HATA: $m`n" -ForegroundColor Red; exit 1 }

if (-not (Test-Path 'pubspec.yaml')) { Fail 'Bu dosyayi proje klasorunde calistirin.' }
if (-not (Test-Path 'android\app\build.gradle') -and -not (Test-Path 'android\app\build.gradle.kts')) {
  Fail 'Once .\KUR.ps1 calistirin - Android projesi henuz uretilmemis.'
}

# --- 1. imza anahtari ------------------------------------------------------
$ks = Join-Path $env:USERPROFILE 'noktapp-garson-upload.jks'
$props = Join-Path $root 'android\key.properties'

if (-not (Test-Path $ks)) {
  Step 1 "Imza anahtari olusturuluyor"
  Write-Host "  Bir sifre belirleyeceksiniz. BU SIFREYI VE $ks DOSYASINI SAKLAYIN." -ForegroundColor Yellow
  Write-Host "  Kaybederseniz uygulamayi bir daha guncelleyemezsiniz.`n" -ForegroundColor Yellow

  $keytool = 'keytool'
  if ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\bin\keytool.exe")) { $keytool = "$env:JAVA_HOME\bin\keytool.exe" }
  elseif (Test-Path "$env:LOCALAPPDATA\Programs\Android Studio\jbr\bin\keytool.exe") { $keytool = "$env:LOCALAPPDATA\Programs\Android Studio\jbr\bin\keytool.exe" }
  elseif (Test-Path "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe") { $keytool = "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" }

  & $keytool -genkey -v -keystore $ks -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 `
      -alias noktapp -dname "CN=NOKTApp, OU=NOKTApp, O=NOKTApp, L=Alanya, C=TR"
  if ($LASTEXITCODE -ne 0) { Fail 'Anahtar olusturulamadi. keytool bulunamadi ise Android Studio kurulu mu bakin.' }
} else {
  Step 1 "Imza anahtari bulundu: $ks"
}

if (-not (Test-Path $props)) {
  Write-Host "`n  android\key.properties yok. Anahtar sifrenizi bir kez buraya yazin." -ForegroundColor Yellow
  $sifre = Read-Host '  Anahtar sifresi' -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
             [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sifre))
  $ksPath = $ks -replace '\\','/'
  @(
    "storePassword=$plain",
    "keyPassword=$plain",
    "keyAlias=noktapp",
    "storeFile=$ksPath"
  ) | Set-Content -Path $props -Encoding ASCII
  Write-Host "  Yazildi: $props  (bu dosyayi kimseyle paylasmayin, git'e eklemeyin)" -ForegroundColor Green
}

# --- 2. gradle'i yayina hazirla -------------------------------------------
Step 2 "Android projesi yayina hazirlaniyor"
$gradle = if (Test-Path 'android\app\build.gradle.kts') { 'android\app\build.gradle.kts' } else { 'android\app\build.gradle' }
$kts = $gradle.EndsWith('.kts')
$g = Get-Content $gradle -Raw

# applicationId
$g = $g -replace 'applicationId\s*=\s*"[^"]*"', 'applicationId = "com.noktapp.garson"'
$g = $g -replace 'applicationId\s+"[^"]*"',     'applicationId "com.noktapp.garson"'

if ($g -notmatch 'noktappImzaAyari') {
  if ($kts) {
    $blok = @'
    // noktappImzaAyari
    signingConfigs {
        create("release") {
            val p = java.util.Properties()
            val f = rootProject.file("key.properties")
            if (f.exists()) { f.inputStream().use { p.load(it) } }
            keyAlias = p.getProperty("keyAlias")
            keyPassword = p.getProperty("keyPassword")
            storeFile = p.getProperty("storeFile")?.let { file(it) }
            storePassword = p.getProperty("storePassword")
        }
    }
'@
    $g = $g -replace '(?m)^(\s*buildTypes\s*\{)', "$blok`r`n`$1"
    $g = $g -replace 'signingConfig\s*=\s*signingConfigs\.getByName\("debug"\)', 'signingConfig = signingConfigs.getByName("release")'
  } else {
    $blok = @'
    // noktappImzaAyari
    signingConfigs {
        release {
            def p = new Properties()
            def f = rootProject.file("key.properties")
            if (f.exists()) { f.withInputStream { s -> p.load(s) } }
            keyAlias p.getProperty("keyAlias")
            keyPassword p.getProperty("keyPassword")
            storeFile p.getProperty("storeFile") ? file(p.getProperty("storeFile")) : null
            storePassword p.getProperty("storePassword")
        }
    }
'@
    $g = $g -replace '(?m)^(\s*buildTypes\s*\{)', "$blok`r`n`$1"
    $g = $g -replace 'signingConfig\s+signingConfigs\.debug', 'signingConfig signingConfigs.release'
  }
  Set-Content -Path $gradle -Value $g -Encoding UTF8
  Write-Host "  build.gradle guncellendi (imza + applicationId)" -ForegroundColor Green
} else {
  Set-Content -Path $gradle -Value $g -Encoding UTF8
  Write-Host "  build.gradle zaten hazir" -ForegroundColor Green
}

# --- 3. paketi uret --------------------------------------------------------
Step 3 "Play Store paketi uretiliyor (.aab) - birkac dakika"
flutter clean | Out-Null
flutter pub get
flutter build appbundle --release
if ($LASTEXITCODE -ne 0) { Fail 'Derleme basarisiz. Yukaridaki kirmizi satirlari gonderin.' }

$aab = 'build\app\outputs\bundle\release\app-release.aab'
if (-not (Test-Path $aab)) { Fail 'Paket olusmadi.' }
$mb = '{0:N1}' -f ((Get-Item $aab).Length / 1MB)
$v  = (Select-String -Path 'pubspec.yaml' -Pattern '^version:\s*(.+)$').Matches[0].Groups[1].Value

Write-Host ""
Write-Host "  HAZIR" -ForegroundColor Green
Write-Host "  Dosya : $(Resolve-Path $aab)"
Write-Host "  Surum : $v"
Write-Host "  Boyut : $mb MB"
Write-Host ""
Write-Host "  Play Console > Uygulama olustur > Uretim (veya Kapali test) > Yeni surum" -ForegroundColor Yellow
Write-Host "  bu .aab dosyasini yukleyin." -ForegroundColor Yellow
Start-Process explorer.exe "/select,`"$((Resolve-Path $aab).Path)`""
