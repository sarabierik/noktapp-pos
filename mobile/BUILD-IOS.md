# Building the NOKTApp Garson app for iPhone, on a Mac

`BUILD.md` covers Android on Windows. This is the iOS half. You need a Mac for
it - not because Flutter needs one, but because only Xcode can produce and sign
an `.ipa`, and Xcode is macOS only. There is no flag, no plugin and no trick
that changes that.

The Dart code is already portable. Nothing in `lib/` branches on the platform,
so the same app that runs on the handhelds runs on an iPhone once the iOS
project exists.

Set aside an afternoon the first time. Xcode alone is a 7 GB download.

---

## 0. Decide first: who is this iPhone build for

Worth being clear about, because it changes how much of this you need to do.

**Waiters do not need it.** Every cheap restaurant handheld - Sunmi, Urovo,
iData - is Android. That is what the pilot sites will be holding.

**Owners do.** They carry iPhones, and NOKTApp Patron is the app they will open.
So the iOS path is worth having working now, on this app, where the surface is
small, rather than discovering the signing and permission problems later on the
app that matters.

If you only want to see it run on your own iPhone, steps 1-8 are enough and cost
nothing. Putting it on somebody else's phone needs step 10.

---

## 1. Xcode

1. Open the **App Store** on the Mac, search **Xcode**, install. It is around
   7 GB and slow; start it and do something else.
2. Open Xcode once after it installs and let it finish "installing additional
   components".
3. Then in **Terminal**:

   ```
   sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -runFirstLaunch
   sudo xcodebuild -license accept
   ```

   Those three lines are what most "works in Xcode but not from the command
   line" problems turn out to be.

---

## 2. Flutter on the Mac

1. Follow <https://docs.flutter.dev/get-started/install/macos>. On an Apple
   Silicon Mac also run:

   ```
   sudo softwareupdate --install-rosetta --agree-to-license
   ```

   Some of CocoaPods' native tooling is still Intel-only.

2. Check:

   ```
   flutter doctor
   ```

   You want green next to **Flutter** and **Xcode**. Ignore Android complaints
   if you are not building Android on this machine.

---

## 3. CocoaPods

Flutter's iOS plugins are wired in through CocoaPods.

```
sudo gem install cocoapods
```

If that fails on a newer macOS, use Homebrew instead: `brew install cocoapods`.

---

## 4. Get the project onto the Mac

Copy the whole `mobile` folder across - USB stick, AirDrop, git, whatever is
easiest. Put it somewhere without spaces in the path.

Then open Terminal in that folder (right-click the folder in Finder →
**Services → New Terminal at Folder**).

---

## 5. Generate the iOS project (once)

The repository holds no iOS project - only `ios/Runner/Info.plist.additions`,
which is a notes file, not a project. Same as Android: the scaffold is
machine-generated.

Back the two hand-written files up first, because `flutter create` will rewrite
whatever it feels like:

```
cp android/app/src/main/AndroidManifest.xml AndroidManifest.backup.xml
cp pubspec.yaml pubspec.backup.yaml
```

Generate:

```
flutter create --org com.noktapp --platforms=ios .
```

Put them back:

```
cp AndroidManifest.backup.xml android/app/src/main/AndroidManifest.xml
diff pubspec.yaml pubspec.backup.yaml || cp pubspec.backup.yaml pubspec.yaml
```

### The `--org` flag is the same one as Android, and for the same reason

It fixes the app's permanent identity: `com.noktapp.noktappGarson`. Apple ties
the signing certificate, the provisioning profile and the App Store record to
that string. Changing it later means a new app, not an update - the same trap as
Android's `applicationId`, but harder to undo because Apple keeps the id
reserved.

---

## 6. Write the permission keys

iOS 14 and later block an app from touching the local network until the
Info.plist says it intends to, and until the user has said yes to a prompt. Miss
this and discovery finds nothing, the manually typed address is refused too, and
the app looks broken with nothing useful in the log.

```
bash tools/ios-izinler.sh
```

It writes four keys into `ios/Runner/Info.plist`:

| Key | Why |
|---|---|
| `NSLocalNetworkUsageDescription` | The sentence iOS shows in the permission prompt. Required, or the prompt never appears and access is simply denied. |
| `NSBonjourServices` = `_noktapp-pos._tcp` | iOS will not let the app browse a service that is not listed here. This is the same service name the till advertises. |
| `NSAppTransportSecurity` → `NSAllowsLocalNetworking` | The till speaks plain HTTP on port 7451. ATS blocks that by default. This opens the LAN only; anything going to the internet still has to be HTTPS. |
| `CFBundleDisplayName` | The name under the icon: NOKTApp Garson. |

