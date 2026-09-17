<#
  NOKTApp Garson - Play Store yayin paketi (.aab)

      .\YAYIN.ps1

  Ne yapar:
    1. Imza anahtarini bulur; yoksa olusturur (sifreyi SIZ yazarsiniz).
    2. android\app\build.gradle.kts dosyasini bastan YAZAR. Eski surumler bu
       dosyaya parca parca ekleme yapiyordu; bir denemenin kalintisi bir
       sonrakini bozuyordu. Artik dosyanin tamami tek bir sablondan uretiliyor,
       yani kac kere calistirirsaniz calistirin sonuc ayni.
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
if (-not (Test-Path 'android\app\src\main\AndroidManifest.xml')) {
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

# --- 2. gradle dosyasini bastan yaz ---------------------------------------
Step 2 "android\app\build.gradle.kts yeniden yaziliyor"

# Eski surumlerin biraktigi her sey gitsin: groovy ikizi, yedekler.
foreach ($eski in @(
    'android\app\build.gradle',
    'android\app\build.gradle.kts.noktapp-yedek',
    'android\app\build.gradle.noktapp-yedek')) {
  if (Test-Path $eski) { Remove-Item $eski -Force }
}

$sablon = @'
import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Imza bilgileri android/key.properties dosyasindan okunur.
// O dosya git'e girmez ve hicbir pakete konmaz.
val imzaAyar = Properties()
val imzaDosyasi = rootProject.file("key.properties")
if (imzaDosyasi.exists()) {
    FileInputStream(imzaDosyasi).use { imzaAyar.load(it) }
}

android {
    namespace = "com.noktapp.garson"
    compileSdk = maxOf(flutter.compileSdkVersion, 35)
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.noktapp.garson"
        minSdk = flutter.minSdkVersion
        targetSdk = maxOf(flutter.targetSdkVersion, 35)
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            keyAlias = imzaAyar.getProperty("keyAlias")
            keyPassword = imzaAyar.getProperty("keyPassword")
            storePassword = imzaAyar.getProperty("storePassword")
            val yol = imzaAyar.getProperty("storeFile")
            if (yol != null) { storeFile = file(yol) }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
'@

# BOM'suz UTF-8. Set-Content -Encoding UTF8 (PowerShell 5.1) basa BOM koyuyor.
$hedef = Join-Path $root 'android\app\build.gradle.kts'
[IO.File]::WriteAllText($hedef, ($sablon -replace "`r?`n", "`r`n"), (New-Object Text.UTF8Encoding($false)))
Write-Host "  Yazildi: imza + applicationId com.noktapp.garson + targetSdk 35+" -ForegroundColor Green

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
Write-Host "  Play Console > Uygulama olustur > Kapali test > Yeni surum" -ForegroundColor Yellow
Write-Host "  bu .aab dosyasini yukleyin." -ForegroundColor Yellow
Start-Process explorer.exe "/select,`"$((Resolve-Path $aab).Path)`""
