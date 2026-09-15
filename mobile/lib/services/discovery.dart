import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:multicast_dns/multicast_dns.dart';
import 'package:network_info_plus/network_info_plus.dart';

/// Finding the till on the restaurant's network.
///
/// The waiter should never type an IP address. We look for the Bonjour service
/// the PC publishes; if the router filters multicast (which cheap ones do), we
/// fall back to sweeping the phone's own subnet, which takes about a second.
class Discovery {
  static const int port = 7451;

  static Future<String?> find({Duration timeout = const Duration(seconds: 4)}) async {
    final viaMdns = await _mdns(timeout);
    if (viaMdns != null) return viaMdns;
    return _sweep();
  }

  /*
   * WHY THIS CLIENT IS BUILT BY HAND.
   *
   * MDnsClient() binds its socket with reusePort: true, and Android does not
   * implement SO_REUSEPORT. The bind throws before a single query goes out:
   *
   *   Dart Socket ERROR: socket_linux.cc:157: 'reusePort' not supported on
   *   this platform.
   *
   * So mDNS discovery has never worked on Android and never could have - not
   * on the emulator, not on a waiter's phone, not on any network. The failure
   * is swallowed by the catch below and the sweep quietly carries the whole
   * feature, which is why it looked like "cheap routers filter multicast"
   * rather than "this code path is dead on the only platform we ship".
   *
   * reuseAddress is enough on its own: two copies of this app on one phone is
   * not a thing that happens, and if it did the second one would fall through
   * to the sweep exactly as it does today.
   */
  static Future<String?> _mdns(Duration timeout) async {
    final client = MDnsClient(rawDatagramSocketFactory: (
      dynamic host,
      int port, {
      bool reuseAddress = true,
      bool reusePort = true,
      int ttl = 1,
    }) {
      return RawDatagramSocket.bind(host, port,
          reuseAddress: true, reusePort: false, ttl: ttl);
    });
    try {
      await client.start();
      const name = '_noktapp-pos._tcp.local';
      await for (final ptr in client
          .lookup<PtrResourceRecord>(ResourceRecordQuery.serverPointer(name))
          .timeout(timeout, onTimeout: (sink) => sink.close())) {
        await for (final srv in client.lookup<SrvResourceRecord>(
            ResourceRecordQuery.service(ptr.domainName))) {
          await for (final ip in client.lookup<IPAddressResourceRecord>(
              ResourceRecordQuery.addressIPv4(srv.target))) {
            return 'http://${ip.address.address}:${srv.port}';
          }
        }
      }
    } catch (_) {
      /* Multicast really is unavailable on some networks - guest wifi with
         client isolation drops it by design - and the sweep below is the
         answer for those. What must not happen again is this catch hiding a
         fault in our own code and looking like the network's fault. */
    } finally {
      client.stop();
    }
    return null;
  }

  /// Ask every address on the local /24 whether it is a NOKTApp till.
  static Future<String?> _sweep() async {
    String? ip;
    try {
      ip = await NetworkInfo().getWifiIP();
    } catch (_) {}
    if (ip == null || !ip.contains('.')) return null;
    final base = ip.substring(0, ip.lastIndexOf('.'));
    final completer = Completer<String?>();
    var pending = 254;

    for (var i = 1; i <= 254; i++) {
      final candidate = '$base.$i';
      _ping(candidate).then((ok) {
        if (ok && !completer.isCompleted) completer.complete('http://$candidate:$port');
        if (--pending == 0 && !completer.isCompleted) completer.complete(null);
      });
    }
    return completer.future.timeout(const Duration(seconds: 6), onTimeout: () => null);
  }

  static Future<bool> _ping(String host) async {
    final client = HttpClient()..connectionTimeout = const Duration(milliseconds: 700);
    try {
      final req = await client.getUrl(Uri.parse('http://$host:$port/api/mobile/ping'));
      final res = await req.close().timeout(const Duration(milliseconds: 900));
      if (res.statusCode != 200) return false;
      final body = await res.transform(utf8.decoder).join();
      return body.contains('noktapp-pos');
    } catch (_) {
      return false;
    } finally {
      client.close(force: true);
    }
  }
}
