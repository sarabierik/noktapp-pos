# Building the NOKTApp Garson APK on Windows

This is the whole process, starting from a Windows PC with nothing installed on
it, ending with the app running on a waiter's handheld. Follow it in order.

Set aside about an hour. Most of that is downloads.

---

## 0. What this repository contains, and what it does not

This folder holds the Flutter application itself:

```
lib/          the app - all of the Dart code
assets/       empty for now, but pubspec.yaml expects the folder to exist
android/app/src/main/AndroidManifest.xml       hand-written, do not lose it
android/app/src/main/res/xml/network_security_config.xml   ditto
ios/Runner/Info.plist.additions                notes, superseded by tools/
tools/ios-izinler.sh                           iOS permission keys, run on the Mac
pubspec.yaml  the app's name, version and package list
BUILD-IOS.md  the same process for iPhone, on a Mac
```

It does **not** contain the generated Android project - no Gradle files, no
`MainActivity`, no launcher icons. Those are machine-generated and are created
in step 5 with a single command. This is normal for a Flutter project that only
keeps its own source in version control.

---

## 1. Install Git for Windows

1. Go to <https://git-scm.com/download/win>. The download starts by itself.
2. Run the installer. Every default is fine - keep clicking **Next**, then
   **Install**.
3. When it finishes, open the Start menu, type `cmd`, and open
   **Command Prompt**. Type:

   ```
   git --version
   ```

   You should see something like `git version 2.46.0.windows.1`. If you instead
   see "not recognized", close the Command Prompt, open a new one, and try
   again - the installer only adds Git to new windows.

---

## 2. Install the Flutter SDK

