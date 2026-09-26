'use strict';
/**
 * Blocked adapters — one per fiscal owner, and every one of them refuses.
 *
 * WHY THESE EXIST AT ALL. A restaurant with a PAYGO or an NCR must be able to
 * commission it, see its real name, and be told plainly that NOKTApp cannot
 * transact with it yet. The alternative — the device simply not appearing —
 * looks like a bug and invites somebody to pick a nearby brand instead, which
 * is how a till ends up sending Token commands to a Worldline terminal.
 *
 * WHAT THEY MUST NEVER DO. Return success. Emit a payment confirmation. Touch
 * the device. Create a fiscal document. An adapter with no obtained SDK
 * returns SDK_NOT_OBTAINED, before dispatch, with zero device-side effects.
 * Naming a class after a manufacturer is not an integration, and this file
 * exists so that nobody can mistake one for the other.
 *
 * HOW ONE BECOMES REAL. Obtain the versioned SDK or protocol package and the
 * contract, implement the real adapter, prove it against hardware, record the
 * capability evidence, then remove that owner from BLOCKED below. Not before.
 */
const { FiscalAdapter } = require('./base');

/** Every fiscal owner in the GİB retail register, and why it is blocked. */
const BLOCKED = {
  vera:       { name: 'VERA (MT Bilgi Teknolojileri)',  reason: 'SDK ve sözleşme alınmadı' },
  edata:      { name: 'E DATA / Profilo / Propay',       reason: 'SDK ve sözleşme alınmadı' },
  pavo:       { name: 'PAVO',                            reason: 'SDK ve sözleşme alınmadı' },
  mikrosaray: { name: 'Mikrosaray / inPOS',              reason: 'SDK ve sözleşme alınmadı' },
  infoteks:   { name: 'Infoteks / Fusions',              reason: 'SDK ve sözleşme alınmadı' },
  /*
   * WORLDLINE VE INGENICO - TICARI KARAR, EKSIK SDK DEGIL.
   *
   * Worldline'in GMP3 paketi 21.09.2026'da incelendi: teklif, sozlesme, DLL
   * on bilgilendirmesi, surec ve satin alma dokumanlari. Teknik olarak
   * mumkun; is modeli olarak kabul edilmedi ve NOKTApp bu yolu KULLANMAYACAK.
   *
   * Karari veren sebepler, bir daha acilmasin diye buraya yaziliyor:
   *   - Hash, uygulama + DLL uzerinden aliniyor ve "kod uzerindeki en ufak bir
   *     gelistirmede dahi" degisiyor; degisince sahadaki her cihaz duruyor.
   *     Sozlesme ayrica takvim yilinda en fazla 2 sistem degisikligi
   *     istenebilecegini soyluyor (Madde 4.2). Haftada surum cikaran bir
   *     urunle bagdasmiyor.
   *   - Cihaz basina AYLIK ucret var ve fiyati Worldline tek tarafli
   *     degistirebiliyor (Madde 6).
   *   - Yemek kartlari ve sadakat 3. grup: ayri ticari sozlesme (Madde 1).
   *     Multinet alamayan bir restoran kasasi restoran kasasi degildir.
   *   - Worldline sozlesmeyi 1 ay onceden, gerekce gostermeden ve tazminatsiz
   *     feshedebiliyor; feshedince BAGLI TUM cihazlarin GMP3 lisansi uzaktan
   *     kapatiliyor (Madde 3, Madde 10).
   *
   * Ingenico da buraya dusuyor cunku Turkiye'de Ingenico ODK'lari WORLDLINE
   * lisanslidir: GMP3 sozlesmesi olmadan bir Ingenico cihazina konusmanin
   * yolu yok. Adaptor sinifi (brands.IngenicoAdapter) duruyor - karar geri
   * alinirsa diye - ama gonderim icin secilemez.
   *
   * Bunu geri acmak bir kod degisikligi degil, bir is kararidir.
   */
  worldline:  { name: 'Worldline', decided: true,
                reason: 'Ticari karar: GMP3 sozlesmesi kullanilmayacak (21.09.2026)' },
  ingenico:   { name: 'Ingenico (Worldline lisansli)', decided: true,
                reason: 'Ticari karar: Worldline GMP3 sozlesmesi kullanilmayacak (21.09.2026)' },
  /*
   * TOKEN VE BEKO - TAHMIN YANLIS CIKTI, 23.09.2026.
   *
   * brands.js'teki TokenAdapter/BekoAdapter, TCP 7600 uzerinden GMP-3 JSON
   * konusan bir istemciydi ve alan adlari ('operation', 'body', 'refNo')
   * tarafimdan uyduruldu. developer.tokeninc.com okundu; UCUNUN DE YANLIS
   * oldugu ortaya cikti:
   *
   *   - TCP YOK. X30TR bir Type-C USB cihazidir ve libusbK surucusuyle
   *     libusb uzerinden konusulur; 300TR ise cradle uzerinde FTDI kopruyle
   *     RS232 seri porttur. Hicbir yerde bir TCP portu yok, 7600 de yok.
   *   - GMP-3 JSON YOK. Tel protokolu TLV'dir (2 bayt Type, 4 bayt Length),
   *     paketler SIKISTIRILMIS ve SIFRELENMIS, anahtar bir el sikismadan
   *     sonra uretiliyor. Tag numaralari, checksum, sifre ve sikistirma
   *     algoritmalari YAYINLANMAMIS.
   *   - Dolayisiyla bu protokol disaridan yazilamaz. Uretici kutuphanesi
   *     (IntegrationHub.dll + libusb-1.0.dll, libcrypto-3.dll, zlib1.dll)
   *     zorunludur; .NET, Delphi, C++ ve Java ornekleri var, Node yok.
   *
   * Alternatif yol var ve bizim mimarimize daha yakin: Token X Connect
   * Cloud, HTTPS REST (POST /v1/baskets, JWT Bearer, webhook ile sonuc).
   * DLL gerektirmiyor. Ama base URL ile client-id/client-secret yalnizca
   * sozlesme sonrasi veriliyor.
   *
   * Her iki yol da ayni kapiya cikiyor: okc.entegrasyon@tokeninc.com,
   * bilgi formu, tanisma toplantisi, SOZLESME, sonra test cihazi. Mali bir
   * OKC ile gelistirme yapilmasi acikca yasak.
   *
   * Adaptor sinifi brands.js'te duruyor ama gonderim icin secilemez:
   * calismayacagini bildigimiz bir kodun bir cihaza ulasmayi denemesi,
   * hicbir sey denememesinden daha kotudur.
   */
  token:      { name: 'Token (Token Finansal Teknolojiler)', decided: true,
                reason: 'Protokol dogrulandi: USB/RS232 + uretici DLL gerekiyor, '
                      + 'TCP 7600 tahmini yanlisti. Sozlesme ve test cihazi alinmadi (23.09.2026)' },
  beko:       { name: 'Beko (Token firmware: 300TR / X30TR)', decided: true,
                reason: 'Token ile ayni: USB/RS232 + uretici DLL gerekiyor, '
                      + 'TCP 7600 tahmini yanlisti. Sozlesme ve test cihazi alinmadi (23.09.2026)' },
  panaroma:   { name: 'Panaroma / Olivetti',             reason: 'SDK ve sözleşme alınmadı' },
  enpos:      { name: 'EnPOS',                           reason: 'SDK ve sözleşme alınmadı' },
  ncr:        { name: 'NCR',                             reason: 'SDK ve sözleşme alınmadı' },
  toshiba:    { name: 'Toshiba Global Commerce',         reason: 'SDK ve sözleşme alınmadı' },
  payport:    { name: 'PayPort',                         reason: 'SDK ve sözleşme alınmadı' },
  paygo:      { name: 'PAYGO',                           reason: 'SDK alınmadı; V02 kayıt çakışması çözülmedi' },
  payera:     { name: 'Payera',                          reason: 'V12: portal sözleşmesi P10 mali akışını kapsıyor mu belirsiz' },
  // Fuel-pump owners: a different domain entirely, never offered here.
  turpak:     { name: 'Turpak',  reason: 'Akaryakıt alanı — ayrı şartname gerekir' },
  mepsan:     { name: 'Mepsan',  reason: 'Akaryakıt alanı — ayrı şartname gerekir' },
};

