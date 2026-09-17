import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';
import 'discovery.dart';

/// One transport for the whole app.
///
/// Every call first tries the till directly over the restaurant's Wi-Fi, which
/// is fast and works with the internet down. If the till cannot be reached the
/// same request is posted to pos.noktapp.com, which parks it until the PC picks
/// it up. The screens above never need to know which path was used.
class Api {
  static const String panel = 'https://pos.noktapp.com';
  static final Api instance = Api._();
  Api._();

  String? _lanBase;      // e.g. http://192.168.1.20:7451
  String? token;         // long lived device token issued by the till
  int? clientId;
  String deviceId = '';
  String deviceName = 'Telefon';
  bool lastCallUsedRelay = false;

  final _uuid = const Uuid();

  /*
   * EVERY ADDRESS THE TILL HAS EVER OFFERED, NOT ONE.
   *
   * A PC answers on more than one address - a cable and a wifi card, a docking
   * station, a hypervisor - and which of them leads back to the phone changes
   * with the room. Keeping a single string meant the app committed to one
   * guess and had no way back when the guess stopped being true.
   *
   * The till now says where it is on every ping and every bootstrap, so this
   * list is refreshed by the act of using the app. Nobody types anything.
   */
  List<String> _bases = [];

  Future<void> load() async {
    final p = await SharedPreferences.getInstance();
    token = p.getString('token');
    clientId = p.getInt('client_id');
    _lanBase = p.getString('lan_base');
    _bases = p.getStringList('lan_bases') ?? [];
    deviceId = p.getString('device_id') ?? _uuid.v4();
    deviceName = p.getString('device_name') ?? 'Telefon';
    await p.setString('device_id', deviceId);
  }

  Future<void> save() async {
    final p = await SharedPreferences.getInstance();
    if (token != null) await p.setString('token', token!);
    if (clientId != null) await p.setInt('client_id', clientId!);
    if (_lanBase != null) await p.setString('lan_base', _lanBase!);
  }

  Future<void> forget() async {
    final p = await SharedPreferences.getInstance();
    await p.remove('token');
    await p.remove('client_id');
    token = null;
    clientId = null;
  }

  /// An address the waiter typed in himself, remembered across restarts.
  ///
  /// Discovery is mDNS, and mDNS is multicast, and multicast is the first thing
  /// a network drops. A guest wifi with client isolation, a router that will
  /// not forward it, an Android emulator whose NAT does not carry it at all -
  /// in every one of those the till is perfectly reachable and the app cannot
  /// find it. The till's own Telefonlar screen has always ended with "if the
  /// app cannot find the till, type one of these addresses in by hand", and
  /// until now there was nowhere to type it. This is that nowhere.
  ///
  /// A typed address is tried BEFORE discovery and never thrown away by a
  /// failed search - a waiter who has been told the address by his boss should
  /// not have to be told it twice.
  Future<bool> setManualBase(String raw) async {
    var v = raw.trim();
    if (v.isEmpty) return false;
    if (!v.startsWith('http://') && !v.startsWith('https://')) v = 'http://$v';
    while (v.endsWith('/')) {
      v = v.substring(0, v.length - 1);
    }
    /* The address without a port is the common typo, and 7451 is the only port
       the till ever listens on, so fill it in rather than failing. */
    final u = Uri.tryParse(v);
    if (u == null || u.host.isEmpty) return false;
    if (!u.hasPort) v = '$v:7451';
    if (!await _alive(v, timeout: typedProbe, tries: 2)) return false;
    await _learnAddresses([v]);
    _lanBase = v;
    final p = await SharedPreferences.getInstance();
    await p.setString('lan_base', v);
    await p.setBool('lan_base_manual', true);
    return true;
  }

  Future<String?> manualBase() async {
    final p = await SharedPreferences.getInstance();
    return (p.getBool('lan_base_manual') ?? false) ? p.getString('lan_base') : null;
  }