1. Go to <https://docs.flutter.dev/get-started/install/windows>.
2. Download the **Flutter SDK zip** for Windows. It is about 1 GB.
3. Create the folder `C:\src` (right-click in `C:\` → New → Folder → `src`).
4. Extract the zip **into `C:\src`**, so that you end up with:

   ```
   C:\src\flutter\bin\flutter.bat
   ```

   Do **not** put it in `C:\Program Files`. That folder needs administrator
   rights to write into, and Flutter writes into its own directory constantly.

5. Add Flutter to the PATH so the `flutter` command works from anywhere:
   - Press the Windows key, type `environment`, open
     **Edit the system environment variables**.
   - Click **Environment Variables...**
   - In the upper box (**User variables**), select **Path**, click **Edit**.
   - Click **New**, type `C:\src\flutter\bin`, click **OK** on all three
     windows.
6. Open a **new** Command Prompt and check:

   ```
   flutter --version
   ```

   The first run takes a minute while Flutter unpacks its tools.

---

## 3. Install the Android tools

1. Go to <https://developer.android.com/studio> and download
   **Android Studio**. Run the installer and accept the defaults; when it first
   opens it will offer to download the Android SDK - let it.
2. Once Android Studio is open, go to
   **More Actions → SDK Manager** (or **File → Settings → Languages & Frameworks
   → Android SDK**).
3. On the **SDK Platforms** tab, tick the newest Android version listed.
4. On the **SDK Tools** tab, tick:
   - **Android SDK Command-line Tools (latest)** - the build fails without this
   - **Android SDK Build-Tools**
   - **Android SDK Platform-Tools** (this is what gives you `adb`)
5. Click **Apply** and wait for the downloads.
6. Back in the Command Prompt, accept the licences. Say `y` to every prompt:

   ```
   flutter doctor --android-licenses
   ```

7. Check the whole toolchain:

   ```
   flutter doctor
   ```

   You want green ticks next to **Flutter** and **Android toolchain**. Ignore
   anything it says about Visual Studio, Chrome or Xcode - those are for
   building Windows, web and iOS apps, and we are building an Android app.

---

## 4. Get the project onto the machine

Put this folder somewhere short and without spaces in the path, for example
`C:\src\noktapp\mobile`. Long paths and spaces are a recurring source of Gradle
failures on Windows.

Then open a Command Prompt **in that folder**: open the folder in File
Explorer, click in the address bar, type `cmd` and press Enter.

Everything from here on is typed in that window.

---

## 5. Generate the Android project (once)

This creates the Gradle files, `MainActivity`, and the launcher icons.

**First, make a copy of the two hand-written files**, because this step
overwrites `AndroidManifest.xml` with a stock one:

```
copy android\app\src\main\AndroidManifest.xml AndroidManifest.backup.xml
copy pubspec.yaml pubspec.backup.yaml
```

Now generate:

```
flutter create --org com.noktapp --platforms=android .
```

(The dot at the end matters - it means "here".)

Then put the hand-written manifest back:

```
copy /Y AndroidManifest.backup.xml android\app\src\main\AndroidManifest.xml
```

And check that `pubspec.yaml` was not changed:

```
fc pubspec.yaml pubspec.backup.yaml
```

If `fc` reports differences, restore it with
`copy /Y pubspec.backup.yaml pubspec.yaml`.

### Why `--org com.noktapp` matters

That flag decides the app's permanent identity on Android:
`com.noktapp.noktapp_garson`. **Never change it later.** Android treats an app
with a different id as a completely different app, so a rebuilt APK with a new
id will not update the one already on the handhelds - it installs alongside it,
and the waiter ends up with two NOKTApp icons and one paired phone.

You only ever do step 5 once. After that the `android` folder exists and should
be kept.

---

## 6. Download the packages

```
flutter pub get
```

This reads `pubspec.yaml` and downloads `http`, `shared_preferences`,
`multicast_dns` and the rest. It takes under a minute.

---

## 7. Build the APK

```
flutter build apk --release
```

The **first** build downloads Gradle and the Android build tools and can take
ten minutes or more with no visible progress. Later builds take about a minute.
Leave it alone while it runs.

When it finishes it prints the path. The file is:

```
build\app\outputs\flutter-apk\app-release.apk
```

That single file is the app. It is roughly 20 MB and runs on any Android 5.0
(2014) handset or newer.

### About signing

Out of the box a release build is signed with Flutter's debug key. That is
fine for installing directly onto handhelds, which is how these devices are
set up. A proper signing key is only needed to publish on Google Play; if that
day comes, follow
<https://docs.flutter.dev/deployment/android#signing-the-app>.

---

## 8. Put it on a handheld

### Over USB (best when you have the device in front of you)

1. On the handheld: **Settings → About phone**, tap **Build number** seven
   times. It will say "You are now a developer".
2. **Settings → System → Developer options**, turn on **USB debugging**.
3. Plug the handheld into the PC with a USB cable. A dialog appears on the
   handheld asking to allow USB debugging - tick "always" and accept.
4. In the Command Prompt:

   ```
   adb devices
   ```

   You should see the device listed. If `adb` is "not recognized", use the full
   path: `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`

5. Install:

   ```
   adb install -r build\app\outputs\flutter-apk\app-release.apk
   ```

   `-r` means "replace the existing one and keep its data", so a waiter's
   phone stays paired across an update.

### By copying the file (for a device you cannot plug in)

1. Put `app-release.apk` somewhere the handheld can reach it - a USB stick, a
   shared folder, or an e-mail to the restaurant.
2. On the handheld, open the file. Android will say installing from this source
   is not allowed; tap **Settings** in that message and allow it for the app you
   are opening the file from (usually Files or Chrome).
3. Tap **Install**.

---

## 9. First run

1. Put the handheld on the **restaurant's own Wi-Fi**. The first connection has
   to happen on the same network as the till - after that the app also works
   over mobile data through the relay.
2. On the till: **Ayarlar → Telefonlar → Yeni cihaz bagla**. A six digit code
   appears.
3. On the handheld: type the code, the waiter's user name and password, and a
   name for the phone. Tap **Baglan**.

The phone is now paired. It stays paired until somebody removes it at the till.

---

## 10. If the build stops

**"unable to find directory entry in pubspec.yaml: ...\assets\"**
The `assets` folder is missing. Create it (it is meant to be empty for now):
`mkdir assets`

**"No Android SDK found" / "cmdline-tools component is missing"**
Go back to step 3.4 and tick **Android SDK Command-line Tools (latest)**.

**"Android license status unknown"**
Run `flutter doctor --android-licenses` and answer `y` to each.

**A Gradle error mentioning Java, JDK or `jlink`**
Android Studio ships its own Java. Point Flutter at it:
`flutter config --jdk-dir "C:\Program Files\Android\Android Studio\jbr"`

**Anything else, or a build that just will not finish**
Clear the build folder and try once more - this fixes a surprising share of
first builds:

```
flutter clean
flutter pub get
flutter build apk --release
```

**To see the actual error rather than a summary**, add `-v`:
`flutter build apk --release -v`

---

## 11. Building an update later

Steps 1 to 5 are one-time. To build a new version afterwards:

```
flutter pub get
flutter build apk --release
adb install -r build\app\outputs\flutter-apk\app-release.apk
```

Before you do, raise the version in `pubspec.yaml`:

```
version: 1.0.1+2
```

The part before the `+` is what a person reads; the number after the `+` must
increase on every release or Android will refuse to install the new APK over
the old one.