/**
 * Owners we have started on. Not in BLOCKED, and not finished either.
 */
const IN_PROGRESS = ['token', 'hugin', 'profilo'];

/**
 * WHERE EACH STARTED PROTOCOL CAME FROM.
 *
 * "In progress" covers two states that must never be confused, and the day
 * Hugin's real documentation arrived is the day collapsing them became
 * dangerous:
 *
 *   vendor_documented — every endpoint, header and field is quoted from the
 *                       manufacturer's own published protocol. Hugin publishes
 *                       PC Link openly; adapters/hugin.js is written to it.
 *   designed_guess    — the framing and command names are MINE, written to a
 *                       plausible shape because no specification was in hand.
 *                       adapters/gmp3.js says so at the top of the file.
 *
 * Neither one means a device has ever answered. `deviceProven` is the separate
 * fact, and it is false for all of them: reading a specification correctly and
 * having a terminal print a legal receipt are different claims, and only the
 * second one is worth anything to a restaurant being audited.
 *
 * `contract` is the third, legal fact. GİB's GMP regulation requires a signed
 * integration agreement between the sales software and the manufacturer before
 * any of this may touch a production device, so a perfect adapter with no
 * contract is still not allowed to trade.
 */
const PROTOCOL_SOURCE = {
  /*
   * 24.09.2026: bu kayit bir donum noktasi. deviceProven artik tek bir
   * evet/hayir degil, cunku cihaz bize YARISINI kanitladi.
   *
   * KANITLANDI (gercek donanim, HUGIN S1, mali sicil FU00032768):
   *   TLS el sikismasi, sertifika okuma ve sabitleme, X-SoftwareId
   *   basliginin kabulu, GET /v1/settings. Cihaz kendini tanitti:
   *   yazilim surumu 6.6.25-sp, sertifika sahibi
   *   serialNumber=FU00032768, CN=FU00032768, O=HUGIN, C=TR.
   *   Dokumandan okudugumuz alan adlari bu yolda DOGRU cikti.
   *
   * 24.09.2026 AKSAMI: NAKIT MALI FIS BASILDI. Satis govdesinin alan
   * adlari artik varsayim degil - gercek cihaz kabul etti ve fisi yazdirdi.
   *
   * KANITLANMADI:
   *   Kart yolu, yemek karti, iptal ve X/Z raporu. Kart bu cihazda
   *   kanitlanamaz: yuklu tek banka uygulamasi T.C. Merkez Bankasi test
   *   uygulamasi.
   *
   * Bu ayrimi korumak onemli: "cihaz cevap verdi" ile "cihaz dogru fis
   * bastirdi" ayni cumle degil ve ikincisi vergi belgesi uretir.
   */
  hugin: {
    source: 'vendor_documented',
    ref: 'developer.hugin.com.tr — PC Link API v1 (okundu 2026-09-21)',
    transport: 'HTTPS REST :4443',
    deviceProven: 'cash_sale_printed',
    deviceProvenDetail: {
      device: 'HUGIN S1',
      serial: 'FU00032768',
      sfaVersion: '6.6.25-sp',
      date: '2026-09-24',
      /*
       * A MALI FIS CAME OUT OF THE DEVICE. 24.09.2026, nakit, on the test
       * unit FU00032768. Everything in `proven` below has now happened on
       * real hardware rather than in a stub: the documented sale body -
       * items[{name, amount, vatRate}] and payments[{type, amount}] - is the
       * right shape, and the two-step POST /documents then PUT /documents/:id
       * is the right conversation.
       *
       * The card path is still unproven and cannot be proven on THIS device:
       * its only loaded bank application is the T.C. Merkez Bankasi test one,
       * so there is no acquirer to authorise against. That waits on a device
       * with a real uye isyeri agreement.
       */
      proven: ['tls', 'cert_pin', 'x_software_id', 'get_settings',
               'start_sale', 'finish_sale', 'cash_receipt'],
      unproven: ['card_sale', 'meal_card', 'void', 'x_report', 'z_report'],
      note: 'Nakit mali fis basildi 24.09.2026. Kart yolu bu cihazda '
          + 'kanitlanamaz - yuklu tek banka uygulamasi T.C. Merkez Bankasi '
          + 'test uygulamasi, provizyon alinacak bir kurum yok.',
    },
    contract: 'required_not_signed',
    note: 'El sikisma ve ayar okuma gercek cihazda dogrulandi (FU00032768, '
        + '24.09.2026). Satis govdesi hala yalnizca dokumandan; ilk mali fise '
        + 'kadar wire_verified 0 kalir. Iptal / iade / X-Z uc noktalari '
        + 'Postman referansinda; henuz elimizde degil.',
  },
  /*
   * Bu kayit artik bir tahmini degil, tahminin YANLIS CIKTIGINI anlatiyor.
   * 'designed_guess' demek "henuz bilmiyoruz" demekti; artik biliyoruz.
   */
  token: {
    source: 'vendor_documented',
    ref: 'developer.tokeninc.com — Token X Connect Wire + Connect Cloud (okundu 2026-09-23)',
    transport: 'USB/libusb (X30TR) veya RS232/FTDI (300TR), uretici DLL uzerinden; '
             + 'alternatif: Token X Connect Cloud HTTPS REST',
    deviceProven: false,
    contract: 'required_not_signed',
    note: 'ONCEKI TAHMIN (TCP :7600, GMP-3 JSON) YANLISTI. Tel protokolu sifreli '
        + 'TLV; tag numaralari yayinlanmamis, disaridan yazilamaz. IntegrationHub.dll '
        + 'zorunlu. Adaptor bu yuzden engellendi.',
  },
  beko: {
    source: 'vendor_documented',
    ref: 'developer.tokeninc.com — Beko 300TR / X30TR (okundu 2026-09-23)',
    transport: 'Token ile ayni',
    deviceProven: false,
    contract: 'required_not_signed',
    note: 'Beko cihazlari Token firmware calistiriyor; ayni kutuphane, ayni sozlesme.',
  },
  profilo: {
    source: 'designed_guess',
    ref: null,
    transport: 'TCP :7500 (varsayim)',
    deviceProven: false,
    contract: 'required_not_signed',
    note: 'Hugin firmware oldugu VARSAYILIYORDU; dogrulanmadi, PC Link iddia edilmiyor.',
  },
};

