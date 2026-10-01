'use strict';
/* =====================================================================
   QNB PAROLALARININ DISKTE SIFRELENMESI            src/ebelge/sirla.js
   ---------------------------------------------------------------------
   Noktappera'nin sirla.js'i Electron'un safeStorage'ini kullaniyor ve
   OLDUGU GIBI TASINSAYDI POS'ta SESSIZCE DUZ METIN yazacakti. Sebep
   mimari:

     desktop-shell/src/main.js  ->  spawn(nodeBin, [pos-service/src/index.js],
                                          { env: { ELECTRON_RUN_AS_NODE: '1' } })

   POS servisi Electron'un ICINDE degil, Electron ikilisinin DUZ NODE
   kipinde calisan AYRI bir surecidir. O kipte require('electron') API
   nesnesini degil, calistirilabilir dosyanin yolunu (bir metin) doner;
   safeStorage YOKTUR. Noktappera'nin kodu bu durumda 'duz:' + parola
   yazar - yani isletmenin QNB parolasi MariaDB'de duz metin durur.
   erik'in acik kurali bunun tam tersi.

   COZUM: Windows'un kendi DPAPI'si, PowerShell uzerinden.
   ConvertFrom-SecureString anahtarsiz kullanildiginda DPAPI'yi
   CurrentUser kapsaminda uygular - safeStorage ile AYNI koruma: anahtar
   Windows kullanici hesabina baglidir, dosya baska bilgisayara ya da
   baska kullaniciya kopyalanirsa cozulemez.

   PAROLA KOMUT SATIRINDAN GECMEZ. Hem sifreleme hem cozme icin deger
   STDIN ile verilir; komut satiri gorev yoneticisinde ve olay
   kayitlarinda gorunur, stdin gorunmez.

   SINIR, acikca: bu, "kasa bilgisayarini ele geciren biri hicbir sey
   yapamaz" demek DEGILDIR. O kullanici olarak oturum acmis bir saldirgan
   ayni PowerShell'i calistirip cozdurebilir. DPAPI'nin korudugu sey
   DOSYANIN KENDISININ tasinmasidir: calinan yedek, kopyalanan disk,
   e-postayla giden veritabani. Gercekte olan senaryolar bunlar.

   SIFRELEME YOKSA (Windows disi, PowerShell yok) deger 'duz:' ile
   ISARETLENIR ve korumaVar() false doner. Sessizce duz metin yazmiyoruz:
   ekran hangi bicimde saklandigini soyleyebiliyor.
   ===================================================================== */
const { execFileSync } = require('child_process');

let _safe = null, _safeDenendi = false;
let _psVar = null;

/* Electron ICINDE calisiyorsak (bugun degiliz, yarin olabilir) safeStorage
   en iyi secenek: surec baslatmadan, ayni korumayla. */
function safeStorage() {
  if (_safeDenendi) return _safe;
  _safeDenendi = true;
  try {
    const e = require('electron');
    if (e && e.safeStorage && typeof e.safeStorage.isEncryptionAvailable === 'function'
        && e.safeStorage.isEncryptionAvailable()) _safe = e.safeStorage;
  } catch (err) { _safe = null; }
  return _safe;
}

function ps(betik, girdi) {
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', betik],
    { input: girdi, encoding: 'utf8', windowsHide: true, timeout: 15000,
      maxBuffer: 1 << 20 }).trim();
}

function psVar() {
  if (_psVar !== null) return _psVar;
  if (process.platform !== 'win32') { _psVar = false; return _psVar; }
  try {
    /* Gercekten calisiyor mu: sinama degeri sifrelenip geri cozuluyor mu?
       "powershell.exe var" yetmez - kisitlanmis bir makinede komut
       calismayabilir ve bunu ilk parolada degil SIMDI ogrenmek isteriz. */
    const c = ps('$p=[Console]::In.ReadToEnd(); ConvertTo-SecureString -String $p -AsPlainText -Force | ConvertFrom-SecureString', 'sinama');
    _psVar = /^[0-9a-f]{16,}$/i.test(c) && psCoz(c) === 'sinama';
  } catch (e) { _psVar = false; }
  return _psVar;
}

