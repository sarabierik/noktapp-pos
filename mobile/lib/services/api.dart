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

  Future<void> load() async {
    final p = await SharedPreferences.getInstance();
    token = p.getString('token');
    clientId = p.getInt('client_id');
    _lanBase = p.getString('lan_base');
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
    if (!await _alive(v)) return false;
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
  Future<String?> locate({bool force = false}) async {
    if (_lanBase != null && !force && await _alive(_lanBase!)) return _lanBase;
    final found = await Discovery.find();
    if (found != null) {
      _lanBase = found;
      await save();
      return found;
    }
    /* Discovery came back empty. If somebody typed an address in, it stands -
       the till may simply have been busy for the second the ping allowed. */
    final typed = await manualBase();
    if (typed != null) {
      _lanBase = typed;
      return typed;
    }
    return found;
  }

  Future<bool> _alive(String base) async {
    try {
      final r = await http
          .get(Uri.parse('$base/api/mobile/ping'))
          .timeout(const Duration(milliseconds: 1200));
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
        'X-Device-Id': deviceId,
      };

  Future<Map<String, dynamic>> call(String method, String path, [Map<String, dynamic>? body]) async {
    lastCallUsedRelay = false;

    // 1) straight to the till over the local network
    final base = _lanBase ?? await locate();
    if (base != null) {
      try {
        final res = await _send(base + path, method, body, _headers)
            .timeout(const Duration(seconds: 8));
        return _decode(res);
      } catch (_) {
        // the phone probably left the restaurant's wifi - fall through
      }
    }

    // 2) through the cloud relay
    if (clientId == null) {
      throw ApiException('Kasaya ulasilamadi. Ayni agda misiniz?');
    }
    lastCallUsedRelay = true;
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

  Map<String, dynamic> _decode(http.Response res) {
    Map<String, dynamic> json;
    try {
      json = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      throw ApiException('Beklenmeyen yanit (${res.statusCode})');
    }
    if (res.statusCode == 401) throw ApiException('Oturum sona erdi. Tekrar baglanin.', unauthorised: true);
    if (json['ok'] == false) throw ApiException(json['error']?.toString() ?? 'Islem tamamlanamadi');
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
      _pair({'qr_token': qr.token}, phoneName, bases: qr.bases);

  /// The till's own address, straight off the symbol.
  ///
  /// Tried in the order the till ranked them and BEFORE discovery: a PC with
  /// a docking station and a hypervisor installed answers on three addresses
  /// and only one of them leads back to the phone's own network.
  Future<String?> baseFromQr(PairQr qr) async {
    for (final b in qr.bases) {
      if (await _alive(b)) {
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
      Map<String, dynamic> credentials, String phoneName, {List<String> bases = const []}) async {
    String? base;
    for (final b in bases) {
      if (await _alive(b)) { base = b; _lanBase = b; break; }
    }
    base ??= await locate(force: true);
    if (base == null) {
      throw ApiException('Kasa bulunamadi. Ilk baglanti icin restoranin wifi agina baglanin.');
    }
    final res = await http.post(Uri.parse('$base/api/auth/pair'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          ...credentials,
          'device_id': deviceId,
          'device_name': phoneName,
          'platform': 'mobile',
          'app_version': '1.2.0',
        }));
    final json = _decode(res);
    token = json['token'] as String;
    clientId = json['client_id'] as int;
    deviceName = phoneName;
    final p = await SharedPreferences.getInstance();
    await p.setString('device_name', phoneName);
    await save();
    return json;
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
  final bool unauthorised;
  ApiException(this.message, {this.unauthorised = false});
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
  PairQr(this.token, this.bases);
  final String token;
  final List<String> bases;

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
    return PairQr(t, bases);
  }
}