/**
 * Two different refusals, and they must not share a code.
 *
 * SDK_NOT_OBTAINED means "nobody has sent us the package yet" - a gap that
 * closes by itself the day it arrives. CLOSED_BY_DECISION means somebody
 * looked at the package and said no. Reporting the second as the first invites
 * the next person to go and fetch a package that is already sitting on the
 * disk, and to reopen a commercial decision as if it were an errand.
 */
function unavailable(ownerKey, op) {
  const info = BLOCKED[ownerKey] || { name: ownerKey, reason: 'Adaptör tanımlı değil' };
  const e = new Error(
    `${info.name}: ${op} yapılamaz. ${info.reason}.`
    + (info.decided ? '' : ' Üretici entegrasyon paketi alındığında bu cihaz açılır.'));
  e.status = 501;
  e.code = info.decided ? 'CLOSED_BY_DECISION' : 'SDK_NOT_OBTAINED';
  e.ownerKey = ownerKey;
  e.deviceEffects = 'none';
  return e;
}

class BlockedAdapter extends FiscalAdapter {
  constructor(device, ownerKey) {
    super(device);
    this.ownerKey = ownerKey || String(device.provider || '').toLowerCase();
  }
  get name() { return `blocked:${this.ownerKey}`; }

  /* ---- read-only, safe, never touches the device --------------------- */

