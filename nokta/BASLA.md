# NOKTA — build and run

The guest app. One person, one account, every NOKTApp restaurant: a stamp
written at a counter in Alanya and one written in Antalya land on the same
wallet.

This folder has **only the files that are ours** — the Dart code, the manifest,
the icon and the two scripts. The Android and iOS project folders are generated,
because a generated folder that is also committed is a folder that drifts.

---

## Android, on your PC

From this folder, in PowerShell:

```powershell
.\KUR.ps1          # generates the android/ and ios/ projects, then checks the code
flutter run        # with a phone plugged in over USB
```

`KUR.ps1` ends with `flutter analyze`. **If it prints errors, stop and send me
those lines exactly as they appear.** This app was written on a machine with no
Flutter SDK on it, so `analyze` on your PC is the first time a compiler has ever
looked at it. That is the one thing I could not do here.

When it runs and you are happy with it:

```powershell
.\YAYIN.ps1        # produces the signed .aab for Play
```

The signing key lands at `%USERPROFILE%\nokta-upload.jks` and the password goes
in `android\key.properties`. **Back both up somewhere that is not this PC.** Lose
them and NOKTA can never be updated again — you would have to publish it as a
new app and every installed copy would be orphaned. Neither file is ever put in
a zip, sent anywhere, or committed; `.gitignore` here names both.

NOKTA's key is a **separate** file from NOKTApp Garson's. Two Play listings, two
keys: losing one must not cost you the other.

---

## iOS, on a Mac

```bash
flutter create --org com.noktapp --project-name nokta --platforms=ios .
bash tools/ios-izinler.sh        # writes the Info.plist keys
flutter build ipa --release
```

`ios/Runner/Info.plist.additions` is the record of what that script writes:
display name, dark appearance, portrait only. That is the whole list — there is
no camera key and no local-network key, because the app needs neither.

---

## Permissions: there is one

`INTERNET`. That is it.

NOKTA talks to `pos.noktapp.com` over HTTPS and to nothing else. No camera (the
guest **shows** a code, the cashier scans it), no local network, no contacts, no
location. Every permission is a question at store review and a line in the
install dialogue that makes somebody hesitate, so the list stays at one.

---

## What the app can and cannot do

It is a **reader**. It never writes a stamp and never spends a reward — only a
till may do that, at the counter, with the guest present. What it does is show
what is there and hand over a code the cashier can scan.

| Screen | What it shows |
|---|---|
| Kartlarım | Every card, grouped by restaurant. A finished card floats to the top. |
| Kart detayı | The campaign in full, plus every stamp behind that one card. |
| Karekod | A one-time code, good for five minutes, burned by the first till that spends it. The permanent card code is one tap down, for when the scan fails. |
| Keşfet | Live campaigns at NOKTApp restaurants, so a new guest does not open an empty app. |
| Profil | Name and e-mail, password change, sign out, and delete my account. |
| Geçmiş | Every stamp and reward, across every restaurant, grouped by day. |

Nothing on any of those screens is computed by the app. Each line is a row a
cashier wrote at a counter and the till mirrored up.

---

## Signing up, and the one thing that is not built yet

Most of the people who install NOKTA were **enrolled at a counter months ago**.
Their account already exists, with their stamps on it, and they have never had a
password. So the login screen does not make them choose "Giriş" or "Kayıt ol"
before anything is known — the number and password go in and the server decides:

- the number is unknown → the account is created and they are signed in
- the number is known and has a password → sign in
- the number is known with no password → **claim it**, by typing the code on
  their NOKTA card

That last step exists because without it anyone who can type a phone number
could take over a stranger's account — see their stamps, and eat their free
pizza. The card code proves they are holding the card.

**An SMS one-time code is the right second channel and it is NOT built.** It
needs a Turkish SMS provider under contract (Netgsm, İletimerkezi, Verimor and
others all sell this cheaply), and inventing an endpoint would make the app look
finished when it is not. When that contract exists it plugs into
`panel/api/guest/register.php` at exactly the point the card code is checked
today, and nothing else has to change.

Until then, a guest with no card in their hand is told to ask the restaurant for
it. That is a real friction and you should know it is there.

---

## Known, deliberately left for later

- **Screen brightness.** The karekod screen draws the code on white, which is
  what a counter scanner needs. Raising the phone's own brightness while that
  screen is open would help further on a dimmed evening phone; it needs a
  platform plugin and is not done.
- **Push notifications.** "Bir pul daha, sonra kahveniz bizden" is the obvious
  thing to send and there is nothing sending it. That is Firebase, a server
  half, and a permission — a whole piece of work, not a line.
- **Deleting an account** erases everything on our side and says so plainly, but
  it cannot reach the restaurants' own computers. A till caches a guest so it can
  recognise them offline, and those caches are on machines we do not control.
  The app tells the guest this rather than claiming otherwise.
