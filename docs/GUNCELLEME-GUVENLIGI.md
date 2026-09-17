# The update channel, and why it is signed

**Read this before publishing a release. There is one step in it that is easy to
forget and that will look like "updates are broken" if you do.**

---

## The problem this solves

The update feed is `https://pos.noktapp.com/indir`, on shared hosting. A till
checks it every six hours, downloads what it finds, and installs it with
administrator rights.

Before this change, the only integrity check was the `sha512` written inside
`latest.yml`. That hash sits in the same folder as the file it describes, so
anyone who can write to that folder writes both. The checksum proves the
download was not corrupted on the way. It proves nothing about who produced it.

So one stolen cPanel password meant administrator-level code on every till in
the field, within six hours, arriving through a dialog restaurants have been
trained to click.

## How it works now

`latest.yml` is signed on the machine that builds the release, with an Ed25519
private key that has never been on the web server. The till carries the public
half inside the application and checks, in this order:

1. Fetch `latest.yml` and `latest.yml.imza`.
2. Verify the signature over the exact bytes of the manifest. **If it fails,
   nothing is downloaded.**
3. Check that the version electron-updater found matches the signed one — so a
   host serving one answer to us and another to the updater is caught rather
   than believed.
4. Download.
5. Hash the downloaded installer and compare it against the hash inside the
   *signed* manifest.
6. Only then offer to install.

An attacker who owns the web host can serve anything they like. Without the
private key, no till will run it.

`autoDownload` is now **false**: nothing is fetched until the signature has
checked out.

### What this is not

This is **not** the Windows code-signing certificate. That is a separate
purchase solving a separate problem — the *"Windows protected your PC"* screen
the customer sees on first install. Buy it too. But it is not what protects the
update channel; this is.

---

## One-time setup

```
node desktop-shell/scripts/anahtar-uret.js
```

Writes the private key to `~/.noktapp/guncelleme-ozel-anahtar.pem` and prints
the public half. Paste that into `desktop-shell/src/guncelleme-anahtar.js`:

```js
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----`;
```

Commit that file. Public keys are meant to be public.

**Back up the private key offline and never commit it.** The bench has a check
that fails if anything key-shaped appears in the repository, but that check is a
safety net, not a permission slip.

While `PUBLIC_KEY` is empty, automatic updates are **disabled** rather than
unverified — deliberately. An update nobody checked is worse than no update.

---

## Every release, three steps

```
npm run dist                                            # build
node desktop-shell/scripts/imzala.js dist/latest.yml    # sign
```

Then upload **all three files together**:

```
latest.yml
latest.yml.imza      ← forget this one and every till refuses the update
NoktApp-POS-Setup-x.y.z.exe
```

`imzala.js` reads the signature back and verifies it before exiting, so it will
not hand you something that does not check out.

---

## If the private key is lost

Generate a new pair, ship it in the next build. Tills running the old public key
stop auto-updating until they are updated by hand. Annoying, survivable.

## If the private key is stolen

Not survivable quietly. An attacker can sign releases as you. Generate a new
pair, ship it, and tell your customers. Treat that key the way you would treat
the master key to every restaurant you have sold to — because that is what it is.

---

## Rolling back a bad release

`allowDowngrade` stays **on**, and that is deliberate. Publishing the previous
version is the only rollback lever there is; without it a release that breaks
the till leaves every customer on the broken build until a fix is written, built,
signed and published.

The risk it used to carry — someone forcing an old build onto a till — is gone:
an attacker would have to sign the old manifest, and they cannot.