  async describe() {
    const info = BLOCKED[this.ownerKey] || { name: this.ownerKey, reason: 'Adaptör tanımlı değil' };
    return {
      ownerKey: this.ownerKey,
      vendor: info.name,
      implementationState: 'design_only',
      productionEnabled: false,
      blockedReason: info.reason,
      capabilities: [],          // nothing is VERIFIED; the profile stays UNKNOWN
    };
  }

  async inspectDevice() {
    return { reachable: null, note: 'Bu adaptör cihaza bağlanmaz.', deviceEffects: 'none' };
  }

  /* ---- everything that could move money or paper -------------------- */

  async prepare()      { throw unavailable(this.ownerKey, 'İşlem hazırlama'); }
  async dispatch()     { throw unavailable(this.ownerKey, 'Mali işlem'); }
  async queryOutcome() { throw unavailable(this.ownerKey, 'Sonuç sorgulama'); }
  async resume()       { throw unavailable(this.ownerKey, 'İşlemi sürdürme'); }
  async cancel()       { throw unavailable(this.ownerKey, 'İptal'); }
  async startSale()    { throw unavailable(this.ownerKey, 'Satış'); }
  async pollSale()     { throw unavailable(this.ownerKey, 'Satış takibi'); }
  async refund()       { throw unavailable(this.ownerKey, 'İade'); }
  async zReport()      { throw unavailable(this.ownerKey, 'Z raporu'); }
}

/** Build the ADAPTERS entries so index.js does not list fifteen classes. */
function blockedAdapters() {
  const out = {};
  for (const key of Object.keys(BLOCKED)) {
    out[key] = class extends BlockedAdapter {
      constructor(device, o) { super(device, key, o); }
    };
  }
  return out;
}

module.exports = { BLOCKED, IN_PROGRESS, PROTOCOL_SOURCE, BlockedAdapter, blockedAdapters, unavailable };