function psSifrele(duz) {
  return ps('$p=[Console]::In.ReadToEnd(); ConvertTo-SecureString -String $p -AsPlainText -Force | ConvertFrom-SecureString', duz);
}
function psCoz(sifreli) {
  return ps('$c=[Console]::In.ReadToEnd().Trim(); $s=ConvertTo-SecureString $c;'
    + ' $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);'
    + ' [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b));'
    + ' [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)', sifreli);
}

/* Cozulmus degerler surec omru boyunca bellekte tutulur: her QNB cagrisi
   icin 200 ms'lik bir PowerShell baslatmak, gun icinde yuzlerce fatura
   kesen bir kasada hissedilir. Disk hep sifreli kalir. */
const _acik = new Map();

/** Sifreleme bu kurulumda GERCEKTEN calisiyor mu? Ekranda durustce soylemek icin. */
function korumaVar() { return !!safeStorage() || psVar(); }

/** Hangi yontemin kullanildigi - ayar ekraninda yaziyor. */
function yontem() {
  if (safeStorage()) return 'electron-safestorage';
  if (psVar()) return 'windows-dpapi';
  return 'yok';
}

/** Duz metni saklanacak bicime cevirir. */
function sar(duz) {
  const s = String(duz == null ? '' : duz);
  if (s === '') return '';
  const ss = safeStorage();
  if (ss) {
    try { return 'dpapi:' + ss.encryptString(s).toString('base64'); } catch (err) { /* asagi dus */ }
  }
  if (psVar()) {
    try {
      const c = 'ps:' + psSifrele(s);
      _acik.set(c, s);
      return c;
    } catch (err) { /* asagi dus */ }
  }
  /* Sifreleme patlarsa veriyi KAYBETMEK yerine duz saklayip ISARETLIYORUZ.
     Sessiz veri kaybi, zayif saklamadan daha kotudur - ve 'duz:' oneki
     ekranin "korumasiz" diyebilmesini saglar. */
  return 'duz:' + s;
}

/** Saklanan bicimi duz metne cevirir. Eski (isaretsiz) degerler duz sayilir. */
function ac(saklanan) {
  const s = String(saklanan == null ? '' : saklanan);
  if (s === '') return '';
  if (s.startsWith('duz:')) return s.slice(4);
  if (_acik.has(s)) return _acik.get(s);
  if (s.startsWith('dpapi:')) {
    const ss = safeStorage();
    if (!ss) throw new Error('Parola bu bilgisayarin Windows hesabina bagli olarak sifrelenmis; '
      + 'bu kipte cozulemiyor. Kasa programini normal sekilde acin.');
    try {
      const v = ss.decryptString(Buffer.from(s.slice(6), 'base64'));
      _acik.set(s, v); return v;
    } catch (err) { throw new Error(kopyaHatasi()); }
  }
  if (s.startsWith('ps:')) {
    if (!psVar()) throw new Error('Parola Windows DPAPI ile sifrelenmis; bu makinede cozulemiyor.');
    try {
      const v = psCoz(s.slice(3));
      _acik.set(s, v); return v;
    } catch (err) { throw new Error(kopyaHatasi()); }
  }
  return s;                      /* eski kurulumlardan kalan duz deger */
}

function kopyaHatasi() {
  return 'Parola cozulemedi. Bu genellikle veritabaninin BASKA bir bilgisayardan ya da '
    + 'baska bir Windows kullanicisindan kopyalandigi anlamina gelir - koruma da zaten '
    + 'bunun icin var. QNB parolasini Faturalar > e-Belge ekranindan yeniden girin.';
}

/** Deger sifreli mi? Ekranda "korumali / korumasiz" demek icin. */
function sifreliMi(saklanan) {
  const s = String(saklanan || '');
  return s.startsWith('dpapi:') || s.startsWith('ps:');
}

/** Yedek alinirken parolalar disari CIKMAZ. */
function yedekDisi(deger) { return sifreliMi(deger) || String(deger || '').startsWith('duz:') ? '' : deger; }

module.exports = { sar, ac, korumaVar, sifreliMi, yontem, yedekDisi };
