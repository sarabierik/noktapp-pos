'use strict';
/**
 * HUGIN PC Link — the manufacturer's documented REST protocol.
 *
 * SOURCE. developer.hugin.com.tr, PC Link, API v1, read 2026-09-21: "Genel
 * Bakış", "Ortam Bilgisi", "Kimlik Doğrulama", and the Cloud Link overview.
 * Unlike adapters/gmp3.js — whose framing and command names I invented to a
 * plausible shape — every endpoint, header, field and enum below is quoted
 * from that documentation.
 *
 * WHAT IT REPLACES. The old Hugin adapter was Gmp3Adapter on port 7500 with
 * command names of my own devising. Hugin does not speak that. It speaks
 * HTTPS on 4443 and needs no DLL at all: "PC tarafında herhangi bir
 * kütüphaneye (DLL) ihtiyaç duymadan, HTTPS istemci ile Yazarkasa POS
 * iletişimi kurabilirsiniz."
 *
 * WHAT IS STILL NOT KNOWN, AND IS THEREFORE NOT GUESSED. The pages above
 * document pairing (GET /v1/settings) and the two-step sale (POST
 * /v1/documents, then PUT /v1/documents/{id}). They do NOT give the endpoints
 * for X/Z reports, refunds or cancellation — those live in the Postman API
 * reference, which needs an integration account. Those methods below throw
 * ENDPOINT_UNDOCUMENTED rather than inventing a path. A wrong URL is a 404 and
 * a bad afternoon; a wrong *fiscal* message is a wrong tax document in a
 * restaurant that is legally answerable for it.
 *
 * WHAT IS REQUIRED BEFORE THIS MAY TOUCH A DEVICE. GİB's GMP regulation
 * requires a signed integration contract between the sales software and the
 * manufacturer ("satış yazılımları ile üretici arasında entegrasyon sözleşmesi
 * bulunmalıdır"). The VKN on that contract is what gets typed into the device
 * to begin pairing and is sent as X-SoftwareId. No contract, no pairing —
 * which is why an unconfigured device fails here with a message naming that,
 * rather than with a connection error nobody can act on.
 *
 * TLS. See assertPinnedCert() below; it is the most important twenty lines in
 * this file.
 */
const https = require('https');
const os = require('os');
const { FiscalAdapter } = require('./base');
const para = require('../tutar');

const API = '/v1';
const DEFAULT_PORT = 4443;

function fail(message, code, status = 400, extra = {}) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  e.deviceEffects = extra.deviceEffects || 'none';
  Object.assign(e, extra);
  return e;
}

/**
 * Minor units to the string the device expects.
 *
 * "Tüm finansal değerler ISO 4217 kurallarını takip eder. Değerler decimal
 * veya float değil, doğrudan string olarak gönderilir." — so 2250 minor units
 * travels as "22.50", never as 22.5 and never as a Number. The whole money
 * layer is already BigInt-on-strings for exactly this reason; this is the one
 * place it becomes the wire format.
 */