The script is safe to run twice.

`getWifiIP()` in `discovery.dart` does **not** need location permission on iOS -
only the wifi *name* and BSSID do, and the app never asks for those. So there is
no location prompt to explain to anyone.

---

## 7. Packages

```
flutter pub get
cd ios && pod install && cd ..
```

`pod install` is the step that most often fails on a first Mac. If it complains
about the repo being out of date: `pod repo update` then try again.

---

## 8. Run it on your own iPhone

1. Plug the iPhone in. Unlock it. Tap **Trust** on the "Trust This Computer"
   prompt.
2. Open the workspace - **not** the project:

   ```
   open ios/Runner.xcworkspace
   ```

   (`Runner.xcodeproj` will open too and then fail to build. Always the
   `.xcworkspace`.)

3. In Xcode's left sidebar click **Runner** at the top, then the **Signing &
   Capabilities** tab.
4. Tick **Automatically manage signing**.
5. In **Team**, pick your Apple ID. If it is not there:
   **Xcode → Settings → Accounts → +** and sign in with your normal Apple ID.
   A free one is enough to get to this point.
6. Close Xcode and go back to Terminal:

   ```
   flutter devices
   flutter run --release -d <the id it printed for your iPhone>
   ```

7. The first launch on the phone will refuse to open - iOS does not trust a
   developer certificate until you say so. On the phone:
   **Settings → General → VPN & Device Management → your Apple ID → Trust**.

8. Put the phone on the restaurant's wifi and pair it exactly as in
   `BUILD.md` step 9. The **first** time the app looks for the till, iOS shows
   the local network prompt. Tap **OK**.

   If anyone ever taps **Don't Allow**, there is no second prompt and no way for
   the app to ask again. The only fix is
   **Settings → NOKTApp Garson → Local Network → on**. Worth telling a waiter
   before handing the phone over, not after.

---

## 9. What a free Apple ID gets you, and what it does not

With a free Apple ID:

- the app runs on iPhones you physically own and have plugged into this Mac
- it **stops working after 7 days** and has to be re-installed from Xcode
- at most three apps at a time

That is fine for testing on your own phone. It is useless for a restaurant.

---

## 10. Real distribution: the Apple Developer Program

$99 a year, at <https://developer.apple.com/programs/>. Registering as a
company needs a D-U-N-S number, which takes a couple of weeks to obtain, so if
NOKTApp is going to publish under the company name rather than your own, start
that early.

With a paid membership:

- builds last a year instead of a week
- **TestFlight** lets you e-mail a link to a restaurant owner and have them
  install it themselves, no cable, no Mac, up to 100 testers
- the App Store becomes possible when you want it

To send a build to TestFlight:

```
flutter build ipa
```

Then either upload the `.ipa` it prints the path to via Xcode's
**Organizer → Distribute App**, or open
`build/ios/archive/Runner.xcarchive` in Xcode and distribute from there.

For Patron, TestFlight is almost certainly the right answer for a long time -
restaurant owners can install it without you touching their phone, and you can
push a new build in minutes.

---

## 11. If it stops

**"CocoaPods could not find compatible versions"**
`cd ios && pod repo update && pod install`

**"Signing for Runner requires a development team"**
Step 8.3 to 8.5 was skipped, or the Apple ID is not in Xcode's Accounts.

**"Unable to install… device is locked"**
Unlock the phone and leave it unlocked while the build finishes.

**"Could not find Developer Disk Image"**
Xcode is older than the iPhone's iOS version. Update Xcode from the App Store.

**Build succeeds, app opens, finds no till**
Almost always the local network permission. Check
**Settings → NOKTApp Garson**; if there is no "Local Network" row at all, the
plist keys are missing - re-run step 6 and rebuild.

**Anything else**

```
flutter clean
flutter pub get
cd ios && pod install && cd ..
flutter run --release
```

---

## 12. Building an update later

Steps 1-6 are one-time. Afterwards:

```
flutter pub get
cd ios && pod install && cd ..
flutter build ipa
```

Raise `version:` in `pubspec.yaml` first. Apple, unlike Android, refuses an
upload whose build number it has already seen - so the number after the `+` must
increase every single time, even for a build you throw away.
