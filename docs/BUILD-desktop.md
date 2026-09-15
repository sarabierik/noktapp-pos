# Building the Windows installer

Done on your own Windows machine. You need Node 20+ and PowerShell; everything
else the script fetches once.

```powershell
cd noktapp-pos-desktop
powershell -ExecutionPolicy Bypass -File installer\build.ps1
```

What the script does:

1. `prepare-mariadb.ps1` downloads MariaDB 10.11 (the same version your dump
   came from), strips tests, docs and headers, keeps six binaries, and leaves
   `vendor\mariadb` at about 90 MB. This runs **once**; later builds skip it.
2. `npm install` in `pos-service` (production only) and `desktop-shell`.
3. `electron-builder` packs the shell, the service, the SQL files, the docs and
   the MariaDB folder into one NSIS installer.

Result: `dist\NoktAppPOS-Setup-2.0.0.exe`, roughly 150 MB, and a matching
`.blockmap`. Nothing is downloaded at install time on the customer's machine.

## Publishing an update

1. Upload the `.exe` (and `.blockmap`) to `pos.noktapp.com/indir/`.
2. In the panel: **Sürümler → Yeni sürüm yayınla**. Enter the version, the file
   name, the size and the sha512 the build script printed, tick "güncel sürüm".
3. `latest.yml` is generated from that row. Installed tills check every six
   hours, download in the background and offer the update — with a note
   suggesting they do it after the day-end.

## What the installer does on the customer's PC

* installs to `C:\Program Files\NoktApp POS`
* creates `C:\ProgramData\NoktAppPOS` for the database, logs and backups —
  **this survives uninstall**, deliberately
* adds two firewall rules: TCP 7451 (the phone API) and UDP 5353 (discovery),
  private/domain profiles only
* starts with Windows, so the till is ready when the shutter goes up

First start initialises the bundled database, loads the schema and shows the
online login. It takes about 40 seconds once; after that start-up is a few
seconds.

## Version numbers

Bump `desktop-shell/package.json` → `version`. That number is what the updater
compares, what the panel lists, and what the till shows in Ayarlar.
