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
$kts    = $gradle.EndsWith('.kts')
$yedek  = "$gradle.noktapp-yedek"

# Her calistirmada TEMIZ dosyadan basla. Ikinci bir calistirma, bir oncekinin
# ekledigi bloklarin ustune yazmasin diye.
#
# Ve yedegin KENDISI temiz olmali: bir onceki surum bozuk bir blok eklediyse ve
# yedek o dosyadan alindiysa, her calistirma bozuklugu geri getirir. Bu yuzden
# yedekte bizim izimiz varsa yedek gecersiz sayilir.
function Temiz([string]$metin) {
  return -not ($metin -match 'noktappImzaAyari' -or
               $metin -match 'noktappAnahtar'   -or
               $metin -match 'val p = java\.util\.Properties')
}

if (Test-Path $yedek) {
  if (Temiz (Get-Content $yedek -Raw)) {
    Copy-Item $yedek $gradle -Force
  } else {
    Remove-Item $yedek -Force
    Fail @"
Yedek dosya bozuk (onceki surumun ekledigi blogu iceriyor) ve silindi.
Temiz bir Android projesi uretmek icin once sunu calistirin:

    .\KUR.ps1

sonra tekrar:

    .\YAYIN.ps1
"@
  }
} else {
  if (-not (Temiz (Get-Content $gradle -Raw))) {
    Fail @"
android\app\build.gradle dosyasinda onceki bir denemenin kalintisi var.
Temiz bir Android projesi uretmek icin once sunu calistirin:

    .\KUR.ps1

sonra tekrar:

    .\YAYIN.ps1
"@
  }
  Copy-Item $gradle $yedek -Force
}
$g = Get-Content $gradle -Raw

# applicationId
$g = $g -replace 'applicationId\s*=\s*"[^"]*"', 'applicationId = "com.noktapp.garson"'
$g = $g -replace 'applicationId\s+"[^"]*"',     'applicationId "com.noktapp.garson"'

if ($kts) {
  # Import'lar dosyanin EN BASINDA olmali. Properties'i burada acmak sart:
  # android { } blogunun icinde "java" adi Gradle'in kendi java eklentisine
  # cozuluyor ve java.util.Properties() derlenmiyor.
  if ($g -notmatch 'import java\.util\.Properties') {
    $g = "import java.util.Properties`r`nimport java.io.FileInputStream`r`n`r`n" + $g
  }
  if ($g -notmatch 'noktappAnahtar') {
    $blok = @'

// noktappAnahtar
val noktappAnahtar = Properties()
val noktappAnahtarDosyasi = rootProject.file("key.properties")
if (noktappAnahtarDosyasi.exists()) {
    FileInputStream(noktappAnahtarDosyasi).use { noktappAnahtar.load(it) }
}

'@
    # plugins { ... } blogundan hemen SONRA
    $g = [regex]::Replace($g, '(?s)(plugins\s*\{.*?
\})', "`$1`r`n$blok", 1)
  }
  if ($g -notmatch 'noktappImzaAyari') {
    $imza = @'
    // noktappImzaAyari
    signingConfigs {
        create("release") {
            keyAlias = noktappAnahtar.getProperty("keyAlias")
            keyPassword = noktappAnahtar.getProperty("keyPassword")
            storePassword = noktappAnahtar.getProperty("storePassword")
            val yol = noktappAnahtar.getProperty("storeFile")
            if (yol != null) { storeFile = file(yol) }
        }
    }

'@
    $g = [regex]::Replace($g, '(?m)^(\s*buildTypes\s*\{)', "$imza`$1", 1)
  }
  $g = $g -replace 'signingConfig\s*=\s*signingConfigs\.getByName\("debug"\)', 'signingConfig = signingConfigs.getByName("release")'
} else {
  if ($g -notmatch 'noktappImzaAyari') {
    $imza = @'
    // noktappImzaAyari
    signingConfigs {
        release {
            def np = new Properties()
            def nf = rootProject.file("key.properties")
            if (nf.exists()) { nf.withInputStream { st -> np.load(st) } }
            keyAlias np.getProperty("keyAlias")
            keyPassword np.getProperty("keyPassword")
            storePassword np.getProperty("storePassword")
            if (np.getProperty("storeFile") != null) { storeFile file(np.getProperty("storeFile")) }
        }
    }

'@
    $g = [regex]::Replace($g, '(?m)^(\s*buildTypes\s*\{)', "$imza`$1", 1)
  }
  $g = $g -replace 'signingConfig\s+signingConfigs\.debug', 'signingConfig signingConfigs.release'
}

Set-Content -Path $gradle -Value $g -Encoding UTF8
if ($g -match 'signingConfigs\.getByName\("release"\)' -or $g -match 'signingConfigs\.release') {
  Write-Host "  build.gradle hazir: imza + applicationId com.noktapp.garson" -ForegroundColor Green
} else {
  Write-Host "  UYARI: release imzasi baglanamadi - paket debug anahtari ile imzalanabilir." -ForegroundColor Yellow
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
