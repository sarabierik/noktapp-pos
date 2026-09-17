# NOKTApp Garson — build it from nothing

You deleted the old project. Good: the old one was a different, older app that
sent the wrong field name and could never have paired. This is the current one.

**Everything here is ready. You do not edit a single line.**

---

## What you need installed

Flutter and Android Studio. You already have both — you were building with them
this morning. If you ever need them from scratch, `BUILD.md` in this folder has
the full walkthrough.

---

## Build it — five commands

1. Unzip this folder somewhere short, with no spaces in the path. For example:

   ```
   C:\src\noktapp-garson
   ```

   Not Desktop, not Downloads, not anything with a space. Long paths and spaces
   are the most common cause of Gradle failing on Windows.

2. Open a Command Prompt **in that folder**: open it in File Explorer, click the
   address bar, type `cmd`, press Enter.

3. Run the script that is in this folder:

   ```
   .\KUR.ps1
   ```

   That is the whole of step 3. It keeps the hand-written manifest and the icon
   safe, generates the Android project around them, puts them back, and fetches
   the packages.

   **Use PowerShell, which is what the Android Studio terminal is.** The older
   `copy /Y` and `xcopy` instructions only work in `cmd`; in PowerShell `copy`
   is an alias for `Copy-Item` and refuses the `/Y`. That is what KUR.ps1
   exists to stop.

   If PowerShell refuses to run it ("running scripts is disabled"):

   ```
   powershell -ExecutionPolicy Bypass -File KUR.ps1
   ```

4. Fetch the packages and build:

   ```
   flutter pub get
   flutter build apk --release
   ```

   The first build downloads Gradle and can sit silently for ten minutes. Leave
   it. Later builds take about a minute.

5. Put it on the phone:

   ```
   adb install build\app\outputs\flutter-apk\app-release.apk
   ```

   If `adb` is not recognised:

   ```
   set PATH=%PATH%;%LOCALAPPDATA%\Android\Sdk\platform-tools
   ```

---

## To open it in Android Studio instead

**File → Open** → pick this folder → wait for it to index → press the green
**Run** button with the phone plugged in.

Do step 3 first, from the command line. Android Studio cannot generate the
Android project for you.

---

## First pairing

1. Phone on the **same Wi-Fi** as the till.
2. On the till: **Ayarlar → Cihazlar → Telefon bağla**. A six digit code appears.
3. In the app: the code, the waiter's **username**, and their **telefon şifresi**.

The phone password is **not** the 4-digit till PIN. They are different
credentials, and a waiter created PIN-only has no phone password at all until
somebody sets one in **Ayarlar → Kullanıcılar**.

If the app cannot find the till by itself, tap **"Kasa bulunamıyor mu? Adresi
elle gir"** and type the PC's address — `172.16.3.253` — with no `http://` and
no port. The app adds `:7451`.

---

## How to tell the right build is on the phone

Pair once, then look at the till's log:

```
C:\ProgramData\NoktAppPOS\logs\service-<today>.log
```

The pairing request carries **`app_version: 1.3.0`**. Anything older is a stale
APK and none of the fixes below are in it.

---

## What changed in 1.3.0

**The pairing field name.** The old app sent `"pin"`; the till reads
`"password"`. Every pairing attempt failed with 401 and the message blamed the
username and password, which were correct all along. This is the fix that
matters.

**Probe timeouts.** A typed address got 1.2 seconds to answer — a number chosen
for scanning 254 hosts at once, and far too short for a first connection across
a router. A correct address was reported as wrong. Now: 1.2 s for the sweep,
5 seconds and a retry for an address a person typed or a QR carried.

**"Oturum sona erdi" when nothing had expired.** A failed local call fell
silently through to the cloud relay, which answers 401 for a device it has never
heard of, and the waiter was told to re-pair — which cannot help. The app now
says *"Kasaya ulaşılamıyor"* when it cannot reach the till, and keeps
*"Oturum sona erdi"* for a real refusal.

**The eight second freeze.** Every tap waited eight seconds for the LAN before
trying the relay. During service, on poor Wi-Fi, that is unusable. Now 2.5 s.

**The icon.** NG on the brand's orange, with a proper Android adaptive icon and
a launch screen in the same colour instead of a white flash.
