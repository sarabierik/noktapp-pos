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
  ///
  /// IN BATCHES, and this matters more than it looks.
  ///
  /// It used to fire all 254 at once with a 700ms connect timeout. A phone is
  /// not a server: Android throttles that many simultaneous sockets, most of
  /// the probes never really got sent, and the ones that did had under a second
  /// to complete. So the sweep reported "no till here" while the till sat on
  /// the same wifi answering the phone's own browser instantly - and the app
  /// fell back to whatever stale address it was holding.
  ///
  /// Thirty-two at a time, a second and a half each, is about four seconds for
  /// a whole subnet and it actually finds things.
  static Future<String?> _sweep() async {
    String? ip;
    try {
      ip = await NetworkInfo().getWifiIP();
    } catch (_) {}
    if (ip == null || !ip.contains('.')) return null;
    final base = ip.substring(0, ip.lastIndexOf('.'));
    final mine = int.tryParse(ip.substring(ip.lastIndexOf('.') + 1)) ?? 0;

    /* Nearest-first. A till is far more often .1 to .50 - a router hands the
       PC an early address and the phones arrive later - so the answer usually
       comes in the first batch or two rather than after all 254. */
    final order = List<int>.generate(254, (i) => i + 1)
      ..sort((a, b) => (a - mine).abs().compareTo((b - mine).abs()));

    for (var i = 0; i < order.length; i += 32) {
      final batch = order.skip(i).take(32).toList();
      final hits = await Future.wait(
          batch.map((n) async => await _ping('$base.$n') ? '$base.$n' : null));
      for (final h in hits) {
        if (h != null) return 'http://$h:$port';
      }
    }
    return null;
  }

  static Future<bool> _ping(String host) async {
    final client = HttpClient()..connectionTimeout = const Duration(milliseconds: 1500);
    try {
      final req = await client.getUrl(Uri.parse('http://$host:$port/api/mobile/ping'));
      final res = await req.close().timeout(const Duration(milliseconds: 1500));
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