  /// Re-find the till. Called at start-up and whenever a LAN call fails.
  /*
   * AN ADDRESS IS ONLY GOOD WHILE IT ANSWERS.
   *
   * This used to end with:
   *
   *     final typed = await manualBase();
   *     if (typed != null) { _lanBase = typed; return typed; }
   *
   * - a typed address returned forever, without once checking that anything
   * was there. Type 172.16.3.253 in an office on Monday and the app will still
   * be calling 172.16.3.253 in a restaurant on Friday, on a different network,
   * while the till sits at 192.168.2.136 answering every browser on the wifi.
   * The waiter sees "connection timed out" against an address he has never
   * heard of and nothing he does in the app can shift it, because the bad value
   * is what the app reaches for first every time.
   *
   * A remembered address is a hint. It has to earn its place on every use, and
   * when it stops answering it is thrown away rather than retried into the next
   * restaurant.
   */
  Future<String?> locate({bool force = false}) async {
    // 1. what worked last time, if it still answers
    if (_lanBase != null && !force &&
        await _alive(_lanBase!, timeout: typedProbe, tries: 2)) return _lanBase;

    // 2. an address somebody typed or scanned - checked, not assumed
    final typed = await manualBase();
    if (typed != null) {
      if (await _alive(typed, timeout: typedProbe, tries: 2)) {
        _lanBase = typed;
        await save();
        return typed;
      }
      /* It is not there. Forget it NOW: keeping it is what turns one wrong
         afternoon into a phone that can never find a till again. */
      await forgetManualBase();
    }

    // 3. every address the till has told us about, newest list first
    for (final b in _bases) {
      if (b == typed) continue;                 // just tried, just failed
      if (await _alive(b, timeout: typedProbe)) {
        _lanBase = b;
        await save();
        return b;
      }
    }

    // 4. look for it
    final found = await Discovery.find();
    if (found != null) {
      _lanBase = found;
      await save();
      return found;
    }

    /* Nothing answered. Do not hand back a stale address - saying "not found"
       is true, and lets the screen offer to search again or to type one. */
    _lanBase = null;
    return null;
  }

  /// Drop a typed address that has stopped answering.
  Future<void> forgetManualBase() async {
    final p = await SharedPreferences.getInstance();
    await p.setBool('lan_base_manual', false);
    await p.remove('lan_base');
    if (_lanBase != null && !(await _alive(_lanBase!))) _lanBase = null;
  }

  /*
   * HOW LONG TO WAIT BEFORE DECIDING A TILL IS NOT THERE.
   *
   * 1200ms was written for the SWEEP, where 254 addresses are probed at once
   * and almost all of them are nothing. It is the wrong number everywhere else,
   * and using it everywhere cost a real afternoon: a phone on 192.168.1.x
   * reaching a till on 172.16.3.x goes through the router, the first request
   * has to resolve a route it has never used, and on wifi that regularly takes
   * longer than 1200ms. The browser on the same phone loaded the same URL
   * without complaint, because a browser does not give up after a second and a
   * fifth. The app told the owner his correct address was wrong.
   *
   * So: the sweep keeps its short fuse, and an address somebody TYPED - or one
   * the till put inside its own QR - gets five seconds and a second attempt.
   * Those are worth waiting for. Nobody types an address by accident.
   */
  static const Duration sweepProbe = Duration(milliseconds: 1200);
  static const Duration typedProbe = Duration(seconds: 5);

  Future<bool> _alive(String base, {Duration timeout = sweepProbe, int tries = 1}) async {
    for (var i = 0; i < tries; i++) {
      try {
        final r = await http.get(Uri.parse('$base/api/mobile/ping')).timeout(timeout);
        if (r.statusCode == 200) return true;
      } catch (_) {
        /* the first attempt is often what warms the route; try once more */
      }
    }
    return false;
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
        'X-Device-Id': deviceId,
      };

  Future<Map<String, dynamic>> call(String method, String path, [Map<String, dynamic>? body]) async {
    lastCallUsedRelay = false;

    /*
     * TWO THINGS THIS USED TO GET WRONG, BOTH OF THEM FELT BY THE WAITER.
     *
     * The wait was eight seconds. During service, on a wifi that is merely
     * poor rather than absent, every single tap froze for eight seconds before
     * anything happened. A local network either answers quickly or is not
     * going to; two and a half seconds is generous for a PC in the same room.
     *
     * And the failure was swallowed by `catch (_)`, so a phone that simply
     * could not see the till fell through to the relay, the relay answered 401
     * because it has never heard of that device, and the waiter was told
     * "Oturum sona erdi. Tekrar baglanin." He would then re-pair, which cannot
     * help, and phone his boss. The message named the wrong problem, which is
     * worse than naming none: it sent people to fix something that was not
     * broken. Now the reason is carried out of the catch and used.
     */
    ApiException? lanFailure;
    final base = _lanBase ?? await locate();
    if (base != null) {
      try {
        final res = await _send(base + path, method, body, _headers)
            .timeout(const Duration(milliseconds: 2500));
        return _decode(res);
      } on ApiException {
        /* The till answered and said no. That is a real answer - a wrong
           token, a missing permission - and retrying it through the relay
           would only ask the same question a slower way. */
        rethrow;
      } catch (_) {
        lanFailure = ApiException('Kasaya ulasilamiyor. Telefon restoranin '
            'wifi agina bagli mi?', offline: true);
      }
    }

    // 2) through the cloud relay
    if (clientId == null) {
      throw lanFailure ?? ApiException('Kasaya ulasilamadi. Ayni agda misiniz?', offline: true);
    }
    lastCallUsedRelay = true;
    try {
      final res = await http
          .post(Uri.parse('$panel/api/mobile/relay.php'),
              headers: {'Content-Type': 'application/json'},
              body: jsonEncode({
                'client_id': clientId,
                'method': method,
                'path': path,
                'body': body,
                'authorization': token == null ? '' : 'Bearer $token',
                'device_id': deviceId,
              }))
          .timeout(const Duration(seconds: 40));
      return _decode(res);
    } on ApiException catch (e) {
      /*
       * THE LIE THIS EXISTS TO STOP.
       *
       * The relay answers 401 for a device it has never been told about, which
       * is the normal state of affairs when the till is simply sitting on the
       * same wifi and answering perfectly well. Reported as "Oturum sona erdi.
       * Tekrar baglanin." it sent a whole afternoon chasing a session that was
       * never expired. If the local network is what actually failed, say THAT.
       */
      if (e.unauthorised && lanFailure != null) throw lanFailure;
      rethrow;
    } catch (_) {
      throw lanFailure ?? ApiException(
          'Ne kasaya ne internete ulasilabiliyor. Baglantiyi kontrol edin.', offline: true);
    }
  }

