# NOKTApp Garson — Google Play

Everything needed to get this on the store, in the order it has to happen.
Your console account (**Noktapp**, personal) is already created.

---

## 1. Build the upload package

```powershell
.\YAYIN.ps1
```

That is the whole build. `YAYIN.ps1` creates the signing key if it is missing,
writes `android\app\build.gradle.kts` from scratch (signing, application id,
target API 35) and produces
`build\app\outputs\bundle\release\app-release.aab`.

You do **not** need `KUR.ps1` any more. It only exists to regenerate the Android
project from nothing, which you already did once.

The bundle is around 64 MB. About 47 MB of that is native debug symbols that
Google strips and keeps for crash reports — what a phone actually downloads is
roughly 25 MB.

### The one irreversible thing

The key lands at **`%USERPROFILE%\noktapp-garson-upload.jks`** and its password
goes in `android\key.properties`.

**Back both up somewhere that is not this PC.** Every future update of this app
must be signed with that same key. Lose it and you cannot update the app ever
again — you have to publish a new listing under a new package id and ask every
restaurant to reinstall. `key.properties` is in `.gitignore`; keep it out of any
zip you send anyone, including me.

Application id: **`com.noktapp.garson`** — permanent from the first upload.

---

## 2. Two Google rules that decide your timeline

**Personal accounts must run a closed test first.** An account registered as
*Personal* (yours is) has to run a closed test with **at least 12 testers who
stay opted in for 14 continuous days** before it can apply for production
access. This is not optional and there is no way to buy past it. Twelve real
Google accounts: your own devices, your staff, your restaurant customers, your
dealers. Start this on day one — the fourteen days run in the background while
you finish everything else.

**Target API level 35.** New apps and updates must target API 35 (Android 15).
`YAYIN.ps1` pins it, so this one is already handled.

---

## 3. Store listing — copy and paste

**App name (30 chars max)**
```
NOKTApp Garson
```

**Short description (80 chars max)**
```
Restoran el terminali: masa, adisyon, mutfağa sipariş. NOKTApp POS kasası ile.
```

**Full description (4000 chars max)**
```
NOKTApp Garson, NOKTApp POS kullanan restoran, kafe ve barlar için garson el
terminali uygulamasıdır. Garson masadan siparişi alır, mutfağa anında gönderir;
kasaya gidip sıra beklemez.

MASALAR
• Bütün salon tek ekranda: dolu masalar, tutarları ve ne kadar süredir açık
  oldukları.
• Masa etiketi: "Ahmet Bey", "doğum günü", "VIP". Etiketi yazan garsonun
  telefonundan yazdığı an bütün telefonlarda ve kasada görünür.
• Masa veya etiket ile arama.

ADİSYON
• Aynı masada birden fazla adisyon; her birine ad verilebilir.
• Hangi ürünün mutfağa gittiği, hangisinin beklediği satır satır görünür.
• Ürün notu ("acısız", "az pişmiş"), adisyon notu ve yalnızca mutfak fişine
  basılan mutfak notu.

ÜRÜN EKLEME
• Kategoriler solda sabit, ürünler sağda: bölüm değiştirmek tek dokunuş.
• Ürün arama, yarım porsiyon, not ile ekleme.

İŞLEMLER
• Mutfağa gönder, hesap fişi, mutfak fişini tekrar yazdır, e-posta ile gönder.
• Masa taşı, indirim, yazdırma kuyruğu.
• Her işlem kasadaki yetkilere bağlıdır: yetkisi olmayan garson işlemi görür,
  "yetki yok" yazar.

BAĞLANTI
• Kasadaki karekodu okutun, bağlantı kurulur. Şifre yazılmaz.
• Telefon ve kasa aynı Wi-Fi ağındaysa doğrudan konuşur, internet gerekmez.
• Aynı ağda değilse karekod internet üzerinden de çalışır.
• Bağlantı koptuğunda alınan siparişler telefonda bekler, bağlantı gelince
  kendiliğinden iletilir.

GEREKLİ
Bu uygulama tek başına çalışmaz. Windows üzerinde çalışan NOKTApp POS kasa
programına ihtiyaç duyar. Bilgi: noktapp.com
```

**Category:** Business · **Tags:** restaurant, point of sale
**Contact email:** destek@noktapp.com · **Website:** https://noktapp.com

---

## 4. Graphics

