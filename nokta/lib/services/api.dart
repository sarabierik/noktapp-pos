import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../models/models.dart';

/// Thrown for anything the guest can be told about in one sentence.
///
/// `code` carries the machine-readable half where the API sends one, because
/// two of them change what the app does rather than just what it says:
/// NEEDS_PROOF sends the sign-up screen to the card-code field, and
/// NEEDS_REGISTER sends the login screen to sign-up.
class ApiError implements Exception {
  final String message;
  final String? code;
  final int status;
  ApiError(this.message, {this.code, this.status = 0});

  bool get unauthorised => status == 401;
  @override
  String toString() => message;
}

/// One transport for the whole app.
///
/// Unlike the waiter app there is no local network path here: a guest is not on
/// the restaurant's wifi and has no business being on it. Everything goes to
/// pos.noktapp.com over HTTPS, with the session token in the Authorization
/// header - never in the URL, because a URL ends up in logs and in history.
class Api {
  static const String base = 'https://pos.noktapp.com/api/guest';
  static final Api instance = Api._();
  Api._();

  String? token;
  Guest? me;

  static const _kToken = 'nokta_token';

  Future<void> load() async {
    final p = await SharedPreferences.getInstance();
    token = p.getString(_kToken);
  }

  Future<void> _keep(String t) async {
    token = t;
    final p = await SharedPreferences.getInstance();
    await p.setString(_kToken, t);
  }

  Future<void> forget() async {
    token = null;
    me = null;
    final p = await SharedPreferences.getInstance();
    await p.remove(_kToken);
  }

  bool get signedIn => token != null && token!.isNotEmpty;

  /* ---------------------------------------------------------------- */

  Future<Map<String, dynamic>> _call(String method, String path,
      {Map<String, dynamic>? body, bool auth = true}) async {
    final uri = Uri.parse('$base/$path');
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (auth && signedIn) headers['Authorization'] = 'Bearer $token';

    http.Response res;
    try {
      final client = http.Client();
      try {
        final req = http.Request(method, uri)..headers.addAll(headers);
        if (body != null) req.body = jsonEncode(body);
        /*
         * THE TIMEOUT HAS TO COVER THE SEND, WHICH IS THE PART THAT HANGS.
         *
         * This used to read
         *     Response.fromStream(await client.send(req)).timeout(...)
         * and the `await client.send(req)` inside the parentheses runs to
         * completion BEFORE .timeout() is ever attached. Connecting and
         * sending - a phone on a lift's worth of signal, a captive portal
         * that accepts the connection and then says nothing - was therefore
         * not covered at all, and the guest watched a spinner with no end.
         * The twenty seconds only ever guarded reading the body back, which
         * is the fast half.
         *
         * Wrapping the whole thing is the fix, and it has to be one future.
         */
        res = await Future(() async =>
                http.Response.fromStream(await client.send(req)))
            .timeout(const Duration(seconds: 20));
      } finally {
        client.close();
      }
    } on TimeoutException {
      throw ApiError('Sunucu yanıt vermedi. Bağlantınızı kontrol edip tekrar deneyin.');
    } on SocketException {
      throw ApiError('İnternet bağlantısı yok gibi görünüyor.');
    } catch (_) {
      throw ApiError('Bağlantı kurulamadı.');
    }

    Map<String, dynamic> j;
    try {
      final decoded = jsonDecode(res.body);
      j = decoded is Map ? Map<String, dynamic>.from(decoded) : <String, dynamic>{};
    } catch (_) {
      /* A proxy page, a maintenance screen, an HTML error - anything that is not
         our JSON. Saying "sunucu hatası" is honest; pretending to parse it is
         how a screen shows nonsense. */
      throw ApiError('Sunucudan beklenmeyen bir yanıt geldi (${res.statusCode}).',
          status: res.statusCode);
    }

    if (res.statusCode == 200 && j['ok'] == true) return j;

    /* A dead session is not an error to show - it is a fact the app has to act
       on, by sending the guest back to the login screen. The stored token goes
       first so nothing retries with it. */
    if (res.statusCode == 401) {
      await forget();
      throw ApiError(
          '${j['error'] ?? 'Oturumunuz sona erdi. Tekrar giriş yapın.'}',
          code: j['code'] as String?, status: 401);
    }
    throw ApiError('${j['error'] ?? 'İşlem tamamlanamadı.'}',
        code: j['code'] as String?, status: res.statusCode);
  }