  Future<http.Response> _send(String url, String method, Map<String, dynamic>? body, Map<String, String> h) {
    final uri = Uri.parse(url);
    switch (method) {
      case 'GET':
        return http.get(uri, headers: h);
      case 'DELETE':
        return http.delete(uri, headers: h, body: body == null ? null : jsonEncode(body));
      case 'PUT':
        return http.put(uri, headers: h, body: body == null ? null : jsonEncode(body));
      default:
        return http.post(uri, headers: h, body: body == null ? null : jsonEncode(body));
    }
  }

  /// Take the till at its word about where it lives. Called on every decoded
  /// answer, so the list stays current without anybody thinking about it.
  Future<void> _learnAddresses(dynamic raw) async {
    if (raw is! List) return;
    final fresh = raw
        .map((e) => '$e'.trim())
        .where((e) => e.startsWith('http://') || e.startsWith('https://'))
        .toList();
    if (fresh.isEmpty) return;
    /* The one that is working right now stays at the front - it is the one
       that will work next time too, far more often than not. */
    final keep = <String>[if (_lanBase != null) _lanBase!, ...fresh];
    final seen = <String>{};
    _bases = keep.where(seen.add).take(8).toList();
    final p = await SharedPreferences.getInstance();
    await p.setStringList('lan_bases', _bases);
  }

  Map<String, dynamic> _decode(http.Response res) {
    Map<String, dynamic> json;
    try {
      json = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      throw ApiException('Beklenmeyen yanit (${res.statusCode})');
    }
    if (res.statusCode == 401) throw ApiException('Oturum sona erdi. Tekrar baglanin.', unauthorised: true);
    if (res.statusCode == 403) throw ApiException('Bu islem icin yetkiniz yok.');
    if (json['ok'] == false) throw ApiException(json['error']?.toString() ?? 'Islem tamamlanamadi');
    if (json['addresses'] != null) _learnAddresses(json['addresses']);
    return json;
  }

  /// Pairing: the till shows a six digit code, the waiter types it once.
  Future<Map<String, dynamic>> pair({
    required String code,
    required String username,
    required String password,
    required String phoneName,
  }) =>
      _pair({'code': code, 'username': username, 'password': password}, phoneName);

  /// Pairing by camera. The symbol carried the address, so there is nothing
  /// to search for and nothing to type - not the code, not the password.
  Future<Map<String, dynamic>> pairWithQr(PairQr qr, {required String phoneName}) =>
      _pair({'qr_token': qr.token}, phoneName, bases: qr.bases, relayClientId: qr.clientId);

  /// The till's own address, straight off the symbol.
  ///
  /// Tried in the order the till ranked them and BEFORE discovery: a PC with
  /// a docking station and a hypervisor installed answers on three addresses
  /// and only one of them leads back to the phone's own network.
  /// The symbol lists every address the till answers on. Remember them ALL -
  /// the one that works in the kitchen is not always the one that works in the
  /// garden, and next week it may be a third.
  Future<String?> baseFromQr(PairQr qr) async {
    await _learnAddresses(qr.bases);
    for (final b in qr.bases) {
      if (await _alive(b, timeout: typedProbe, tries: 2)) {
        _lanBase = b;
        final p = await SharedPreferences.getInstance();
        await p.setString('lan_base', b);
        await p.setBool('lan_base_manual', true);
        return b;
      }
    }
    return null;
  }