| What | Size | Note |
|---|---|---|
| App icon | 512 × 512 PNG | the NG mark — `assets/noktapp-garson-icon.png` upscaled |
| Feature graphic | 1024 × 500 PNG | orange background, "NOKTApp Garson" + a phone |
| Phone screenshots | min 2, max 8, ≥ 1080 px | from a real paired phone |

There is no demo mode in this build, so take the screenshots from a phone
paired to a real till with a few open tables on it. Photograph: the table list,
**Ürün Ekle** with the category rail, the **Adisyon** tab, **İşlemler**, and the
etiket sheet. Five is plenty.

On Android: hold **Power + Volume Down**. Any modern phone screenshot is over
1080 px, so no resizing is needed. Do not use mockups — Google wants the real
app, and a listing whose screenshots do not match the app gets pulled.

---

## 5. Privacy policy — required, and it must be a live URL

`gizlilik-garson.html` is in this folder. Upload it to
**https://noktapp.com/gizlilik-garson.html** and paste that URL into the console.
There is no way to skip this; a listing without a reachable policy URL is
rejected.

---

## 6. Data safety form — the honest answers

- **Does your app collect or share user data?** → **Yes**
- Collected: **App activity** (orders taken) and **Device ID**, both:
  - *Collected*, not shared with third parties
  - *Required* (the app cannot work without them)
  - Purpose: **App functionality**
- **Is data encrypted in transit?** → Yes when the cloud relay is used (HTTPS).
  On the restaurant's own Wi-Fi the phone talks to the till directly over the
  local network. Say so in the form's description field; do not claim more.
- **Can users request deletion?** → Yes — the restaurant owner removes the
  device from Ayarlar › Cihazlar on the till.
- **Camera permission:** used only to read the pairing QR. No photo is stored or
  transmitted. Say exactly that.

---

## 7. Content rating & audience

Questionnaire: no violence, no sex, no gambling, no user-generated content
sharing, no ads. It will come out **Everyone / 3+**. Target audience: adults
only (18+) — it is a work tool, which also keeps you out of the Families
programme and its extra review.

---

## 8. The order to do it in

1. `.\YAYIN.ps1` → get the .aab. **Back up the key.**  ✔ done
2. Console → **Create app** → NOKTApp Garson, Turkish, App, Free.  ✔ done
3. Upload the .aab to **Closed testing**, add your 12 testers, send them the
   opt-in link. **The 14 days start now.**
4. While that runs: privacy policy URL, data safety, content rating, store
   listing, graphics.
5. After 14 days → **Apply for production access** → answer their questions
   about who the app is for (restaurants that already run NOKTApp POS).
6. Production release.

Realistically: three weeks from today, most of it waiting.

---

## 9. The one thing that can get you rejected — read this

Google's reviewer opens the app and hits the pairing screen. The app does
nothing until it is paired with a Windows till inside a restaurant, which the
reviewer does not have. An app that stops at a login with no way through is
refused under **App access**, and it is the most ordinary way a working B2B app
fails to reach the store.

There is no demo mode in this build, so you have to give them a real way in.
Do this **before** you submit:

1. Put a till on the internet — the Bella Alanya PC, or any PC running NOKTApp
   POS with the relay enabled and `pos.noktapp.com` reachable. It has to stay
   switched on through the whole review, which can be several days.
2. On that till: Ayarlar › Cihazlar › **Telefon bağla**, generate a code for a
   staff member whose only permission is taking orders. Screenshot the QR.
3. In Play Console → **App content › App access**, choose *All or some
   functionality is restricted*, and give them:
   - the six-digit code, the username and the password
   - the QR screenshot as the attachment
   - this note:

> Uygulama, restoranda çalışan NOKTApp POS kasa programına bağlanır. İnceleme
> için bir kasa açık tutulmaktadır. Giriş ekranında "Kodu elle yaz" deyip
> aşağıdaki altı haneli kodu, kullanıcı adını ve şifreyi girin. Kod 10 dakikada
> bir yenilenir; süresi dolarsa destek@noktapp.com adresine yazın, yeni kod
> gönderelim.

**The ten-minute expiry is the problem.** A reviewer who opens your submission
six hours later finds a dead code and rejects it. Two ways round it, pick one:

- Raise the pairing code lifetime on that one demo till to 30 days. Tell me and
  I will add a setting for it — it is a small change to `lan.createPairCode`.
- Or keep a phone paired and watch for the review, regenerating on request.

The first is the only one that actually works while you sleep.

---

*Every version you upload needs a higher build number. `pubspec.yaml` line 4:
`version: 2.1.0+15` → the number after the + is what Play counts.*
