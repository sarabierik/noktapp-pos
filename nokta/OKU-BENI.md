# NOKTA — the complete project folder

Everything the app is made of is in here. What is **not** in here is the
generated Android and iOS scaffolding — `android/build.gradle`, the Gradle
wrapper, the Xcode project. Those are produced by `flutter create`, which has
to run on a machine that has the Flutter SDK. Mine does not; yours does.

That is one command, and then Android Studio has a normal project to open.

---

## What do I do with this

**1. Run the setup once.** Double-click **`BASLA.bat`**.

Or, in PowerShell, from this folder:

```powershell
.\KUR.ps1
```

It does five things: generates the Android/iOS project, puts your hand-written
manifest and the NOKTA icon back over Flutter's stock ones, downloads the
packages, runs `flutter analyze`, and runs the tests.

**If it stops with red lines, send them to me exactly as they are.** No compiler
has ever seen this Dart — it was written without a Flutter SDK available, so
this is the first time anything has checked it. I expect it may have something
to say.

**2. When it prints `Hazir.`** — open this folder in Android Studio
(`File → Open`, pick the `nokta` folder), plug in the Huawei, press Run.

Or stay in PowerShell: `flutter run`.

---

## What is in the folder

| | |
|---|---|
| `lib/` | the app — 13 files, 8 screens, the API client, the theme |
| `test/` | boot smoke test + the number-handling tests |
| `android/app/src/main/` | your manifest and the NOKTA icon (hand-written, not generated) |
| `ios/Runner/Info.plist.additions` | what the iOS plist must say |
| `tools/ios-izinler.sh` | writes those keys on the Mac |
| `play-grafik/` | the 512 and 1024 store icons |
| `KUR.ps1` | setup — run once |
| `YAYIN.ps1` | the Play Store bundle, when you are ready |
| `BASLA.md` | the longer notes on how the app is put together |

Android config: `com.noktapp.nokta`, one permission (INTERNET), portrait,
dark. The app is a reader — it never writes a stamp and never spends a reward;
only a till can do that, at the counter, with the guest present.

---

## Two things worth knowing before you build

**The app talks to `https://pos.noktapp.com/api/guest`.** Those endpoints are
live on your panel already — register, login, cards, card, history, qr,
restaurants, profile, delete. If a screen comes back empty, that is the place
to look first, not the Dart.

**No keystore yet, and that is fine.** `flutter build apk --release` will sign
with the debug key and install on a phone. It cannot go to Play like that.
When you want the store build, run `YAYIN.ps1` — it creates the keystore, asks
you for a password once, and writes it to `android/key.properties`, which is
already in `.gitignore`. I never see that password and it never travels in
anything I send you. Keep the `.jks` file and the password safe: lose either and
the app can never be updated again.

---

## iOS

The Xcode project is generated rather than stored, so there is nothing stale in
the folder to maintain. On your Mac:

```bash
cd nokta
flutter create --org com.noktapp --project-name nokta --platforms=ios .
bash tools/ios-izinler.sh
flutter build ipa
```

To check it compiles without touching the Mac: the repo's **Actions** tab has
**NOKTA (Flutter)** → **Run workflow**, which builds it unsigned on a macOS
runner. That proves the code; anything installable on an iPhone still needs
your Apple Developer account.