  Future<Map<String, dynamic>> _pair(
      Map<String, dynamic> credentials, String phoneName,
      {List<String> bases = const [], int? relayClientId}) async {
    final payload = {
      ...credentials,
      'device_id': deviceId,
      'device_name': phoneName,
      'platform': 'mobile',
      'app_version': '1.9.0',
    };

    String? base;
    for (final b in bases) {
      if (await _alive(b, timeout: typedProbe, tries: 2)) { base = b; _lanBase = b; break; }
    }
    base ??= await locate(force: true);

    /*
     * THE LOCAL NETWORK IS NOW AN OPTIMISATION, NOT A REQUIREMENT.
     *
     * Pairing used to be possible only while the phone could see the till over
     * Wi-Fi, because /api/auth is a door the relay does not carry. That is why
     * every handset had to be set up inside the building, on the correct
     * network, by somebody who knew which network that was - and why a waiter
     * whose phone was reinstalled on a Saturday could not be brought back
     * until Monday. The till's symbol now carries the tenant number, so when
     * the LAN cannot be reached the same token goes through the cloud instead
     * and the pairing finishes anyway, usually in about a second.
     *
     * Local first all the same: it is faster, it needs no internet at all, and
     * it is the path the restaurant uses every day afterwards.
     */
    http.Response res;
    if (base != null) {
      res = await http.post(Uri.parse('$base/api/auth/pair'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode(payload));
    } else if (relayClientId != null) {
      res = await http
          .post(Uri.parse('$panel/api/mobile/relay.php'),
              headers: {'Content-Type': 'application/json'},
              body: jsonEncode({
                'client_id': relayClientId,
                'method': 'POST',
                'path': '/api/mobile/pair',
                'body': payload,
                'device_id': deviceId,
              }))
          .timeout(const Duration(seconds: 45));
    } else {
      throw ApiException('Kasa bulunamadi. Ilk baglanti icin restoranin wifi '
          'agina baglanin veya kasadaki karekodu okutun.');
    }
    final json = _decode(res);
    token = json['token'] as String;
    clientId = json['client_id'] as int;
    deviceName = phoneName;
    final p = await SharedPreferences.getInstance();
    await p.setString('device_name', phoneName);
    await save();
    return json;
  }

  /// Put a label on a table, or clear it by sending an empty one.
  ///
  /// `kalici` null leaves the sticky flag as the till has it, so renaming a
  /// VIP table does not quietly make its label temporary.
  Future<Map<String, dynamic>> setEtiket(int tableId, String etiket, {bool? kalici}) =>
      call('POST', '/api/mobile/tables/$tableId/etiket', {
        'etiket': etiket,
        if (kalici != null) 'kalici': kalici,
      });

  /// The note on the bill, and the note only the kitchen sees.
  ///
  /// Either may be left out; sending an empty string clears one. They are two
  /// fields on purpose - `notes` is printed on the guest's bill as well as the
  /// kitchen slip, `kitchenNote` never leaves the kitchen.
  Future<Map<String, dynamic>> setNote(int orderId, {String? notes, String? kitchenNote}) =>
      call('POST', '/api/mobile/orders/$orderId/note', {
        if (notes != null) 'notes': notes,
        if (kitchenNote != null) 'kitchen_note': kitchenNote,
      });

  /// Labels already in use in this restaurant, offered as chips so the same
  /// words are not typed twice on four different phones.
  Future<List<String>> etiketler() async {
    try {
      final r = await call('GET', '/api/mobile/etiketler');
      return ((r['etiketler'] ?? []) as List).map((e) => '$e').toList();
    } catch (_) {
      return const [];
    }
  }

  String newOpId() => _uuid.v4();

  /* ------------------------------------------------------------------ *
   *  The handheld's own verbs.                                          *
   *                                                                     *
   *  Thin on purpose: each one is a single request the till already      *
   *  understands, so the screens never build a path by hand and a change *
   *  of endpoint is one line here rather than five across the app.       *
   * ------------------------------------------------------------------ */

  /// Open a bill on a table without putting anything on it yet.
  /// [forceNew] opens a SECOND bill on a table that already has one.
  Future<int> openOrder({required int tableId, bool forceNew = false}) async {
    final r = await call('POST', '/api/mobile/orders',
        {'table_id': tableId, 'force_new': forceNew});
    return r['order_id'] as int;
  }

  /// Fire the kitchen for a bill that is already open. Safe to send twice:
  /// only the lines that have not gone yet go.
  Future<Map<String, dynamic>> sendToStations(int orderId) =>
      call('POST', '/api/mobile/orders/$orderId/send');

  Future<Map<String, dynamic>> order(int orderId) =>
      call('GET', '/api/mobile/orders/$orderId');

  Future<Map<String, dynamic>> billsOnTable(int tableId) =>
      call('GET', '/api/mobile/tables/$tableId/order');

  Future<void> setLabel(int orderId, String label) async {
    await call('POST', '/api/mobile/orders/$orderId/label', {'label': label});
  }

  Future<void> transferTable(int orderId, int tableId) async {
    await call('POST', '/api/mobile/orders/$orderId/transfer', {'table_id': tableId});
  }

  Future<void> discount(int orderId, {double? percent, double? amount, String? reason}) async {
    await call('POST', '/api/mobile/orders/$orderId/discount', {
      if (percent != null) 'percent': percent,
      if (amount != null) 'amount': amount,
      'reason': reason ?? 'Telefondan indirim',
    });
  }

  Future<void> cancelLine(int orderId, int itemId, {double? qty, String? reason}) async {
    await call('DELETE', '/api/mobile/orders/$orderId/items/$itemId', {
      if (qty != null) 'qty': qty,
      'reason': reason ?? 'Telefondan iptal',
    });
  }

  Future<void> printBill(int orderId) async {
    await call('POST', '/api/mobile/orders/$orderId/print');
  }

  /// A second copy of the kitchen slip. Reprints what already went; it does
  /// NOT order anything again.
  Future<void> reprintStationSlip(int orderId, {int? stationId}) async {
    await call('POST', '/api/mobile/orders/$orderId/print/station',
        {if (stationId != null) 'station_id': stationId});
  }

  Future<List<dynamic>> printJobs() async {
    final r = await call('GET', '/api/mobile/print-jobs');
    return (r['jobs'] ?? []) as List<dynamic>;
  }

  Future<void> retryPrintJob(int jobId) async {
    await call('POST', '/api/mobile/print-jobs/$jobId/retry');
  }
}

class ApiException implements Exception {
  final String message;