  /* ------------------------------ auth ------------------------------ */

  Future<Guest> register({
    required String phone,
    required String firstName,
    String? lastName,
    String? email,
    required String password,
    String? cardCode,
  }) async {
    final j = await _call('POST', 'register.php', auth: false, body: {
      'phone': phone,
      'first_name': firstName,
      if (lastName != null && lastName.isNotEmpty) 'last_name': lastName,
      if (email != null && email.isNotEmpty) 'email': email,
      'password': password,
      if (cardCode != null && cardCode.isNotEmpty) 'card_code': cardCode,
      'device': 'NOKTA telefon',
    });
    await _keep('${j['token']}');
    me = Guest.fromJson(Map<String, dynamic>.from(j['guest'] as Map));
    return me!;
  }

  Future<Guest> login({required String phone, required String password}) async {
    final j = await _call('POST', 'login.php', auth: false, body: {
      'phone': phone, 'password': password, 'device': 'NOKTA telefon',
    });
    await _keep('${j['token']}');
    me = Guest.fromJson(Map<String, dynamic>.from(j['guest'] as Map));
    return me!;
  }

  Future<void> logout({bool everywhere = false}) async {
    try {
      await _call('POST', 'logout.php', body: {'all': everywhere});
    } catch (_) {
      /* Signing out locally must work with no signal at all. The server row
         expires on its own. */
    }
    await forget();
  }

  /* ------------------------------ cards ------------------------------ */

  /// Kartlarım. Returns the groups and sets [me] from the same reply, so the
  /// home screen does not need a second round trip to know the guest's name.
  Future<List<CardGroup>> cards() async {
    final j = await _call('GET', 'cards.php');
    if (j['guest'] is Map) {
      me = Guest.fromJson(Map<String, dynamic>.from(j['guest'] as Map));
    }
    return ((j['restaurants'] as List?) ?? const [])
        .map((e) => CardGroup.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<({LoyaltyCard card, List<Movement> events})> card(
      int tenantId, int programId) async {
    final j = await _call('POST', 'card.php',
        body: {'tenant_id': tenantId, 'program_id': programId});
    final card = LoyaltyCard.fromJson(Map<String, dynamic>.from(j['card'] as Map));
    final events = ((j['events'] as List?) ?? const []).map((e) {
      final m = Map<String, dynamic>.from(e as Map);
      /* card.php answers with the card's own movements and leaves out the
         restaurant, which the caller already knows. */
      m['tenant_id'] ??= tenantId;
      m['restaurant'] ??= card.restaurant;
      m['program_id'] ??= programId;
      return Movement.fromJson(m);
    }).toList();
    return (card: card, events: events);
  }

  Future<List<Movement>> history({int limit = 100}) async {
    final j = await _call('GET', 'history.php?limit=$limit');
    return ((j['events'] as List?) ?? const [])
        .map((e) => Movement.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<List<Place>> places() async {
    final j = await _call('GET', 'restaurants.php');
    return ((j['restaurants'] as List?) ?? const [])
        .map((e) => Place.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  /* ------------------------------ the code ------------------------------ */

  Future<OneTimeCode> mintCode() async {
    final j = await _call('POST', 'qr.php', body: const {});
    return OneTimeCode.fromJson(j);
  }

  /* ------------------------------ profile ------------------------------ */

  Future<Guest> profile() async {
    final j = await _call('GET', 'profile.php');
    me = Guest.fromJson(Map<String, dynamic>.from(j['guest'] as Map));
    return me!;
  }

  Future<Guest> saveProfile({
    String? firstName,
    String? lastName,
    String? email,
    String? birthDate,
  }) async {
    final j = await _call('POST', 'profile.php', body: {
      if (firstName != null) 'first_name': firstName,
      if (lastName != null) 'last_name': lastName,
      if (email != null) 'email': email,
      if (birthDate != null) 'birth_date': birthDate,
    });
    me = Guest.fromJson(Map<String, dynamic>.from(j['guest'] as Map));
    return me!;
  }

  Future<void> changePassword(String current, String next) async {
    await _call('POST', 'profile.php',
        body: {'current_password': current, 'new_password': next});
  }

  /// Returns the server's own account of what it erased and what it could not,
  /// so the confirmation screen quotes it rather than inventing a summary.
  Future<Map<String, dynamic>> deleteAccount(String password) async {
    final j = await _call('POST', 'delete.php', body: {'password': password});
    await forget();
    return j;
  }
}
