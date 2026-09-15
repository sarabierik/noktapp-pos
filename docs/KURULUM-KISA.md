# The short version — what you actually touch

Three files, in this order.

## 1. `panel-pos.noktapp.com.zip` → your server

cPanel → **MySQL Databases**: create `tecofi_nokpos_panel` + a user of the same
name, tick **All Privileges**. Write the password down.

cPanel → **File Manager** → open the `pos.noktapp.com` folder → **Upload** this
zip → right-click it → **Extract** → then move everything out of the `panel/`
folder it creates into the root, and delete the empty `panel/` folder.

Edit `lib/config.php` (right-click → Edit). Three things:

```php
'db' => [ 'name' => 'tecofi_nokpos_panel',
          'user' => 'tecofi_nokpos_panel',
          'pass' => 'the password you just wrote down' ],

'pass_db' => [ 'name' => 'tecofi_nokpos',
               'user' => 'tecofi_nokpos',
               'pass' => 'the password of your EXISTING pos database' ],

'backup_dir' => '/home/YOUR_CPANEL_USER/noktapp-backups',
```

Then File Manager → go up one level from `public_html` → **+ Folder** →
`noktapp-backups`.

Open `https://pos.noktapp.com/setup.php`, create your login, **delete
setup.php**, then log in at `/admin/` and add your first restaurant.

## 2. `KUR.bat` → your Windows PC

Right-click → **Yönetici olarak çalıştır**. That is the whole step. It installs
Node if you do not have it, builds the installer, and opens the folder it landed
in. 10–15 minutes the first time.

## 3. `NoktAppPOS-Setup-2.1.1.exe` → the restaurant PC

Double-click, accept the Windows prompt. Then the e-mail and password you set in
step 1. The wizard asks four questions and the till is selling.

---

Stuck at any point: send me the error text or a screenshot and I will fix it.
