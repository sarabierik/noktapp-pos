import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'api.dart';

/// The offline queue.
///
/// A waiter's phone loses signal in a garden or a basement. Orders typed while
/// that happens are stored here and replayed as soon as the till is reachable
/// again. Every entry carries an op_id, so replaying twice cannot create the
/// same order twice - the till recognises the id and returns the first answer.
class OfflineQueue {
  static const _key = 'offline_ops';

  static Future<List<Map<String, dynamic>>> _read() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_key);
    if (raw == null) return [];
    return (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
  }

  static Future<void> _write(List<Map<String, dynamic>> ops) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_key, jsonEncode(ops));
  }

  static Future<int> count() async => (await _read()).length;

  static Future<void> add(Map<String, dynamic> op) async {
    final ops = await _read();
    op['op_id'] ??= Api.instance.newOpId();
    op['device_id'] = Api.instance.deviceId;
    op['queued_at'] = DateTime.now().toIso8601String();
    ops.add(op);
    await _write(ops);
  }

  /// Try to push everything. Anything the till rejected outright is dropped
  /// (with its error kept for the waiter to see); anything that failed because
  /// of the network stays for the next attempt.
  static Future<QueueResult> flush() async {
    final ops = await _read();
    if (ops.isEmpty) return QueueResult(0, 0, []);
    try {
      final res = await Api.instance.call('POST', '/api/mobile/sync', {'ops': ops});
      final results = (res['results'] as List).cast<Map<String, dynamic>>();
      final rejected = <String>[];
      final done = <String>{};
      for (final r in results) {
        if (r['status'] == 'applied') {
          done.add(r['op_id'] as String);
        } else {
          done.add(r['op_id'] as String);
          rejected.add(r['error']?.toString() ?? 'reddedildi');
        }
      }
      final left = ops.where((o) => !done.contains(o['op_id'])).toList();
      await _write(left);
      return QueueResult(done.length - rejected.length, rejected.length, rejected);
    } catch (_) {
      return QueueResult(0, 0, []);   // still offline; keep everything
    }
  }
}

class QueueResult {
  final int sent;
  final int failed;
  final List<String> errors;
  QueueResult(this.sent, this.failed, this.errors);
}
