<#
  NOKTA - Play Store yayin paketi (.aab)

      .\YAYIN.ps1

  1. Imza anahtarini bulur; yoksa olusturur (sifreyi SIZ yazarsiniz).
  2. android\app\build.gradle.kts dosyasini BASTAN YAZAR. Parca parca duzeltme
     yapmiyoruz: bir denemenin kalintisi bir sonrakini bozuyordu. Dosyanin
     tamami tek bir sablondan uretilir, kac kere calistirirsaniz sonuc ayni.
  3. flutter analyze - derleme baslamadan once hata varsa soyler.
  4. app-release.aab uretir ve nerede oldugunu soyler.

  ONEMLI - ANAHTARI KAYBETMEYIN.
  Play Store'a yuklediginiz ilk .aab bu anahtarla imzalanir. Kaybederseniz
  uygulamayi BIR DAHA guncelleyemezsiniz; yeni bir uygulama acmaniz gerekir.
      %USERPROFILE%\nokta-upload.jks
  Bu dosyayi ve sifresini yedekleyin. Ikisi de hicbir zaman bir zip'e, bir
  e-postaya veya git'e girmez.

  NOT: Garson uygulamasinin anahtari AYRI bir dosyadir. Iki uygulama iki ayri
  Play kaydidir ve ayni anahtari paylasmalari gerekmez; birini kaybetmek
  digerini etkilemesin diye de paylasmamalari daha iyidir.
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
$ks = Join-Path $env:USERPROFILE 'nokta-upload.jks'
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
      -alias nokta -dname "CN=NOKTApp, OU=NOKTA, O=NOKTApp, L=Alanya, C=TR"
  if ($LASTEXITCODE -ne 0) { Fail 'Anahtar olusturulamadi. keytool yoksa Android Studio kurulu mu bakin.' }
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
    "keyAlias=nokta",
    "storeFile=$ksPath"
  ) | Set-Content -Path $props -Encoding ASCII
  Write-Host "  Yazildi: $props  (paylasmayin, git'e eklemeyin)" -ForegroundColor Green
}

# --- 2. gradle dosyasini bastan yaz ---------------------------------------
Step 2 "android\app\build.gradle.kts yeniden yaziliyor"
foreach ($eski in @('android\app\build.gradle', 'android\app\build.gradle.kts.yedek')) {
  if (Test-Path $eski) { Remove-Item $eski -Force }
}

$sablon = @'
plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Imza bilgileri android/key.properties dosyasindan okunur.
// O dosya git'e girmez ve hicbir pakete konmaz.
//
// TAM NITELIKLI ISIM, `import` YOK. Otel uygulamasinda bu dosyanin basindaki
// `import java.util.Properties` AGP 9 altinda "unresolved reference" verdi ve
// derleme bastan durdu. Kotlin DSL'de importlar dosyanin EN basinda, plugins
// blogundan once olmak zorundadir; uretilen dosyanin basina bir BOM ya da tek
// bir bos satir girmesi yeter, import artik ilk sey degildir ve cozulmez.
// java.util.Properties() diye tam yazinca o sinif bagimliligi tamamen yok
// olur - hicbir siralamaya bagli degil.
val imzaAyar = java.util.Properties()
val imzaDosyasi = rootProject.file("key.properties")
val imzaVar = imzaDosyasi.exists()
if (imzaVar) {
    imzaDosyasi.inputStream().use { imzaAyar.load(it) }
}

android {
    namespace = "com.noktapp.nokta"
    compileSdk = maxOf(flutter.compileSdkVersion, 35)
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.noktapp.nokta"
        minSdk = flutter.minSdkVersion
        targetSdk = maxOf(flutter.targetSdkVersion, 35)
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // Imza yapilandirmasi YALNIZCA key.properties gercekten varsa kurulur.
    // Kosulsuz kurulunca, anahtari olmayan bir makinede storeFile null kalir
    // ve `flutter build apk --release` anlamsiz bir Gradle hatasiyla duser.
    // Boyle: anahtar yoksa release yapisi debug anahtariyla imzalanir - Play'e
    // yuklenemez ama telefona kurulur, ki denemek icin gereken tam olarak odur.
    if (imzaVar) {
        signingConfigs {
            create("release") {
                keyAlias = imzaAyar.getProperty("keyAlias")
                keyPassword = imzaAyar.getProperty("keyPassword")
                storePassword = imzaAyar.getProperty("storePassword")
                val yol = imzaAyar.getProperty("storeFile")
                if (yol != null) { storeFile = file(yol) }
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (imzaVar) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
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
Write-Host "  Yazildi: imza + applicationId com.noktapp.nokta + targetSdk 35+" -ForegroundColor Green

# --- 3. once kontrol, sonra derleme ---------------------------------------
Step 3 "Kod kontrol ediliyor (flutter analyze)"
flutter pub get | Out-Null
flutter analyze --no-fatal-infos
if ($LASTEXITCODE -ne 0) { Fail 'analyze hata buldu. Kirmizi satirlari oldugu gibi gonderin.' }

Step 4 "Play Store paketi uretiliyor (.aab) - birkac dakika"
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
Write-Host "  Play Console > Uygulama olustur > NOKTA > Yeni surum" -ForegroundColor Yellow
Start-Process explorer.exe "/select,`"$((Resolve-Path $aab).Path)`""