  /// The till answered and refused us: a token it does not know, an account
  /// that has been retired. Re-pairing is the right advice for this, and ONLY
  /// for this.
  final bool unauthorised;

  /// We never reached anything. Nothing is wrong with the session; the phone
  /// cannot see the till. Telling a waiter to re-pair here sends him to fix
  /// something that is not broken, which is how an afternoon disappears.
  final bool offline;

  ApiException(this.message, {this.unauthorised = false, this.offline = false});
  @override
  String toString() => message;
}

/// What the till's symbol says.
///
///     noktapp://pair?b=http://192.168.1.40:7451&t=<32 hex>&a=<other addresses>
///
/// Parsed strictly and never trusted further than this: `t` must look like the
/// token or the scan is ignored, and the addresses are only ever used as
/// somewhere to try - a wrong one costs a failed probe and nothing else.
class PairQr {
  PairQr(this.token, this.bases, this.clientId);
  final String token;
  final List<String> bases;

  /// The tenant number, straight off the symbol.
  ///
  /// Without it a phone that cannot see any of the addresses above is finished
  /// - and "cannot see them" is the normal case for a waiter pairing at home,
  /// on mobile data, or on a restaurant's guest wifi that isolates clients.
  /// With it the token can be handed to the relay instead and the pairing
  /// completes from anywhere.
  final int? clientId;

  static final _token = RegExp(r'^[0-9a-f]{32}$');

  /// null when this is not one of our symbols - a table QR, a wifi card, a
  /// bottle of ketchup. The scanner keeps looking rather than showing an error
  /// for every barcode that happens to pass the lens.
  static PairQr? parse(String raw) {
    final text = raw.trim();
    if (!text.startsWith('noktapp://pair')) return null;
    final u = Uri.tryParse(text);
    if (u == null) return null;
    final t = (u.queryParameters['t'] ?? '').toLowerCase();
    if (!_token.hasMatch(t)) return null;

    final bases = <String>[];
    void add(String? v) {
      for (final part in (v ?? '').split(',')) {
        var b = part.trim();
        if (b.isEmpty) continue;
        if (!b.startsWith('http://') && !b.startsWith('https://')) b = 'http://$b';
        while (b.endsWith('/')) {
          b = b.substring(0, b.length - 1);
        }
        if (!bases.contains(b)) bases.add(b);
      }
    }
    add(u.queryParameters['b']);
    add(u.queryParameters['a']);
    final c = int.tryParse(u.queryParameters['c'] ?? '');
    return PairQr(t, bases, c);
  }
}