function amountString(minorValue, field = 'amount') {
  const b = para.minor(minorValue, field);
  const neg = b < BigInt(0);
  const digits = (neg ? -b : b).toString().padStart(3, '0');
  return `${neg ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * The X-HardwareId this PC will use.
 *
 * Hugin asks for "PC'ye ait tekil değer (MAC adresi önerilir)" and warns that
 * replacing the PC breaks the pairing and needs a service visit. So the value
 * has to be the same every boot, which rules out anything virtual: Docker
 * bridges, VPN taps and Hyper-V switches appear and disappear and would
 * silently re-key the device.
 *
 * Physical, non-internal interfaces only, and the lowest name alphabetically
 * among them so two interfaces on one machine cannot flip the answer between
 * restarts. Returns null rather than a made-up value - an empty field a human
 * fills in is better than a plausible one that changes next Tuesday.
 */
function primaryMac() {
  const bad = /^(00:00:00:00:00:00)$/i;
  const virtual = /^(docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|wg|zt|utun|Hyper-V|vEthernet)/i;
  const found = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (virtual.test(name)) continue;
    for (const a of ifaces[name] || []) {
      if (a.internal) continue;
      if (!a.mac || bad.test(a.mac)) continue;
      found.push({ name, mac: a.mac.toUpperCase() });
      break;
    }
  }
  if (!found.length) return null;
  found.sort((x, y) => x.name.localeCompare(y.name));
  return found[0].mac;
}

class HuginPcLinkAdapter extends FiscalAdapter {
  constructor(device, options = {}) {
    super(device, options);
    this.host = device.device_ip || null;
    this.port = Number(device.device_port || options.defaultPort || DEFAULT_PORT);
    this.timeout = Number(options.timeout || 60000);
    /*
     * OUR OWN AGENT, WITH KEEP-ALIVE OFF.
     *
     * Node's global agent pools sockets, and a pooled socket is already
     * through its TLS handshake - so 'secureConnect' does not fire again and
     * a certificate check hung off that event runs on the FIRST request and
     * never again. That is a security control that switches itself off after
     * one use, which is worse than not having one, because it looks present.
     *
     * A fiscal device sees a few requests per sale, not thousands per second,
     * so there is nothing to gain from pooling and one real thing to lose.
     * The check below no longer depends on the event either; this is the
     * second lock, not the only one.
     */
    this.agent = options.agent || new https.Agent({
      keepAlive: false,
      maxSockets: 1,
      /*
       * AND NO TLS SESSION CACHE.
       *
       * This one is subtle and it silently disarmed the check above. With the
       * session cache on, the second and every later connection RESUMES the
       * TLS session - and a resumed handshake does not re-send the server's
       * certificate, so getPeerCertificate() comes back empty. Everything
       * looked fine: the handshake event fired, the request succeeded, and the
       * pin was compared against nothing at all.
       *
       * A full handshake per request costs a few milliseconds against a device
       * that sees a handful of requests per sale. The certificate being
       * physically present on every connection is worth more than that.
       */
      maxCachedSessions: 0,
    });
  }
  get name() { return 'hugin'; }

  /* ------------------------------------------------------------------ */
  /* identity                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * The three headers. All of them, every request, byte for byte as they were
   * at pairing: "Bu üç header değerinden herhangi birinin farklı gönderilmesi
   * durumunda cihaz işlemi kabul etmeyip hata dönecektir."
   *
   * X-SerialNo is omitted only for the pairing call, which is the one request
   * whose whole purpose is to learn it.
   */
  headers({ withSerial = true } = {}) {
    const softwareId = this.device.pclink_software_id;
    const hardwareId = this.device.pclink_hardware_id;
    if (!softwareId) {
      throw fail('HUGIN: X-SoftwareId tanimli degil. Ayarlar > OKC ekranindan '
        + 'Hugin entegrasyon sozlesmenizdeki VKN\'yi girin - ayni VKN cihaza da girilir.',
        'PCLINK_NOT_CONFIGURED', 400);
    }
    if (!hardwareId) {
      throw fail('HUGIN: X-HardwareId tanimli degil. Bu bilgisayarin MAC adresi '
        + 'eslesme sirasinda kaydedilir; cihazi yeniden eslestirin.',
        'PCLINK_NOT_CONFIGURED', 400);
    }
    const h = {
      'X-SoftwareId': String(softwareId),
      'X-HardwareId': String(hardwareId),
      'Accept': 'application/json',
    };
    if (withSerial) {
      const serial = this.device.serial_number;
      if (!serial) {
        throw fail('HUGIN: cihaz henuz eslesmedi. Once eslesmeyi tamamlayin.',
          'PCLINK_NOT_PAIRED', 409);
      }
      h['X-SerialNo'] = String(serial);
    }
    return h;
  }

  /* ------------------------------------------------------------------ */
  /* transport                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * THE CERTIFICATE CHECK.
   *
   * The device's certificate cannot be validated the ordinary way, and that is
   * by design rather than by neglect: "Cihaz SSL için ... ÖKC sertifikası
   * kullanır. Subject alanında FQDN yerine Mali Sicil No yer aldığından, web
   * tarayıcılar üzerinden SSL doğrulaması mümkün değildir." Hugin's examples
   * therefore use `curl -k`.
   *
   * `-k` in a product means: accept whatever certificate answers on that
   * address. On a restaurant's wifi — the network with the guest laptop and
   * the tablet the waiters share — that is an invitation to sit between the
   * till and the fiscal device and rewrite receipts.
   *
   * So the trust is moved rather than dropped. The first pairing records the
   * certificate's SHA-256 fingerprint and its Subject, and every request after
   * that demands the same certificate. Different fingerprint, no request. It
   * is the SSH model: verified once, pinned thereafter, and loud when it
   * changes.
   *
   * Two things this deliberately does NOT do:
   *   - it never sets NODE_TLS_REJECT_UNAUTHORIZED, which would disable
   *     verification for every other HTTPS call the till makes, including the
   *     licence check and the backup upload;
   *   - it never silently re-pins. A changed certificate stops the sale and
   *     says so, because the legitimate reasons (device replaced, re-flashed)
   *     are all things a human should confirm.
   */
  /** Compare one certificate against the pin. Throws, or returns it. */
  assertPinnedCert(cert) {
    if (!cert || !cert.fingerprint256) {
      throw fail('HUGIN: cihaz sertifikasi okunamadi.', 'PCLINK_TLS_NO_CERT', 502);
    }
    const pinned = this.device.pclink_cert_sha256;
    if (!pinned) return cert;                       // pairing: nothing to compare yet
    if (cert.fingerprint256 !== pinned) {
      throw fail(
        'HUGIN: cihazin SSL sertifikasi kayitli olandan FARKLI. Islem durduruldu. '
        + 'Cihaz degistirildiyse veya yeniden yuklendiyse Ayarlar > OKC ekranindan '
        + 'yeniden eslestirin; degistirilmediyse agda araya giren bir cihaz olabilir.',
        'PCLINK_CERT_MISMATCH', 502, { deviceEffects: 'none' });
    }
    return cert;
  }

  /**
   * Read the certificate off a socket, if it still has one.
   *
   * A closed or closing socket answers getPeerCertificate() with an empty
   * object - which is why this returns null for "nothing to read" and lets the
   * caller decide, rather than treating a torn-down socket as a failed
   * certificate. The two are not the same and conflating them turns a normal
   * connection close into a false "somebody is on your network".
   */
  peerCertOf(socket) {
    if (!socket || typeof socket.getPeerCertificate !== 'function') return null;
    let cert = null;
    try { cert = socket.getPeerCertificate(); } catch (_) { return null; }
    return cert && cert.fingerprint256 ? cert : null;
  }

  /**
   * Tell whoever is listening what just went over the wire.
   *
   * The adapter deliberately does not know what a database is. It announces;
   * the fiscal layer sets `onExchange` and decides that the answer belongs in
   * fiscal_provider_logs. A throw in the listener must never become a failed
   * sale, so it is swallowed here and nowhere else.
   */
  announce(entry) {
    if (typeof this.onExchange !== 'function') return;
    try { this.onExchange(entry); } catch (_) { /* logging never breaks a sale */ }
  }

  request(method, path, body = null, { withSerial = true, timeoutMs = null } = {}) {
    if (!this.host) {
      throw fail('HUGIN: cihazin IP adresi tanimli degil. Cihaz ekraninda yazan '
        + 'adresi (ornek 192.168.1.50) Ayarlar > OKC ekranina girin.',
        'PCLINK_NO_ADDRESS', 400);
    }
    const headers = this.headers({ withSerial });
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }

    const op = `${method} ${path}`;
    const startedAt = Date.now();
    this.announce({ direction: 'request', operation: op, payload: body === null ? {} : body });

    return new Promise((resolve, reject) => {
      const req = https.request({
        host: this.host,
        port: this.port,
        path: API + path,
        method,
        headers,
        /*
         * Hostname verification is impossible against this certificate (the
         * Subject holds a fiscal serial, not a name), so it is switched off
         * HERE, on this one request, and replaced by the fingerprint checks
         * below - at handshake and again against the socket that carries the
         * response. Never globally: the licence check and the backup upload
         * keep full verification.
         */
        rejectUnauthorized: false,
        agent: this.agent,
        timeout: timeoutMs || this.timeout,
      });

      let settled = false;
      const done = (err, val) => {
        if (settled) return;
        settled = true;
        try { req.destroy(); } catch (_) {}
        /*
         * A failure is the reason this log exists, so it is recorded with the
         * device's own code and wording rather than ours. An X report refused
         * with ERR_DATA_CORRUPT left no trace anywhere before this line.
         */
        this.announce({
          direction: err ? 'error' : 'response',
          operation: op,
          httpStatus: (err && err.httpStatus) || (val && val.httpStatus) || null,
          durationMs: Date.now() - startedAt,
          payload: err
            ? { code: err.code || null, deviceCode: err.deviceCode || null,
                deviceTitle: err.deviceTitle || null, message: String(err.message || '') }
            : (val && val.data) || {},
        });
        err ? reject(err) : resolve(val);
      };

      /*
       * Checked as early as the handshake allows, so a wrong certificate costs
       * nothing more than a connection.
       */
      let verified = null;
      req.on('socket', socket => {
        const check = () => {
          const cert = this.peerCertOf(socket);
          if (!cert) return;                 // nothing readable yet; the response check covers it
          try { verified = this.assertPinnedCert(cert); }
          catch (e) { done(e); }
        };
        if (!socket.connecting && socket.authorized !== undefined) check();
        else socket.on('secureConnect', check);
      });

      req.on('timeout', () => done(fail(
        'HUGIN: cihaz yanit vermedi. Cihazda PC Link uygulamasi acik mi ve ayni agda mi?',
        'PCLINK_TIMEOUT', 504)));

      req.on('error', e => done(fail(
        'HUGIN: cihaza baglanilamadi (' + e.message + ')', 'PCLINK_UNREACHABLE', 502)));

      req.on('response', res => {
        /*
         * And again here, against the socket that actually carried this
         * response - the check that gates the DATA rather than the connection.
         *
         * If the socket has already begun closing it has no certificate left
         * to show; that is not a failure, it is just late. What must never
         * happen is accepting a body when NEITHER check ran, so that case is
         * the one that refuses.
         */
        const late = this.peerCertOf(res.socket);
        if (late) {
          try { verified = this.assertPinnedCert(late); }
          catch (e) { return done(e); }
        } else if (!verified) {
          return done(fail('HUGIN: cihaz sertifikasi dogrulanamadi.',
            'PCLINK_TLS_NO_CERT', 502));
        }
        req.peerCert = verified;
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* handled below */ }
          if (!json || typeof json !== 'object') {
            return done(fail('HUGIN: cihazdan beklenmeyen yanit geldi (HTTP '
              + res.statusCode + ').', 'PCLINK_BAD_RESPONSE', 502));
          }
          /*
           * The documented envelope: status SUCCESS | ERROR, plus data,
           * error {code,title,description} and metadata {timestamp, ...}.
           * An ERROR is the device speaking, so its own code and description
           * are carried through rather than flattened into our wording.
           */
          if (String(json.status).toUpperCase() !== 'SUCCESS') {
            const err = json.error || {};
            return done(fail(
              'HUGIN: ' + (err.description || err.title || 'cihaz islemi reddetti'),
              err.code || 'PCLINK_DEVICE_ERROR', 400,
              { deviceCode: err.code || null, deviceTitle: err.title || null,
                httpStatus: res.statusCode, peerCert: req.peerCert || null }));
          }
          /*
           * httpStatus travels with every success, not just failures: the
           * refund endpoint answers 206 when the device decides the
           * transaction was still voidable and voids it instead. That is a
           * different financial event with a different receipt, and the only
           * thing that distinguishes it is the status code.
           */
          done(null, { data: json.data || {}, metadata: json.metadata || {},
                       httpStatus: res.statusCode,
                       peerCert: req.peerCert || null });
        });
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  /* ------------------------------------------------------------------ */
  /* pairing                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * "Hello world" — the one request that may go without X-SerialNo, because
   * learning the serial is what it is for. The device must be sitting on
   * "Eşleşme bekleniyor" with the contract VKN already entered on its screen.
   *
   * Returns everything the caller has to persist. It does NOT write to the
   * database itself: pairing is a decision a person takes on the ÖKC screen,
   * and an adapter that silently re-pairs is an adapter that can silently
   * attach a till to the wrong device.
   */
  async pair() {
    const res = await this.request('GET', '/settings', null,
      { withSerial: false, timeoutMs: 20000 });
    const serial = res.data && res.data.serialNo;
    if (!serial) {
      throw fail('HUGIN: cihaz seri numarasi dondurmedi. Cihaz "Eslesme bekleniyor" '
        + 'durumunda mi ve girilen VKN sozlesmedeki ile ayni mi?',
        'PCLINK_PAIR_NO_SERIAL', 502);
    }
    const cert = res.peerCert || {};
    return {
      serialNo: String(serial),
      sfaVersion: (res.metadata && res.metadata.sfaVersion) || null,
      certSha256: cert.fingerprint256 || null,
      certSubject: cert.subject
        ? Object.entries(cert.subject).map(([k, v]) => `${k}=${v}`).join(', ').slice(0, 255)
        : null,
      settings: res.data,
    };
  }

  async connect() {
    const r = await this.request('GET', '/settings', null, { timeoutMs: 15000 });
    return { ok: true, device: r.data, sfaVersion: r.metadata.sfaVersion || null };
  }

  /**
   * There is no documented status endpoint. GET /settings answering at all is
   * the honest definition of "the device is there and accepts our headers",
   * and that is what this reports - not a guess at busy / z_needed, which the
   * documentation does not give us a way to know.
   */
  async status() {
    try {
      const r = await this.request('GET', '/settings', null, { timeoutMs: 10000 });
      return { state: 'ready', raw: r.data, sfaVersion: r.metadata.sfaVersion || null };
    } catch (e) {
      if (e.code === 'PCLINK_CERT_MISMATCH') throw e;   // never soften this one
      return { state: 'offline', error: { code: e.code, message: e.message } };
    }
  }

  /* ------------------------------------------------------------------ */
  /* the sale                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Payment types, exactly as documented, uppercase English:
   *   EFT_POS  banka/kredi karti      CASH   nakit
   *   CHECK    cek                    VOUCHER_POS / VOUCHER  yemek karti
   *
   * A method the till knows but this table does not is an error, not a
   * fallback to cash. Sending CASH for a card payment would put the wrong
   * tender on a legal receipt and leave the day-end short.
   */
  /**
   * Our tender name -> PC Link's.
   *
   * The first list here was written from the PC Link table and a guess at what
   * the till would send, and it missed the till's own vocabulary: the app's
   * canonical methods are modules/payments.js METHODS - 'kredi_karti',
   * 'yemek_karti' - and the table only had 'kredi' and 'yemek'. So a real
   * cash sale printed and the very next card sale was refused by our own
   * adapter before it ever reached the device.
   *
   * The till's OWN names come first and are exact; the looser synonyms stay
   * underneath for anything else that reaches this layer. test/hugin.js walks
   * payments.METHODS and asserts every one of them either maps or is named
   * here as deliberately not a device tender - so adding a tender to the till
   * can no longer silently leave a hole in the fiscal path.
   */
  static paymentType(method) {
    const m = String(method || '').toLowerCase();

    /*
     * The till's canonical tenders. All six of them have a PC Link
     * counterpart - the reference's payment table has WIRE, OPEN_ACCOUNT and
     * NO_CHARGE, which an earlier note in this file wrongly said did not
     * exist. Mapping them here does NOT by itself send them to the device:
     * whether ikram and acik hesap belong on a fiscal receipt is a tax
     * decision the owner takes, and the till still decides what to dispatch.
     * This layer's job is to know the vocabulary, not to set the policy.
     */
    if (m === 'nakit') return 'CASH';
    if (m === 'kredi_karti') return 'EFT_POS';
    if (m === 'yemek_karti') return 'VOUCHER';
    if (m === 'havale') return 'WIRE';
    if (m === 'acik_hesap') return 'OPEN_ACCOUNT';
    if (m === 'ikram') return 'NO_CHARGE';

    /* the rest of the documented table, for callers other than the till */
    if (m === 'voucher_pos') return 'VOUCHER_POS';
    if (m === 'puan' || m === 'loyalty_points') return 'LOYALTY_POINTS';
    if (m === 'hediye_karti' || m === 'gift_card') return 'GIFT_CARD';
    if (m === 'sanal_pos' || m === 'vpos') return 'VPOS';
    if (m === 'mobil' || m === 'mobile') return 'MOBILE';
    if (m === 'e_para' || m === 'e-money') return 'E-MONEY';
    if (m === 'bagis' || m === 'charity') return 'CHARITY';
    if (m === 'ulasim_karti' || m === 'transport_card') return 'TRANSPORT_CARD';

    /* synonyms, for anything arriving from elsewhere */
    if (['cash'].includes(m)) return 'CASH';
    if (['kart', 'kredi', 'card', 'credit', 'eft_pos', 'eftpos'].includes(m)) return 'EFT_POS';
    if (['cek', 'check', 'cheque'].includes(m)) return 'CHECK';
    if (['yemek', 'voucher', 'ticket', 'multinet', 'sodexo', 'setcard'].includes(m)) return 'VOUCHER';

    throw fail(`HUGIN: "${method}" odeme tipi PC Link tablosunda yok. `
      + 'Desteklenenler: CASH, EFT_POS, CHECK, VOUCHER, VOUCHER_POS.',
      'PAYMENT_TYPE_UNSUPPORTED', 400);
  }

  /**
   * One sale line. The documented shape is {name, amount, vatRate} where
   * `amount` is the LINE total as a string and `vatRate` is the rate itself.
   *
   * Note what is NOT sent: a department index. The Ingenico protocol carries
   * one and adapters/base.js resolves it from the device's own tables; the
   * PC Link documentation shows a rate on the line instead. Sending a field
   * the documentation does not show would be guessing, so the department stays
   * out until the full API reference says otherwise.
   */
  buildItem(i) {
    const name = String(i.name || '').trim().slice(0, 40);
    if (!name) throw fail('HUGIN: urun adi bos olamaz.', 'ITEM_NAME_EMPTY', 400);
    const lineMinor = i.lineTotalMinor !== undefined && i.lineTotalMinor !== null
      ? i.lineTotalMinor
      : para.mulDecimal(String(i.qty), i.unitPriceMinor, 'line');
    return { name, amount: amountString(lineMinor, 'item.amount'), vatRate: Number(i.vatRate) };
  }

  /**
   * Step 1 of the documented two-step sale: open a document and keep its id.
   * The device now holds an OPEN document; nothing has been printed and no
   * money has moved.
   */
  async startSale(sale) {
    const r = await this.request('POST', '/documents', { docCategory: 'SALE' },
      { timeoutMs: 20000 });
    const id = r.data.documentId || r.data.id;
    if (!id) {
      throw fail('HUGIN: cihaz belge numarasi dondurmedi.', 'PCLINK_NO_DOCUMENT_ID', 502);
    }
    return { providerSessionId: String(id), state: 'waiting_device', raw: r.data };
  }

  /**
   * Step 2: the basket and the payment, in one PUT. The device runs its own
   * payment interface and answers when the customer has finished, so this call
   * is long — a person is tapping a card at the other end of it.
   *
   * Returns the shape the fiscal module already understands, so nothing above
   * this adapter changes.
   */
  /**
   * The whole PUT body, built without touching the device.
   *
   * Split out of finishSale so the orchestrator can build it BEFORE opening a
   * document. Every refusal in here - a price of the wrong type, an empty
   * name, an unknown tender - is one that used to happen with a document
   * already open on the OKC and no documented way to close it.
   */
  buildSalePayload(sale) {
    const body = {
      items: (sale.items || []).map(i => this.buildItem(i)),
      payments: [{
        type: HuginPcLinkAdapter.paymentType(sale.payment && sale.payment.method),
        amount: amountString(sale.payment.amountMinor, 'payment.amount'),
      }],
      /*
       * ASKED FOR ON EVERY SALE, because a refund six days from now cannot be
       * made without it.
       *
       * "Iade isleminde gereken bankId ve bankReferenceNo alanlarinin, orjinal
       * islem esnasinda alinip kayit edilebilmesi icin ... detailedResponse =
       * true gonderilmeli ve gelen cevaptaki alanlar kayit edilmelidir."
       *
       * There is no way to look these up afterwards. A card sale taken without
       * them is a card sale that can never be refunded through PC Link - and
       * nobody finds out until a guest comes back with a complaint. The flag
       * costs nothing on a cash sale and is not worth making conditional.
       */
      detailedResponse: true,
    };
    if (!body.items.length) {
      throw fail('HUGIN: bos sepet gonderilemez.', 'SALE_EMPTY', 400);
    }
    return body;
  }

  async finishSale(providerSessionId, sale) {
    const body = this.buildSalePayload(sale);
    const r = await this.request('PUT', `/documents/${encodeURIComponent(providerSessionId)}`,
      body, { timeoutMs: 180000 });
    const d = r.data || {};
    const state = String(d.status || d.state || '').toUpperCase();
    if (state === 'CANCELLED' || state === 'CANCELED') {
      return { state: 'cancelled', raw: d };
    }
    if (state && state !== 'COMPLETED') {
      return { state: 'waiting_device', raw: d };
    }
    return {
      state: 'approved',
      receipt: {
        /*
         * Field names here follow the documented envelope's data object as far
         * as the pages read give it, and fall back to null rather than to a
         * guessed key. A receipt number the till invented is worse than a
         * receipt number it admits it does not have.
         */
        fiscalReceiptNo: d.receiptNo || d.documentNo || null,
        zNumber: d.zNo || null,
        ekhSerial: this.device.serial_number || null,
        fiscalReference: d.documentId || providerSessionId,
        approvalCode: d.approvalCode || null,
        cardBrand: d.cardBrand || null,
        cardMasked: d.maskedPan || null,
        bank: d.bankName || null,

        /*
         * The two fields a refund needs later. They travel in the detailed
         * response and nowhere else; losing them here loses the ability to
         * refund this sale for good. Read from several spellings because the
         * reference shows them at both levels and a null is better than a
         * wrong guess at which.
         */
        bankId: d.bankId || (d.additionalData && d.additionalData.bankId) || null,
        bankReferenceNo: d.bankReferenceNo
          || (d.additionalData && d.additionalData.bankReferenceNo) || null,
        posTransactionId: d.transactionId
          || (d.additionalData && d.additionalData.transactionId) || null,
      },
      raw: d,
    };
  }

  /**
   * The fiscal module polls; PC Link does not have a poll endpoint, because
   * the PUT above only returns once the device has finished. Reporting
   * "waiting_device" for ever would hang a sale, so this says plainly that the
   * answer arrives with finishSale().
   */
  /**
   * PC Link is request/response, not poll: the PUT in finishSale carries the
   * basket and the payment and its own answer is the result. The orchestrator
   * reads this to know it must CALL finishSale rather than start a poll loop -
   * which is exactly what it failed to do the first time a real S1 was asked
   * for a receipt: the document opened, nothing sent the basket, and the till
   * waited three minutes for an answer to a question it never asked.
   */
  get saleShape() { return 'request_response'; }

  async pollSale() {
    throw fail('HUGIN: PC Link yoklama (poll) kullanmaz - satis sonucu PUT yanitinda doner.',
      'POLL_NOT_APPLICABLE', 400);
  }

  /* ------------------------------------------------------------------ */
  /* the rest of the API reference                                       */
  /* ------------------------------------------------------------------ */

  /*
   * These three used to throw ENDPOINT_UNDOCUMENTED, and that claim was wrong.
   * It meant "not on the pages I read" - the developer portal's landing page -
   * when the full reference was one link away at
   * hugin-pc-link.docs.buildwithfern.com. Hugin support said as much when
   * asked: "dokumanda istekler bulunmaktadir". Read 24.09.2026.
   */

  /**
   * Cancel the OPEN document on the device.
   *
   * This is the endpoint whose absence made a failed sale strand the OKC:
   * startSale opens a document, and without this there was no way to close
   * one, so the device answered every later sale with ERR_INVALID_STATE until
   * somebody restarted it.
   *
   * Documented limits, carried here rather than discovered at the counter:
   * only an ACTIVE document can be cancelled, and a document holding more
   * than one card payment cannot be (ERR_INVALID_CANCEL) - the outstanding
   * payments have to be completed instead.
   */
  async cancelSale(providerSessionId) {
    if (!providerSessionId) {
      throw fail('HUGIN: iptal edilecek belge numarasi yok.', 'PCLINK_NO_DOCUMENT_ID', 400);
    }
    const r = await this.request(
      'POST', `/documents/${encodeURIComponent(providerSessionId)}/cancel`, null,
      { timeoutMs: 30000 });
    const d = r.data || {};
    return {
      state: 'cancelled',
      documentStatus: d.documentStatus || 'CANCELLED',
      receiptNo: d.receiptNo || null,
      raw: d,
    };
  }

  /**
   * X or Z. Z CLOSES THE FISCAL DAY and advances the counters, which is not
   * something to fire by accident, so the kind is validated rather than
   * interpolated.
   *
   * `detail` returns the report as data; `print` puts it on the device's
   * paper and answers 204. Both are the same data model.
   */
  async report(kind = 'X', { print = true } = {}) {
    const k = String(kind || '').toUpperCase();
    if (k !== 'X' && k !== 'Z') {
      throw fail(`HUGIN: "${kind}" rapor turu yok. X veya Z olmali.`,
        'REPORT_KIND_UNSUPPORTED', 400);
    }
    const r = await this.request('POST', `/reports/${k}/${print ? 'print' : 'detail'}`, null,
      { timeoutMs: 120000 });
    return { kind: k, printed: !!print, data: r.data || {}, raw: r.data || {} };
  }

  /**
   * Void a card transaction that has NOT yet been financialised - i.e. before
   * the day-end. Only the device that took the original payment can do it.
   *
   *   POST /v1/pos/transactions/{transactionId}/void
   */
  async voidTransaction(posTransactionId) {
    if (!posTransactionId) {
      throw fail('HUGIN: iptal edilecek banka islem numarasi yok. Satista '
        + 'detailedResponse ile donen transactionId kaydedilmeli.',
        'PCLINK_NO_TRANSACTION_ID', 400);
    }
    const r = await this.request(
      'POST', `/pos/transactions/${encodeURIComponent(posTransactionId)}/void`, null,
      { timeoutMs: 60000 });
    const d = r.data || {};
    return { state: 'voided', transactionId: d.transactionId || posTransactionId,
      amount: d.amount || null, raw: d };
  }

  /**
   * Refund a card payment that HAS been financialised (after the day-end).
   *
   *   POST /v1/pos/refunds   { amount, bankId, bankReferenceNo }
   *
   * Two things the reference is explicit about and that decide the shape of
   * this method:
   *
   *  - bankId and bankReferenceNo cannot be looked up later. They come back in
   *    the original sale's detailed response and must have been stored then.
   *    Without them there is no refund, which is why buildSalePayload asks for
   *    detailedResponse on every sale.
   *
   *  - If the transaction turns out NOT to be financialised yet, the device
   *    redirects to a void and answers 206. That is a different financial
   *    event with a different receipt, so it is reported as such rather than
   *    flattened into "refunded".
   */
  async refund(refund = {}) {
    const amountMinor = refund.amountMinor !== undefined && refund.amountMinor !== null
      ? refund.amountMinor : refund.amount;
    const bankId = refund.bankId;
    const bankReferenceNo = refund.bankReferenceNo;
    if (!bankId || !bankReferenceNo) {
      throw fail(
        'HUGIN: iade icin bankId ve bankReferenceNo gerekli. Bunlar orijinal '
        + 'satisin detayli yanitinda gelir ve sonradan sorgulanamaz; bu satis '
        + 'onlar kaydedilmeden alinmissa PC Link uzerinden iade edilemez.',
        'REFUND_REFERENCE_MISSING', 400, { deviceEffects: 'none' });
    }
    const r = await this.request('POST', '/pos/refunds', {
      amount: amountString(amountMinor, 'refund.amount'),
      bankId: Number(bankId),
      bankReferenceNo: String(bankReferenceNo),
    }, { timeoutMs: 120000 });
    const d = r.data || {};
    /* 206: the device decided this was still voidable and voided it instead */
    const redirected = Number(r.httpStatus) === 206;
    return {
      state: redirected ? 'voided' : 'refunded',
      redirectedToVoid: redirected,
      transactionId: d.transactionId || null,
      approvalCode: d.authorizationCode || null,
      amount: d.amount || null,
      raw: d,
    };
  }
}

module.exports = { HuginPcLinkAdapter, amountString, primaryMac };
